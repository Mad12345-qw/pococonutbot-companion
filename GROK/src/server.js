import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import express from "express";

const STARTED_AT = new Date();
const execFileAsync = promisify(execFile);
const GROK_EXECUTABLE_NAME = process.platform === "win32" ? "grok.exe" : "grok";
const STREAM_ANSWER_ELEMENT_ID = "answer_md";
const STREAM_STATUS_ELEMENT_ID = "status_md";
const DEFAULT_SYSTEM_PROMPT = [
  "You are Grok connected to a Feishu bot.",
  "Reply in the user's language.",
  "When the user asks for latest, current, prices, news, or web facts, use web search if available.",
  "Be direct, include dates for time-sensitive facts, and do not invent sources.",
  "If a searched company is private and has no public stock ticker, say that clearly before giving valuation or secondary-market context.",
  "In headless CLI mode, stop searching once you have enough reliable evidence to answer.",
  "Treat --max-turns as an upper bound, not a target; prefer a concise final answer over continuing optional searches.",
  "For image generation requests, only claim success when you create or return an actual image file path or downloadable image URL.",
  "For video generation requests, only claim success when you create or return an actual MP4 file path or downloadable video URL."
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
  grokCliEnabled: envFlag("GROK_CLI_ENABLED", true),
  grokCliCommand: process.env.GROK_CLI_COMMAND || path.join(process.cwd(), ".grok", "bin", GROK_EXECUTABLE_NAME),
  grokCliCwd: process.env.GROK_CLI_CWD || path.join(os.tmpdir(), "grok-feishu-bridge-cwd"),
  grokCliTimeoutMs: envNumber("GROK_CLI_TIMEOUT_MS", 540000),
  maxCardContentChars: envNumber("MAX_CARD_CONTENT_CHARS", 90000),
  maxReplyChars: envNumber("MAX_REPLY_CHARS", 3500),
  maxImageBytes: envNumber("MAX_IMAGE_BYTES", 10 * 1024 * 1024),
  maxVideoBytes: envNumber("MAX_VIDEO_BYTES", 30 * 1024 * 1024),
  mediaMaxTurns: envNumber("GROK_MEDIA_MAX_TURNS", 10),
  videoMaxTurns: envNumber("GROK_VIDEO_MAX_TURNS", 10),
  videoModel: process.env.GROK_VIDEO_MODEL || "grok-build",
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

function redactSensitive(value = "") {
  return String(value || "")
    .replace(/(access_token|refresh_token|id_token|authorization|cookie|set-cookie)["':=\s]+[A-Za-z0-9._~+/=-]+/gi, "$1=<redacted>")
    .replace(/(xai-|xox[abp]-|sk-[A-Za-z0-9_-]*|eyJ[A-Za-z0-9._-]+)/g, "<redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>");
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

function stripProgressOnlyLead(text = "") {
  const lines = String(text || "").split("\n");
  while (
    lines.filter((line) => line.trim()).length > 1 &&
    /^\s*正在(?:搜索|联网|查找|检索|查詢|查询)\b[\s\S]{0,120}[。.!！]?\s*$/i.test(lines[0] || "")
  ) {
    lines.shift();
  }
  return lines.join("\n");
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
  return stripProgressOnlyLead(clean).trim();
}

function sanitizeFeishuText(text = "") {
  const clean = sanitizeGrokOutput(text)
    .replace(/[\u2028\u2029]/g, "\n")
    .trim();
  return clean || "没有生成可发送的回复。";
}

function cardText(value = "", max = 80) {
  const clean = sanitizeFeishuText(value)
    .replace(/[<>{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function cardMarkdown(value = "", max = config.maxCardContentChars) {
  const clean = sanitizeFeishuText(value)
    .replace(/[<>{}]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 20))}\n\n…内容过长，已分段继续。` : clean;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function imageMimeType(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function isSafeGrokFilePath(filePath = "", { pattern, maxBytes }) {
  if (!filePath || !pattern.test(filePath)) return false;
  const resolved = path.resolve(filePath);
  const cwdRoot = path.resolve(config.grokCliCwd);
  const sessionsRoot = path.resolve(os.homedir(), ".grok", "sessions");
  const generatedMediaRoot = path.resolve(os.homedir(), ".grok", "generated-media");
  const underCwd = resolved === cwdRoot || resolved.startsWith(`${cwdRoot}${path.sep}`);
  const underGrokSession = resolved.startsWith(`${sessionsRoot}${path.sep}`)
    && [path.sep + "images" + path.sep, path.sep + "videos" + path.sep, path.sep + "media" + path.sep, path.sep + "artifacts" + path.sep]
      .some((segment) => resolved.includes(segment));
  const underGeneratedMedia = resolved === generatedMediaRoot || resolved.startsWith(`${generatedMediaRoot}${path.sep}`);
  if (!underCwd && !underGrokSession && !underGeneratedMedia) return false;
  try {
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size > 0 && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

function isSafeGrokImagePath(filePath = "") {
  return isSafeGrokFilePath(filePath, {
    pattern: /\.(?:png|jpe?g|webp|gif)$/i,
    maxBytes: config.maxImageBytes
  });
}

function isSafeGrokVideoPath(filePath = "") {
  return isSafeGrokFilePath(filePath, {
    pattern: /\.(?:mp4|mov|webm)$/i,
    maxBytes: config.maxVideoBytes
  });
}

function candidatePathVariants(candidate = "") {
  const raw = String(candidate || "").replace(/[),.;:，。；：]+$/g, "");
  const variants = [raw];
  const jsonUnescaped = raw.replace(/\\\\/g, "\\");
  if (jsonUnescaped !== raw) variants.push(jsonUnescaped);
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) variants.push(decoded);
  } catch {
    // Keep raw if URI decoding is not applicable.
  }
  try {
    const decodedUnescaped = decodeURIComponent(jsonUnescaped);
    if (decodedUnescaped !== jsonUnescaped) variants.push(decodedUnescaped);
  } catch {
    // Keep unescaped if URI decoding is not applicable.
  }
  return variants;
}

function extractLocalPaths(text = "", patterns, validator, limit = 4) {
  const paths = [];
  const seen = new Set();
  for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
    let match;
    while ((match = pattern.exec(String(text || ""))) !== null && paths.length < limit) {
      for (const candidate of candidatePathVariants(match[1])) {
        const resolved = path.resolve(candidate);
        if (!seen.has(resolved) && validator(resolved)) {
          seen.add(resolved);
          paths.push(resolved);
          break;
        }
      }
    }
  }
  return paths;
}

function appendCappedText(current = "", chunk = "", max = 120000) {
  const next = `${current}${chunk}`;
  return next.length > max ? next.slice(-max) : next;
}

function extractLocalPathCandidates(text = "", pattern, limit = 8) {
  const paths = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null && paths.length < limit) {
    for (const item of candidatePathVariants(match[1])) {
      const resolved = path.resolve(item);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        paths.push(resolved);
      }
    }
  }
  return paths;
}

function extractLocalImagePaths(text = "", limit = 4) {
  return extractLocalPaths(text, [
    /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi,
    /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi
  ], isSafeGrokImagePath, limit);
}

function extractLocalVideoPaths(text = "", limit = 2) {
  return extractLocalPaths(text, [
    /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:mp4|mov|webm))/gi,
    /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:mp4|mov|webm))/gi
  ], isSafeGrokVideoPath, limit);
}

function stripLocalMediaPaths(text = "") {
  let clean = String(text || "");
  const localPaths = [
    ...extractLocalPathCandidates(clean, /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi),
    ...extractLocalPathCandidates(clean, /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:mp4|mov|webm))/gi),
    ...extractLocalPathCandidates(clean, /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi),
    ...extractLocalPathCandidates(clean, /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:mp4|mov|webm))/gi)
  ];
  for (const filePath of localPaths) {
    clean = clean.replace(new RegExp(escapeRegExp(filePath), "g"), "");
    clean = clean.replace(new RegExp(escapeRegExp(`file://${filePath}`), "g"), "");
  }
  return sanitizeGrokOutput(clean)
    .split("\n")
    .filter((line) => !/^\s*(图片文件路径|视频文件路径|媒体文件路径|文件路径|本地路径|path|image path|video path|media path|url)[:：]?\s*$/i.test(line))
    .join("\n")
    .trim();
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function solidPng(width = 640, height = 360, rgba = [28, 45, 74, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = rgba[0];
    row[2 + x * 4] = rgba[1];
    row[3 + x * 4] = rgba[2];
    row[4 + x * 4] = rgba[3];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND")
  ]);
}

function ensureVideoThumbnail() {
  const thumbnailPath = path.join(config.grokCliCwd, "video-thumbnail.png");
  if (!fs.existsSync(thumbnailPath)) {
    fs.mkdirSync(path.dirname(thumbnailPath), { recursive: true });
    fs.writeFileSync(thumbnailPath, solidPng());
  }
  return thumbnailPath;
}

function safeDeleteLocalFile(filePath = "") {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const cwdRoot = path.resolve(config.grokCliCwd);
  const sessionsRoot = path.resolve(os.homedir(), ".grok", "sessions");
  const generatedMediaRoot = path.resolve(os.homedir(), ".grok", "generated-media");
  const underCwd = resolved === cwdRoot || resolved.startsWith(`${cwdRoot}${path.sep}`);
  const underGrokSession = resolved.startsWith(`${sessionsRoot}${path.sep}`);
  const underGeneratedMedia = resolved === generatedMediaRoot || resolved.startsWith(`${generatedMediaRoot}${path.sep}`);
  if (!underCwd && !underGrokSession && !underGeneratedMedia) return false;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
    fs.rmSync(resolved, { force: true });
    return true;
  } catch {
    return false;
  }
}

function safeDeleteLocalFiles(filePaths = []) {
  let deleted = 0;
  for (const filePath of filePaths) {
    if (safeDeleteLocalFile(filePath)) deleted += 1;
  }
  return deleted;
}

function extractUrlsFromText(text = "", limit = 3) {
  const urls = [];
  const seen = new Set();
  const add = (url) => {
    const clean = String(url || "").replace(/[.,!?;:，。！？；：]+$/g, "");
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    urls.push(clean);
  };
  for (const match of String(text || "").matchAll(/\[[^\]]{1,160}\]\((https?:\/\/[^)\s]+)\)/g)) add(match[1]);
  for (const match of String(text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(match[0]);
  return urls.slice(0, limit);
}

function splitForCard(text = "", maxChars = 4200) {
  const clean = sanitizeFeishuText(text);
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let index = rest.lastIndexOf("\n\n", maxChars);
    if (index < Math.floor(maxChars * 0.45)) index = rest.lastIndexOf("\n", maxChars);
    if (index < Math.floor(maxChars * 0.45)) index = maxChars;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sourceButtons(text = "") {
  return extractUrlsFromText(text, 3).map((url, index) => ({
    tag: "button",
    text: {
      tag: "plain_text",
      content: `打开来源 ${index + 1}`
    },
    type: index === 0 ? "primary" : "default",
    url
  }));
}

function sourceButtonsV2(text = "") {
  return extractUrlsFromText(text, 4).map((url, index) => ({
    tag: "button",
    element_id: `source_btn_${index + 1}`,
    text: {
      tag: "plain_text",
      content: `来源 ${index + 1}`
    },
    type: index === 0 ? "primary_filled" : "default",
    size: "small",
    width: "default",
    behaviors: [
      {
        type: "open_url",
        default_url: url,
        pc_url: url,
        ios_url: url,
        android_url: url
      }
    ]
  }));
}

function buildStreamingCard(text = "", title = "Grok 回复", { webSearch = false, status = "Grok CLI 已接管任务" } = {}) {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      enable_forward: false,
      width_mode: "fill",
      summary: {
        content: "[生成中...] Grok CLI"
      },
      streaming_config: {
        print_frequency_ms: { default: 45, android: 45, ios: 45, pc: 45 },
        print_step: { default: 2, android: 2, ios: 2, pc: 2 },
        print_strategy: "delay"
      }
    },
    header: {
      template: webSearch ? "indigo" : "blue",
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      },
      subtitle: {
        tag: "plain_text",
        content: webSearch ? "Grok CLI · 联网检索 · 原生流式卡片" : "Grok CLI · 原生流式卡片"
      },
      text_tag_list: [
        {
          tag: "text_tag",
          element_id: "mode_tag",
          text: {
            tag: "plain_text",
            content: webSearch ? "搜索" : "对话"
          },
          color: webSearch ? "indigo" : "blue"
        },
        {
          tag: "text_tag",
          element_id: "stream_tag",
          text: {
            tag: "plain_text",
            content: "流式"
          },
          color: "green"
        }
      ]
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          element_id: STREAM_STATUS_ELEMENT_ID,
          content: `**状态**：${cardMarkdown(status, 260)}`
        },
        {
          tag: "markdown",
          element_id: STREAM_ANSWER_ELEMENT_ID,
          content: ` ${cardMarkdown(text || "", config.maxCardContentChars - 1)}`
        }
      ]
    }
  };
}

function buildFinalCard(text = "", title = "Grok 回复", { webSearch = false } = {}) {
  const safe = sanitizeFeishuText(text);
  const elements = [
    {
      tag: "markdown",
      element_id: STREAM_ANSWER_ELEMENT_ID,
      content: cardMarkdown(safe)
    }
  ];
  const buttons = sourceButtonsV2(safe);
  if (buttons.length) {
    elements.push({
      tag: "markdown",
      element_id: "source_label",
      content: "**来源链接**"
    });
    elements.push(...buttons);
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      enable_forward: true,
      width_mode: "fill",
      summary: {
        content: cardText(safe || title, 80)
      }
    },
    header: {
      template: webSearch ? "indigo" : "blue",
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      },
      text_tag_list: [
        {
          tag: "text_tag",
          element_id: "mode_tag",
          text: {
            tag: "plain_text",
            content: webSearch ? "联网" : "对话"
          },
          color: webSearch ? "indigo" : "blue"
        },
        {
          tag: "text_tag",
          element_id: "done_tag",
          text: {
            tag: "plain_text",
            content: "完成"
          },
          color: "green"
        }
      ]
    },
    body: {
      direction: "vertical",
      padding: "14px 14px 14px 14px",
      vertical_spacing: "8px",
      elements
    }
  };
}

function buildFeishuCard(text = "", title = "Grok 回复", { webSearch = false, part = 1, total = 1 } = {}) {
  const safe = sanitizeFeishuText(text);
  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: cardMarkdown(safe)
      }
    }
  ];
  const actions = sourceButtons(safe);
  if (actions.length) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "action", actions });
  }
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: [
          webSearch ? "Grok CLI · 联网检索" : "Grok CLI",
          total > 1 ? `第 ${part}/${total} 段` : "飞书卡片富文本"
        ].join(" · ")
      }
    ]
  });
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true
    },
    header: {
      template: webSearch ? "indigo" : "blue",
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      }
    },
    elements
  };
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

function messageType(message = {}) {
  return message.message_type || message.msg_type || message.body?.message_type || "";
}

function messageContent(message = {}) {
  return parseContent(message.content ?? message.body?.content ?? {});
}

function extractMessageText(message = {}) {
  const content = messageContent(message);
  if (messageType(message) === "post") return stripAtTags(flattenPostContent(content));
  return stripAtTags(content.text || content.title || content.description || "");
}

function quotedMessageId(message = {}) {
  const own = message.message_id || "";
  for (const key of ["parent_id", "parent_message_id", "root_id", "root_message_id"]) {
    const value = message[key];
    if (typeof value === "string" && value && value !== own) return value;
  }
  return "";
}

function safeName(value = "") {
  return String(value || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

function extFromContentType(contentType = "", fallback = ".bin") {
  const clean = String(contentType || "").toLowerCase();
  if (clean.includes("png")) return ".png";
  if (clean.includes("webp")) return ".webp";
  if (clean.includes("gif")) return ".gif";
  if (clean.includes("jpeg") || clean.includes("jpg")) return ".jpg";
  if (clean.includes("mp4")) return ".mp4";
  if (clean.includes("quicktime")) return ".mov";
  if (clean.includes("webm")) return ".webm";
  if (clean.includes("pdf")) return ".pdf";
  return fallback;
}

function messageContentKeys(message = {}) {
  const content = messageContent(message);
  const type = messageType(message);
  const keys = [];
  const seen = new Set();
  const add = (type, key, fallbackName = "") => {
    if (typeof key === "string" && key && !seen.has(`${type}:${key}`)) {
      seen.add(`${type}:${key}`);
      keys.push({ type, key, name: fallbackName || key });
    }
  };
  if (type === "image") {
    add("image", content.image_key, "quoted-image.jpg");
  } else if (type === "media") {
    add("file", content.file_key, content.file_name || "quoted-video.mp4");
    add("image", content.image_key, "quoted-video-thumbnail.jpg");
  } else if (type === "file") {
    add("file", content.file_key, content.file_name || content.name || "quoted-file.bin");
  } else if (type === "audio") {
    add("file", content.file_key, content.file_name || "quoted-audio.bin");
  }
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    add("image", value.image_key, value.file_name || value.name || "quoted-image.jpg");
    add("file", value.file_key, value.file_name || value.name || "quoted-file.bin");
    for (const item of Object.values(value)) walk(item);
  };
  walk(content);
  return keys;
}

function shouldUseWebSearch(text = "") {
  return /(最新|今天|今日|现在|当前|实时|联网|搜索|查一下|股价|价格|新闻|市值|估值|财报|汇率|天气|多少|latest|today|current|real[- ]?time|search|stock|price|news|valuation)/i.test(text);
}

function shouldUseMediaGeneration(text = "") {
  return /(生成|做|制作|create|generate|make).{0,30}(图片|照片|图像|视频|动图|短片|image|photo|picture|video|mp4|gif)|(?:图片|照片|图像|视频|动图|短片).{0,30}(生成|做|制作|create|generate|make|打招呼|动起来|animate)/i.test(text);
}

function mediaKind(text = "") {
  if (/(视频|短片|mp4|video|动起来|打招呼|animate)/i.test(text)) return "video";
  if (/(图片|照片|图像|image|photo|picture|gif)/i.test(text)) return "image";
  return "";
}

function isDeepResearch(text = "") {
  return /(深度|详细|全面|对比|分析|报告|调研|研究|多来源|多个来源|引用来源|长文|方案|strategy|research|compare|analysis|report)/i.test(text);
}

function isQuickFact(text = "") {
  return String(text || "").trim().length <= 80
    && /(是什么|什么意思|多少|是谁|哪天|今天|现在|股价|价格|定义|解释|when|what|who|price)/i.test(text);
}

function classifyTask(text = "") {
  const media = mediaKind(text);
  if (media === "video") {
    return {
      kind: "video",
      maxTurns: config.videoMaxTurns,
      title: "Grok 视频生成",
      webSearch: false,
      mediaTask: true,
      rules: [
        "This is a Grok Build video task. Use the available Grok Build media tools, especially image_to_video or reference_to_video. If no reference image is provided, create a source image first, then animate it. Do not create videos with Python, FFmpeg, shell scripts, or code. Return the saved local MP4 path."
      ]
    };
  }
  if (media === "image") {
    return {
      kind: "image",
      maxTurns: config.mediaMaxTurns,
      title: "Grok 图片生成",
      webSearch: false,
      mediaTask: true,
      rules: [
        "This is a Grok Imagine image task. Use the built-in image generation capability, such as /imagine, and return the saved local image path. If quoted files are provided, use them as explicit references."
      ]
    };
  }
  if (shouldUseWebSearch(text)) {
    const deep = isDeepResearch(text);
    return {
      kind: deep ? "research" : "quick_search",
      maxTurns: deep ? 18 : 10,
      title: "Grok 联网检索",
      webSearch: true,
      mediaTask: false,
      rules: []
    };
  }
  if (isQuickFact(text)) {
    return {
      kind: "quick_fact",
      maxTurns: 6,
      title: "Grok 回复",
      webSearch: false,
      mediaTask: false,
      rules: []
    };
  }
  return {
    kind: "chat",
    maxTurns: 8,
    title: "Grok 回复",
    webSearch: false,
    mediaTask: false,
    rules: []
  };
}

function grokCliArgs(prompt, { maxTurns, model } = {}) {
  const raw = process.env.GROK_CLI_ARGS_JSON || "[\"--no-auto-update\",\"--always-approve\",\"--permission-mode\",\"bypassPermissions\",\"--max-turns\",\"10\",\"--cwd\",\"{{cwd}}\",\"--no-memory\",\"--output-format\",\"streaming-json\",\"-p\",\"{{prompt}}\"]";
  const args = parseJson(raw, ["--no-auto-update", "--always-approve", "--permission-mode", "bypassPermissions", "--max-turns", "10", "--cwd", "{{cwd}}", "--no-memory", "--output-format", "streaming-json", "-p", "{{prompt}}"]);
  const turns = String(maxTurns || config.mediaMaxTurns);
  const modelName = model ? String(model) : "";
  const resolvedArgs = (Array.isArray(args) ? args : ["-p", "{{prompt}}"]).map((arg) => String(arg)
    .replaceAll("{{prompt}}", prompt)
    .replaceAll("{{maxTurns}}", turns)
    .replaceAll("{{model}}", modelName)
    .replaceAll("{{cwd}}", config.grokCliCwd));
  const turnIndex = resolvedArgs.indexOf("--max-turns");
  if (turnIndex >= 0 && turnIndex + 1 < resolvedArgs.length) {
    resolvedArgs[turnIndex + 1] = turns;
  }
  if (modelName) {
    const modelIndex = resolvedArgs.findIndex((arg) => arg === "-m" || arg === "--model");
    if (modelIndex >= 0 && modelIndex + 1 < resolvedArgs.length) {
      resolvedArgs[modelIndex + 1] = modelName;
    } else {
      resolvedArgs.unshift("--model", modelName);
    }
  }
  return resolvedArgs;
}

function buildGrokPrompt(userPrompt = "", { quotedContext = null, taskRules = [] } = {}) {
  const quotedLines = quotedContext
    ? [
        "The user explicitly replied to or quoted this Feishu message. Treat it as referenced context, then use your own agent judgment.",
        quotedContext.text ? `Quoted text:\n${quotedContext.text}` : "",
        ...quotedContext.files.map((item) => item.path
          ? `Quoted ${item.type} file: ${item.path}`
          : `Quoted ${item.type || "resource"} could not be downloaded: ${item.error || "unknown error"}`)
      ].filter(Boolean)
    : [];
  return [
    config.systemPrompt,
    ...quotedLines,
    ...taskRules,
    "User message:",
    String(userPrompt || "").trim()
  ].filter(Boolean).join("\n\n");
}

function parseStreamingJsonLine(line = "") {
  const clean = stripAnsi(line).trim();
  if (!clean || !clean.startsWith("{")) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function streamingEventText(event = {}) {
  for (const key of ["data", "text", "content", "delta", "message"]) {
    if (typeof event[key] === "string" && event[key]) return event[key];
  }
  return "";
}

function describeGrokEvent(event = {}) {
  const text = `${event.type || ""} ${event.name || ""} ${event.tool || ""}`.toLowerCase();
  if (!text.trim()) return "";
  if (text.includes("web") || text.includes("search") || text.includes("browser")) {
    return "正在联网搜索并核对来源";
  }
  if (text.includes("tool")) return "正在调用工具获取信息";
  if (text.includes("end")) return "正在整理最终回答";
  if (text.includes("error")) return "Grok CLI 返回运行事件，正在等待最终结果";
  return "";
}

async function callGrokCli(prompt, { onText, onEvent, maxTurns, model = "", quotedContext = null, taskRules = [], timeoutMs } = {}) {
  if (!config.grokCliEnabled) throw new Error("Grok CLI is disabled.");
  fs.mkdirSync(config.grokCliCwd, { recursive: true });
  const command = await ensureGrokCliCommand();
  const effectivePrompt = buildGrokPrompt(prompt, { quotedContext, taskRules });
  return new Promise((resolve, reject) => {
    const child = spawn(command, grokCliArgs(effectivePrompt, { maxTurns, model }), {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let streamedText = "";
    let sawStreamingEvent = false;
    let stopReason = "";
    let processClosed = false;
    const effectiveTimeoutMs = Number(timeoutMs || config.grokCliTimeoutMs);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!processClosed) child.kill("SIGKILL");
      }, 3000).unref?.();
      reject(new Error(`Grok CLI timed out after ${effectiveTimeoutMs}ms. stdoutTail=${sanitizeGrokOutput(stdout).slice(-1200)} stderrTail=${sanitizeGrokOutput(stderr).slice(-1200)}`));
    }, effectiveTimeoutMs);
    child.stdout.on("data", (chunk) => {
      const piece = chunk.toString("utf8");
      stdout += piece;
      lineBuffer += piece;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseStreamingJsonLine(line);
        if (!event) continue;
        sawStreamingEvent = true;
        if (event.type === "text" && streamingEventText(event)) {
          const delta = streamingEventText(event);
          streamedText += delta;
          onText?.(streamedText, delta);
        } else if (event.type === "end") {
          stopReason = event.stopReason || "";
          onEvent?.(event);
        } else if (event.type !== "thought") {
          onEvent?.(event);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      processClosed = true;
      clearTimeout(timer);
      const trailing = parseStreamingJsonLine(lineBuffer);
      if (trailing?.type === "text" && streamingEventText(trailing)) {
        sawStreamingEvent = true;
        const delta = streamingEventText(trailing);
        streamedText += delta;
        onText?.(streamedText, delta);
      }
      if (trailing?.type === "end") {
        stopReason = trailing.stopReason || "";
        onEvent?.(trailing);
      }
      const output = sawStreamingEvent ? sanitizeGrokOutput(streamedText) : sanitizeGrokOutput(stdout);
      const mediaPathText = [
        ...extractLocalImagePaths(stdout, 8),
        ...extractLocalVideoPaths(stdout, 4)
      ].join("\n");
      const outputWithMediaPaths = sanitizeGrokOutput([output, mediaPathText].filter(Boolean).join("\n"));
      if (code === 0 && outputWithMediaPaths) {
        resolve(outputWithMediaPaths);
        return;
      }
      reject(new Error(`Grok CLI exited ${code}: ${[stopReason, stderr.trim() || "empty output"].filter(Boolean).join("; ")}`));
    });
  });
}

async function callGrokImagineVideo(prompt, options = {}) {
  options.onEvent?.({ type: "tool", name: "grok-build-image-to-video" });
  const answer = await callGrokCli(prompt, {
    ...options,
    model: config.videoModel,
    maxTurns: options.maxTurns || config.videoMaxTurns
  });
  const videoPaths = extractLocalVideoPaths(answer);
  if (!videoPaths.length) {
    throw new Error(`Grok video task finished without a safe MP4 path. Output: ${stripLocalMediaPaths(answer).slice(-1600)}`);
  }
  return answer;
}

async function probeGrokTui(input = "/help", timeoutMs = 12000) {
  fs.mkdirSync(config.grokCliCwd, { recursive: true });
  const command = await ensureGrokCliCommand();
  const shellCommand = [
    shellQuote(command),
    "--no-auto-update",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--cwd",
    shellQuote(config.grokCliCwd),
    "--no-memory"
  ].join(" ");
  return new Promise((resolve) => {
    const child = spawn("script", ["-q", "-f", "-e", "-c", shellCommand, "/dev/null"], {
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.stdin?.write("/quit\r");
      } catch {
        // Ignore closed stdin.
      }
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 1000).unref?.();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        stdoutTail: sanitizeGrokOutput(stdout).slice(-3000),
        stderrTail: sanitizeGrokOutput(stderr).slice(-1000)
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendCappedText(stdout, chunk.toString("utf8"), 30000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendCappedText(stderr, chunk.toString("utf8"), 10000);
    });
    child.on("error", (error) => {
      finish({ ok: false, error: error.message, stdoutTail: sanitizeGrokOutput(stdout).slice(-3000), stderrTail: sanitizeGrokOutput(stderr).slice(-1000) });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, exitCode: code, stdoutTail: sanitizeGrokOutput(stdout).slice(-5000), stderrTail: sanitizeGrokOutput(stderr).slice(-1000) });
    });
    setTimeout(() => {
      child.stdin.write(`${input}\r`);
    }, 1500).unref?.();
    setTimeout(() => {
      child.stdin.write("/quit\r");
    }, Math.max(2500, timeoutMs - 2000)).unref?.();
  });
}

async function probeGrokCli(prompt, timeoutMs = 60000) {
  fs.mkdirSync(config.grokCliCwd, { recursive: true });
  const command = await ensureGrokCliCommand();
  const args = grokCliArgs(prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const events = [];
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let textLength = 0;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        timedOut: true,
        command,
        args: args.map((arg) => (arg === prompt ? "{{prompt}}" : arg)),
        events,
        textLength,
        stderrTail: sanitizeGrokOutput(stderr).slice(-1200),
        stdoutTail: sanitizeGrokOutput(stdout).slice(-1200)
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const piece = chunk.toString("utf8");
      stdout += piece;
      lineBuffer += piece;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseStreamingJsonLine(line);
        if (!event) continue;
        const delta = event.type === "text" ? streamingEventText(event) : "";
        if (delta) textLength += delta.length;
        if (events.length < 40) {
          events.push({
            type: event.type || "",
            name: event.name || event.tool || "",
            textLength: delta.length
          });
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      const event = parseStreamingJsonLine(lineBuffer);
      if (event) {
        const delta = event.type === "text" ? streamingEventText(event) : "";
        if (delta) textLength += delta.length;
        if (events.length < 40) {
          events.push({
            type: event.type || "",
            name: event.name || event.tool || "",
            textLength: delta.length
          });
        }
      }
      finish({
        ok: code === 0,
        timedOut: false,
        exitCode: code,
        command,
        args: args.map((arg) => (arg === prompt ? "{{prompt}}" : arg)),
        events,
        textLength,
        stderrTail: sanitizeGrokOutput(stderr).slice(-1200),
        stdoutTail: sanitizeGrokOutput(stdout).slice(-1200)
      });
    });
  });
}

async function runCliDiagnostic(command, args, timeout = 20000) {
  try {
    const result = await execFileAsync(command, args, {
      env: process.env,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return {
      ok: true,
      stdout: redactSensitive(sanitizeGrokOutput(result.stdout)).slice(0, 6000),
      stderr: redactSensitive(sanitizeGrokOutput(result.stderr)).slice(0, 3000)
    };
  } catch (error) {
    return {
      ok: false,
      message: redactSensitive(error.message),
      stdout: redactSensitive(sanitizeGrokOutput(error.stdout || "")).slice(0, 6000),
      stderr: redactSensitive(sanitizeGrokOutput(error.stderr || "")).slice(0, 3000)
    };
  }
}

function statIfExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
  } catch {
    return { exists: false };
  }
}

async function grokDiagnostics() {
  const command = await ensureGrokCliCommand();
  const home = os.homedir();
  const grokHome = path.join(home, ".grok");
  const help = await runCliDiagnostic(command, ["--help"]);
  const version = await runCliDiagnostic(command, ["--version"]);
  const inspect = await runCliDiagnostic(command, ["inspect"], 30000);
  const maxToolRoundsSmoke = await runCliDiagnostic(command, [
    "--no-auto-update",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--max-tool-rounds",
    "1",
    "--output-format",
    "json",
    "-p",
    "Do not use tools. Reply with OK."
  ], 45000);
  const maxTurnsSmoke = await runCliDiagnostic(command, [
    "--no-auto-update",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "4",
    "--output-format",
    "json",
    "-p",
    "Do not use tools. Reply with OK."
  ], 45000);
  const webToolsSmoke = await runCliDiagnostic(command, [
    "--no-auto-update",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    "web_search,web_fetch",
    "--max-turns",
    "6",
    "--output-format",
    "streaming-json",
    "-p",
    "Use web_search to find the xAI CLI headless scripting docs URL, then answer with only that URL."
  ], 90000);
  const helpText = `${help.stdout}\n${help.stderr}`;
  let sessionCount = null;
  try {
    const sessionsDir = path.join(grokHome, "sessions");
    sessionCount = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).length : 0;
  } catch {
    sessionCount = null;
  }
  return {
    command,
    cwd: process.cwd(),
    home,
    grokCliCwd: config.grokCliCwd,
    configuredArgs: grokCliArgs("{{prompt}}"),
    mediaConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.mediaMaxTurns }),
    videoConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.videoMaxTurns, model: config.videoModel }),
    files: {
      grokHome: statIfExists(grokHome),
      authJson: statIfExists(path.join(grokHome, "auth.json")),
      configToml: statIfExists(path.join(grokHome, "config.toml")),
      requirementsToml: statIfExists(path.join(grokHome, "requirements.toml")),
      sessions: {
        ...statIfExists(path.join(grokHome, "sessions")),
        count: sessionCount
      }
    },
    supports: {
      alwaysApprove: /--always-approve/.test(helpText),
      permissionMode: /--permission-mode/.test(helpText),
      maxToolRounds: /--max-tool-rounds/.test(helpText),
      sandbox: /--sandbox/.test(helpText),
      deviceAuth: /device-auth/.test(helpText)
    },
    version,
    help: {
      ok: help.ok,
      excerpt: helpText.split("\n").filter((line) => /approve|permission|tool|search|sandbox|format|auto|headless|max/i.test(line)).slice(0, 80)
    },
    inspect,
    maxToolRoundsSmoke,
    maxTurnsSmoke,
    webToolsSmoke
  };
}

async function answerWithGrok(prompt) {
  return callGrokCli(prompt);
}

function createCardKitStreamingUpdater({ feishu, cardId, title, webSearch }) {
  let sequence = 0;
  let lastAnswerAt = 0;
  let lastStatusAt = 0;
  let latestAnswer = "";
  let latestStatus = webSearch ? "正在联网搜索并核对来源" : "正在生成回答";
  let queue = Promise.resolve();
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  const enqueue = (task) => {
    queue = queue
      .then(task)
      .catch((error) => {
        console.error("Feishu CardKit streaming update failed:", error.message);
      });
    return queue;
  };
  const patchAnswer = (text, force = false) => {
    latestAnswer = sanitizeFeishuText(text);
    if (!cardId || !latestAnswer) return queue;
    const now = Date.now();
    if (!force && now - lastAnswerAt < 900) return queue;
    lastAnswerAt = now;
    return enqueue(() => feishu.streamCardText(cardId, STREAM_ANSWER_ELEMENT_ID, ` ${cardMarkdown(latestAnswer, config.maxCardContentChars - 1)}`, nextSequence()));
  };
  const patchStatus = (status, force = false) => {
    latestStatus = sanitizeFeishuText(status).slice(0, 260);
    if (!cardId || !latestStatus) return queue;
    const now = Date.now();
    if (!force && now - lastStatusAt < 3000) return queue;
    lastStatusAt = now;
    return enqueue(() => feishu.streamCardText(cardId, STREAM_STATUS_ELEMENT_ID, `**状态**：${latestStatus}`, nextSequence()));
  };
  return {
    patchAnswer,
    patchStatus,
    finish: async () => {
      await queue;
      await patchAnswer(latestAnswer, true);
      await queue;
      await feishu.updateCard(cardId, buildFinalCard(latestAnswer, title, { webSearch }), nextSequence());
      await queue;
    },
    fail: async (errorText) => {
      latestAnswer = sanitizeFeishuText(errorText);
      await queue;
      await patchAnswer(latestAnswer, true);
      await patchStatus("运行失败，已把根因暴露在卡片里", true);
      await enqueue(() => feishu.updateCardSettings(cardId, {
        config: {
          streaming_mode: false,
          summary: { content: "Grok CLI 运行失败" }
        }
      }, nextSequence()));
      await queue;
    }
  };
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

  async post(path, body, method = "POST") {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method,
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

  async get(path) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  async download(requestPath, destPath) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${requestPath}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Feishu download failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return { path: destPath, contentType, size: buffer.length };
  }

  async getMessage(messageId) {
    if (!messageId) return null;
    const data = await this.get(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
    const item = data?.data?.items?.[0] || data?.data?.message || data?.data?.item || data?.data;
    return item && typeof item === "object" ? item : null;
  }

  async downloadMessageResource(messageId, resource) {
    const type = resource.type === "image" ? "image" : "file";
    const baseName = safeName(resource.name || resource.key);
    const rawDest = path.join(config.grokCliCwd, "quoted", safeName(messageId), baseName);
    const resourcePath = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}?type=${encodeURIComponent(type)}`;
    try {
      const downloaded = await this.download(resourcePath, rawDest);
      const ext = path.extname(rawDest) || extFromContentType(downloaded.contentType, type === "image" ? ".jpg" : ".bin");
      if (!path.extname(rawDest) && ext) {
        const renamed = `${rawDest}${ext}`;
        fs.renameSync(rawDest, renamed);
        downloaded.path = renamed;
      }
      return { type, key: resource.key, path: downloaded.path, size: downloaded.size };
    } catch (error) {
      if (type !== "image") throw error;
      const fallbackDest = path.extname(rawDest) ? rawDest : `${rawDest}.jpg`;
      const downloaded = await this.download(`/open-apis/im/v1/images/${encodeURIComponent(resource.key)}`, fallbackDest);
      return { type, key: resource.key, path: downloaded.path, size: downloaded.size };
    }
  }

  async quotedContextFromMessage(message) {
    const firstQuoteId = quotedMessageId(message);
    if (!firstQuoteId) return null;

    const seen = new Set([message.message_id].filter(Boolean));
    const chain = [];
    const textParts = [];
    const files = [];
    let currentId = firstQuoteId;

    for (let depth = 0; currentId && depth < 3 && !seen.has(currentId); depth += 1) {
      seen.add(currentId);
      const entry = {
        messageId: currentId,
        messageType: "",
        textPreview: "",
        resourceCount: 0,
        fileCount: 0
      };
      chain.push(entry);

      const quoted = await this.getMessage(currentId);
      if (!quoted) {
        entry.error = "Quoted Feishu message was not found.";
        break;
      }

      const type = messageType(quoted);
      const text = extractMessageText(quoted);
      const resources = messageContentKeys(quoted);
      const filesBefore = files.filter((item) => item.path).length;
      entry.messageType = type;
      entry.textPreview = text.slice(0, 160);
      entry.resourceCount = resources.length;

      if (text) {
        textParts.push(`Quoted message ${depth + 1}${type ? ` (${type})` : ""}:\n${text}`);
      }

      for (const resource of resources) {
        try {
          const downloaded = await this.downloadMessageResource(currentId, resource);
          files.push({ ...downloaded, sourceMessageId: currentId });
        } catch (error) {
          files.push({ type: resource.type, key: resource.key, sourceMessageId: currentId, error: error.message });
        }
      }

      entry.fileCount = files.filter((item) => item.path).length - filesBefore;
      if (entry.fileCount > 0) break;

      const nextId = quotedMessageId(quoted);
      currentId = nextId && !seen.has(nextId) ? nextId : "";
    }

    return {
      messageId: firstQuoteId,
      messageType: chain[0]?.messageType || "",
      text: textParts.join("\n\n"),
      files,
      chain
    };
  }

  async uploadImage(filePath) {
    const resolved = path.resolve(filePath);
    if (!isSafeGrokImagePath(resolved)) {
      throw new Error(`Refusing to upload unsafe or missing image path: ${resolved}`);
    }
    const token = await this.tenantAccessToken();
    const buffer = fs.readFileSync(resolved);
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([buffer], { type: imageMimeType(resolved) }), path.basename(resolved));
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu image upload failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const imageKey = data?.data?.image_key || data?.image_key || "";
    if (!imageKey) throw new Error(`Feishu image upload did not return image_key: ${JSON.stringify(data).slice(0, 500)}`);
    return imageKey;
  }

  async uploadFile(filePath, fileType = "stream") {
    const resolved = path.resolve(filePath);
    if (!isSafeGrokVideoPath(resolved)) {
      throw new Error(`Refusing to upload unsafe or missing video path: ${resolved}`);
    }
    const token = await this.tenantAccessToken();
    const buffer = fs.readFileSync(resolved);
    const form = new FormData();
    form.append("file_type", fileType);
    form.append("file_name", path.basename(resolved));
    form.append("file", new Blob([buffer], { type: "application/octet-stream" }), path.basename(resolved));
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu file upload failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const fileKey = data?.data?.file_key || data?.file_key || "";
    if (!fileKey) throw new Error(`Feishu file upload did not return file_key: ${JSON.stringify(data).slice(0, 500)}`);
    return fileKey;
  }

  async replyImage(messageId, imageKey) {
    if (!messageId || !imageKey) return null;
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey })
    });
  }

  async replyMedia(messageId, fileKey, imageKey) {
    if (!messageId || !fileKey || !imageKey) return null;
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "media",
      content: JSON.stringify({ file_key: fileKey, image_key: imageKey })
    });
  }

  async replyFile(messageId, fileKey) {
    if (!messageId || !fileKey) return null;
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey })
    });
  }

  async replyLocalImages(messageId, imagePaths = []) {
    const sent = [];
    for (const imagePath of imagePaths) {
      const imageKey = await this.uploadImage(imagePath);
      await this.replyImage(messageId, imageKey);
      safeDeleteLocalFile(imagePath);
      sent.push({ imagePath, imageKey });
    }
    return sent;
  }

  async replyLocalVideos(messageId, videoPaths = []) {
    const sent = [];
    for (const videoPath of videoPaths) {
      const ext = path.extname(videoPath).toLowerCase();
      const fileKey = await this.uploadFile(videoPath, ext === ".mp4" ? "mp4" : "stream");
      if (ext === ".mp4") {
        const thumbnailKey = await this.uploadImage(ensureVideoThumbnail());
        await this.replyMedia(messageId, fileKey, thumbnailKey);
        safeDeleteLocalFile(videoPath);
        sent.push({ videoPath, fileKey, type: "media" });
      } else {
        await this.replyFile(messageId, fileKey);
        safeDeleteLocalFile(videoPath);
        sent.push({ videoPath, fileKey, type: "file" });
      }
    }
    return sent;
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
    if (!messageId) return;
    const chunks = splitForCard(text);
    let lastResponse = null;
    for (let index = 0; index < chunks.length; index += 1) {
      lastResponse = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "interactive",
        content: JSON.stringify(buildFeishuCard(chunks[index], title, {
          webSearch: /联网|检索|搜索/i.test(title),
          part: index + 1,
          total: chunks.length
        }))
      });
    }
    return lastResponse;
  }

  async createCardEntity(cardJson) {
    const data = await this.post("/open-apis/cardkit/v1/cards", {
      type: "card_json",
      data: JSON.stringify(cardJson)
    });
    const cardId = data?.data?.card_id || data?.card_id || "";
    if (!cardId) throw new Error(`Feishu CardKit did not return card_id: ${JSON.stringify(data).slice(0, 500)}`);
    return cardId;
  }

  async replyCardEntity(messageId, cardId) {
    if (!messageId || !cardId) return null;
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "interactive",
      content: JSON.stringify({
        type: "card",
        data: { card_id: cardId }
      })
    });
  }

  async replyStreamingCard(messageId, initialText, title = "Grok 回复", options = {}) {
    const cardId = await this.createCardEntity(buildStreamingCard(initialText, title, options));
    const response = await this.replyCardEntity(messageId, cardId);
    return { cardId, response };
  }

  async streamCardText(cardId, elementId, content, sequence) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`, {
      uuid: crypto.randomUUID(),
      content,
      sequence
    }, "PUT");
  }

  async updateCardSettings(cardId, settings, sequence) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
      settings: JSON.stringify(settings),
      uuid: crypto.randomUUID(),
      sequence
    }, "PATCH");
  }

  async updateCard(cardId, cardJson, sequence) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
      card: {
        type: "card_json",
        data: JSON.stringify(cardJson)
      },
      uuid: crypto.randomUUID(),
      sequence
    }, "PUT");
  }

  async addCardElements(cardId, elements, { type = "insert_after", targetElementId = STREAM_ANSWER_ELEMENT_ID, sequence } = {}) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements`, {
      type,
      target_element_id: targetElementId,
      uuid: crypto.randomUUID(),
      sequence,
      elements: JSON.stringify(elements)
    });
  }

  async patchCard(messageId, text, title = "Grok 回复", options = {}) {
    if (!messageId) return;
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: JSON.stringify(buildFeishuCard(text, title, options))
    }, "PATCH");
  }
}

function feishuMessageId(response = {}) {
  return response?.data?.message_id || response?.message_id || response?.data?.message?.message_id || "";
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
    grokCliEnabled: config.grokCliEnabled,
    grokCliCwd: config.grokCliCwd,
    grokCliCommand: config.grokCliCommand,
    grokCliCommandExists: config.grokCliCommand.includes(path.sep) ? fs.existsSync(config.grokCliCommand) : null,
    grokCliCommandExecutable: config.grokCliCommand.includes(path.sep) ? isExecutable(config.grokCliCommand) : null,
    model: "grok-cli",
    videoModel: config.videoModel,
    videoMaxTurns: config.videoMaxTurns,
    cardMode: "feishu-cardkit-streaming-json-2.0",
    webSearchMode: "grok-cli"
  });
});

app.get("/debug/grok-config", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    ok: true,
    mediaMaxTurns: config.mediaMaxTurns,
    videoMaxTurns: config.videoMaxTurns,
    videoModel: config.videoModel,
    configuredArgs: grokCliArgs("{{prompt}}"),
    mediaConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.mediaMaxTurns }),
    videoConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.videoMaxTurns, model: config.videoModel })
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

app.get("/debug/grok-probe", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const prompt = String(req.query.prompt || "用一句中文回答：probe").slice(0, 500);
    const timeoutMs = Math.min(envNumber("DEBUG_PROBE_TIMEOUT_MS", 60000), 90000);
    const result = await probeGrokCli(prompt, timeoutMs);
    res.status(result.ok ? 200 : 504).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-tui-probe", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const input = String(req.query.input || "/help").slice(0, 500);
    const timeoutMs = Math.min(Number(req.query.timeoutMs || 12000) || 12000, 30000);
    const result = await probeGrokTui(input, timeoutMs);
    res.status(result.ok ? 200 : 504).json(result);
  } catch (error) {
    res.status(/timed out/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-diagnostics", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    res.json({ ok: true, diagnostics: await grokDiagnostics() });
  } catch (error) {
    res.status(500).json({ ok: false, error: redactSensitive(error.message) });
  }
});

app.get("/debug/cardkit-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const cardId = await feishu.createCardEntity(buildStreamingCard("", "CardKit 流式协议自检", {
      webSearch: true,
      status: "服务端自检：创建卡片实体"
    }));
    await feishu.streamCardText(cardId, STREAM_ANSWER_ELEMENT_ID, " CardKit 流式文本接口自检通过。", 1);
    await feishu.updateCardSettings(cardId, {
      config: {
        streaming_mode: false,
        summary: { content: "CardKit 自检通过" }
      }
    }, 2);
    res.json({ ok: true, cardId, cardMode: "cardkit-json-2.0-streaming" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/media-upload-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const imageKey = await feishu.uploadImage(ensureVideoThumbnail());
    res.json({
      ok: true,
      uploaded: true,
      imageKeyPrefix: imageKey.slice(0, 8),
      sentToChat: false
    });
  } catch (error) {
    res.status(/timed out/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-media-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const prompt = String(req.query.prompt || "生成一张简单的蓝色圆形测试图。必须返回真实图片文件路径，不要只描述。").slice(0, 500);
    const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs || 180000) || 180000, 60000), 240000);
    const task = classifyTask(prompt);
    const answer = task.kind === "video"
      ? await callGrokImagineVideo(prompt, { maxTurns: task.maxTurns, mediaTask: true, taskRules: task.rules, timeoutMs })
      : await callGrokCli(prompt, { maxTurns: task.maxTurns || config.mediaMaxTurns, mediaTask: true, taskRules: task.rules, timeoutMs });
    const imagePaths = extractLocalImagePaths(answer);
    const videoPaths = extractLocalVideoPaths(answer);
    const uploadedImages = [];
    const uploadedVideos = [];
    for (const imagePath of imagePaths) {
      const imageKey = await feishu.uploadImage(imagePath);
      uploadedImages.push({ name: path.basename(imagePath), imageKeyPrefix: imageKey.slice(0, 8) });
    }
    for (const videoPath of videoPaths) {
      const fileKey = await feishu.uploadFile(videoPath, path.extname(videoPath).toLowerCase() === ".mp4" ? "mp4" : "stream");
      uploadedVideos.push({ name: path.basename(videoPath), fileKeyPrefix: fileKey.slice(0, 8) });
    }
    res.json({
      ok: true,
      sentToChat: false,
      textPreview: stripLocalMediaPaths(answer).slice(0, 300),
      taskKind: task.kind,
      timeoutMs,
      foundImages: imagePaths.length,
      foundVideos: videoPaths.length,
      uploadedImages,
      uploadedVideos
    });
  } catch (error) {
    res.status(/timed out/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
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
  const task = classifyTask(prompt);
  const quotedContext = await feishu.quotedContextFromMessage(message);
  const quotedTempFiles = quotedContext?.files?.map((item) => item.path).filter(Boolean) || [];

  const job = {
    id: messageId,
    promptPreview: prompt.slice(0, 120),
    status: "running",
    taskKind: task.kind,
    webSearch: task.webSearch,
    mediaTask: task.mediaTask,
    quotedMessageId: quotedContext?.messageId || "",
    quotedFileCount: quotedContext?.files?.filter((item) => item.path).length || 0,
    quotedChain: quotedContext?.chain || [],
    startedAt: new Date().toISOString()
  };
  jobs.set(messageId, job);

  const title = task.title;
  let updater = null;
  try {
    const streamingCard = await feishu.replyStreamingCard(
      messageId,
      "",
      title,
      {
        webSearch: job.webSearch,
        status: job.webSearch ? "正在联网搜索并等待 Grok CLI 返回正文" : "正在等待 Grok CLI 返回正文"
      }
    );
    job.cardId = streamingCard.cardId;
    job.replyMessageId = feishuMessageId(streamingCard.response);
    updater = createCardKitStreamingUpdater({
      feishu,
      cardId: streamingCard.cardId,
      title,
      webSearch: job.webSearch
    });
    const grokOptions = {
      maxTurns: task.maxTurns,
      quotedContext,
      mediaTask: task.mediaTask,
      taskRules: task.rules,
      onText: (fullText) => {
        updater.patchAnswer(stripLocalMediaPaths(fullText) || "媒体生成中，正在等待 Grok 返回真实文件。");
      },
      onEvent: (event) => {
        const status = describeGrokEvent(event);
        if (status) {
          job.lastEvent = event.type || "";
          updater.patchStatus(status);
        }
      }
    };
    const answer = task.kind === "video"
      ? await callGrokImagineVideo(prompt, grokOptions)
      : await callGrokCli(prompt, grokOptions);
    const imagePaths = extractLocalImagePaths(answer);
    const videoPaths = extractLocalVideoPaths(answer);
    const answerWithoutMediaPaths = stripLocalMediaPaths(answer);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    if (imagePaths.length || videoPaths.length) {
      await updater.patchAnswer(answerWithoutMediaPaths || "媒体已生成，正在上传到飞书。", true);
      const sentImages = await feishu.replyLocalImages(messageId, imagePaths);
      const sentVideos = await feishu.replyLocalVideos(messageId, videoPaths);
      job.imageCount = sentImages.length;
      job.videoCount = sentVideos.length;
      const sentSummary = [
        sentImages.length ? `${sentImages.length} 张图片` : "",
        sentVideos.length ? `${sentVideos.length} 个视频` : ""
      ].filter(Boolean).join("、");
      const finalText = answerWithoutMediaPaths
        ? `${answerWithoutMediaPaths}\n\n已发送 ${sentSummary}。`
        : `媒体已生成，已发送 ${sentSummary}。`;
      await updater.patchAnswer(finalText, true);
    } else {
      await updater.patchAnswer(answer, true);
    }
    await updater.finish();
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    const failure = [
      "这次没有拿到 Grok 的最终回答，但我不会停在“正在检索”。",
      "",
      `原因：${error.message}`,
      "",
      "这不是正常答案，我会把它作为需要修复的运行错误暴露出来，而不是降级成普通文本。"
    ].join("\n");
    if (updater) {
      await updater.fail(failure);
    } else {
      await feishu.replyRich(messageId, failure, "Grok 运行错误");
    }
  } finally {
    safeDeleteLocalFiles(quotedTempFiles);
  }
}

app.listen(config.port, "0.0.0.0", () => {
  console.log(`${config.serviceName} listening on 0.0.0.0:${config.port}`);
});
