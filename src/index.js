import express from "express";
import { assertRequiredConfig, config } from "./config.js";
import { AIClient } from "./ai-client.js";
import { ImageGenerationClient } from "./image-client.js";
import { SpeechToTextClient } from "./stt-client.js";
import { TextToSpeechClient } from "./tts-client.js";
import { createStorage } from "./storage.js";
import { TelegramCompanionBot } from "./telegram.js";
import { FeishuBot } from "./feishu.js";
import { FeishuBitableClient } from "./feishu-bitable.js";
import { setupAdminRoutes } from "./admin.js";
import { GitHubMemoryBackup } from "./github-backup.js";

assertRequiredConfig();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", true);

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "telegram-ai-companion",
    health: "/health",
    admin: "/admin"
  });
});
app.get("/health", (_req, res) => {
  const payload = {
    ok: true,
    storage: config.databaseUrl ? "postgres" : "json-file",
    imageGeneration: Boolean(config.imageGenerationEnabled && config.imageApiKey && config.imageApiUrl),
    voiceRecognition: Boolean(config.sttEnabled && config.sttApiKey && config.sttApiUrl),
    voiceReply: Boolean(config.ttsEnabled && config.ttsApiKey && config.ttsVoiceId),
    feishu: Boolean(config.feishuAppId && config.feishuAppSecret),
    feishuProjectFolder: Boolean(config.feishuProjectFolderToken)
  };
  if (config.exposeModelInfo) {
    payload.model = config.aiModel;
    payload.compatibility = config.aiCompatibility;
  }
  res.json(payload);
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Health server listening on 0.0.0.0:${config.port}`);
});

const storage = createStorage(config);
await storage.init();

const feishuBitable = new FeishuBitableClient({ config });
setupAdminRoutes(app, { config, storage, feishuBitable });

function serviceOrigin(req) {
  const host = req.get("x-forwarded-host") || req.get("host");
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}`;
}

app.get("/feishu/bitable-user-auth/start", (req, res) => {
  const redirectUri = `${serviceOrigin(req)}/feishu/bitable-user-auth/callback`;
  const state = Buffer.from(JSON.stringify({
    appToken: String(req.query.appToken || "P1g7bR1bkaBhIDs2QHQcoGbEnLg"),
    execute: req.query.execute === "1",
    ts: Date.now()
  })).toString("base64url");
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.searchParams.set("client_id", config.feishuAppId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "bitable:app");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/feishu/bitable-user-auth/callback", async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) {
    res.status(400).send("Missing Feishu OAuth code.");
    return;
  }

  let appToken = "P1g7bR1bkaBhIDs2QHQcoGbEnLg";
  let execute = false;
  try {
    const parsed = JSON.parse(Buffer.from(String(req.query.state || ""), "base64url").toString("utf8"));
    if (parsed?.appToken) appToken = parsed.appToken;
    execute = parsed?.execute === true;
  } catch {
    // Keep default app token.
  }

  const redirectUri = `${serviceOrigin(req)}/feishu/bitable-user-auth/callback`;
  const diagnostics = {
    ok: false,
    stage: "oauth_token",
    appToken,
    execute,
    tokenKind: "not_received",
    userInfo: null,
    accessCheck: null,
    hint: ""
  };
  try {
    const tokenResponse = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.feishuAppId,
        client_secret: config.feishuAppSecret,
        code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.code !== 0) {
      diagnostics.error = tokenData;
      diagnostics.hint = "OAuth token exchange failed. Check the Feishu app redirect URL and OAuth app configuration.";
      res.status(500).type("html").send(`<!doctype html><meta charset="utf-8"><title>Feishu OAuth Failed</title><pre>${JSON.stringify(diagnostics, null, 2)}</pre>`);
      return;
    }

    const userToken = tokenData.data?.access_token || tokenData.access_token;
    if (!userToken) {
      diagnostics.error = tokenData;
      diagnostics.hint = "OAuth succeeded but Feishu did not return an access_token.";
      res.status(500).type("html").send(`<!doctype html><meta charset="utf-8"><title>Feishu OAuth Failed</title><pre>${JSON.stringify(diagnostics, null, 2)}</pre>`);
      return;
    }
    diagnostics.tokenKind = userToken.startsWith("u-") ? "user_access_token" : "oauth_access_token";
    diagnostics.stage = "user_info";

    try {
      const userInfoResponse = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      diagnostics.userInfo = await userInfoResponse.json();
    } catch (error) {
      diagnostics.userInfo = { error: error.message };
    }

    const originalTenantAccessToken = feishuBitable.tenantAccessToken.bind(feishuBitable);
    feishuBitable.tenantAccessToken = async () => userToken;
    try {
      diagnostics.stage = "bitable_access_check";
      const tables = await feishuBitable.listAll(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
        page_size: 100
      });
      diagnostics.accessCheck = {
        ok: true,
        tableCount: tables.length,
        tables: tables.map((table) => ({
          tableId: table.table_id,
          name: table.name
        }))
      };

      if (!execute) {
        diagnostics.ok = true;
        diagnostics.stage = "ready_to_execute";
        diagnostics.hint = "The authorized user token can read this Base. Re-open the start URL with &execute=1 to apply the schema after confirming the schema file is clean.";
        res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Feishu Base Access OK</title><pre>${JSON.stringify(diagnostics, null, 2)}</pre>`);
        return;
      }

      diagnostics.stage = "apply_sales_schema";
      const result = await feishuBitable.applySalesSchema({ appToken });
      diagnostics.ok = true;
      diagnostics.stage = "done";
      diagnostics.result = result;
      res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Feishu Base Updated</title><pre>${JSON.stringify({
        ...diagnostics
      }, null, 2)}</pre>`);
    } finally {
      feishuBitable.tenantAccessToken = originalTenantAccessToken;
    }
  } catch (error) {
    diagnostics.error = error.message;
    diagnostics.hint = "If tokenKind is user_access_token but bitable_access_check returns RolePermNotAllow, the authorized Feishu user is not recognized as an editor of this Base for OpenAPI, or the app's OAuth scopes/tenant do not match this Base.";
    res.status(500).type("html").send(`<!doctype html><meta charset="utf-8"><title>Feishu Bitable Failed</title><pre>${JSON.stringify({
      ...diagnostics
    }, null, 2)}</pre>`);
  }
});

const githubBackup = new GitHubMemoryBackup({ config, storage });
await githubBackup.start();

const ai = new AIClient(config, {
  getSetting: (key, fallback) => storage.getSetting(key, fallback)
});
const imageGenerator = new ImageGenerationClient(config);
const speechToText = new SpeechToTextClient(config);
const textToSpeech = new TextToSpeechClient(config);
const feishuBot = new FeishuBot({ config, storage, ai, imageGenerator, speechToText });
feishuBot.setupRoutes(app);
const telegramBot = new TelegramCompanionBot({ config, storage, ai, imageGenerator, speechToText, textToSpeech });
await telegramBot.start();
