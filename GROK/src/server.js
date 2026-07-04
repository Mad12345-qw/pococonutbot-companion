import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const STARTED_AT = new Date();
const execFileAsync = promisify(execFile);
const DEFAULT_SYSTEM_PROMPT = [
  "You are Grok connected to a Feishu bot.",
  "Reply in the user's language.",
  "When the user asks for latest, current, prices, news, or web facts, use web search if available.",
  "Be direct, include dates for time-sensitive facts, and do not invent sources.",
  "If a searched company is private and has no public stock ticker, say that clearly before giving valuation or secondary-market context."
].join("\n");

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const config = {
  port: envNumber("PORT", 3000),
  serviceName: process.env.SERVICE_NAME || "feishu-grok-bridge",
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
  feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
  xaiApiKey: process.env.XAI_API_KEY || "",
  xaiModel: process.env.XAI_MODEL || "grok-4.3",
  xaiTimeoutMs: envNumber("XAI_TIMEOUT_MS", 540000),
  grokCliEnabled: envFlag("GROK_CLI_ENABLED", true),
  grokCliCommand: process.env.GROK_CLI_COMMAND || "grok",
  grokCliCwd: process.env.GROK_CLI_CWD || path.join(os.tmpdir(), "grok-feishu-bridge-cwd"),
  grokCliTimeoutMs: envNumber("GROK_CLI_TIMEOUT_MS", 300000),
  sendProgressMessage: envFlag("SEND_PROGRESS_MESSAGE", true),
  maxReplyChars: envNumber("MAX_REPLY_CHARS", 3500),
  debugToken: process.env.DEBUG_TOKEN || "",
  systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT
};

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stripAnsi(text = "") {
  return String(text || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isExecutable(filePath = "") {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function grokBinaryCandidates() {
  const exe = process.platform === "win32" ? "grok.exe" : "grok";
  return [
    config.grokCliCommand,
    path.join(process.cwd(), ".grok", "bin", exe),
    path.join(os.homedir(), ".grok", "bin", exe),
    process.env.GROK_BIN_DIR ? path.join(process.env.GROK_BIN_DIR, exe) : ""
  ].filter(Boolean);
}

async function ensureGrokCliCommand() {
  for (const candidate of grokBinaryCandidates()) {
    if (candidate.includes(path.sep) && isExecutable(candidate)) return candidate;
  }
  if (config.grokCliCommand && !config.grokCliCommand.includes(path.sep)) {
    try {
      await execFileAsync(config.grokCliCommand, ["--version"], { timeout: 10000, windowsHide: true });
      return config.grokCliCommand;
    } catch {
      // Fall through to a runtime install. Render can lose PATH/build artifacts in
      // ways that still leave the service running, so repair here before replying.
    }
  }

  if (process.platform === "win32") {
    throw new Error(`Grok CLI executable was not found. Checked: ${grokBinaryCandidates().join(", ")}`);
  }

  const binDir = path.join(process.cwd(), ".grok", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  await execFileAsync("bash", [
    "-lc",
    `export GROK_BIN_DIR=${JSON.stringify(binDir)} && curl -fsSL https://x.ai/cli/install.sh | bash`
  ], {
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });

  const installed = path.join(binDir, "grok");
  if (!isExecutable(installed)) {
    throw new Error(`Grok CLI install completed, but ${installed} is not executable.`);
  }
  return installed;
}

function parseContent(content = "") {
  if (!content) return {};
  if (typeof content === "object") return content;
  return parseJson(content, {});
}

function stripAtTags(text = "") {
  return String(text || "")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "")
    .replace(/@_user_\d+/g, "")
    .trim();
}

function flattenPostContent(content = {}) {
  const root = content?.zh_cn?.content || content?.content || content?.en_us?.content || [];
  const lines = Array.isArray(root) ? root : [];
  return lines
    .map((line) => {
      const nodes = Array.isArray(line) ? line : [line];
      return nodes.map((node) => {
        if (!node || typeof node !== "object") return "";
        if (node.tag === "at") return "";
        return node.text || node.name || "";
      }).join("");
    })
    .join("\n")
    .trim();
}

function extractMessageText(message = {}) {
  const content = parseContent(message.content);
  if (message.message_type === "post") return stripAtTags(flattenPostContent(content));
  return stripAtTags(content.text || content.title || content.description || "");
}

function shouldUseWebSearch(text = "") {
  return /(最新|今天|今日|现在|当前|实时|联网|搜索|查一下|股价|价格|新闻|市值|估值|财报|汇率|天气|多少|latest|today|current|real[- ]?time|search|stock|price|news|valuation)/i.test(text);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(timer) };
}

function extractResponseText(data = {}) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === "string") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    if ((value.type === "output_text" || value.type === "text") && typeof value.text === "string") {
      parts.push(value.text);
    }
    if (typeof value.content === "string") parts.push(value.content);
    if (Array.isArray(value.content)) visit(value.content);
    if (Array.isArray(value.output)) visit(value.output);
  };
  visit(data.output);
  if (parts.join("").trim()) return parts.join("").trim();
  const choice = data.choices?.[0]?.message?.content;
  return typeof choice === "string" ? choice.trim() : "";
}

function extractCitations(data = {}) {
  const urls = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.url === "string" && /^https?:\/\//i.test(value.url)) urls.add(value.url);
    if (Array.isArray(value.citations)) visit(value.citations);
    if (Array.isArray(value.sources)) visit(value.sources);
    if (Array.isArray(value.output)) visit(value.output);
    if (Array.isArray(value.content)) visit(value.content);
  };
  visit(data);
  return [...urls].slice(0, 6);
}

async function callXaiApi({ prompt, webSearch }) {
  if (!config.xaiApiKey) throw new Error("XAI_API_KEY is not configured.");
  const timeout = withTimeout(config.xaiTimeoutMs);
  try {
    const payload = {
      model: config.xaiModel,
      input: [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: prompt }
      ],
      store: false
    };
    if (webSearch) payload.tools = [{ type: "web_search" }];

    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.xaiApiKey}`
      },
      body: JSON.stringify(payload),
      signal: timeout.controller.signal
    });
    const text = await response.text();
    const data = parseJson(text, null);
    if (!response.ok) {
      const message = data?.error?.message || data?.message || text.slice(0, 500);
      throw new Error(`xAI API failed ${response.status}: ${message}`);
    }
    const answer = extractResponseText(data);
    if (!answer) throw new Error("xAI API returned no final text.");
    const citations = extractCitations(data);
    return citations.length ? `${answer}\n\n来源：\n${citations.map((url) => `- ${url}`).join("\n")}` : answer;
  } finally {
    timeout.clear();
  }
}

function grokCliArgs(prompt) {
  const raw = process.env.GROK_CLI_ARGS_JSON || "[\"--cwd\",\"{{cwd}}\",\"--no-memory\",\"--no-plan\",\"--max-turns\",\"1\",\"--output-format\",\"plain\",\"-p\",\"{{prompt}}\"]";
  const args = parseJson(raw, ["--cwd", "{{cwd}}", "--no-memory", "--no-plan", "--max-turns", "1", "--output-format", "plain", "-p", "{{prompt}}"]);
  return (Array.isArray(args) ? args : ["-p", "{{prompt}}"]).map((arg) => String(arg)
    .replaceAll("{{prompt}}", prompt)
    .replaceAll("{{cwd}}", config.grokCliCwd));
}

async function callGrokCli(prompt) {
  if (!config.grokCliEnabled) throw new Error("Grok CLI fallback is disabled.");
  fs.mkdirSync(config.grokCliCwd, { recursive: true });
  const command = await ensureGrokCliCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, grokCliArgs(prompt), {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Grok CLI timed out after ${config.grokCliTimeoutMs}ms.`));
    }, config.grokCliTimeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = stripAnsi(stdout).trim();
      if (code === 0 && output) {
        resolve(output);
        return;
      }
      reject(new Error(`Grok CLI exited ${code}: ${stderr.trim() || "empty output"}`));
    });
  });
}

async function answerWithGrok(prompt) {
  const webSearch = shouldUseWebSearch(prompt);
  if (config.xaiApiKey) {
    return callXaiApi({ prompt, webSearch });
  }
  return callGrokCli(prompt);
}

class FeishuClient {
  constructor() {
    this.token = "";
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(config.feishuAppId && config.feishuAppSecret);
  }

  async tenantAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60000) return this.token;
    if (!this.enabled) throw new Error("Feishu credentials are not configured.");
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.feishuAppId,
        app_secret: config.feishuAppSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu tenant token failed: ${JSON.stringify(data).slice(0, 500)}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = now + Number(data.expire || 3600) * 1000;
    return this.token;
  }

  async post(path, body) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  async replyText(messageId, text) {
    if (!messageId) return;
    for (const chunk of splitReply(text, config.maxReplyChars)) {
      await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "text",
        content: JSON.stringify({ text: chunk })
      });
    }
  }
}

function splitReply(text, maxChars) {
  const clean = String(text || "").trim() || "没有生成可发送的回复。";
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let index = rest.lastIndexOf("\n", maxChars);
    if (index < Math.floor(maxChars * 0.5)) index = maxChars;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function decryptIfNeeded(payload) {
  if (!payload?.encrypt) return payload;
  if (!config.feishuEncryptKey) {
    throw new Error("Received encrypted Feishu event, but FEISHU_ENCRYPT_KEY is not configured.");
  }
  const key = crypto.createHash("sha256").update(config.feishuEncryptKey).digest();
  const encrypted = Buffer.from(payload.encrypt, "base64");
  const iv = encrypted.subarray(0, 16);
  const data = encrypted.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

function handleUrlVerification(payload) {
  if (payload?.type !== "url_verification") return null;
  if (config.feishuVerificationToken && payload.token !== config.feishuVerificationToken) {
    throw new Error("Invalid Feishu URL verification token.");
  }
  return { challenge: payload.challenge };
}

function validFeishuToken(payload) {
  if (!config.feishuVerificationToken) return true;
  return payload?.header?.token === config.feishuVerificationToken || payload?.token === config.feishuVerificationToken;
}

const app = express();
const feishu = new FeishuClient();
const seenMessageIds = new Map();
const jobs = new Map();

app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", true);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: config.serviceName, health: "/health", feishuEvents: "/feishu/events" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: config.serviceName,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    feishuConfigured: feishu.enabled,
    xaiApiConfigured: Boolean(config.xaiApiKey),
    grokCliEnabled: config.grokCliEnabled,
    grokCliCwd: config.grokCliCwd,
    grokCliCandidates: grokBinaryCandidates().map((candidate) => ({
      path: candidate,
      exists: candidate.includes(path.sep) ? fs.existsSync(candidate) : null
    })),
    model: config.xaiApiKey ? config.xaiModel : "grok-cli",
    webSearchMode: config.xaiApiKey ? "xai-responses-web_search" : "grok-cli"
  });
});

app.get("/debug/jobs", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ jobs: [...jobs.values()].slice(-50) });
});

app.post("/feishu/events", async (req, res) => {
  let payload;
  try {
    payload = decryptIfNeeded(req.body || {});
    const verification = handleUrlVerification(payload);
    if (verification) {
      res.json(verification);
      return;
    }
    if (!validFeishuToken(payload)) {
      res.status(403).json({ error: "Invalid Feishu verification token." });
      return;
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const eventType = payload?.header?.event_type || payload?.type || "";
  if (eventType !== "im.message.receive_v1") {
    res.json({});
    return;
  }

  const message = payload?.event?.message || {};
  const messageId = message.message_id || "";
  if (!messageId || seenMessageIds.has(messageId)) {
    res.json({});
    return;
  }
  seenMessageIds.set(messageId, Date.now());
  for (const [id, ts] of seenMessageIds) {
    if (Date.now() - ts > 30 * 60 * 1000) seenMessageIds.delete(id);
  }

  res.json({});
  processFeishuMessage(payload).catch((error) => {
    console.error("Feishu background job failed:", error.message);
  });
});

async function processFeishuMessage(payload) {
  const event = payload.event || {};
  const senderType = event.sender?.sender_type || "";
  if (senderType === "app") return;
  const message = event.message || {};
  const messageId = message.message_id || "";
  const prompt = extractMessageText(message);
  if (!prompt) return;

  const job = {
    id: messageId,
    promptPreview: prompt.slice(0, 120),
    status: "running",
    webSearch: shouldUseWebSearch(prompt),
    startedAt: new Date().toISOString()
  };
  jobs.set(messageId, job);

  if (config.sendProgressMessage && job.webSearch) {
    await feishu.replyText(messageId, "我开始联网检索，完成后会直接把结论发在下面。");
  }

  try {
    const answer = await answerWithGrok(prompt);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await feishu.replyText(messageId, answer);
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    const fallback = [
      "这次没有拿到 Grok 的最终回答，但我不会停在“正在检索”。",
      "",
      `原因：${error.message}`,
      "",
      "如果这是联网问题，请在 Render 环境变量里配置 XAI_API_KEY；Grok CLI 的本地登录态不会自动带到 Render。"
    ].join("\n");
    await feishu.replyText(messageId, fallback);
  }
}

app.listen(config.port, "0.0.0.0", () => {
  console.log(`${config.serviceName} listening on 0.0.0.0:${config.port}`);
});
