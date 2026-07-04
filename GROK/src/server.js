import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const STARTED_AT = new Date();
const execFileAsync = promisify(execFile);
const GROK_EXECUTABLE_NAME = process.platform === "win32" ? "grok.exe" : "grok";
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
  grokCliCommand: process.env.GROK_CLI_COMMAND || path.join(process.cwd(), ".grok", "bin", GROK_EXECUTABLE_NAME),
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
  return String(text || "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b[@-_]/g, "");
}

function isGrokDiagnosticLine(line = "") {
  const text = String(line || "").trim();
  return (
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(WARN|ERROR|INFO|DEBUG)\b/i.test(text) ||
    /\b(repo_state\.git\.collect|Codebase upload failed|Reference blob upload|batch_exists returned|dedup batch existence probe)\b/i.test(text) ||
    /^Caused by:\s*$/i.test(text)
  );
}

function sanitizeGrokOutput(text = "") {
  const clean = stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .filter((line) => !isGrokDiagnosticLine(line))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return clean;
}

function sanitizeFeishuText(text = "") {
  const clean = sanitizeGrokOutput(text)
    .replace(/[\u2028\u2029]/g, "\n")
    .trim();
  return clean || "没有生成可发送的回复。";
}

function plainMarkdownLine(line = "") {
  return String(line || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^(\s*)[-*+]\s+/, "$1• ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function appendTextNode(nodes, text, style = undefined) {
  if (!text) return;
  const node = { tag: "text", text };
  if (style?.length) node.style = style;
  const previous = nodes[nodes.length - 1];
  if (previous?.tag === "text" && JSON.stringify(previous.style || []) === JSON.stringify(node.style || [])) {
    previous.text += text;
    return;
  }
  nodes.push(node);
}

function appendInlineRichNodes(nodes, line = "", style = undefined) {
  const markdownLink = /\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g;
  let cursor = 0;
  let match;
  while ((match = markdownLink.exec(line)) !== null) {
    appendBareUrls(nodes, line.slice(cursor, match.index), style);
    nodes.push({ tag: "a", text: plainMarkdownLine(match[1]) || match[2], href: match[2] });
    cursor = match.index + match[0].length;
  }
  appendBareUrls(nodes, line.slice(cursor), style);
}

function appendBareUrls(nodes, text = "", style = undefined) {
  const urlPattern = /(https?:\/\/[^\s<>"')\]]+)/g;
  let cursor = 0;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    appendTextNode(nodes, plainMarkdownLine(text.slice(cursor, match.index)), style);
    const url = match[1].replace(/[.,!?;:，。！？；：]+$/g, "");
    nodes.push({ tag: "a", text: url, href: url });
    cursor = match.index + match[1].length;
  }
  appendTextNode(nodes, plainMarkdownLine(text.slice(cursor)), style);
}

function markdownLineToPostNodes(line = "", inCodeBlock = false) {
  const nodes = [];
  const raw = String(line || "");
  if (!raw.trim()) return [{ tag: "text", text: " " }];
  if (inCodeBlock) {
    appendTextNode(nodes, raw);
    return nodes;
  }

  const heading = raw.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    appendInlineRichNodes(nodes, heading[2], ["bold"]);
    return nodes;
  }

  const quote = raw.match(/^>\s?(.+)$/);
  if (quote) {
    appendTextNode(nodes, "引用：", ["bold"]);
    appendInlineRichNodes(nodes, quote[1]);
    return nodes;
  }

  const bullet = raw.match(/^(\s*)[-*+]\s+(.+)$/);
  if (bullet) {
    appendTextNode(nodes, "• ");
    appendInlineRichNodes(nodes, bullet[2]);
    return nodes;
  }

  const numbered = raw.match(/^\s*(\d+)[.)、]\s+(.+)$/);
  if (numbered) {
    appendTextNode(nodes, `${numbered[1]}. `);
    appendInlineRichNodes(nodes, numbered[2]);
    return nodes;
  }

  appendInlineRichNodes(nodes, raw);
  return nodes.length ? nodes : [{ tag: "text", text: plainMarkdownLine(raw) || " " }];
}

function buildFeishuPostContent(text = "", title = "Grok 回复") {
  const safe = sanitizeFeishuText(text);
  const lines = safe.split("\n");
  const content = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    content.push(markdownLineToPostNodes(line, inCodeBlock));
  }
  return {
    zh_cn: {
      title,
      content: content.length ? content : [[{ tag: "text", text: safe }]]
    }
  };
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

async function ensureGrokCliCommand() {
  if (config.grokCliCommand && !config.grokCliCommand.includes(path.sep)) {
    try {
      await execFileAsync(config.grokCliCommand, ["--version"], { timeout: 10000, windowsHide: true });
      return config.grokCliCommand;
    } catch (error) {
      throw new Error(`Configured Grok CLI command is not available on PATH: ${config.grokCliCommand}; ${error.message}`);
    }
  }

  if (!isExecutable(config.grokCliCommand)) {
    throw new Error(`Configured Grok CLI path does not exist or is not executable: ${config.grokCliCommand}`);
  }
  return config.grokCliCommand;
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
      const output = sanitizeGrokOutput(stdout);
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
    for (const chunk of splitReply(sanitizeFeishuText(text), config.maxReplyChars)) {
      await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "text",
        content: JSON.stringify({ text: chunk })
      });
    }
  }

  async replyPost(messageId, text, title = "Grok 回复") {
    if (!messageId) return;
    for (const chunk of splitReply(sanitizeFeishuText(text), config.maxReplyChars)) {
      await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "post",
        content: JSON.stringify(buildFeishuPostContent(chunk, title))
      });
    }
  }

  async replyRich(messageId, text, title = "Grok 回复") {
    try {
      await this.replyPost(messageId, text, title);
    } catch (error) {
      console.error("Feishu post reply failed, falling back to text:", error.message);
      await this.replyText(messageId, text);
    }
  }
}

function splitReply(text, maxChars) {
  const clean = sanitizeFeishuText(text);
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
    cwd: process.cwd(),
    feishuConfigured: feishu.enabled,
    xaiApiConfigured: Boolean(config.xaiApiKey),
    grokCliEnabled: config.grokCliEnabled,
    grokCliCwd: config.grokCliCwd,
    grokCliCommand: config.grokCliCommand,
    grokCliCommandExists: config.grokCliCommand.includes(path.sep) ? fs.existsSync(config.grokCliCommand) : null,
    grokCliCommandExecutable: config.grokCliCommand.includes(path.sep) ? isExecutable(config.grokCliCommand) : null,
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

app.get("/debug/grok-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const prompt = String(req.query.prompt || "用一句中文回答：Render Grok CLI 已经可以运行。").slice(0, 500);
    const command = await ensureGrokCliCommand();
    const answer = await callGrokCli(prompt);
    res.json({ ok: true, command, answer: answer.slice(0, 2000) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
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
    await feishu.replyRich(messageId, answer, job.webSearch ? "Grok 联网检索" : "Grok 回复");
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
