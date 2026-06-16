import express from "express";
import { assertRequiredConfig, config } from "./config.js";
import { AIClient } from "./ai-client.js";
import { ImageGenerationClient } from "./image-client.js";
import { SpeechToTextClient } from "./stt-client.js";
import { createStorage } from "./storage.js";
import { TelegramCompanionBot } from "./telegram.js";
import { FeishuBot } from "./feishu.js";
import { FeishuBitableClient } from "./feishu-bitable.js";
import { setupAdminRoutes } from "./admin.js";
import { GitHubMemoryBackup } from "./github-backup.js";

assertRequiredConfig();

const app = express();
app.use(express.json({ limit: "1mb" }));

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

const bitableBootstrapStatus = {
  enabled: true,
  startedAt: new Date().toISOString(),
  finishedAt: "",
  ok: false,
  result: null,
  error: ""
};
app.get("/bitable-bootstrap-status", (_req, res) => {
  res.json(bitableBootstrapStatus);
});
feishuBitable.applySalesSchema()
  .then((result) => {
    bitableBootstrapStatus.ok = true;
    bitableBootstrapStatus.result = result;
  })
  .catch((error) => {
    bitableBootstrapStatus.error = error.message;
  })
  .finally(() => {
    bitableBootstrapStatus.finishedAt = new Date().toISOString();
  });

const githubBackup = new GitHubMemoryBackup({ config, storage });
await githubBackup.start();

const ai = new AIClient(config, {
  getSetting: (key, fallback) => storage.getSetting(key, fallback)
});
const imageGenerator = new ImageGenerationClient(config);
const speechToText = new SpeechToTextClient(config);
const feishuBot = new FeishuBot({ config, storage, ai, imageGenerator, speechToText });
feishuBot.setupRoutes(app);
const telegramBot = new TelegramCompanionBot({ config, storage, ai, imageGenerator, speechToText });
await telegramBot.start();
