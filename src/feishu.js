import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractImageGenerationIntent } from "./image-intent.js";
import { buildSearchCard, buildWorldCupPollResultCard, inferSearchFreshness, searchKindFromText } from "./feishu-card-templates.js";
import { buildPremiumPollCard, buildPremiumSearchCard, renderPremiumSearchCardImage } from "./feishu-premium-card-renderer.js";
import { buildSystemPrompt } from "./persona.js";
import {
  DEFAULT_FEISHU_ARTICLE_GROUP_CHAT_ID,
  DEFAULT_FEISHU_ARTICLE_GROUP_INVITE_TEXT,
  FeishuWorkspaceClient
} from "./feishu-workspace.js";
import { isProjectCreateRequest, ProjectEngine } from "./project-engine.js";
import { logEvent } from "./runtime-log.js";
import { convertAudioToOpus, convertWavToOpus } from "./tts-client.js";
import { detectImageMimeType, getReplyDeliveryPreference, redactSensitive, removeGeneratedSpeechArtifacts, splitChatBubbles, stripLeadingSelfName, truncate } from "./utils.js";
import { WeChatPublisher } from "./wechat-publisher.js";

const execFileAsync = promisify(execFile);
const YOUTUBE_ARTICLE_PART_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const imageNounPattern = /(图|图片|图像|配图|攻略图|信息图|流程图|海报|封面|头像|壁纸|插画|漫画|表情包|infographic|poster|cover|wallpaper)$/i;
const selfieKeywords = /(自拍|自拍照|照片|相片|发张照|发一张照|发张照片|发一张照片|看看你|你长什么样|你的样子|小椰的样子|小椰照片|小椰自拍)/i;

function platformId(id = "") {
  return `feishu:${String(id || "")}`;
}

function normalizeReplyIdentity(value = "") {
  return String(value || "")
    .trim()
    .replace(/^feishu:/i, "")
    .replace(/^用户\s*/i, "")
    .toLowerCase();
}

function uniqueReplyIdentities(values = []) {
  return [...new Set(values.map(normalizeReplyIdentity).filter(Boolean))];
}

function parseContent(content = "") {
  if (!content) return {};
  if (typeof content === "object") return content;
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function normalizeFeishuMessageResponse(data = {}) {
  const root = data?.data || data || {};
  if (Array.isArray(root.items) && root.items[0]) return root.items[0];
  if (root.message) return root.message;
  if (root.item) return root.item;
  if (root.message_info) return root.message_info;
  if (Array.isArray(data?.items) && data.items[0]) return data.items[0];
  return data?.message || data?.item || data?.message_info || {};
}

function feishuMessageType(message = {}) {
  return message.message_type || message.msg_type || message.type || message.body?.message_type || message.body?.msg_type || "";
}

function feishuMessageContent(message = {}) {
  return parseContent(
    message.content ??
    message.body?.content ??
    message.message?.content ??
    message.item?.content ??
    message.message_info?.content ??
    ""
  );
}

function stripAtTags(text = "") {
  return String(text || "")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "")
    .replace(/@_user_\d+/g, "")
    .trim();
}

function flattenPostContent(content = {}) {
  const root =
    content?.zh_cn?.content ||
    content?.content ||
    content?.en_us?.content ||
    content?.ja_jp?.content ||
    [];
  const lines = Array.isArray(root) ? root : [];
  return lines
    .map((line) => {
      const nodes = Array.isArray(line) ? line : [line];
      return nodes.map((node) => {
        if (!node || typeof node !== "object") return "";
        if (node.tag === "at") {
          const name = node.user_name || node.name || node.text || node.user_id || "";
          return name ? `@${normalizeMentionName(name)}` : "";
        }
        return node.text || node.name || "";
      }).join("");
    })
    .join("\n")
    .trim();
}

function extractPostLinks(content = {}) {
  const root =
    content?.zh_cn?.content ||
    content?.content ||
    content?.en_us?.content ||
    content?.ja_jp?.content ||
    [];
  const links = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const href = node.href || node.url || node.link || node.link_url;
    if (href) links.push(String(href));
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return links;
}

function extractUrls(text = "") {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'`）)】\]]+/gi) || [];
  return matches.map((url) => url.replace(/[.,!?;:，。！？；：]+$/g, ""));
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function pickFirstString(values = []) {
  return values.map((item) => String(item || "").trim()).find(Boolean) || "";
}

function collectIdsDeep(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectIdsDeep(item, output);
    return output;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (raw && typeof raw === "object") {
      collectIdsDeep(raw, output);
      continue;
    }
    if (/(?:open_id|user_id|union_id)$/i.test(key)) {
      const text = String(raw || "").trim();
      if (text) output.push(text);
    }
  }
  return output;
}

function extractStringsDeep(value, output = []) {
  if (value == null) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractStringsDeep(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) extractStringsDeep(item, output);
  }
  return output;
}

function flattenGenericContent(content = {}) {
  const priority = [
    content.text,
    content.title,
    content.name,
    content.file_name,
    content.description,
    content.summary,
    content.url,
    content.href
  ];
  const strings = uniqueStrings([
    ...priority,
    ...extractStringsDeep(content).filter((item) => item.length <= 500)
  ]);
  return strings.slice(0, 20).join("\n").trim();
}

function extractFeishuDocxIdsDeep(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) extractFeishuDocxIdsDeep(item, output);
    return output;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (raw && typeof raw === "object") {
      extractFeishuDocxIdsDeep(raw, output);
      continue;
    }
    const text = String(raw || "").trim();
    if (!text) continue;
    const fromUrl = extractFeishuDocxId(text);
    if (fromUrl) output.push(fromUrl);
    if (/docx|document/i.test(key) && /^[A-Za-z0-9]{8,}$/.test(text)) {
      output.push(text);
    }
  }
  return output;
}

function extractFeishuWikiTokensDeep(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) extractFeishuWikiTokensDeep(item, output);
    return output;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (raw && typeof raw === "object") {
      extractFeishuWikiTokensDeep(raw, output);
      continue;
    }
    const text = String(raw || "").trim();
    if (!text) continue;
    const fromUrl = extractFeishuWikiToken(text);
    if (fromUrl) output.push(fromUrl);
    if (/wiki/i.test(key) && /^[A-Za-z0-9]{8,}$/.test(text)) {
      output.push(text);
    }
  }
  return output;
}

function isFeishuHost(hostname = "") {
  return /(^|\.)((feishu|larksuite)\.cn|feishu\.com|larksuite\.com|larkoffice\.com)$/i.test(String(hostname || ""));
}

function extractFeishuDocxId(url = "") {
  try {
    const parsed = new URL(url);
    if (!isFeishuHost(parsed.hostname)) return "";
    const match = parsed.pathname.match(/\/docx\/([A-Za-z0-9]+)/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function extractFeishuWikiToken(url = "") {
  try {
    const parsed = new URL(url);
    if (!isFeishuHost(parsed.hostname)) return "";
    const match = parsed.pathname.match(/\/wiki\/([A-Za-z0-9]+)/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function isFeishuDocCandidate(url = "") {
  return (
    /^feishu-docx:/i.test(String(url || "")) ||
    /^feishu-wiki:/i.test(String(url || "")) ||
    Boolean(extractFeishuDocxId(url)) ||
    Boolean(extractFeishuWikiToken(url))
  );
}

function isLikelyBinaryUrl(url = "") {
  try {
    const parsed = new URL(url);
    return /\.(?:avif|bmp|gif|ico|jpe?g|mp3|mp4|ogg|opus|png|svg|webm|webp|wav)(?:$|[?#])/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeLinkCandidates(values = []) {
  return uniqueStrings(values)
    .filter((url) => /^https?:\/\//i.test(url) || /^feishu-(?:docx|wiki):/i.test(url))
    .filter((url) => isFeishuDocCandidate(url) || !isLikelyBinaryUrl(url))
    .sort((a, b) => Number(isFeishuDocCandidate(b)) - Number(isFeishuDocCandidate(a)));
}

function linkLogLabel(url = "") {
  if (/^feishu-docx:/i.test(url)) return "feishu-docx";
  if (/^feishu-wiki:/i.test(url)) return "feishu-wiki";
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.slice(0, 160);
  } catch {
    return "unknown";
  }
}

function isPrivateLikeHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::1"
  );
}

function htmlToReadableText(html = "") {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeLongFormReadingRequest(text = "") {
  return /(文档|文章|链接|网页|内容|学习|总结|精华|重点|亮点|怎么玩|怎么做|玩法|规则|细则|策划|方案|文字发我|转文字|摘要|概括|整理|分析|评价)/i.test(String(text || ""));
}

function looksLikeContextReferenceRequest(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  return (
    /(这个|这条|这篇|这份|这段|上面|上边|刚才|引用|原文|资料|内容|文档|文章|链接|帖子|截图|长图)/i.test(value) &&
    /(看看|看下|看一下|读一下|阅读|总结|整理|概括|提炼|复盘|分析|评价|提取|精华|重点|亮点|文字发我|转文字)/i.test(value)
  );
}

function looksLikeHardWebSearchIntent(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  return (
    /^\/(?:search|web|news|weather|worldcup|wc)\b/i.test(value) ||
    /(搜一下|搜下|搜搜看|搜索|查一下|查下|查查看|查询|联网查|联网搜|网上搜|百度一下)/i.test(value) ||
    /(?:天气|气温|温度|下雨|降雨|空气质量|AQI|台风|暴雨|预报).*(?:今天|今日|明天|现在|本周|周末|多少|会不会|适合)/i.test(value) ||
    /(?:价格|行情|报价|金价|黄金|白银|汇率|股价|股票|指数|油价|利率|CPI|PPI|BTC|USDT|比特币|人民币|美元)/i.test(value) ||
    /(?:世界杯|FIFA|World Cup|worldcup|足球).*(?:赛程|对阵|比分|积分|预测|胜率|投票|支持|谁赢)/i.test(value) ||
    /github.*(?:热榜|热门|趋势|trending|榜单|排行|仓库|repo|repository|开源项目)/i.test(value) ||
    /^(?:最新|今天|今日|现在|近期|最近)[\s\S]{2,}(?:新闻|消息|进展|动态|政策|情况|热搜|榜单|发布|更新)/i.test(value)
  );
}

function cleanMarkdownInline(text = "") {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .trim();
}

function formatFeishuPlainText(text = "") {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let headingIndex = 0;

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) {
      if (output.length && output[output.length - 1] !== "") output.push("");
      continue;
    }
    if (/^```/.test(line)) continue;

    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      headingIndex += 1;
      const icon = headingIndex === 1 ? "📌" : headingIndex === 2 ? "🎯" : headingIndex === 3 ? "🧩" : "🔹";
      output.push(`${icon} ${cleanMarkdownInline(heading[1])}`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      output.push(`• ${cleanMarkdownInline(bullet[1])}`);
      continue;
    }

    const numbered = line.match(/^(\d+)[.)、]\s+(.+)$/);
    if (numbered) {
      output.push(`${numbered[1]}. ${cleanMarkdownInline(numbered[2])}`);
      continue;
    }

    output.push(cleanMarkdownInline(line));
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shouldTryFallbackImagePrompt(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/^(?:\/draw|\/image|\/imagine|画图|生图|生成图片|生成图像)/i.test(raw)) return true;
  const match = raw.match(/^(?:请|帮我|麻烦你|给我|你)?\s*(?:生成|做|制作|设计|画|出|来)\s*(?:一张|一个|一份|个|张)?\s*(.+)$/i);
  if (!match) return false;
  const prompt = String(match[1] || "").replace(/[？?！!。.\s]+$/g, "");
  return imageNounPattern.test(prompt);
}

function isUsableBotName(name = "") {
  const value = String(name || "").trim();
  return Boolean(value && !/^[?\uFFFD]+$/.test(value) && /[\p{L}\p{N}]/u.test(value));
}

function normalizeMentionName(value = "") {
  return String(value || "").replace(/^@+/, "").trim();
}

function isValidMentionId(value = "") {
  return Boolean(String(value || "").trim());
}

function cardText(value = "", max = 600) {
  return truncate(String(value || "").replace(/[<>{}]/g, "").replace(/\s+/g, " ").trim(), max);
}

function cardMarkdown(value = "", max = 1200) {
  return truncate(
    String(value || "")
      .replace(/[<>{}]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    max
  );
}

function compactLines(lines = []) {
  return lines.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
}

const GENERATION_FIRST_PRINCIPLES = [
  "Generation contract: get the direction right before writing. Do not produce low-quality draft content and rely on later rejection or cleanup.",
  "Plan from evidence first: identify the reader goal, topic boundary, concrete source anchors, time context, and required structure before generating prose.",
  "The model fills bounded content fields; code owns layout, section order, metadata placement, source links, and final rendering.",
  "Every generated JSON string must be final reader-facing article content, never a promise about what the assistant will do next.",
  "Never output internal process notes, generic template filler, placeholder failure text, repeated metadata, unsupported HTML, or database-style fields as reader content.",
  "If evidence is insufficient for a claim, write a bounded uncertainty or next research task instead of inventing confident prose."
];

function generationFirstPrinciplesText() {
  return GENERATION_FIRST_PRINCIPLES.join(" ");
}

function elapsedMsSince(startedAt = 0) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function formatShortDuration(ms = 0) {
  const value = Math.max(0, Math.round(Number(ms || 0)));
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function formatYoutubeDiagnosticsLine(report = {}, doc = {}, deliveryMs = 0) {
  const timing = report.diagnostics || {};
  const parts = [
    timing.candidateMs ? `候选 ${formatShortDuration(timing.candidateMs)}` : "",
    timing.transcriptMs ? `字幕 ${formatShortDuration(timing.transcriptMs)}` : "",
    timing.aiMs ? `AI ${formatShortDuration(timing.aiMs)}` : "",
    doc.diagnostics?.documentMs ? `飞书 ${formatShortDuration(doc.diagnostics.documentMs)}` : "",
    deliveryMs ? `发卡 ${formatShortDuration(deliveryMs)}` : "",
    timing.totalMs ? `总计 ${formatShortDuration((timing.totalMs || 0) + (doc.diagnostics?.documentMs || 0) + (deliveryMs || 0))}` : ""
  ].filter(Boolean);
  return parts.length ? `耗时诊断：${parts.join(" / ")}` : "";
}

function uniqueCardItems(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function sourceLabel(item = {}) {
  return cardText([item.siteName, item.publishedAt].filter(Boolean).join(" | "), 140);
}

function summaryBullets(text = "", limit = 4) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines.slice(0, limit).map((line) => cardText(line, 170));
  return raw
    .split(/[。！？!?]\s*/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => cardText(line, 170));
}

function cardActionButtons(results = [], limit = 3) {
  return results
    .filter((item) => /^https?:\/\//i.test(item.url))
    .slice(0, limit)
    .map((item, index) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content: `\u6765\u6e90 ${item.index || index + 1}`
      },
      type: index === 0 ? "primary" : "default",
      url: item.url
    }));
}

function extractYouTubeUrl(text = "") {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"'）)]+/gi) || [];
  return urls.find((url) => extractYouTubeReference(url).kind) || "";
}

function extractYouTubeReference(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return { kind: "", url: "", value: "" };
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id)
        ? { kind: "video", url: raw, value: id }
        : { kind: "", url: raw, value: "" };
    }
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) {
      return { kind: "", url: raw, value: "" };
    }
    const directId = url.searchParams.get("v") || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(directId)) {
      return { kind: "video", url: raw, value: directId };
    }
    const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]{11})(?:\/|$)/i);
    if (pathMatch) {
      return { kind: "video", url: raw, value: pathMatch[1] };
    }
    const playlistId = url.searchParams.get("list") || "";
    if (/^[a-zA-Z0-9_-]{10,}$/.test(playlistId) && /^\/(?:playlist)?\/?$/i.test(url.pathname)) {
      return { kind: "playlist", url: raw, value: playlistId };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const first = parts[0] || "";
    if (/^@[A-Za-z0-9._-]{2,}$/.test(first)) {
      return { kind: "channel", url: raw, value: first };
    }
    if (/^(?:channel|c|user)$/i.test(first) && parts[1]) {
      return { kind: "channel", url: raw, value: `${first}/${parts[1]}` };
    }
  } catch {
    return { kind: "", url: raw, value: "" };
  }
  return { kind: "", url: raw, value: "" };
}

function extractYouTubeVideoIdFromUrl(value = "") {
  const reference = extractYouTubeReference(value);
  return reference.kind === "video" ? reference.value : "";
}

function safeMarkdownValue(value = "") {
  return String(value || "").replace(/\r?\n/g, " ").replace(/"/g, '\\"').trim();
}

function slugifyNoteName(value = "") {
  const ascii = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return ascii || `youtube-${Date.now()}`;
}

function tagifyTopic(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .slice(0, 60);
}

function inferYoutubeTopic(text = "", fallback = "YouTube") {
  const value = String(text || "");
  const cnTopicMatch = value.match(/\u5173\u4e8e\s*([a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff\s-]{1,60}?)(?:\u7684)?(?:\u89c6\u9891|\u5185\u5bb9|\u6280\u672f|\u8bdd\u9898|$)/i);
  if (cnTopicMatch) return cnTopicMatch[1].trim().replace(/[，。,.!?！？:：].*$/, "") || fallback;
  const topicMatch = value.match(/(?:about|regarding|topic)\s+([a-zA-Z0-9][a-zA-Z0-9\s-]{1,60})/i);
  if (topicMatch) return topicMatch[1].trim().replace(/[，。,.!?！？:：].*$/, "") || fallback;
  if (/spacex|space x|starship|falcon\s?9|falcon heavy|super heavy/i.test(value)) return "SpaceX";
  return fallback;
}

function parseSmallCount(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const cn = {
    "\u4e00": 1,
    "\u4e8c": 2,
    "\u4e24": 2,
    "\u4e09": 3,
    "\u56db": 4,
    "\u4e94": 5
  };
  if (cn[text]) return cn[text];
  const match = text.match(/^\d+$/);
  if (!match) return 0;
  const count = Number(text);
  return Number.isInteger(count) ? count : 0;
}

function extractRequestedYoutubeVideoCount(text = "") {
  const value = String(text || "");
  const patterns = [
    /\btop\s*([1-5])\b/i,
    /(?:\u524d|top)\s*([1-5\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94])\s*(?:\u4e2a|\u6761|\u90e8)?/i,
    /([1-5\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94])\s*(?:\u4e2a|\u6761|\u90e8)\s*(?:youtube\s*)?(?:\u89c6\u9891|\u5f71\u7247)/i,
    /(?:\u641c|\u627e|\u641c\u7d22|\u6574\u7406|\u603b\u7ed3)[^\n]{0,16}?([1-5\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94])\s*(?:\u4e2a|\u6761|\u90e8)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const count = parseSmallCount(match[1]);
    if (count >= 1 && count <= 5) return count;
  }
  return 0;
}

function normalizeTopicForMatch(value = "") {
  return String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
}

function contentMentionsTopic(content = "", topic = "") {
  const cleanTopic = normalizeTopicForMatch(topic);
  if (!cleanTopic || cleanTopic === "youtube") return false;
  return normalizeTopicForMatch(content).includes(cleanTopic);
}

function isWeakYoutubeTopic(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return !text || /^(?:this|it|a|an|ai|tech|technology|youtube|video|summary|note|notes|技术|科技|视频|总结|笔记)$/.test(text);
}

function isWeakYoutubeTitle(value = "", topic = "") {
  const text = String(value || "").trim();
  if (!text) return true;
  const normalized = normalizeTopicForMatch(text.replace(/youtube\s*技术笔记/ig, "").replace(/技术笔记/g, ""));
  return normalized.length <= 3 ||
    normalized === normalizeTopicForMatch(topic) ||
    isWeakYoutubeTopic(normalized) ||
    /youtube\s*技术笔记/i.test(text) ||
    /技术笔记$/i.test(text);
}

function cleanYoutubeDocumentTitle(value = "") {
  return String(value || "")
    .replace(/\s*YouTube\s*技术笔记\s*$/i, "")
    .replace(/\s*技术笔记\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksMostlyEnglish(value = "") {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text) return false;
  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return asciiLetters > chinese * 2 && asciiLetters > 8;
}

function youtubeTitleFallback(report = {}) {
  const first = report.videos?.[0] || {};
  const raw = `${first.title || ""} ${report.title || ""} ${report.topic || ""}`;
  if (/spacex|starfactory|starship|elon|musk/i.test(raw)) {
    return "星舰工厂里的马斯克赌局：SpaceX 想把火箭变成流水线产品";
  }
  if (/viking|ragnar|berserker|valhalla|norse|norman/i.test(raw)) {
    return "维京时代的真实动力：长船、恐惧与宗教叙事如何改写欧洲";
  }
  const firstVideoTitle = cleanYoutubeDocumentTitle(first.title || "");
  const keywords = extractYoutubeQuestionKeywords(raw, 3);
  const focus = keywords.length ? keywords.join("、") : cleanYoutubeDocumentTitle(report.topic || firstVideoTitle || "这条视频");
  return `${focus}深度解读：这条视频真正回答了什么`;
}

function formatSeconds(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function compactTranscriptSegments(segments = [], maxChars = 60000) {
  const lines = [];
  let chars = 0;
  for (const segment of segments) {
    const line = segment.start
      ? `[${formatSeconds(segment.start)}] ${segment.text}`
      : segment.text;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

function transcriptIndexLines(transcriptText = "") {
  return String(transcriptText || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => /^\[\d+:\d{2}(?::\d{2})?\]\s+\S/.test(line));
}

function buildTranscriptExcerptBlock(video = {}, index = 0) {
  const transcript = String(video.transcriptText || "").trim();
  if (!transcript) return "";
  const title = cleanYoutubeDocumentTitle(video.title || `视频 ${index + 1}`) || `视频 ${index + 1}`;
  const allLines = transcriptIndexLines(transcript);
  const lines = allLines
    .map((line) => line.replace(/```/g, "'''"));
  if (!lines.length) return "";
  return compactLines([
    `### ${index + 1}. ${title}｜原文索引`,
    "> 下方保留完整时间戳原文索引，用来按时间点核对正文判断。",
    "```text",
    lines.join("\n"),
    "```"
  ]);
}

function youtubeDocSectionKey(heading = "") {
  const text = String(heading || "")
    .replace(/^#+\s*/, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, "")
    .replace(/^\d+[.)、.．]\s*/, "")
    .trim();
  if (!text) return "";
  if (/^(?:阅读摘要|来源视频|阅读导航|本文来源)$/i.test(text)) return "skip";
  if (/背景|导读|阅读门槛|术语|上下文|拍摄|访问背景|访谈背景|市场\/技术环境|市场环境|技术环境|为什么.*值得|为什么.*重要|先理解|新手|小白|术语解释/.test(text)) return "background";
  if (/精华总结|核心观点|一句话|金句|反共识|结论/.test(text)) return "summary";
  if (/关键技术|技术点|速览|技术概览/.test(text)) return "tech";
  if (/详细技术|技术拆解|深度拆解|拆解/.test(text)) return "detail";
  if (/时间线|逐字稿摘要|时间轴/.test(text)) return "timeline";
  if (/追问|问题|下一步/.test(text)) return "questions";
  if (/出处|链接|来源|参考/.test(text)) return "sources";
  return "";
}

function isLowValueYoutubeMetadataLine(line = "") {
  const text = String(line || "").trim();
  if (!text) return false;
  if (/^(?:#{1,6}\s*)?(?:[-*]\s*)?.*YouTube\s*技术笔记\s*$/i.test(text)) return true;
  if (/^(?:#{1,6}\s*)?(?:[-*]\s*)?.*技术笔记\s*$/i.test(text) && looksMostlyEnglish(text)) return true;
  if (/^我先按|^接下来我会|^下面我会|^我会把|^先按你给的|^根据你给的时间戳|^我先根据/.test(text)) return true;
  if (/真正值得读的，不是某个孤立知识点|背后的产业判断、工程取舍和商业后果|重点不是记住每个参数|解决了什么瓶颈、牺牲了什么、为什么现在值得讨论|具体判断以后文的字幕证据为准/.test(text)) return true;
  if (/^#{1,6}\s*完整字幕逐字稿/.test(text)) return true;
  if (/这篇文档由小椰根据视频字幕整理|阅读导航|这部分没有生成到有效内容|需要重新跑一次|当前摘要没有返回可靠时间线/.test(text)) return true;
  if (/^<\/?details|^<summary|^```/.test(text)) return true;
  if (/^>\s*(?:主题聚合|来源类型)[：:]/.test(text)) return true;
  if (/^\s*[-*]\s*\*\*(?:主题|视频数量|整理时间|输出语言(?:与形式)?|内容形态|字幕|原始语言|说明|关联链接|来源链接|频道|链接)[：:]?\*\*[：:]?/.test(text)) return true;
  if (/^\s*[-*]\s*(?:主题|视频数量|整理时间|输出语言(?:与形式)?|内容形态|字幕|原始语言|说明|关联链接|来源链接|频道|链接)[：:]/.test(text)) return true;
  if (/^(?:主题|视频数量|整理时间|输出语言(?:与形式)?|内容形态|字幕|原始语言|说明|关联链接|来源链接|频道|链接)[：:]/.test(text)) return true;
  return false;
}

function stripLowValueYoutubeMetadataLines(markdown = "") {
  const lines = [];
  let inFence = false;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    if (inFence || !isLowValueYoutubeMetadataLine(line)) lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripYoutubeProcessPreamble(markdown = "") {
  const text = String(markdown || "").trim();
  if (!text) return "";
  const firstTitle = text.search(/^#\s+/m);
  if (firstTitle > 0 && /我先按|接下来我会|我会把|时间戳骨架|整理成中文|可直接进\s*(?:Obsidian|飞书)/.test(text.slice(0, firstTitle))) {
    return text.slice(firstTitle).trim();
  }
  return text;
}

function hasMeaningfulYoutubeSection(value = "") {
  const text = stripLowValueYoutubeMetadataLines(value)
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/^[-*]\s*/gm, "")
    .trim();
  return text.length >= 12;
}

function collectYoutubeDocSections(markdown = "") {
  const sections = {
    background: [],
    summary: [],
    tech: [],
    detail: [],
    timeline: [],
    questions: [],
    other: []
  };
  let current = "summary";
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) {
      const key = youtubeDocSectionKey(heading[2]);
      if (key || heading[1] === "##") {
        current = key === "skip" || key === "sources" ? "skip" : key || "other";
      }
      continue;
    }
    if (current === "skip") continue;
    sections[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(sections).map(([key, lines]) => [key, stripLowValueYoutubeMetadataLines(lines.join("\n"))])
  );
}

function dropOpeningSubtitles(markdown = "") {
  return String(markdown || "")
    .split(/\r?\n/)
    .filter((line) => {
      const heading = line.match(/^#{3,6}\s+(.+)$/);
      if (!heading) return true;
      const title = heading[1].trim();
      if (/YouTube\s*技术笔记|技术笔记$/i.test(title)) return false;
      if (looksMostlyEnglish(title) && !/^(?:\d+[.)、.．]\s*)?(?:关键术语解释|一句话结论|核心观点|标志性金句|最反共识的判断)$/i.test(title)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function buildYoutubeBackgroundFallback(report = {}) {
  const videos = report.videos || [];
  const first = videos[0] || {};
  const title = cleanYoutubeDocumentTitle(first.title || report.title || report.topic || "这条视频");
  const channel = first.channel ? `，来自 ${first.channel}` : "";
  const raw = `${title} ${report.topic || ""}`;
  if (/spacex|starfactory|starship|elon|musk/i.test(raw)) {
    return compactLines([
      "**这条视频真正值得看的**，不是马斯克又带人参观了一次工厂，而是 SpaceX 正在把星舰从一次性工程项目推向可重复制造、可快速复用的工业系统。",
      "",
      "拍摄场景发生在 Starbase/Starfactory 一线，镜头里出现的不是单个炫技零件，而是 Starship 船体、Super Heavy 助推器、猛禽发动机、热防护、塔架回收和产线节拍如何被揉成同一个问题：火箭能不能像飞机或汽车一样进入连续制造和连续使用。",
      "",
      "### 关键术语解释",
      "- **Starship / 星舰：** SpaceX 的超重型运载系统中的上面级飞船。",
      "- **Super Heavy / 超重型助推器：** 星舰系统的一级助推器，负责把飞船推到接近入轨条件后返回发射场。",
      "- **全复用：** 助推器和飞船都能快速返回、检查、再次飞行，目标是接近飞机或车辆的使用逻辑。",
      "- **产线化：** 不是把厂房盖大，而是让工位、装配、测试和返工都进入更稳定、更快的节拍。"
    ]);
  }
  if (/viking|ragnar|berserker|valhalla|norse|norman/i.test(raw)) {
    return compactLines([
      "**这条视频真正要解决的问题**，不是复述“维京人很能打”的刻板印象，而是解释他们为什么能在中世纪欧洲形成长期冲击：长船带来的机动性、宗教叙事提供的战斗心理，以及从掠夺到贸易、殖民、政治整合的快速转换。",
      "",
      "**访谈语境：** Lex Fridman 采访历史学者 Lars Brownworth，讨论维京时代、Ragnar、狂战士、Valhalla、诺曼人和拜占庭相关历史。读这类内容，关键不是记住人名年表，而是看清“技术优势、暴力组织、神话叙事、制度适应”怎样互相放大。",
      "",
      "### 关键术语解释",
      "- **Viking / 维京：** 更像一种行动身份，常指参与远航、袭掠、贸易和殖民的北欧人，而不是单一固定民族。",
      "- **Longship / 长船：** 维京扩张的核心工具，速度快、吃水浅，能跨海航行也能进入河道。",
      "- **Berserker / 狂战士：** 维京叙事中带有宗教和心理色彩的战士形象，常被用来解释极端战斗意志。",
      "- **Valhalla / 英灵殿：** 北欧神话中战死者前往的殿堂，影响了维京人对死亡、荣耀和战斗的理解。",
      "- **Ragnarok / 诸神黄昏：** 北欧神话中的终末战争，代表一种悲壮而不乐观的世界观。"
    ]);
  }
  return compactLines([
    `**这条视频《${title}》的阅读重点**，要从视频里反复出现的具体人物、技术、事件或案例切入${channel}。`,
    "",
    "下面的总结只保留字幕能够支撑的具体判断：它讨论了什么对象，给出了哪些证据，哪些地方仍然需要继续验证。"
  ]);
}

function extractMisplacedBackgroundFromSummary(summary = "") {
  const lines = String(summary || "").split(/\r?\n/);
  const moved = [];
  const kept = [];
  let target = kept;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    target.push(...buffer);
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^#{3,5}\s+(.+)$/);
    if (heading) {
      flush();
      const title = heading[1];
      target = /背景|导读|阅读门槛|术语|上下文|拍摄|语境|先理解|新手|小白/.test(title) ? moved : kept;
    }
    buffer.push(line);
  }
  flush();
  return {
    background: stripLowValueYoutubeMetadataLines(moved.join("\n")),
    summary: stripLowValueYoutubeMetadataLines(kept.join("\n"))
  };
}

function splitMisplacedBackgroundBlocks(markdown = "") {
  const moved = [];
  const kept = [];
  let target = kept;
  let buffer = [];
  const backgroundPattern = /背景|导读|阅读门槛|术语|上下文|拍摄|访问背景|访谈背景|市场\/技术环境|市场环境|技术环境|为什么.*值得|为什么.*重要|先理解|新手|小白|术语解释/;
  const flush = () => {
    if (!buffer.length) return;
    target.push(...buffer);
    buffer = [];
  };
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^#{3,6}\s+(.+)$/);
    const bulletLabel = line.match(/^\s*[-*]\s*(?:\*\*)?([^：:]{2,24})(?:[：:]\*\*|\*\*[：:]|[：:])/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (heading || bulletLabel) {
      flush();
      const label = heading ? heading[1] : bulletLabel[1];
      target = backgroundPattern.test(label) ? moved : kept;
    } else if (bullet && isBackgroundTermCandidate(bullet[1])) {
      flush();
      target = moved;
    }
    buffer.push(line);
  }
  flush();
  return {
    background: stripLowValueYoutubeMetadataLines(moved.join("\n")),
    body: stripLowValueYoutubeMetadataLines(kept.join("\n"))
  };
}

function isBackgroundTermCandidate(text = "") {
  const value = String(text || "").trim();
  if (!value || value.length > 42) return false;
  if (/[。；;，,：:]/.test(value)) return false;
  return /\/|[A-Za-z].*[\u4e00-\u9fff]|[\u4e00-\u9fff].*[A-Za-z]|系统|飞船|助推器|复用|长船|龙船|英灵殿|瓦尔哈拉|狂战士|民族|术语/.test(value);
}

function parseTermLine(text = "") {
  const value = String(text || "")
    .trim()
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .replace(/^(?:关键)?术语(?:解释)?[：:]\s*/i, "")
    .trim();
  const match = value.match(/^([^：:]{2,42})[：:]\s*(.+)$/);
  if (!match) return null;
  return {
    term: match[1].trim(),
    description: match[2].trim()
  };
}

function normalizeBackgroundSection(background = "", report = {}) {
  const lines = String(background || "").split(/\r?\n/);
  const body = [];
  const terms = [];
  let termMode = false;
  const pushTerm = (term, description = "") => {
    const cleanTerm = String(term || "").replace(/^[-*]\s*/, "").trim();
    const cleanDescription = String(description || "").replace(/^[-*]\s*/, "").trim();
    if (!cleanTerm) return;
    terms.push(`- **${cleanTerm.replace(/[：:]\s*$/, "")}：** ${cleanDescription}`.trim());
  };
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) {
      if (!termMode) body.push("");
      continue;
    }
    if (/^#{3,6}\s*(?:关键)?术语(?:解释)?|^初学者.*(?:关键词|术语)/.test(line)) {
      termMode = true;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet && (termMode || /术语/.test(bullet[1]) || isBackgroundTermCandidate(bullet[1]))) {
      const parsed = parseTermLine(bullet[1]);
      if (parsed) {
        pushTerm(parsed.term, parsed.description);
        continue;
      }
      const next = lines[index + 1]?.trim() || "";
      const nextBullet = next.match(/^[-*]\s+(.+)$/);
      if (isBackgroundTermCandidate(bullet[1]) && nextBullet && !parseTermLine(nextBullet[1])) {
        pushTerm(bullet[1], nextBullet[1]);
        index += 1;
        continue;
      }
    }
    if (termMode && /^#{2,6}\s+/.test(line)) {
      termMode = false;
    }
    body.push(rawLine);
  }
  const raw = [report.title, report.topic, ...(report.videos || []).map((video) => video.title)].filter(Boolean).join(" ");
  if (!terms.length && /spacex|starfactory|starship|elon|musk/i.test(raw)) {
    terms.push(
      "- **Starship / 星舰：** SpaceX 的超重型运载系统中的上面级飞船。",
      "- **Super Heavy / 超重型助推器：** 星舰系统的一级助推器，负责把飞船推到接近入轨条件后返回发射场。",
      "- **全复用：** 助推器和飞船都能快速返回、检查、再次飞行。"
    );
  }
  return compactLines([
    compactLines(body),
    terms.length ? compactLines(["### 关键术语解释", ...terms]) : ""
  ]);
}

function splitYoutubeBackgroundAndGlossary(markdown = "") {
  const text = String(markdown || "").trim();
  if (!text) return { background: "", glossary: "" };
  const marker = text.search(/^###\s+关键术语解释\s*$/m);
  if (marker < 0) return { background: text, glossary: "" };
  return {
    background: text.slice(0, marker).trim(),
    glossary: text.slice(marker).replace(/^###\s+关键术语解释\s*/m, "").trim()
  };
}

function emphasizeReaderLabels(markdown = "") {
  const labels = [
    "市场/技术环境", "市场环境", "技术环境", "访问背景", "访谈背景", "拍摄背景", "为什么这个视频重要",
    "为什么重要", "视频里怎么说", "风险或不确定性", "风险", "含义", "可迁移启发",
    "读者该抓住什么", "核心判断", "关键证据", "边界条件", "一句话结论", "反共识判断"
  ];
  const pattern = new RegExp(`^(\\s*[-*]\\s+)(?!\\*\\*)(${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})([：:])\\s*(.+)$`);
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(pattern);
      if (!match) return line;
      return `${match[1]}**${match[2]}${match[3]}** ${match[4]}`;
    })
    .join("\n");
}

function indentReaderLabelBullets(markdown = "") {
  const labelPattern = /^\s*[-*]\s+\*\*(?:为什么重要|读者该抓住什么|视频里怎么说|风险或不确定性|风险|含义|可迁移启发|关键证据|边界条件)[：:]/;
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => (labelPattern.test(line) && !/^\s{2,}[-*]/.test(line) ? `  ${line}` : line))
    .join("\n");
}

function extractYoutubeQuestionKeywords(text = "", limit = 8) {
  const source = String(text || "");
  const stopwords = new Set([
    "youtube", "video", "first", "look", "inside", "with", "and", "the", "this", "that",
    "what", "how", "why", "from", "about", "watch", "full", "episode", "interview",
    "一个", "这个", "那个", "视频", "里面", "什么", "为什么", "怎么", "我们", "他们", "可以",
    "不是", "没有", "因为", "所以", "如果", "但是", "以及", "进行", "问题", "内容"
  ]);
  const counts = new Map();
  const add = (raw) => {
    const token = String(raw || "").trim().replace(/^[-_.,:;'"()[\]{}]+|[-_.,:;'"()[\]{}]+$/g, "");
    if (!token || token.length < 2 || token.length > 32) return;
    const key = token.toLowerCase();
    if (stopwords.has(key) || stopwords.has(token)) return;
    counts.set(token, (counts.get(token) || 0) + 1);
  };
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9+.#/-]{2,}/g)) add(match[0]);
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,10}/g)) add(match[0]);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, limit);
}

function buildYoutubeGenerationAnchors(videos = [], topic = "") {
  const combined = [
    topic,
    ...videos.map((video) => [
      video.title,
      video.channel,
      truncate(video.transcriptText || "", 8000)
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
  const keywords = extractYoutubeQuestionKeywords(combined, 16);
  const evidenceLines = [];
  for (const video of videos.slice(0, 3)) {
    const lines = transcriptIndexLines(video.transcriptText || "").slice(0, 18);
    for (const line of lines) {
      if (evidenceLines.length >= 30) break;
      evidenceLines.push(line);
    }
  }
  return compactLines([
    keywords.length ? `Concrete anchors to use: ${keywords.join(" / ")}` : "",
    evidenceLines.length ? "Timestamp evidence examples:" : "",
    evidenceLines.slice(0, 30).map((line) => `- ${line}`).join("\n")
  ]);
}

function buildYoutubeBoundedEvidenceSource(videos = [], maxChars = 12000) {
  const chunks = [];
  let chars = 0;
  const push = (line = "") => {
    const text = String(line || "").trim();
    if (!text) return false;
    if (chars + text.length + 1 > maxChars) return false;
    chunks.push(text);
    chars += text.length + 1;
    return true;
  };
  for (const [index, video] of videos.slice(0, 3).entries()) {
    push(`Video ${index + 1}: ${video.title || ""}`);
    if (video.url) push(`URL: ${video.url}`);
    if (video.channel) push(`Channel: ${video.channel}`);
    if (video.language) push(`Transcript language: ${video.language}`);
    const lines = transcriptIndexLines(video.transcriptText || "");
    if (!lines.length) continue;
    push("Selected timestamp evidence:");
    const selected = [];
    for (const line of lines.slice(0, 30)) selected.push(line);
    const stride = Math.max(1, Math.floor(lines.length / 30));
    for (let i = 30; i < lines.length && selected.length < 60; i += stride) selected.push(lines[i]);
    for (const line of selected) {
      if (!push(`- ${line}`)) return chunks.join("\n");
    }
  }
  return chunks.join("\n");
}

function extractJsonObject(text = "") {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("AI did not return valid JSON.");
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanArticleText(value = "", max = 1400) {
  return truncate(String(value || "").replace(/\s+/g, " ").trim(), max);
}

function stripMarkdownFencedCodeBlocks(markdown = "") {
  return String(markdown || "").replace(/(^|\n)```[\s\S]*?(?:\n```|$)/g, "\n");
}

const youtubeProcessArtifactPattern =
  /(?:我\s*先.{0,40}(?:整理|生成|写成|串成|放进|进入|发送|发你|发给你)|接下来\s*我\s*会.{0,40}(?:整理|生成|写成|串成|放进|进入|发送|发你|发给你)|下面\s*我\s*会.{0,40}(?:整理|生成|写成|串成|放进|进入|发送|发你|发给你)|我\s*(?:会|将)\s*把.{0,40}(?:整理|生成|写成|串成|放进|进入|发送|发你|发给你)|先按你给的|根据你给的时间戳|时间戳骨架|整理成中文(?:技术)?简报|可直接(?:进入|进)\s*(?:Obsidian|飞书)|直接(?:进入|进)\s*(?:Obsidian|飞书))/i;

function isYoutubeProcessArtifactText(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  return youtubeProcessArtifactPattern.test(text);
}

function stripYoutubeProcessArtifactFragments(value = "") {
  let text = String(value || "");
  if (/^\s*(?:我\s*先|接下来\s*我\s*会|我\s*会\s*把|我\s*将\s*把)/i.test(text) && /真正的正文标题[:：]/.test(text)) {
    text = text.replace(/^[\s\S]{0,360}?真正的正文标题[:：]\s*/i, "");
  }
  return text
    .replace(/我\s*先\s*(?:按你给的|根据你给的)?[^。！？\n]{0,120}?(?:时间戳骨架|整理成中文(?:技术)?简报|可直接(?:进入|进)\s*(?:Obsidian|飞书)|直接(?:进入|进)\s*(?:Obsidian|飞书))[^。！？\n]*[。！？；;，,]*/gi, " ")
    .replace(/我\s*先\s*按[^。！？\n]{0,240}?(?:接下来\s*我\s*会|我\s*会\s*把|我\s*将\s*把)[^。！？\n]*[。！？；;，,]*/gi, " ")
    .replace(/我\s*先\s*接下来\s*我\s*会[^。！？\n]{0,180}[。！？；;，,]*/gi, " ")
    .replace(/接下来\s*我\s*会[^。！？\n]{0,200}?(?:整理|生成|写成|串成|放进|进入|发送|发你|发给你|文章|文档|笔记|飞书|Obsidian|可直接(?:进入|进)\s*(?:Obsidian|飞书)|直接(?:进入|进)\s*(?:Obsidian|飞书))[^。！？\n]*[。！？；;，,]*/gi, " ")
    .replace(/我\s*(?:会|将)\s*把[^。！？\n]{0,200}?(?:整理|生成|写成|串成|放进|进入|发送|发你|发给你|文章|文档|笔记|飞书|Obsidian|可直接(?:进入|进)\s*(?:Obsidian|飞书)|直接(?:进入|进)\s*(?:Obsidian|飞书))[^。！？\n]*[。！？；;，,]*/gi, " ")
    .replace(/(?:时间戳骨架|整理成中文(?:技术)?简报|可直接(?:进入|进)\s*(?:Obsidian|飞书)|直接(?:进入|进)\s*(?:Obsidian|飞书))[^。！？\n]*[。！？；;，,]*/gi, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function cleanYoutubeArticleText(value = "", max = 1400) {
  const text = cleanArticleText(stripYoutubeProcessArtifactFragments(value), max);
  if (!text || isYoutubeProcessArtifactText(text)) return "";
  return text;
}

function stripYoutubeProcessArtifactLines(markdown = "") {
  const lines = [];
  let inFence = false;
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      lines.push(rawLine);
      continue;
    }
    if (inFence) {
      lines.push(rawLine);
      continue;
    }
    const line = stripYoutubeProcessArtifactFragments(rawLine);
    if (line.trim() && !isYoutubeProcessArtifactText(line)) lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLowValueResearchArtifactText(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  return /YouTube\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading|<\/?details|<summary|我先按|接下来我会/i.test(text);
}

function stripLowValueResearchArtifacts(value = "", max = 1400) {
  const raw = String(value || "");
  if (!raw) return "";
  return truncate(raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      if (!line) return "";
      if (/^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading)\s*[:：]?/i.test(line)) return "";
      if (/<\/?details|<summary/i.test(line)) return "";
      if (/^(?:我先按|接下来我会)/.test(line)) return "";
      return line;
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s*YouTube\s*技术笔记\s*/ig, " ")
    .replace(/\s*技术笔记\s*$/ig, "")
    .replace(/<\/?details[^>]*>|<\/?summary[^>]*>/ig, " ")
    .replace(/(?:阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading)\s*[:：]?\s*[^。；;，,|]*/ig, " ")
    .replace(/(?:我先按|接下来我会)[^。；;，,|]*/g, " ")
    .replace(/\s+/g, " ")
    .trim(), max);
}

function cleanResearchArticleText(value = "", max = 1400) {
  let text = stripLowValueResearchArtifacts(value, max);
  text = cleanArticleText(text, max);
  if (!text) return "";
  if (/^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading)\s*[:：]?/i.test(text)) return "";
  if (/^(?:#{1,6}\s*)?.*YouTube\s*技术笔记\s*$/i.test(text)) {
    text = cleanYoutubeDocumentTitle(text.replace(/^#{1,6}\s*/, ""));
    if (isWeakYoutubeTitle(text)) return "";
  }
  text = text
    .replace(/\s*YouTube\s*技术笔记\s*/ig, " ")
    .replace(/\s*技术笔记\s*$/ig, "")
    .replace(/<\/?details[^>]*>|<\/?summary[^>]*>/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:我先按|接下来我会)/.test(text)) return "";
  return truncate(text, max);
}

function cleanResearchEvidenceText(value = "", max = 1400) {
  const raw = stripLowValueResearchArtifacts(value, max);
  if (/^(?:#{1,6}\s*)?.*YouTube\s*技术笔记\s*$/i.test(raw)) return "";
  if (/^(?:阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading)\s*[:：]?/i.test(raw)) return "";
  return cleanResearchArticleText(raw, max);
}

function buildYoutubeEvidenceBriefSource(brief = {}) {
  const source = {
    thesis: cleanArticleText(brief.thesis, 600),
    titleAngles: asArray(brief.titleAngles).map((item) => cleanArticleText(item, 160)).filter(Boolean).slice(0, 5),
    narrativeConflict: cleanArticleText(brief.narrativeConflict, 900),
    backgroundAnchors: asArray(brief.backgroundAnchors).map((item) => cleanArticleText(item, 220)).filter(Boolean).slice(0, 12),
    glossarySeeds: asArray(brief.glossarySeeds).map((item) => ({
      term: cleanArticleText(item?.term, 80),
      evidence: cleanArticleText(item?.evidence, 500),
      plainMeaning: cleanArticleText(item?.plainMeaning, 500)
    })).filter((item) => item.term).slice(0, 10),
    evidenceClaims: asArray(brief.evidenceClaims).map((item) => ({
      claim: cleanArticleText(item?.claim, 220),
      timestamp: cleanArticleText(item?.timestamp, 40),
      quote: cleanArticleText(item?.quote, 700),
      whyItMatters: cleanArticleText(item?.whyItMatters, 700)
    })).filter((item) => item.claim && (item.quote || item.timestamp)).slice(0, 16),
    timelineSeeds: asArray(brief.timelineSeeds).map((item) => ({
      time: cleanArticleText(item?.time || item?.timestamp, 40),
      event: cleanArticleText(item?.event, 500),
      importance: cleanArticleText(item?.importance || item?.whyItMatters, 500),
      quote: cleanArticleText(item?.quote, 500)
    })).filter((item) => item.time && item.event).slice(0, 24),
    questionSeeds: asArray(brief.questionSeeds).map((item) => cleanArticleText(item, 260)).filter(Boolean).slice(0, 10)
  };
  return JSON.stringify(source, null, 2);
}

function buildYoutubeTimelineSeedsFromTranscripts(videos = [], minCount = 8) {
  const candidates = [];
  for (const video of videos || []) {
    const lines = transcriptIndexLines(video.transcriptText || "");
    if (!lines.length) continue;
    const stride = Math.max(1, Math.floor(lines.length / Math.max(minCount, 1)));
    for (let index = 0; index < lines.length && candidates.length < 24; index += stride) {
      const line = lines[index] || "";
      const match = line.match(/^\[(\d+:\d{2}(?::\d{2})?)\]\s+(.+)$/);
      if (!match) continue;
      const quote = cleanArticleText(match[2], 500);
      if (!quote) continue;
      candidates.push({
        time: match[1],
        event: `视频在这里展开了一个关键论据：${quote}`,
        importance: "这个时间点可以作为正文判断的原文锚点，帮助读者回到视频核对上下文。",
        quote
      });
    }
  }
  return candidates.slice(0, 18);
}

function mergeUniqueBy(values = [], keyFn = (item) => JSON.stringify(item), limit = 12) {
  const output = [];
  const seen = new Set();
  for (const item of values) {
    if (!item) continue;
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    output.push(item);
    seen.add(key);
    if (output.length >= limit) break;
  }
  return output;
}

function buildDeterministicYoutubeEvidenceBrief({ topic = "", videos = [] } = {}) {
  const rawContext = [
    topic,
    ...videos.map((video) => `${video.title || ""} ${video.channel || ""} ${truncate(video.transcriptText || "", 4000)}`)
  ].join(" ");
  const keywords = extractYoutubeQuestionKeywords(rawContext, 12);
  const focus = keywords.slice(0, 3).join("、") || cleanYoutubeDocumentTitle(videos[0]?.title || topic || "这条视频");
  const backgroundAnchors = mergeUniqueBy([
    ...keywords,
    ...videos.map((video) => cleanYoutubeDocumentTitle(video.title || "")).filter(Boolean),
    ...videos.map((video) => video.channel).filter(Boolean)
  ], (item) => String(item || "").toLowerCase(), 8);
  const timelineSeeds = buildYoutubeTimelineSeedsFromTranscripts(videos, 8);
  const glossarySeeds = backgroundAnchors.slice(0, 6).map((term) => ({
    term,
    evidence: term,
    plainMeaning: `这是理解本视频判断链条的核心对象或术语，读者可以先把它当作后文反复出现的线索。`
  }));
  const evidenceClaims = timelineSeeds.slice(0, 8).map((seed) => ({
    claim: seed.event,
    timestamp: seed.time,
    quote: seed.quote,
    whyItMatters: seed.importance
  }));
  return normalizeYoutubeEvidenceBrief({
    thesis: `${focus}的关键问题，不是视频表面讲了什么，而是这些证据如何改变读者对任务、技术路径和风险边界的理解。`,
    titleAngles: [],
    narrativeConflict: `这篇文章要解释的核心冲突是：${focus}看似只是视频里的若干信息点，但真正影响判断的是它们背后的约束、取舍和可验证证据。`,
    backgroundAnchors,
    glossarySeeds,
    evidenceClaims,
    timelineSeeds,
    questionSeeds: []
  }, { topic, videos });
}

function mergeYoutubeEvidenceBriefs(base = {}, model = {}, report = {}) {
  const merged = {
    thesis: cleanArticleText(model.thesis) || cleanArticleText(base.thesis),
    titleAngles: mergeUniqueBy([
      ...asArray(model.titleAngles).map((item) => cleanArticleText(item, 160)).filter(Boolean),
      ...asArray(base.titleAngles).map((item) => cleanArticleText(item, 160)).filter(Boolean)
    ], (item) => item.toLowerCase(), 5),
    narrativeConflict: cleanArticleText(model.narrativeConflict) || cleanArticleText(base.narrativeConflict),
    backgroundAnchors: mergeUniqueBy([
      ...asArray(model.backgroundAnchors).map((item) => cleanArticleText(item, 220)).filter(Boolean),
      ...asArray(base.backgroundAnchors).map((item) => cleanArticleText(item, 220)).filter(Boolean)
    ], (item) => item.toLowerCase(), 12),
    glossarySeeds: mergeUniqueBy([
      ...asArray(model.glossarySeeds),
      ...asArray(base.glossarySeeds)
    ], (item) => cleanArticleText(item?.term).toLowerCase(), 10),
    evidenceClaims: mergeUniqueBy([
      ...asArray(model.evidenceClaims),
      ...asArray(base.evidenceClaims)
    ], (item) => `${cleanArticleText(item?.timestamp)}|${cleanArticleText(item?.quote || item?.claim)}`.toLowerCase(), 16),
    timelineSeeds: mergeUniqueBy([
      ...asArray(model.timelineSeeds),
      ...asArray(base.timelineSeeds)
    ], (item) => cleanArticleText(item?.time || item?.timestamp), 24),
    questionSeeds: mergeUniqueBy([
      ...asArray(model.questionSeeds).map((item) => cleanArticleText(item, 260)).filter(Boolean),
      ...asArray(base.questionSeeds).map((item) => cleanArticleText(item, 260)).filter(Boolean)
    ], (item) => item.toLowerCase(), 10)
  };
  return normalizeYoutubeEvidenceBrief(merged, report);
}

function normalizeYoutubeEvidenceBrief(brief = {}, report = {}) {
  const source = JSON.parse(buildYoutubeEvidenceBriefSource(brief));
  const videos = report.videos || [];
  const rawContext = [
    report.topic,
    report.title,
    ...videos.map((video) => `${video.title || ""} ${video.channel || ""} ${truncate(video.transcriptText || "", 2500)}`)
  ].join(" ");
  const keywords = extractYoutubeQuestionKeywords(rawContext, 10);
  const focus = keywords.slice(0, 3).join("、") || cleanYoutubeDocumentTitle(videos[0]?.title || report.topic || "这条视频");
  const firstTranscriptLines = buildYoutubeTimelineSeedsFromTranscripts(videos, 8);
  if (!source.thesis || isWeakYoutubeTitle(source.thesis, report.topic || "")) {
    source.thesis = `${focus}的关键问题，不是视频表面讲了什么，而是这些证据如何改变读者对任务、技术路径和风险边界的理解。`;
  }
  if (!source.narrativeConflict) {
    source.narrativeConflict = `这篇文章要解释的核心冲突是：${focus}看似只是视频里的若干信息点，但真正影响判断的是它们背后的约束、取舍和可验证证据。`;
  }
  if (source.backgroundAnchors.length < 3) {
    for (const item of [
      ...keywords,
      ...videos.map((video) => cleanYoutubeDocumentTitle(video.title || "")).filter(Boolean),
      ...videos.map((video) => video.channel).filter(Boolean)
    ]) {
      if (!item || source.backgroundAnchors.includes(item)) continue;
      source.backgroundAnchors.push(item);
      if (source.backgroundAnchors.length >= 5) break;
    }
  }
  if (source.glossarySeeds.length < 3) {
    for (const term of source.backgroundAnchors.concat(keywords)) {
      if (!term || source.glossarySeeds.some((item) => item.term === term)) continue;
      source.glossarySeeds.push({
        term,
        evidence: term,
        plainMeaning: `这是理解本视频判断链条的核心对象或术语，读者可以先把它当作后文反复出现的线索。`
      });
      if (source.glossarySeeds.length >= 3) break;
    }
  }
  if (source.evidenceClaims.length < 4) {
    for (const seed of firstTranscriptLines) {
      source.evidenceClaims.push({
        claim: seed.event,
        timestamp: seed.time,
        quote: seed.quote,
        whyItMatters: seed.importance
      });
      if (source.evidenceClaims.length >= 6) break;
    }
  }
  if (source.timelineSeeds.length < 6) {
    const seen = new Set(source.timelineSeeds.map((item) => item.time));
    for (const seed of firstTranscriptLines) {
      if (seen.has(seed.time)) continue;
      source.timelineSeeds.push(seed);
      seen.add(seed.time);
      if (source.timelineSeeds.length >= 8) break;
    }
  }
  if (source.questionSeeds.length < 5) {
    const fallbackQuestions = buildYoutubeQuestionsFallback({ ...report, videos })
      .split(/\r?\n/)
      .map((line) => cleanArticleText(line.replace(/^[-*]\s*/, ""), 260))
      .filter(Boolean);
    for (const question of fallbackQuestions) {
      if (source.questionSeeds.includes(question)) continue;
      source.questionSeeds.push(question);
      if (source.questionSeeds.length >= 5) break;
    }
  }
  return source;
}

function assertYoutubeEvidenceBrief(brief = {}, report = {}) {
  const source = normalizeYoutubeEvidenceBrief(brief, report);
  if (!source.thesis || isWeakYoutubeTitle(source.thesis, report.topic || "")) {
    throw new Error("YouTube evidence brief failed: missing specific thesis.");
  }
  if (!source.narrativeConflict) throw new Error("YouTube evidence brief failed: missing narrative conflict.");
  if (source.backgroundAnchors.length < 3) throw new Error("YouTube evidence brief failed: missing concrete background anchors.");
  if (source.glossarySeeds.length < 3) throw new Error("YouTube evidence brief failed: missing glossary seeds.");
  if (source.evidenceClaims.length < 4) throw new Error("YouTube evidence brief failed: missing evidence-backed claims.");
  if (source.timelineSeeds.length < 6) throw new Error("YouTube evidence brief failed: missing timeline seeds.");
}

function structuredArticleFallbackTitle(article = {}, report = {}) {
  const title = cleanYoutubeDocumentTitle(article.title || "");
  if (!isWeakYoutubeTitle(title, report.topic || "") && !looksMostlyEnglish(title)) return title;
  return youtubeTitleFallback(report);
}

function normalizeYoutubeStructuredArticle(article = {}, evidenceBrief = {}, report = {}) {
  const source = normalizeYoutubeEvidenceBrief(evidenceBrief, report);
  const normalized = {
    ...article,
    opening: {
      ...(article.opening || {})
    }
  };
  if (!normalized.title || isWeakYoutubeTitle(normalized.title, report.topic || "") || looksMostlyEnglish(normalized.title)) {
    normalized.title = source.titleAngles[0] || youtubeTitleFallback(report);
  }
  const anchors = source.backgroundAnchors.slice(0, 5).join("、");
  const contextParagraphs = asArray(normalized.opening.contextParagraphs).map((item) => cleanYoutubeArticleText(item, 1000)).filter(Boolean);
  if (contextParagraphs.length < 2) {
    normalized.opening.contextParagraphs = [
      `这条视频值得先放回具体语境里看：${anchors || report.topic || "视频中的关键对象"}不是孤立信息点，而是理解后续判断的入口。读者先抓住视频反复出现的对象、数字和场景，再进入结论会轻松很多。`,
      source.narrativeConflict || `本文要解释的主线是：${source.thesis}`
    ];
  } else {
    normalized.opening.contextParagraphs = contextParagraphs;
  }
  const glossary = asArray(normalized.opening.glossary).filter((item) => cleanYoutubeArticleText(item?.term) && cleanYoutubeArticleText(item?.explanation || item?.description));
  if (glossary.length < 3) {
    normalized.opening.glossary = source.glossarySeeds.slice(0, 6).map((item) => ({
      term: item.term,
      explanation: item.plainMeaning || `这是视频中反复出现的核心对象，后文会围绕它解释证据和判断。`
    }));
  } else {
    normalized.opening.glossary = glossary;
  }
  if (!cleanYoutubeArticleText(normalized.opening.oneSentence)) {
    normalized.opening.oneSentence = source.thesis;
  } else {
    normalized.opening.oneSentence = cleanYoutubeArticleText(normalized.opening.oneSentence, 700);
  }
  const corePoints = asArray(normalized.opening.corePoints).filter((item) => cleanYoutubeArticleText(item?.title) && cleanYoutubeArticleText(item?.evidence || item?.quote));
  if (corePoints.length < 3) {
    normalized.opening.corePoints = source.evidenceClaims.slice(0, 6).map((item, index) => ({
      title: item.claim || `关键判断 ${index + 1}`,
      evidence: item.timestamp ? `[${item.timestamp}] ${item.quote}` : item.quote,
      why: item.whyItMatters || "这条证据决定了读者应该如何理解视频里的核心判断。",
      takeaway: "先看证据，再看结论，避免把视频信息误读成空泛观点。"
    }));
  } else {
    normalized.opening.corePoints = corePoints;
  }
  const quotes = asArray(normalized.opening.quotes)
    .map((item) => ({
      title: cleanYoutubeArticleText(item?.title, 80),
      original: cleanYoutubeArticleText(item?.original || item?.quote, 700),
      meaning: cleanYoutubeArticleText(item?.meaning, 700),
      implication: cleanYoutubeArticleText(item?.implication || item?.transfer, 700)
    }))
    .filter((item) => item.original);
  if (!quotes.length) {
    normalized.opening.quotes = source.evidenceClaims.slice(0, 3).map((item, index) => ({
      title: `原文证据 ${index + 1}`,
      original: item.quote,
      meaning: item.whyItMatters,
      implication: "好判断必须能回到原文证据，而不是只停留在概括。"
    })).filter((item) => item.original);
  } else {
    normalized.opening.quotes = quotes;
  }
  const counterintuitive = asArray(normalized.opening.counterintuitive)
    .map((item) => cleanYoutubeArticleText(item, 600))
    .filter(Boolean);
  if (counterintuitive.length < 3) {
    normalized.opening.counterintuitive = source.evidenceClaims.slice(0, 3).map((item) => `容易被忽略的是：${item.whyItMatters || item.claim}`);
  } else {
    normalized.opening.counterintuitive = counterintuitive;
  }
  const techPoints = asArray(normalized.techPoints).filter((item) => cleanYoutubeArticleText(item?.name || item?.title) && cleanYoutubeArticleText(item?.says || item?.inVideo));
  if (techPoints.length < 2) {
    normalized.techPoints = source.evidenceClaims.slice(0, 5).map((item, index) => ({
      name: source.backgroundAnchors[index] || item.claim || `关键技术点 ${index + 1}`,
      says: item.quote || item.claim,
      importance: item.whyItMatters || "它决定了后文判断是否站得住。",
      risk: "仍需要结合完整视频上下文和外部资料验证边界条件。"
    }));
  } else {
    normalized.techPoints = techPoints;
  }
  const detailSections = asArray(normalized.detailSections)
    .map((section) => ({
      title: cleanYoutubeArticleText(section?.title, 120),
      bullets: asArray(section?.bullets).map((item) => cleanYoutubeArticleText(item, 700)).filter(Boolean)
    }))
    .filter((section) => section.title && section.bullets.length);
  if (!detailSections.length) {
    normalized.detailSections = [
      {
        title: "证据链如何支撑主判断",
        bullets: source.evidenceClaims.slice(0, 4).map((item) => `${item.timestamp ? `[${item.timestamp}] ` : ""}${item.claim}：${item.whyItMatters}`)
      },
      {
        title: "读者需要注意的边界",
        bullets: source.questionSeeds.slice(0, 4).map((item) => `后续仍要追问：${item}`)
      }
    ];
  } else {
    normalized.detailSections = detailSections;
  }
  const timeline = asArray(normalized.timeline).filter((item) => cleanYoutubeArticleText(item?.time || item?.timestamp) && cleanYoutubeArticleText(item?.event || item?.whatHappens));
  if (timeline.length < 6) {
    normalized.timeline = source.timelineSeeds.slice(0, 18).map((item) => ({
      time: item.time,
      event: item.event,
      importance: item.importance,
      evidence: item.quote
    }));
  } else {
    normalized.timeline = timeline;
  }
  const questions = asArray(normalized.questions).map((item) => cleanYoutubeArticleText(item, 500)).filter(Boolean);
  if (questions.length < 4) {
    normalized.questions = source.questionSeeds.slice(0, 8);
  } else {
    normalized.questions = questions;
  }
  return normalized;
}

function renderYoutubeStructuredArticle(article = {}, report = {}) {
  const fallbackTitle = structuredArticleFallbackTitle(article, report);
  const title = cleanYoutubeDocumentTitle(article.title || fallbackTitle) || fallbackTitle;
  const opening = article.opening || {};
  const paragraphs = asArray(opening.contextParagraphs).map((item) => cleanYoutubeArticleText(item, 900)).filter(Boolean);
  const glossary = asArray(opening.glossary)
    .map((item) => ({
      term: cleanYoutubeArticleText(item?.term, 80),
      explanation: cleanYoutubeArticleText(item?.explanation || item?.description, 500)
    }))
    .filter((item) => item.term && item.explanation);
  const oneSentence = cleanYoutubeArticleText(opening.oneSentence || article.oneSentence, 700);
  const corePoints = asArray(opening.corePoints || article.corePoints)
    .map((item, index) => ({
      title: cleanYoutubeArticleText(item?.title || `核心观点 ${index + 1}`, 120),
      evidence: cleanYoutubeArticleText(item?.evidence || item?.quote, 700),
      why: cleanYoutubeArticleText(item?.why || item?.importance, 700),
      takeaway: cleanYoutubeArticleText(item?.takeaway || item?.readerTakeaway, 700)
    }))
    .filter((item) => item.title && (item.evidence || item.why || item.takeaway));
  const quotes = asArray(opening.quotes || article.quotes)
    .map((item, index) => ({
      title: cleanYoutubeArticleText(item?.title || `金句 ${index + 1}`, 80),
      original: cleanYoutubeArticleText(item?.original || item?.quote, 700),
      meaning: cleanYoutubeArticleText(item?.meaning, 700),
      implication: cleanYoutubeArticleText(item?.implication || item?.transfer, 700)
    }))
    .filter((item) => item.original);
  const counterintuitive = asArray(opening.counterintuitive || article.counterintuitive)
    .map((item) => cleanYoutubeArticleText(item, 600))
    .filter(Boolean);
  const techPoints = asArray(article.techPoints)
    .map((item, index) => ({
      name: cleanYoutubeArticleText(item?.name || item?.title || `技术点 ${index + 1}`, 120),
      says: cleanYoutubeArticleText(item?.says || item?.inVideo, 700),
      importance: cleanYoutubeArticleText(item?.importance || item?.why, 700),
      risk: cleanYoutubeArticleText(item?.risk || item?.uncertainty, 700)
    }))
    .filter((item) => item.name && (item.says || item.importance || item.risk));
  const detailSections = asArray(article.detailSections)
    .map((section, index) => ({
      title: cleanYoutubeArticleText(section?.title || `拆解 ${index + 1}`, 120),
      bullets: asArray(section?.bullets).map((item) => cleanYoutubeArticleText(item, 700)).filter(Boolean)
    }))
    .filter((section) => section.title && section.bullets.length);
  const timeline = asArray(article.timeline)
    .map((item) => ({
      time: cleanYoutubeArticleText(item?.time || item?.timestamp, 40),
      event: cleanYoutubeArticleText(item?.event || item?.whatHappens, 700),
      importance: cleanYoutubeArticleText(item?.importance || item?.whyItMatters, 700),
      evidence: cleanYoutubeArticleText(item?.evidence || item?.quote, 500)
    }))
    .filter((item) => item.time && item.event);
  const questions = asArray(article.questions).map((item) => cleanYoutubeArticleText(item, 500)).filter(Boolean);

  const lines = [
    `# ${title}`,
    "",
    glossary.length ? compactLines([
      "## 一、关键术语解释",
      glossary.map((item) => `- **${item.term.replace(/[：:]\s*$/, "")}：** ${item.explanation}`).join("\n")
    ]) : "",
    paragraphs.length ? compactLines([
      "## 二、背景导读",
      paragraphs.join("\n\n")
    ]) : "",
    "## 三、导读与核心结论",
    oneSentence ? compactLines(["### 一句话结论", oneSentence]) : "",
    corePoints.length ? compactLines([
      "### 核心观点",
      corePoints.map((item, index) => compactLines([
        `#### ${index + 1}. ${item.title}`,
        item.evidence ? `> ${item.evidence}` : "",
        item.why ? `  - **为什么重要：** ${item.why}` : "",
        item.takeaway ? `  - **读者该抓住什么：** ${item.takeaway}` : ""
      ])).join("\n\n")
    ]) : "",
    quotes.length ? compactLines([
      "### 标志性金句",
      quotes.map((item, index) => compactLines([
        `#### ${index + 1}. ${item.title}`,
        `> ${item.original}`,
        item.meaning ? `  - **含义：** ${item.meaning}` : "",
        item.implication ? `  - **可迁移启发：** ${item.implication}` : ""
      ])).join("\n\n")
    ]) : "",
    counterintuitive.length ? compactLines([
      "### 最反共识的判断",
      counterintuitive.map((item) => `- ${item}`).join("\n")
    ]) : "",
    techPoints.length ? compactLines([
      "## 四、关键技术点速览",
      techPoints.map((item, index) => compactLines([
        `#### ${index + 1}. ${item.name}`,
        item.says ? `  - **视频里怎么说：** ${item.says}` : "",
        item.importance ? `  - **为什么重要：** ${item.importance}` : "",
        item.risk ? `  - **风险或不确定性：** ${item.risk}` : ""
      ])).join("\n\n")
    ]) : "",
    detailSections.length ? compactLines([
      "## 五、详细技术拆解",
      detailSections.map((section, index) => compactLines([
        `### ${index + 1}. ${section.title}`,
        section.bullets.map((item) => `- ${item}`).join("\n")
      ])).join("\n\n")
    ]) : "",
    timeline.length ? compactLines([
      "## 六、时间线摘要",
      timeline.map((item) => compactLines([
        `- [${item.time}] ${item.event}${item.importance ? `；${item.importance}` : ""}`,
        item.evidence ? `  > ${item.evidence}` : ""
      ])).join("\n")
    ]) : "",
    questions.length ? compactLines([
      "## 七、值得继续追问的问题",
      questions.map((item) => `- ${item}`).join("\n")
    ]) : ""
  ];
  return compactLines(lines);
}

function assertStructuredYoutubeArticle(article = {}, report = {}) {
  const title = structuredArticleFallbackTitle(article, report);
  if (isWeakYoutubeTitle(title, report.topic || "") || looksMostlyEnglish(title)) {
    throw new Error("YouTube structured article failed quality gate: weak Chinese title.");
  }
  const opening = article.opening || {};
  const context = asArray(opening.contextParagraphs).map((item) => cleanYoutubeArticleText(item, 1000)).filter(Boolean);
  const glossary = asArray(opening.glossary).filter((item) => cleanYoutubeArticleText(item?.term) && cleanYoutubeArticleText(item?.explanation || item?.description));
  const corePoints = asArray(opening.corePoints || article.corePoints).filter((item) => cleanYoutubeArticleText(item?.title) && cleanYoutubeArticleText(item?.evidence || item?.quote));
  const techPoints = asArray(article.techPoints).filter((item) => cleanYoutubeArticleText(item?.name || item?.title) && cleanYoutubeArticleText(item?.says || item?.inVideo));
  const timeline = asArray(article.timeline).filter((item) => cleanYoutubeArticleText(item?.time || item?.timestamp) && cleanYoutubeArticleText(item?.event || item?.whatHappens));
  const questions = asArray(article.questions).filter((item) => cleanYoutubeArticleText(item));
  if (context.length < 2) throw new Error("YouTube structured article failed quality gate: opening context is too thin.");
  if (glossary.length < 3) throw new Error("YouTube structured article failed quality gate: glossary is missing.");
  if (corePoints.length < 3) throw new Error("YouTube structured article failed quality gate: evidence-backed core points are missing.");
  if (techPoints.length < 2) throw new Error("YouTube structured article failed quality gate: technical points are missing.");
  if (timeline.length < 6) throw new Error("YouTube structured article failed quality gate: timeline is missing.");
  if (questions.length < 4) throw new Error("YouTube structured article failed quality gate: follow-up questions are missing.");
}

function buildYoutubeQuestionsFallback(report = {}) {
  const videos = report.videos || [];
  const firstTitle = cleanYoutubeDocumentTitle(videos[0]?.title || report.title || report.topic || "这条视频");
  const keywordText = [
    report.topic,
    report.title,
    ...videos.map((video) => `${video.title || ""} ${truncate(video.transcriptText || "", 2500)}`)
  ].join(" ");
  const keywords = extractYoutubeQuestionKeywords(keywordText);
  const focus = keywords.length ? keywords.slice(0, 3).join("、") : firstTitle;
  const nextSignals = keywords.length > 3 ? keywords.slice(3, 6).join("、") : "后续实验、真实用户反馈、成本结构";
  return [
    `- 《${firstTitle}》里围绕 **${focus}** 的核心判断，哪些已经被视频证据支撑，哪些还需要外部数据验证？`,
    `- 如果 **${focus}** 要从演示、访谈或局部案例走向规模化落地，最可能先卡在成本、可靠性、供应链、法规还是组织执行？`,
    `- 视频里没有充分展开的边界条件是什么：适用场景、失败模式、维护成本、数据假设，还是用户采用门槛？`,
    `- 未来应该追踪哪些信号来验证这篇文章的判断：**${nextSignals}**，还是更直接的商业化/量产/复用结果？`,
    "- 如果把视频里的方法迁移到另一个项目，哪些前提一变，结论就会完全失效？",
    "- 作者最强的判断和最脆弱的证据分别在哪里？下一次复盘应该优先补哪一类材料？"
  ].join("\n");
}

function buildYoutubeSourceSection(videos = []) {
  const blocks = videos.slice(0, 8).map((video, index) => {
    const meta = [
      video.channel ? `频道：${video.channel}` : "",
      video.lengthText ? `时长：${video.lengthText}` : "",
      video.language ? `字幕：${video.language}` : ""
    ].filter(Boolean).join("；");
    return compactLines([
      `### ${index + 1}. ${cleanYoutubeDocumentTitle(video.title || "YouTube video")}`,
      meta || "",
      video.url ? video.url : ""
    ]);
  });
  return blocks.filter(Boolean).join("\n\n") || "> 当前没有可展示的来源信息。";
}

function isGuidedYoutubeBlueprintMarkdown(markdown = "") {
  const text = String(markdown || "");
  return [
    "## 一、关键术语解释",
    "## 二、背景导读",
    "## 三、导读与核心结论",
    "### 一句话结论",
    "### 核心观点",
    "## 四、关键技术点速览",
    "## 六、时间线摘要",
    "## 七、值得继续追问的问题"
  ].every((needle) => text.includes(needle));
}

function stripYoutubeSourceSection(markdown = "") {
  return String(markdown || "").replace(/\n+##\s+[一二三四五六七八九十]+、出处与链接[\s\S]*$/m, "").trim();
}

function insertYoutubeTranscriptBlocks(markdown = "", transcriptBlocks = "") {
  const body = stripYoutubeSourceSection(markdown);
  if (!transcriptBlocks) return body;
  if (body.includes("### 原文摘录")) return body;
  const transcriptSection = compactLines(["### 原文摘录", transcriptBlocks]);
  const nextHeading = body.search(/\n##\s+[一二三四五六七八九十]+、值得继续追问的问题/);
  if (nextHeading >= 0) {
    return `${body.slice(0, nextHeading).trim()}\n\n${transcriptSection}\n\n${body.slice(nextHeading + 1).trim()}`;
  }
  return compactLines([body, "## 六、时间线摘要", transcriptSection]);
}

function finalizeGuidedYoutubeDocumentMarkdown(body = "", { transcriptBlocks = "", videos = [] } = {}) {
  const withoutTitle = String(body || "").replace(/^#\s+.+\n+/, "").trim();
  const withTranscript = insertYoutubeTranscriptBlocks(withoutTitle, transcriptBlocks);
  return compactLines([
    withTranscript,
    "## 八、出处与链接",
    buildYoutubeSourceSection(videos)
  ]);
}

function countMarkdownBullets(markdown = "") {
  return (String(markdown || "").match(/^\s*[-*]\s+/gm) || []).length;
}

function markdownSectionBetween(markdown = "", startHeading = "", endHeading = "") {
  const text = String(markdown || "");
  const start = text.indexOf(startHeading);
  if (start < 0) return "";
  const afterStart = start + startHeading.length;
  const end = endHeading ? text.indexOf(endHeading, afterStart) : -1;
  return (end >= 0 ? text.slice(afterStart, end) : text.slice(afterStart)).trim();
}

function replaceMarkdownSection(markdown = "", startHeading = "", endHeading = "", replacement = "") {
  const text = String(markdown || "");
  const start = text.indexOf(startHeading);
  if (start < 0) return text;
  const afterStart = start + startHeading.length;
  const end = endHeading ? text.indexOf(endHeading, afterStart) : -1;
  const before = text.slice(0, afterStart).trimEnd();
  const after = end >= 0 ? text.slice(end).trimStart() : "";
  return compactLines([
    before,
    String(replacement || "").trim(),
    after
  ]);
}

function youtubeFallbackGlossary(report = {}, minimum = 3) {
  const videos = report.videos || [];
  const keywordText = [
    report.topic,
    report.title,
    ...videos.map((video) => `${video.title || ""} ${video.channel || ""} ${truncate(video.transcriptText || "", 1500)}`)
  ].join(" ");
  const terms = extractYoutubeQuestionKeywords(keywordText, Math.max(minimum, 5));
  return terms.slice(0, minimum).map((term) =>
    `- **${term.replace(/[：:]\s*$/, "")}：** 这是理解这条视频判断链条的关键对象或术语，读者可以先把它当作后文反复出现的线索。`
  ).join("\n");
}

function repairYoutubeGlossarySection(markdown = "", report = {}) {
  const start = "## 一、关键术语解释";
  const end = "## 二、背景导读";
  const section = markdownSectionBetween(markdown, start, end);
  if (countMarkdownBullets(section) >= 3) return markdown;
  const existing = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[-*]\s+/.test(line));
  const fallback = youtubeFallbackGlossary(report, 3)
    .split(/\r?\n/)
    .filter(Boolean);
  const merged = mergeUniqueBy([...existing, ...fallback], (item) => item.replace(/\s+/g, " ").toLowerCase(), 6).join("\n");
  return replaceMarkdownSection(markdown, start, end, merged);
}

function repairYoutubeBackgroundSection(markdown = "", report = {}) {
  const start = "## 二、背景导读";
  const end = "## 三、导读与核心结论";
  const section = markdownSectionBetween(markdown, start, end);
  if (!section) return markdown;
  if (!/^\s*[-*]\s+/m.test(section) && section.length >= 120 && section.length <= 1400) return markdown;
  const prose = section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .join("\n\n");
  const fallback = splitYoutubeBackgroundAndGlossary(buildYoutubeBackgroundFallback(report)).background;
  const repaired = prose.length >= 120 ? prose : fallback;
  return replaceMarkdownSection(markdown, start, end, repaired);
}

function repairYoutubeQuestionsSection(markdown = "", report = {}) {
  const start = "## 七、值得继续追问的问题";
  const end = "## 八、出处与链接";
  const section = markdownSectionBetween(markdown, start, end);
  if (countMarkdownBullets(section) >= 4) return markdown;
  const existing = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line));
  const fallback = buildYoutubeQuestionsFallback(report)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line));
  const merged = mergeUniqueBy([...existing, ...fallback], (item) => item.replace(/\s+/g, " ").toLowerCase(), 8).join("\n");
  return replaceMarkdownSection(markdown, start, end, merged);
}

function repairYoutubeDocumentBeforeAudit(markdown = "", report = {}) {
  let repaired = stripYoutubeProcessArtifactLines(markdown);
  repaired = repairYoutubeGlossarySection(repaired, report);
  repaired = repairYoutubeBackgroundSection(repaired, report);
  repaired = repairYoutubeQuestionsSection(repaired, report);
  return repaired;
}

function auditYoutubeFinishedDocument(markdown = "") {
  const text = String(markdown || "");
  const articleText = stripMarkdownFencedCodeBlocks(text);
  const requiredOrder = [
    "## 一、关键术语解释",
    "## 二、背景导读",
    "## 三、导读与核心结论",
    "## 四、关键技术点速览",
    "## 五、详细技术拆解",
    "## 六、时间线摘要",
    "## 七、值得继续追问的问题",
    "## 八、出处与链接"
  ];
  let cursor = -1;
  for (const heading of requiredOrder) {
    const index = text.indexOf(heading);
    if (index <= cursor) throw new Error(`reader audit failed: missing or misordered section ${heading}`);
    cursor = index;
  }
  const glossary = markdownSectionBetween(text, "## 一、关键术语解释", "## 二、背景导读");
  const background = markdownSectionBetween(text, "## 二、背景导读", "## 三、导读与核心结论");
  const core = markdownSectionBetween(text, "## 三、导读与核心结论", "## 四、关键技术点速览");
  const timeline = markdownSectionBetween(text, "## 六、时间线摘要", "## 七、值得继续追问的问题");
  const questions = markdownSectionBetween(text, "## 七、值得继续追问的问题", "## 八、出处与链接");
  const sources = markdownSectionBetween(text, "## 八、出处与链接", "");
  if (countMarkdownBullets(glossary) < 3) throw new Error("reader audit failed: glossary is too thin.");
  if (background.length < 120 || background.length > 1400) throw new Error(`reader audit failed: background length is not reader-friendly (${background.length}).`);
  if (/^\s*[-*]\s+/m.test(background)) throw new Error("reader audit failed: background should be prose, not a bullet wall.");
  for (const needle of ["### 一句话结论", "### 核心观点", "### 标志性金句", "### 最反共识的判断"]) {
    if (!core.includes(needle)) throw new Error(`reader audit failed: missing ${needle}`);
  }
  if (!timeline.includes("### 原文摘录")) throw new Error("reader audit failed: timeline must include source excerpt index.");
  if (/<\/?details|<summary/i.test(stripMarkdownFencedCodeBlocks(timeline))) throw new Error("reader audit failed: transcript excerpt must not use raw HTML.");
  if (countMarkdownBullets(questions) < 4) throw new Error("reader audit failed: follow-up questions are too thin.");
  if (/输出语言|内容形态|来源链接|字幕语言|阅读导航/.test(articleText)) throw new Error("reader audit failed: low-value metadata leaked into article.");
  if ((text.match(/## 八、出处与链接/g) || []).length !== 1 || !sources.trim()) throw new Error("reader audit failed: source section must appear once at the end.");
}

function assertReadableYoutubeDocument(markdown = "") {
  const text = String(markdown || "");
  const articleText = stripMarkdownFencedCodeBlocks(text);
  if (isYoutubeProcessArtifactText(articleText)) {
    throw new Error("YouTube Feishu document failed quality gate: assistant process artifact leaked into article.");
  }
  const forbidden = [
    /阅读导航/,
    /这篇文档由小椰根据视频字幕整理/,
    /我先按|接下来我会|我会把|时间戳骨架|可直接进\s*(?:Obsidian|飞书)/,
    /真正值得读的，不是某个孤立知识点|背后的产业判断、工程取舍和商业后果|重点不是记住每个参数|解决了什么瓶颈、牺牲了什么、为什么现在值得讨论|具体判断以后文的字幕证据为准/,
    /这部分没有生成到有效内容|需要重新跑一次|当前摘要没有返回可靠时间线/,
    /(?:^|\n)#{1,6}\s*.*YouTube\s*技术笔记/i,
    /<\/?details|<summary/i
  ];
  const hit = forbidden.find((pattern) => pattern.test(articleText));
  if (hit) throw new Error(`YouTube Feishu document failed quality gate: ${hit}`);
  auditYoutubeFinishedDocument(text);
}

function youtubeArticlePartsSourceKey(sourceUrl = "") {
  return researchHash(String(sourceUrl || "").trim().toLowerCase());
}

function summarizeYoutubeArticleParts(cache = {}) {
  const parts = cache?.parts && typeof cache.parts === "object" ? cache.parts : {};
  const entries = Object.entries(parts);
  const done = entries.filter(([, part]) => part?.status === "done").length;
  const failed = entries.filter(([, part]) => part?.status === "failed").length;
  return {
    total: entries.length,
    done,
    failed,
    succeeded: done,
    failedParts: entries.filter(([, part]) => part?.status === "failed").map(([name]) => name),
    cachedPartNames: entries.filter(([, part]) => part?.status === "done").map(([name]) => name),
    updatedAt: cache.updatedAt || ""
  };
}

function isFreshYoutubeArticlePartsCache(cache = {}, sourceKey = "") {
  if (!cache || typeof cache !== "object") return false;
  if (sourceKey && cache.sourceKey && cache.sourceKey !== sourceKey) return false;
  if (!cache.parts || typeof cache.parts !== "object") return false;
  const expiresAt = Date.parse(cache.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function buildYoutubeArticlePartsCache({ sourceKey = "", parts = {}, recoveredFromJobId = "" } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + YOUTUBE_ARTICLE_PART_CACHE_TTL_MS);
  return {
    cacheVersion: 1,
    sourceKey,
    recoveredFromJobId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    parts: parts && typeof parts === "object" ? parts : {}
  };
}

function markYoutubeArticlePart(cache = {}, partName = "", part = {}) {
  const now = new Date();
  return {
    ...cache,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + YOUTUBE_ARTICLE_PART_CACHE_TTL_MS).toISOString(),
    parts: {
      ...(cache.parts || {}),
      [partName]: {
        ...part,
        updatedAt: now.toISOString()
      }
    }
  };
}

function researchHash(value = "") {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function researchSourceId(kind = "source", value = "") {
  return `${kind}:${researchHash(value || `${kind}:${Date.now()}`)}`;
}

function normalizeResearchEntityName(value = "") {
  return cleanArticleText(value, 120).replace(/^[-*#\s]+/, "").trim();
}

function classifyResearchEvidenceType(text = "") {
  const value = String(text || "").toLowerCase();
  if (/(cost|price|capex|opex|margin|revenue|valuation|tam|sam|som)/i.test(value)) return "market_financial";
  if (/(capacity|production|factory|supply|shipment|manufactur|yield|inventory)/i.test(value)) return "supply_chain";
  if (/(policy|regulation|license|faa|fcc|sec|approval|law)/i.test(value)) return "regulatory";
  if (/(risk|failure|delay|constraint|bottleneck|uncertain|competition)/i.test(value)) return "risk";
  if (/(customer|contract|order|adoption|commercial|deployment)/i.test(value)) return "commercialization";
  if (/(engine|model|chip|robot|rocket|software|hardware|architecture|technology|technical)/i.test(value)) return "technology";
  return "general_evidence";
}

function inferResearchEntityType(name = "") {
  const value = String(name || "");
  if (/(inc\.?|corp\.?|ltd\.?|llc|company|technologies|labs|systems|space|ai)$/i.test(value)) return "company";
  if (/^[A-Z][A-Za-z0-9+.-]{1,24}$/.test(value)) return "technology_or_product";
  return "topic";
}

function buildResearchEntitiesFromEvidenceBrief(brief = {}, videos = []) {
  const entities = [];
  const push = (name, role = "mentioned", entityType = "") => {
    const clean = normalizeResearchEntityName(name);
    if (!clean) return;
    const type = entityType || inferResearchEntityType(clean);
    entities.push({
      entityId: researchSourceId(`entity:${type}`, clean.toLowerCase()),
      name: clean,
      entityType: type,
      role
    });
  };
  for (const anchor of brief.backgroundAnchors || []) push(anchor, "background_anchor");
  for (const item of brief.glossarySeeds || []) push(item.term, "glossary_term", "technology_or_concept");
  for (const video of videos || []) {
    if (video.channel) push(video.channel, "publisher", "organization");
  }
  return mergeUniqueBy(entities, (item) => item.entityId, 40);
}

function buildResearchEvidenceCardsFromBrief(brief = {}) {
  const claims = [
    ...asArray(brief.evidenceClaims).map((item) => ({
      claim: item.claim,
      quoteOriginal: item.quote,
      location: item.timestamp,
      whyItMatters: item.whyItMatters
    })),
    ...asArray(brief.timelineSeeds).map((item) => ({
      claim: item.event,
      quoteOriginal: item.quote,
      location: item.time || item.timestamp,
      whyItMatters: item.importance || item.whyItMatters
    }))
  ];
  return mergeUniqueBy(claims, (item) => `${item.location}|${item.quoteOriginal || item.claim}`, 40)
    .filter((item) => item.claim || item.quoteOriginal)
    .map((item) => {
      const text = [item.claim, item.quoteOriginal, item.whyItMatters].filter(Boolean).join(" ");
      const lens = classifyResearchEvidenceType(text);
      return {
        evidenceType: lens,
        claim: cleanArticleText(item.claim || item.quoteOriginal, 900),
        quoteOriginal: cleanArticleText(item.quoteOriginal || "", 1400),
        quoteZh: "",
        location: cleanArticleText(item.location || "", 80),
        whyItMatters: cleanArticleText(item.whyItMatters || "", 900),
        confidence: 0.72,
        timeSensitivity: "medium",
        staleRisk: "",
        evidenceStrength: "primary_transcript",
        analysisLens: lens,
        requiresRecheck: []
      };
    });
}

function buildResearchCoverageGapsForYoutube(report = {}, videos = []) {
  const first = videos[0] || {};
  const gaps = [];
  if (!first.publishedTimeText) {
    gaps.push({
      gap: "source_published_at_not_normalized",
      impact: "The public video metadata did not provide a normalized publication date, so later time-series comparisons should recheck the original platform page.",
      fallbackSignals: ["platform_metadata", "channel_page", "web_search_timestamp"],
      confidenceImpact: "medium"
    });
  }
  gaps.push({
    gap: "recorded_at_usually_unknown_for_video",
    impact: "Video publication time may differ from recording time; industry-stage conclusions should treat recording date as unknown until externally verified.",
    fallbackSignals: ["spoken_date_references", "event_mentions", "channel_description", "related_news_dates"],
    confidenceImpact: "medium"
  });
  if ((videos || []).length < 2) {
    gaps.push({
      gap: "single_source_material",
      impact: "This source is useful as a research signal, but investment synthesis should compare it with disclosures, filings, industry data, expert interviews, and regulatory records.",
      fallbackSignals: ["company_disclosure", "regulatory_filing", "industry_report", "paper", "news", "webpage", "dataset"],
      confidenceImpact: "high"
    });
  }
  if (!report.evidenceBrief?.questionSeeds?.length) {
    gaps.push({
      gap: "follow_up_questions_need_cross_source_validation",
      impact: "Initial research questions should be routed to broader source types before producing a formal investment conclusion.",
      fallbackSignals: ["reference_source_registry", "contrarian_sources", "updated_primary_data"],
      confidenceImpact: "medium"
    });
  }
  return gaps;
}

function buildResearchKnowledgeBundleFromYoutubeReport(report = {}, { doc = {}, sync = {} } = {}) {
  const videos = report.videos || [];
  const first = videos[0] || {};
  const sourceUrl = first.url || report.request?.videoUrl || report.request?.query || report.title || "";
  const rawText = videos.map((video, index) => compactLines([
    `Video ${index + 1}: ${video.title || ""}`,
    video.url ? `URL: ${video.url}` : "",
    video.channel ? `Channel: ${video.channel}` : "",
    video.publishedTimeText ? `Published: ${video.publishedTimeText}` : "",
    video.transcriptText || ""
  ])).join("\n\n---\n\n");
  const evidenceBrief = normalizeYoutubeEvidenceBrief(
    report.evidenceBrief || buildDeterministicYoutubeEvidenceBrief({ topic: report.topic, videos }),
    report
  );
  const sourceId = researchSourceId("source", sourceUrl || rawText.slice(0, 500));
  const questions = asArray(evidenceBrief.questionSeeds).map((question, index) => ({
    question,
    priority: Math.min(5, index + 1),
    researchDirection: "cross_source_validation",
    suggestedSourceTypes: [
      "company_disclosure",
      "regulatory_filing",
      "industry_report",
      "paper",
      "news",
      "webpage",
      "expert_interview",
      "dataset",
      "video",
      "patent",
      "job_posting",
      "conference"
    ],
    status: "open"
  }));
  return {
    topics: [
      {
        name: report.topic || report.request?.query || report.title || first.title || "",
        topicType: "theme",
        role: "report_topic",
        aliases: [report.title, first.title, sourceUrl].filter(Boolean)
      },
      ...asArray(evidenceBrief.backgroundAnchors).slice(0, 8).map((name) => ({
        name,
        topicType: "theme",
        role: "background_anchor"
      })),
      ...asArray(evidenceBrief.glossarySeeds).slice(0, 10).map((item) => ({
        name: item.term,
        topicType: "technology_or_concept",
        role: "glossary_term"
      }))
    ].filter((item) => item.name),
    source: {
      sourceId,
      sourceType: "video",
      platform: "youtube",
      url: sourceUrl,
      title: report.title || first.title || "",
      author: first.channel || "",
      organization: first.channel || "",
      publishedAt: first.publishedTimeText || "",
      recordedAt: "",
      eventPeriod: first.publishedTimeText || "",
      fetchedAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      language: first.language || "",
      durationText: first.lengthText || "",
      rawText,
      rawTextHash: researchHash(rawText),
      docUrl: doc.url || "",
      obsidianPath: sync.notePath || "",
      reliabilityLevel: "source_transcript",
      sourcePerspective: "primary_or_expert_video",
      institutionType: "primary_video",
      institutionRole: "source_material",
      analysisLenses: ["technology", "industry_chain", "commercialization", "risk", "time_context"],
      evidenceStrength: "primary_transcript",
      accessLevel: "public",
      conflictProfile: "platform_or_speaker_bias_possible",
      metadata: {
        adapter: "youtube",
        reportTopic: report.topic || "",
        videoCount: videos.length,
        docCreated: Boolean(doc.created),
        obsidianSynced: Boolean(sync.synced),
        transcriptSegments: videos.reduce((sum, video) => sum + Number(video.segmentCount || 0), 0),
        principles: [
          "evidence_before_opinion",
          "time_context_first_class",
          "coverage_gaps_reduce_confidence",
          "do_not_generate_garbage_then_reject"
        ]
      }
    },
    evidenceCards: buildResearchEvidenceCardsFromBrief(evidenceBrief),
    entities: buildResearchEntitiesFromEvidenceBrief(evidenceBrief, videos),
    timeContext: {
      videoPublishedAt: first.publishedTimeText || "",
      likelyRecordedAt: "",
      eventPeriod: first.publishedTimeText || "",
      industryStageAtThatTime: "",
      currentRelevance: evidenceBrief.narrativeConflict || evidenceBrief.thesis || "",
      timeSensitivity: "medium",
      staleIf: "Company progress, prices, capacity, regulation, product roadmap, or customer adoption changes materially.",
      requiresRecheck: ["price", "capacity", "funding", "policy", "product_progress", "customer_orders", "technical_metrics"],
      metadata: {
        publicationDateNeedsNormalization: !first.publishedTimeText,
        recordedAtKnown: false
      }
    },
    questions,
    coverageGaps: buildResearchCoverageGapsForYoutube(report, videos)
  };
}

function extractBackfillEvidenceCardsFromDocument(text = "", { max = 18 } = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .filter((line) => line.length >= 24 && line.length <= 900)
    .filter((line) => !/^(来源|出处|原始链接|飞书文档|Obsidian|触发请求)[:：]/i.test(line))
    .filter((line) => !isLowValueResearchArtifactText(line))
    .map((line) => cleanResearchEvidenceText(line, 900))
    .filter((line) => line && !isLowValueResearchArtifactText(line));
  const picked = [];
  const preferred = lines.filter((line) => /结论|判断|证据|重要|风险|瓶颈|成本|产能|供应链|技术|商业|时间|为什么|意味着|关键|反证/.test(line));
  for (const line of [...preferred, ...lines]) {
    if (picked.some((item) => item === line || item.includes(line) || line.includes(item))) continue;
    picked.push(line);
    if (picked.length >= max) break;
  }
  return picked.map((line, index) => {
    const lens = classifyResearchEvidenceType(line);
    return {
      evidenceType: lens,
      claim: cleanResearchEvidenceText(line, 900),
      quoteOriginal: "",
      quoteZh: "",
      location: `generated_doc:${index + 1}`,
      whyItMatters: "This evidence was backfilled from an existing reader-facing YouTube document so it can participate in cross-source research synthesis.",
      confidence: 0.58,
      timeSensitivity: "medium",
      staleRisk: "Backfilled from a generated document; recheck the original transcript or source link before using as a high-confidence investment conclusion.",
      evidenceStrength: "generated_article_backfill",
      analysisLens: lens,
      requiresRecheck: ["original_transcript", "publication_date", "cross_source_validation"]
    };
  });
}

function buildResearchKnowledgeBundleFromYoutubeHistoryDoc(history = {}, rawText = "", request = {}) {
  const metadata = history.metadata || {};
  const docUrl = metadata.feishuDocUrl || "";
  const title =
    cleanYoutubeDocumentTitle(metadata.title || "") ||
    cleanArticleText(String(rawText || "").match(/^#\s+(.+)$/m)?.[1] || "", 160) ||
    cleanArticleText(String(history.content || "").split(/\r?\n/).find(Boolean) || request.query || "YouTube research document", 160);
  const sourceId = researchSourceId("source:youtube_doc_backfill", docUrl || title);
  const evidenceCards = extractBackfillEvidenceCardsFromDocument(rawText, { max: 18 });
  const entities = mergeUniqueBy([
    ...extractYoutubeQuestionKeywords([request.query, title, rawText.slice(0, 4000)].join("\n"), 12).map((name) => ({
      entityId: researchSourceId("entity:topic", String(name).toLowerCase()),
      name,
      entityType: inferResearchEntityType(name),
      role: "backfilled_topic"
    }))
  ], (item) => item.entityId, 20);
  return {
    topics: [
      {
        name: request.query || metadata.topic || title,
        topicType: "theme",
        role: "report_topic",
        aliases: [title, metadata.title].filter(Boolean)
      },
      ...entities.slice(0, 12).map((entity) => ({
        name: entity.name,
        topicType: entity.entityType || "theme",
        role: entity.role || "backfilled_topic"
      }))
    ].filter((item) => item.name),
    source: {
      sourceId,
      sourceType: "video_article_backfill",
      platform: "feishu_youtube_doc",
      url: metadata.sourceUrl || metadata.originalUrl || "",
      title,
      author: metadata.channel || "",
      organization: metadata.channel || "",
      publishedAt: "",
      recordedAt: "",
      eventPeriod: "",
      fetchedAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      language: "zh-CN",
      durationText: "",
      rawText,
      rawTextHash: researchHash(rawText),
      docUrl,
      obsidianPath: metadata.obsidianPath || "",
      reliabilityLevel: "generated_reader_document",
      sourcePerspective: "backfilled_youtube_article",
      institutionType: "public_video_summary",
      institutionRole: "source_material_backfill",
      analysisLenses: ["technology", "industry_chain", "commercialization", "risk", "time_context"],
      evidenceStrength: "generated_article_backfill",
      accessLevel: "private_knowledge_base",
      conflictProfile: "summary_generation_bias_possible",
      metadata: {
        adapter: "youtube_history_backfill",
        reportTopic: metadata.topic || request.query || "",
        originalMessageCreatedAt: history.createdAt || history.created_at || "",
        backfillCreatedAt: new Date().toISOString(),
        requiresOriginalTranscriptRecheck: true
      }
    },
    evidenceCards,
    entities,
    timeContext: {
      videoPublishedAt: "",
      likelyRecordedAt: "",
      eventPeriod: "",
      industryStageAtThatTime: "",
      currentRelevance: cleanArticleText(rawText.slice(0, 900), 900),
      timeSensitivity: "medium",
      staleIf: "The original video, company progress, regulation, production status, or market environment changed after this document was generated.",
      requiresRecheck: ["original_transcript", "source_date", "company_progress", "regulation", "cross_source_validation"],
      metadata: {
        backfilledFromGeneratedDocument: true,
        originalDocUrl: docUrl
      }
    },
    questions: [
      {
        question: `哪些原始字幕、官方材料、监管记录或产业数据可以验证「${request.query || title}」这条研究线？`,
        priority: 1,
        researchDirection: "cross_source_validation",
        suggestedSourceTypes: ["video", "company_disclosure", "regulatory_record", "industry_report", "dataset", "paper", "news"]
      }
    ],
    coverageGaps: [
      {
        gap: "backfilled_from_generated_reader_document",
        impact: "This source was recovered from an existing reader document rather than the original transcript ingestion path; use it to recover research continuity, but recheck primary source material before high-confidence conclusions.",
        fallbackSignals: ["original_transcript", "youtube_metadata", "company_disclosure", "regulatory_record", "industry_data"],
        confidenceImpact: "medium"
      }
    ]
  };
}

function researchSourceIdForYoutubeHistoryDoc(history = {}, request = {}) {
  const metadata = history.metadata || {};
  const docUrl = metadata.feishuDocUrl || "";
  const title = cleanArticleText(String(history.content || "").split(/\r?\n/).find(Boolean) || request.query || "YouTube research document", 160);
  return researchSourceId("source:youtube_doc_backfill", docUrl || title);
}

function researchRowValue(row = {}, camel = "", snake = "") {
  return row?.[camel] ?? row?.[snake || camel] ?? "";
}

function normalizeResearchSourceRow(row = {}, index = 0) {
  const sourceId = String(researchRowValue(row, "sourceId", "source_id") || "");
  const rawTitle = row.title || "";
  const cleanTitle = cleanResearchArticleText(rawTitle, 220);
  return {
    id: `S${index + 1}`,
    sourceId,
    sourceType: readerResearchPhrase(researchRowValue(row, "sourceType", "source_type") || ""),
    platform: readerResearchPhrase(row.platform || ""),
    title: cleanTitle || cleanResearchArticleText(researchRowValue(row, "docUrl", "doc_url") ? "历史 YouTube 研究文档" : "Untitled source", 220),
    organization: cleanResearchArticleText(row.organization || row.author || "", 160),
    url: String(row.url || ""),
    docUrl: String(researchRowValue(row, "docUrl", "doc_url") || ""),
    publishedAt: String(researchRowValue(row, "publishedAt", "published_at") || ""),
    recordedAt: String(researchRowValue(row, "recordedAt", "recorded_at") || ""),
    eventPeriod: String(researchRowValue(row, "eventPeriod", "event_period") || ""),
    reliabilityLevel: readerResearchPhrase(researchRowValue(row, "reliabilityLevel", "reliability_level") || ""),
    evidenceStrength: readerResearchPhrase(researchRowValue(row, "evidenceStrength", "evidence_strength") || ""),
    conflictProfile: readerResearchPhrase(researchRowValue(row, "conflictProfile", "conflict_profile") || "")
  };
}

function readerResearchPhrase(value = "") {
  const text = cleanResearchArticleText(value, 900);
  if (!text) return "";
  if (/^low$/i.test(text)) return "低";
  if (/^medium$/i.test(text)) return "中等";
  if (/^high$/i.test(text)) return "高";
  if (/^low-to-medium$/i.test(text)) return "低到中等";
  if (/^video_article_backfill$/i.test(text)) return "历史 YouTube 文档回填";
  if (/^feishu_youtube_doc$/i.test(text)) return "飞书 YouTube 研究文档";
  if (/^generated_reader_document$/i.test(text)) return "历史生成文档";
  if (/^generated_article_backfill$/i.test(text)) return "历史文档回填证据";
  if (/^summary_generation_bias_possible$/i.test(text)) return "来源来自历史生成文档，可能存在摘要二次加工偏差，关键判断需回到原文核对。";
  if (/^backfilled_from_generated_reader_document$/i.test(text)) return "该线索来自历史读者文档回填，不是一手原始资料。";
  if (/This evidence was backfilled from an existing reader-facing YouTube document/i.test(text)) {
    return "该证据来自历史读者文档回填，可用于保持研究连续性，但不能替代原始字幕、公告或监管记录。";
  }
  if (/Backfilled from a generated document/i.test(text)) {
    return "该证据来自历史生成文档回填，形成高置信结论前需要回到原始资料复核。";
  }
  if (/This source was recovered from an existing reader document/i.test(text)) {
    return "该来源由历史读者文档回填，可用于恢复研究线索，但高置信结论必须复核原始资料。";
  }
  if (/The original video, company progress, regulation, production status, or market environment changed/i.test(text)) {
    return "若原视频背景、公司进展、监管状态、产能进度或市场环境已变化，本判断需要重新复核。";
  }
  return text;
}

function readerEvidenceLocation(value = "") {
  const text = cleanResearchEvidenceText(value, 120);
  if (!text) return "";
  const generated = text.match(/^generated_doc:(\d+)/i);
  if (generated) return `历史文档摘录 ${generated[1]}`;
  return readerResearchPhrase(text);
}

function normalizeResearchEvidenceRow(row = {}, index = 0, sourceIndexById = new Map()) {
  const sourceId = String(researchRowValue(row, "sourceId", "source_id") || "");
  return {
    id: `E${index + 1}`,
    sourceId,
    sourceRef: sourceIndexById.get(sourceId) || sourceId || "S?",
    evidenceType: String(researchRowValue(row, "evidenceType", "evidence_type") || ""),
    claim: cleanResearchEvidenceText(row.claim || "", 500),
    quoteOriginal: cleanResearchEvidenceText(researchRowValue(row, "quoteOriginal", "quote_original") || "", 500),
    quoteZh: cleanResearchEvidenceText(researchRowValue(row, "quoteZh", "quote_zh") || "", 500),
    location: readerEvidenceLocation(row.location || ""),
    whyItMatters: readerResearchPhrase(researchRowValue(row, "whyItMatters", "why_it_matters") || ""),
    confidence: Number(row.confidence || 0),
    timeSensitivity: readerResearchPhrase(researchRowValue(row, "timeSensitivity", "time_sensitivity") || ""),
    evidenceStrength: readerResearchPhrase(researchRowValue(row, "evidenceStrength", "evidence_strength") || ""),
    analysisLens: readerResearchPhrase(researchRowValue(row, "analysisLens", "analysis_lens") || "")
  };
}

function buildInvestmentReportEvidencePack(corpus = {}) {
  const sources = (corpus.sources || []).map(normalizeResearchSourceRow);
  const sourceIndexById = new Map(sources.map((source) => [source.sourceId, source.id]));
  const evidenceCards = (corpus.evidenceCards || [])
    .map((row, index) => normalizeResearchEvidenceRow(row, index, sourceIndexById))
    .filter((card) => card.claim || card.quoteOriginal)
    .slice(0, 120);
  const entities = mergeUniqueBy((corpus.entities || []).map((row) => ({
    name: cleanResearchArticleText(row.name || "", 120),
    entityType: cleanResearchArticleText(researchRowValue(row, "entityType", "entity_type") || "", 80),
    role: cleanResearchArticleText(row.role || "", 80),
    sourceRef: sourceIndexById.get(String(researchRowValue(row, "sourceId", "source_id") || "")) || ""
  })).filter((item) => item.name), (item) => `${item.name}|${item.entityType}|${item.role}`, 80);
  const timeContexts = (corpus.timeContexts || []).map((row) => ({
    sourceRef: sourceIndexById.get(String(researchRowValue(row, "sourceId", "source_id") || "")) || "",
    videoPublishedAt: cleanResearchArticleText(researchRowValue(row, "videoPublishedAt", "video_published_at") || "", 120),
    likelyRecordedAt: cleanResearchArticleText(researchRowValue(row, "likelyRecordedAt", "likely_recorded_at") || "", 120),
    eventPeriod: cleanResearchArticleText(researchRowValue(row, "eventPeriod", "event_period") || "", 120),
    currentRelevance: cleanResearchArticleText(researchRowValue(row, "currentRelevance", "current_relevance") || "", 500),
    timeSensitivity: readerResearchPhrase(researchRowValue(row, "timeSensitivity", "time_sensitivity") || ""),
    staleIf: readerResearchPhrase(researchRowValue(row, "staleIf", "stale_if") || "")
  }));
  const questions = (corpus.questions || []).map((row) => ({
    sourceRef: sourceIndexById.get(String(researchRowValue(row, "sourceId", "source_id") || "")) || "",
    question: cleanResearchArticleText(row.question || "", 500),
    priority: Number(row.priority || 3),
    researchDirection: cleanResearchArticleText(researchRowValue(row, "researchDirection", "research_direction") || "", 120)
  })).filter((item) => item.question);
  const coverageGaps = (corpus.coverageGaps || []).map((row) => ({
    sourceRef: sourceIndexById.get(String(researchRowValue(row, "sourceId", "source_id") || "")) || "",
    gap: readerResearchPhrase(row.gap || ""),
    impact: readerResearchPhrase(row.impact || ""),
    confidenceImpact: readerResearchPhrase(researchRowValue(row, "confidenceImpact", "confidence_impact") || "")
  })).filter((item) => item.gap);
  return { sources, evidenceCards, entities, timeContexts, questions, coverageGaps, topicMap: normalizeInvestmentTopicMap(corpus.topicMap || { topics: [], edges: [] }) };
}

function normalizeInvestmentTopicMap(topicMap = {}) {
  const topics = (topicMap.topics || []).map((topic) => {
    const topicKey = cleanResearchArticleText(topic.topicKey || topic.topic_key || "", 120);
    const canonicalName =
      cleanResearchArticleText(topic.canonicalName || topic.canonical_name || "", 160) ||
      cleanResearchArticleText(topic.name || "", 160) ||
      topicKey;
    const aliases = asArray(topic.aliases)
      .filter((item) => !isLowValueResearchArtifactText(item))
      .filter((item) => !/^https?:\/\//i.test(String(item || "").trim()))
      .map((item) => cleanResearchEvidenceText(item, 160))
      .filter(Boolean)
      .filter((item) => item !== canonicalName)
      .filter((item) => item.length <= 80)
      .slice(0, 8);
    return {
      ...topic,
      topicKey,
      topic_key: topicKey,
      canonicalName,
      canonical_name: canonicalName,
      topicType: cleanResearchArticleText(topic.topicType || topic.topic_type || "theme", 80) || "theme",
      topic_type: cleanResearchArticleText(topic.topicType || topic.topic_type || "theme", 80) || "theme",
      aliases
    };
  }).filter((topic) => topic.canonicalName || topic.topicKey);
  const edges = (topicMap.edges || []).map((edge) => ({
    ...edge,
    fromTopicKey: cleanResearchArticleText(edge.fromTopicKey || edge.from_topic_key || "", 120),
    from_topic_key: cleanResearchArticleText(edge.fromTopicKey || edge.from_topic_key || "", 120),
    fromName: cleanResearchArticleText(edge.fromName || edge.from_name || "", 160),
    from_name: cleanResearchArticleText(edge.fromName || edge.from_name || "", 160),
    toTopicKey: cleanResearchArticleText(edge.toTopicKey || edge.to_topic_key || "", 120),
    to_topic_key: cleanResearchArticleText(edge.toTopicKey || edge.to_topic_key || "", 120),
    toName: cleanResearchArticleText(edge.toName || edge.to_name || "", 160),
    to_name: cleanResearchArticleText(edge.toName || edge.to_name || "", 160),
    edgeType: cleanResearchArticleText(edge.edgeType || edge.edge_type || "related_to", 80) || "related_to",
    edge_type: cleanResearchArticleText(edge.edgeType || edge.edge_type || "related_to", 80) || "related_to"
  })).filter((edge) =>
    (edge.fromName || edge.fromTopicKey || edge.from_topic_key) &&
    (edge.toName || edge.toTopicKey || edge.to_topic_key)
  );
  return { topics, edges };
}

function assessInvestmentReportReadiness(pack = {}) {
  const sourceCount = (pack.sources || []).length;
  const evidenceCount = (pack.evidenceCards || []).length;
  if (sourceCount < 2) {
    return {
      ready: false,
      reason: "evidence_sources_too_few",
      message: `当前只检索到 ${sourceCount} 个相关来源。投研报告至少需要 2 个以上来源交叉验证，避免把单一视频包装成结论。`
    };
  }
  if (evidenceCount < 6) {
    return {
      ready: false,
      reason: "evidence_cards_too_few",
      message: `当前只检索到 ${evidenceCount} 条相关证据卡。投研报告至少需要 6 条以上证据，建议先继续喂相关视频、报告、网页或论文。`
    };
  }
  return { ready: true, reason: "" };
}

function investmentReportTopicGraphPrompt(topicMap = {}) {
  const topics = (topicMap.topics || []).slice(0, 60).map((topic) => [
    topic.canonicalName || topic.canonical_name || topic.topicKey || topic.topic_key,
    topic.topicType || topic.topic_type ? `type=${topic.topicType || topic.topic_type}` : "",
    (topic.aliases || []).length ? `aliases=${(topic.aliases || []).slice(0, 6).join("/")}` : ""
  ].filter(Boolean).join(" | "));
  const edges = (topicMap.edges || []).slice(0, 80).map((edge) => [
    `${edge.fromName || edge.fromTopicKey || edge.from_topic_key || "?"} -> ${edge.toName || edge.toTopicKey || edge.to_topic_key || "?"}`,
    edge.edgeType || edge.edge_type ? `edge=${edge.edgeType || edge.edge_type}` : "",
    edge.confidence ? `confidence=${edge.confidence}` : "",
    edge.evidenceCount || edge.evidence_count ? `evidence_count=${edge.evidenceCount || edge.evidence_count}` : ""
  ].filter(Boolean).join(" | "));
  return compactLines([
    "Topic graph:",
    topics.length ? topics.join("\n") : "No graph nodes yet. Build the topic boundary from evidence, but do not invent unsupported nodes.",
    "",
    "Topic edges:",
    edges.length ? edges.join("\n") : "No graph edges yet. Infer only evidence-grounded relationships and mark gaps."
  ]);
}

function investmentReportPriorPrompt(priorReport = null) {
  if (!priorReport) return "Prior report baseline: none. This is the first version for this topic.";
  const output = priorReport.output || {};
  const metadata = priorReport.metadata || {};
  const priorTitle = cleanResearchArticleText(metadata.title || output.title || "", 180);
  const priorOneSentence = cleanResearchArticleText(metadata.oneSentence || "", 500);
  const priorThesis = cleanResearchArticleText(metadata.thesis || "", 700);
  const priorDeltaSummary = cleanResearchArticleText(priorReport.deltaSummary || "", 700);
  return compactLines([
    "Prior report baseline:",
    `version=${priorReport.versionNo || "unknown"}`,
    priorReport.evidenceCutoffAt ? `evidence_cutoff=${priorReport.evidenceCutoffAt}` : "",
    priorTitle ? `prior_title=${priorTitle}` : "",
    priorOneSentence ? `prior_one_sentence=${priorOneSentence}` : "",
    priorThesis ? `prior_thesis=${priorThesis}` : "",
    priorDeltaSummary ? `prior_delta_summary=${priorDeltaSummary}` : "",
    "Hard rule: this prior report is only a previous thesis baseline. It is not evidence, must not be cited as evidence, must not increase source count or evidence count, and must not be used to prove a hypothesis. Use it only to explain what changed, what strengthened, what weakened, and what still needs validation."
  ]);
}

function investmentReportEvidencePrompt(pack = {}) {
  const sourceLines = (pack.sources || []).map((source) => [
    `${source.id}. ${source.title || "Untitled source"}`,
    source.organization ? `org=${source.organization}` : "",
    source.sourceType ? `type=${source.sourceType}` : "",
    source.publishedAt ? `published=${source.publishedAt}` : "",
    source.recordedAt ? `recorded=${source.recordedAt}` : "",
    source.eventPeriod ? `period=${source.eventPeriod}` : "",
    source.reliabilityLevel ? `reliability=${source.reliabilityLevel}` : "",
    source.conflictProfile ? `conflict=${source.conflictProfile}` : ""
  ].filter(Boolean).join(" | "));
  const evidenceLines = (pack.evidenceCards || []).map((card) => [
    `${card.id} [${card.sourceRef}${card.location ? ` ${card.location}` : ""}]`,
    card.evidenceType ? `lens=${card.evidenceType}` : "",
    card.claim ? `claim=${card.claim}` : "",
    card.quoteOriginal ? `quote=${card.quoteOriginal}` : "",
    card.whyItMatters ? `why=${card.whyItMatters}` : "",
    card.timeSensitivity ? `time=${card.timeSensitivity}` : ""
  ].filter(Boolean).join(" | "));
  const entityLines = (pack.entities || []).slice(0, 50).map((entity) =>
    `${entity.name}${entity.entityType ? ` (${entity.entityType})` : ""}${entity.role ? ` role=${entity.role}` : ""}${entity.sourceRef ? ` source=${entity.sourceRef}` : ""}`
  );
  const gapLines = (pack.coverageGaps || []).map((gap) =>
    `${gap.sourceRef ? `${gap.sourceRef} ` : ""}${gap.gap}${gap.impact ? ` | impact=${gap.impact}` : ""}${gap.confidenceImpact ? ` | confidence=${gap.confidenceImpact}` : ""}`
  );
  const questionLines = (pack.questions || []).slice(0, 30).map((question) =>
    `${question.sourceRef ? `${question.sourceRef} ` : ""}${question.question}${question.researchDirection ? ` | direction=${question.researchDirection}` : ""}`
  );
  return compactLines([
    investmentReportTopicGraphPrompt(pack.topicMap || {}),
    "",
    investmentReportPriorPrompt(pack.priorReport || null),
    "",
    "Sources:",
    sourceLines.join("\n"),
    "",
    "Evidence cards:",
    evidenceLines.join("\n"),
    "",
    "Entities:",
    entityLines.join("\n"),
    "",
    "Coverage gaps:",
    gapLines.join("\n"),
    "",
    "Existing follow-up questions:",
    questionLines.join("\n")
  ]).slice(0, 70000);
}

function investmentReportSynthesisSystemPrompt() {
  return [
    generationFirstPrinciplesText(),
    "You are a senior long-term industry-chain investment research analyst.",
    "Your job is to synthesize a research report from a bounded evidence pack, not from general knowledge.",
    "Return only one valid JSON object. Do not return Markdown.",
    "Write in Simplified Chinese.",
    "Every important hypothesis must cite evidence IDs from the provided evidence pack, such as E1 or E7.",
    "If evidence is weak, say it is weak and convert it into a research task instead of pretending it is proven.",
    "Define the topic boundary, value-chain map, time context, and what changed versus the prior baseline if any.",
    "Do not narrow an open industry topic into a single company unless the evidence proves the company is the right anchor.",
    "Focus on long-term industry-chain value, inflection points, value-chain nodes, leading indicators, counter-evidence, and time-context risks.",
    "Do not give short-term trading calls, target prices, or direct buy/sell advice.",
    "Do not mention Feishu, Obsidian, prompt, JSON, or generation process."
  ].join(" ");
}

function normalizeEvidenceIds(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeEvidenceIds(item)).slice(0, 12);
  }
  return String(value || "").match(/\bE\d+\b/g) || [];
}

function normalizeReportListItem(item, itemMax = 500) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const title = cleanResearchArticleText(item.title || item.name || item.node || item.segment || item.horizon || item.scenario || "", 120);
    const body = cleanResearchArticleText(
      item.summary || item.logic || item.why || item.whyItMatters || item.condition || item.implication || item.watch || item.event || item.risk || item.task || item.description || "",
      itemMax
    );
    const evidence = normalizeEvidenceIds(item.evidenceIds || item.evidence).slice(0, 4).join("、");
    return cleanResearchArticleText([
      title,
      body ? `${title ? "：" : ""}${body}` : "",
      evidence ? `（证据：${evidence}）` : ""
    ].join(""), itemMax);
  }
  return cleanResearchArticleText(item, itemMax);
}

function normalizeReportList(value, max = 10, itemMax = 500) {
  return asArray(value).map((item) => normalizeReportListItem(item, itemMax)).filter(Boolean).slice(0, max);
}

function evidenceAnchor(id = "") {
  const value = String(id || "").trim().toLowerCase();
  return value ? `#证据-${value}` : "";
}

function evidenceMarkdownLink(id = "") {
  const value = String(id || "").trim().toUpperCase();
  const anchor = evidenceAnchor(value);
  return value && anchor ? `[证据 ${value}](${anchor})` : "";
}

function normalizeInvestmentReportStructured(raw = {}, request = {}) {
  const fallbackTitle = cleanResearchArticleText(request.query || "产业链投研报告", 80) || "产业链投研报告";
  const cleanTitle = cleanResearchArticleText(raw.title || "", 120);
  return {
    title: cleanTitle || `${fallbackTitle}：产业链证据与下一步调研`,
    oneSentence: cleanResearchArticleText(raw.oneSentence || raw.summary || "", 500),
    thesis: cleanResearchArticleText(raw.thesis || raw.coreThesis || "", 900),
    topicBoundary: cleanResearchArticleText(raw.topicBoundary || raw.boundary || "", 900),
    industryMap: asArray(raw.industryMap || raw.valueChainMap).map((item) => cleanResearchArticleText(item, 500)).filter(Boolean).slice(0, 10),
    timeCalibration: asArray(raw.timeCalibration || raw.timeContext).map((item) => cleanResearchArticleText(item, 500)).filter(Boolean).slice(0, 10),
    deltaSincePrior: cleanResearchArticleText(raw.deltaSincePrior || raw.versionDelta || "", 900),
    evidenceBase: asArray(raw.evidenceBase || raw.evidenceSummary).map((item) => cleanResearchArticleText(item, 500)).filter(Boolean).slice(0, 8),
    investableMap: normalizeReportList(raw.investableMap || raw.investmentMap || raw.publicMarketMap, 10, 500),
    valuePools: normalizeReportList(raw.valuePools || raw.profitPools || raw.marketMap, 10, 500),
    peerComparison: normalizeReportList(raw.peerComparison || raw.competitiveLandscape || raw.alternativeRoutes, 10, 500),
    hypotheses: asArray(raw.hypotheses || raw.industryChainHypotheses).map((item) => ({
      title: cleanResearchArticleText(item.title || item.hypothesis || "", 180),
      logic: cleanResearchArticleText(item.logic || item.why || "", 800),
      evidenceIds: normalizeEvidenceIds(item.evidenceIds || item.evidence).slice(0, 8),
      counterEvidenceIds: normalizeEvidenceIds(item.counterEvidenceIds || item.counterEvidence).slice(0, 6),
      timeRisk: cleanResearchArticleText(item.timeRisk || item.staleRisk || "", 500),
      confidence: cleanResearchArticleText(item.confidence || "", 80)
    })).filter((item) => item.title || item.logic).slice(0, 6),
    valueChainNodes: asArray(raw.valueChainNodes || raw.nodes).map((item) => ({
      node: cleanResearchArticleText(item.node || item.name || "", 120),
      whyItMatters: cleanResearchArticleText(item.whyItMatters || item.why || "", 500),
      signals: asArray(item.signals || item.leadingSignals).map((signal) => cleanResearchArticleText(signal, 220)).filter(Boolean).slice(0, 6),
      risks: asArray(item.risks || item.uncertainties).map((risk) => cleanResearchArticleText(risk, 220)).filter(Boolean).slice(0, 6),
      evidenceIds: normalizeEvidenceIds(item.evidenceIds).slice(0, 6)
    })).filter((item) => item.node).slice(0, 10),
    leadingIndicators: asArray(raw.leadingIndicators).map((item) => cleanResearchArticleText(item, 260)).filter(Boolean).slice(0, 12),
    scenarios: asArray(raw.scenarios || raw.scenarioAnalysis).map((item) => ({
      name: cleanResearchArticleText(item.name || item.scenario || "", 120),
      condition: cleanResearchArticleText(item.condition || item.trigger || "", 500),
      implication: cleanResearchArticleText(item.implication || item.impact || "", 600),
      evidenceIds: normalizeEvidenceIds(item.evidenceIds || item.evidence).slice(0, 6)
    })).filter((item) => item.name || item.condition || item.implication).slice(0, 5),
    catalystCalendar: asArray(raw.catalystCalendar || raw.catalysts).map((item) => ({
      horizon: cleanResearchArticleText(item.horizon || item.timeframe || "", 120),
      event: cleanResearchArticleText(item.event || item.catalyst || "", 400),
      watch: cleanResearchArticleText(item.watch || item.signal || "", 400),
      evidenceIds: normalizeEvidenceIds(item.evidenceIds || item.evidence).slice(0, 6)
    })).filter((item) => item.event || item.watch).slice(0, 10),
    risks: asArray(raw.risks || raw.counterArguments).map((item) => cleanResearchArticleText(item, 400)).filter(Boolean).slice(0, 10),
    timeContextRisks: asArray(raw.timeContextRisks || raw.timeRisks).map((item) => cleanResearchArticleText(item, 400)).filter(Boolean).slice(0, 8),
    falsificationConditions: normalizeReportList(raw.falsificationConditions || raw.disconfirmingEvidence || raw.whatWouldChangeMind, 10, 500),
    nextResearchTasks: asArray(raw.nextResearchTasks || raw.nextSteps).map((item) => cleanResearchArticleText(item, 400)).filter(Boolean).slice(0, 12)
  };
}

function buildFallbackInvestmentReportStructured(pack = {}, request = {}, error = null) {
  const query = cleanResearchArticleText(request.query || "产业链主题", 80) || "产业链主题";
  const evidenceCards = (pack.evidenceCards || []).slice(0, 12);
  const sourceCount = (pack.sources || []).length;
  const evidenceCount = (pack.evidenceCards || []).length;
  const topics = (pack.topicMap?.topics || []).slice(0, 8)
    .map((topic) => cleanResearchArticleText(topic.canonicalName || topic.canonical_name || topic.topicKey || topic.topic_key || "", 80))
    .filter(Boolean);
  const sourceTitles = (pack.sources || []).slice(0, 6)
    .map((source) => cleanResearchArticleText(source.title || source.organization || source.platform || "", 120))
    .filter(Boolean);
  const lenses = [...new Set(evidenceCards.map((card) => cleanResearchArticleText(card.analysisLens || card.evidenceType || "", 80)).filter(Boolean))];
  const topEvidence = evidenceCards.slice(0, 6);
  const nodes = mergeUniqueBy([
    ...topics,
    ...lenses,
    ...evidenceCards.map((card) => cleanResearchArticleText(card.claim || card.quoteOriginal || "", 40)).filter(Boolean)
  ], (item) => item, 8);
  const timeoutNote = /timeout|aborted/i.test(String(error?.message || ""))
    ? "模型综合步骤超时，本版先用结构化证据包生成基线报告，避免任务直接失败。"
    : "模型综合步骤暂不可用，本版先用结构化证据包生成基线报告，后续可在新增证据后迭代。";
  return normalizeInvestmentReportStructured({
    title: `${query}：产业链证据基线与下一步验证`,
    oneSentence: `当前知识库已覆盖 ${sourceCount} 个来源、${evidenceCount} 条证据卡；本版先把可验证线索、约束和后续调研任务整理成基线判断。`,
    thesis: `围绕「${query}」的现有证据还不适合直接包装成强投资结论，更适合作为产业链假设池：先看哪些节点被反复提到，再用时间、产能、监管、成本和客户需求数据继续验证。`,
    topicBoundary: `本报告只使用已入库的结构化来源和证据卡，覆盖 ${sourceTitles.slice(0, 3).join("、") || "当前知识库来源"} 等材料；上一版报告只作为判断基线，不作为新证据。${timeoutNote}`,
    industryMap: (nodes.length ? nodes : [query, "上游供给", "核心技术", "商业化需求", "监管与风险"]).slice(0, 8),
    timeCalibration: [
      `当前证据来自 ${sourceCount} 个来源，需要逐条核对发布时间、拍摄时间和事件发生期。`,
      "凡是产能、成本、监管、产品进度相关判断，都必须用最新公开资料复核。",
      "旧视频或旧文章只能作为线索，不能直接外推成当前产业结论。"
    ],
    deltaSincePrior: pack.priorReport
      ? "本版读取上一版报告作为判断基线，但所有新判断仍以当前证据卡为准。"
      : "这是该主题的第一版证据基线报告。",
    evidenceBase: [
      `证据基础：${sourceCount} 个来源、${evidenceCount} 条证据卡。`,
      "当前版本优先沉淀可追踪线索，不做短线交易建议。",
      timeoutNote
    ],
    investableMap: [
      `围绕「${query}」先按可观察产业链节点拆分，不把不可直接投资的主体强行等同于投资标的。`,
      "优先映射到上游材料/设备、核心部件、测试验证、制造集成、应用需求、监管服务等可跟踪环节。",
      "每个可投资方向必须继续补齐公开公司、订单、产能、客户和财务口径，不能只凭视频叙事下结论。"
    ],
    valuePools: [
      "真正值得跟踪的价值池不是单一热点名词，而是成本下降、产能扩张、可靠性提升和需求放量之间的联动。",
      "如果证据指向制造节拍提升，重点看设备、关键部件、测试设施、材料工艺和运维服务是否同步受益。",
      "如果证据指向需求端扩张，重点看客户预算、任务频率、替代方案成本和监管容量。"
    ],
    peerComparison: [
      "同业/替代路线比较必须围绕技术路线、成本曲线、产能节拍、监管约束和客户需求展开。",
      "当前证据不足时，先列出需要比较的路线和变量，不把单一公司叙事直接外推成行业结论。",
      "后续优先补充中美差异、领先公司与追赶公司、传统方案与新技术路线的公开可核验材料。"
    ],
    hypotheses: topEvidence.slice(0, 4).map((card, index) => ({
      title: cleanResearchArticleText(card.claim || card.quoteOriginal || `待验证假设 ${index + 1}`, 160),
      logic: cleanResearchArticleText(card.whyItMatters || "这条证据提示了一个可能影响产业链判断的变量，但还需要跨来源验证。", 700),
      evidenceIds: [card.id].filter(Boolean),
      counterEvidenceIds: [],
      timeRisk: cleanResearchArticleText(card.timeSensitivity ? `时间敏感性：${card.timeSensitivity}` : "需要用更新来源复核，避免旧材料和当前产业状态错位。", 500),
      confidence: "low-to-medium，当前先作为研究假设，不作为确定结论。"
    })),
    valueChainNodes: topEvidence.slice(0, 6).map((card, index) => ({
      node: cleanResearchArticleText(lenses[index] || nodes[index] || `关键节点 ${index + 1}`, 100),
      whyItMatters: cleanResearchArticleText(card.whyItMatters || card.claim || "该节点可能影响后续产业链判断，需要继续验证。", 500),
      signals: ["新增来源数量", "公开产能/成本/进度数据", "监管或客户需求变化"],
      risks: ["单一来源偏差", "时间错位", "缺少反证材料"],
      evidenceIds: [card.id].filter(Boolean)
    })),
    leadingIndicators: [
      "新增一手来源数量",
      "产能或交付节奏变化",
      "成本口径变化",
      "监管审批或政策变化",
      "客户订单或实际需求变化",
      "竞争路线变化"
    ],
    scenarios: [
      {
        name: "乐观情景",
        condition: "核心技术进展、产能节拍、监管许可和需求端同时改善。",
        implication: "产业链机会可能从主题叙事转向订单、产能和利润兑现，需要优先跟踪最卡脖子的节点。",
        evidenceIds: topEvidence.slice(0, 2).map((card) => card.id).filter(Boolean)
      },
      {
        name: "中性情景",
        condition: "技术路线继续推进，但成本、监管或产能数据仍不透明。",
        implication: "更适合作为观察清单和产业链假设池，等待可量化领先指标确认。",
        evidenceIds: topEvidence.slice(2, 4).map((card) => card.id).filter(Boolean)
      },
      {
        name: "悲观情景",
        condition: "关键测试失败、监管延迟、成本口径被证伪或需求不及预期。",
        implication: "应降低结论置信度，把相关机会退回到调研任务，不继续强化原假设。",
        evidenceIds: topEvidence.slice(4, 6).map((card) => card.id).filter(Boolean)
      }
    ],
    catalystCalendar: [
      { horizon: "3-6 个月", event: "补齐最新一手来源和监管/公告材料。", watch: "是否出现能直接验证产能、成本、订单或政策变化的新证据。", evidenceIds: topEvidence.slice(0, 2).map((card) => card.id).filter(Boolean) },
      { horizon: "6-12 个月", event: "观察关键节点是否从叙事进入可量化兑现。", watch: "交付节奏、客户需求、成本口径和竞争路线是否同步变化。", evidenceIds: topEvidence.slice(2, 4).map((card) => card.id).filter(Boolean) },
      { horizon: "12-24 个月", event: "复盘产业链机会是否形成持续趋势。", watch: "是否出现产业链扩产、利润改善、技术替代或监管框架变化。", evidenceIds: topEvidence.slice(4, 6).map((card) => card.id).filter(Boolean) }
    ],
    risks: [
      "现有资料可能来自同一叙事圈层，存在观点重复。",
      "旧视频和当前市场状态可能错位。",
      "部分证据来自生成文档回填，需要回到原始材料复核。",
      "缺少财务、监管、订单、产能等独立数据时，不应形成强结论。"
    ],
    timeContextRisks: [
      "视频发布时间不等于事件发生时间。",
      "产业链结论会随政策、技术进度和融资环境变化。"
    ],
    falsificationConditions: [
      "如果最新一手来源显示关键技术路线进度停滞，原先的产业链放量假设必须下修。",
      "如果成本、产能、订单或监管数据与视频叙事相反，应优先相信可核验数据。",
      "如果新增反证来自独立来源并能解释核心变量，本报告相关假设要降级为观察项。",
      "如果同业替代路线更快兑现，原主题的价值链映射需要重画。"
    ],
    nextResearchTasks: [
      `补充「${query}」的一手来源：官方公告、监管记录、财报、论文或行业数据。`,
      "为每条核心假设寻找至少一条反证材料。",
      "补齐来源的发布时间、拍摄时间、事件期和过期条件。",
      "把高频出现的公司、产品、材料、供应链节点拆成独立主题继续追踪。",
      "下一版报告重点比较新增证据相对本版基线是增强、削弱还是推翻。"
    ]
  }, request);
}

function extractYearsFromText(value = "") {
  return [...String(value || "").matchAll(/\b(20\d{2}|19\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1990 && year <= 2100);
}

function investmentReportTimeScope(pack = {}) {
  const sourceTexts = (pack.sources || []).flatMap((source) => [
    source.publishedAt,
    source.recordedAt,
    source.eventPeriod,
    source.title
  ]);
  const contextTexts = (pack.timeContexts || []).flatMap((context) => [
    context.videoPublishedAt,
    context.likelyRecordedAt,
    context.eventPeriod,
    context.currentRelevance,
    context.staleIf
  ]);
  const years = [...new Set([...sourceTexts, ...contextTexts].flatMap(extractYearsFromText))].sort((a, b) => a - b);
  const missingDates = (pack.sources || []).filter((source) => !(source.publishedAt || source.recordedAt || source.eventPeriod)).length;
  const stage = years.length
    ? years.length === 1
      ? `${years[0]} 年附近`
      : `${years[0]}-${years[years.length - 1]} 年`
    : "未完全标准化，需以后续原始来源补齐";
  return { stage, missingDates, generatedAt: new Date().toISOString().slice(0, 10) };
}

function investmentReportEvidenceLegend(pack = {}) {
  const { stage, missingDates, generatedAt } = investmentReportTimeScope(pack);
  return compactLines([
    `- **研究材料覆盖期：** ${stage}${missingDates ? `；其中 ${missingDates} 个来源缺少标准化发布时间/拍摄时间。` : "。"}`,
    `- **报告生成日：** ${generatedAt}。`,
    `- **编号说明：** S1/S2 代表资料来源，E1/E2 代表证据卡；正文里的「证据 E52」可在文末证据索引中核对原始出处。`,
    `- **证据边界：** 历史 YouTube 文档回填可以帮助恢复研究线索，但不等同于一手公告、财报、监管记录或论文；涉及成本、产能、监管许可、订单和估值的判断必须二次验证。`,
    `- **适用场景：** 本文是长期产业链研究假设，不是短线交易建议，也不是直接买卖建议。`
  ]);
}

function renderInvestmentResearchReportMarkdown(structured = {}, pack = {}, request = {}) {
  const evidenceIndex = new Map((pack.evidenceCards || []).map((card) => [card.id, card]));
  const evidenceRefs = (ids = []) => asArray(ids)
    .map(String)
    .map((id) => id.trim().toUpperCase())
    .filter((id) => evidenceIndex.has(id))
    .map((id) => evidenceMarkdownLink(id))
    .filter(Boolean)
    .join("、");
  const renderList = (items = [], label = "") => asArray(items).length
    ? asArray(items).map((item) => `- ${label ? `**${label}：** ` : ""}${item}`).join("\n")
    : "";
  const markdownBlock = (lines = []) => lines
    .map((line) => String(line || "").replace(/[ \t]+$/g, ""))
    .filter((line) => line.trim())
    .join("\n");
  const graphTopics = (pack.topicMap?.topics || []).slice(0, 20).map((topic) => (
    `- **${topic.canonicalName || topic.canonical_name || topic.topicKey || topic.topic_key}：** ${topic.topicType || topic.topic_type || "theme"}${(topic.aliases || []).length ? `；别名/相关叫法：${(topic.aliases || []).slice(0, 5).join("、")}` : ""}`
  )).join("\n");
  const graphEdges = (pack.topicMap?.edges || []).slice(0, 20).map((edge) => (
    `- **${edge.fromName || edge.fromTopicKey || edge.from_topic_key || "?"} → ${edge.toName || edge.toTopicKey || edge.to_topic_key || "?"}：** ${edge.edgeType || edge.edge_type || "related_to"}${edge.evidenceCount || edge.evidence_count ? `；证据次数 ${edge.evidenceCount || edge.evidence_count}` : ""}`
  )).join("\n");
  const topicBoundary = compactLines([
    structured.topicBoundary ? `- **研究边界：** ${structured.topicBoundary}` : "",
    structured.industryMap.length ? structured.industryMap.map((item) => `- **产业链地图：** ${item}`).join("\n") : "",
    graphTopics ? "\n### 已入库主题节点\n" + graphTopics : "",
    graphEdges ? "\n### 已识别关系\n" + graphEdges : ""
  ]) || "- **研究边界：** 当前主题图谱仍在积累，先以本次证据包中的来源、实体、时间线和产业链节点为边界。";
  const timeCalibration = compactLines([
    structured.timeCalibration.length ? structured.timeCalibration.map((item) => `- **时间校准：** ${item}`).join("\n") : "",
    ...(pack.timeContexts || []).slice(0, 8).map((context) => markdownBlock([
      `- **${context.sourceRef || "来源"}：** ${[
        context.videoPublishedAt && `发布 ${context.videoPublishedAt}`,
        context.likelyRecordedAt && `拍摄/记录 ${context.likelyRecordedAt}`,
        context.eventPeriod && `事件期 ${context.eventPeriod}`
      ].filter(Boolean).join("；") || "时间未完全标准化"}`,
      context.currentRelevance ? `  - **当前相关性：** ${context.currentRelevance}` : "",
      context.staleIf ? `  - **过期条件：** ${context.staleIf}` : ""
    ]))
  ]) || "- **时间校准：** 来源时间仍需继续标准化，所有产业链判断都要警惕旧视频、旧报告和当前市场环境错位。";
  const evidenceBase = structured.evidenceBase.length
    ? structured.evidenceBase.map((item) => `- **证据基线：** ${item}`).join("\n")
    : `- **证据基线：** 本报告基于 ${pack.sources.length} 个来源、${pack.evidenceCards.length} 条证据卡生成，所有结论必须回到文末证据索引核对。`;
  const investmentMap = compactLines([
    structured.investableMap.length ? "### 投资地图\n" + renderList(structured.investableMap, "可跟踪方向") : "",
    structured.valuePools.length ? "\n### 价值池\n" + renderList(structured.valuePools, "价值来源") : "",
    structured.peerComparison.length ? "\n### 同业与替代路线\n" + renderList(structured.peerComparison, "比较维度") : ""
  ]) || "- **待补充：** 当前证据还不足以形成可跟踪投资地图，需要继续补齐公开公司、上下游关系、订单、产能和成本资料。";
  const hypotheses = structured.hypotheses.length
    ? structured.hypotheses.map((item, index) => markdownBlock([
      `### ${index + 1}. ${item.title || "产业链假设"}`,
      item.logic ? `- **判断逻辑：** ${item.logic}` : "",
      evidenceRefs(item.evidenceIds) ? `  - **支持证据：** ${evidenceRefs(item.evidenceIds)}` : "",
      evidenceRefs(item.counterEvidenceIds) ? `  - **反证线索：** ${evidenceRefs(item.counterEvidenceIds)}` : "",
      item.timeRisk ? `  - **时间错位风险：** ${item.timeRisk}` : "",
      item.confidence ? `  - **当前置信度：** ${item.confidence}` : ""
    ])).join("\n\n")
    : "- **暂不形成强假设：** 当前证据还不足以形成稳定产业链假设。";
  const nodes = structured.valueChainNodes.length
    ? structured.valueChainNodes.map((node) => markdownBlock([
      `- **${node.node}：** ${node.whyItMatters || "需要继续验证其产业链位置和受益机制。"}`,
      node.signals.length ? `  - **跟踪信号：** ${node.signals.join("；")}` : "",
      node.risks.length ? `  - **风险边界：** ${node.risks.join("；")}` : "",
      evidenceRefs(node.evidenceIds) ? `  - **相关证据：** ${evidenceRefs(node.evidenceIds)}` : ""
    ])).join("\n")
    : "- **待补充：** 需要更多来源来拆分明确的价值链节点。";
  const catalysts = structured.catalystCalendar.length
    ? structured.catalystCalendar.map((item) => markdownBlock([
      `- **${item.horizon || "待定时间窗"}：** ${item.event || "观察关键进展"}`,
      item.watch ? `  - **跟踪重点：** ${item.watch}` : "",
      evidenceRefs(item.evidenceIds) ? `  - **相关证据：** ${evidenceRefs(item.evidenceIds)}` : ""
    ])).join("\n")
    : "- **待补充：** 当前证据还不足以形成明确催化剂日历。";
  const scenarios = structured.scenarios.length
    ? structured.scenarios.map((item) => markdownBlock([
      `- **${item.name || "情景"}：** ${item.condition || "触发条件待补充"}`,
      item.implication ? `  - **产业链含义：** ${item.implication}` : "",
      evidenceRefs(item.evidenceIds) ? `  - **相关证据：** ${evidenceRefs(item.evidenceIds)}` : ""
    ])).join("\n")
    : "- **待补充：** 需要更多跨来源证据来拆分乐观、中性和悲观情景。";
  const risks = mergeUniqueBy([
    ...structured.risks.map((risk) => `- **反证/风险：** ${risk}`),
    ...structured.timeContextRisks.map((risk) => `- **时间错位：** ${risk}`),
    ...(pack.coverageGaps || []).slice(0, 8).map((gap) => `- **覆盖缺口：** ${gap.gap}${gap.impact ? `。${gap.impact}` : ""}`)
  ].filter(Boolean), (item) => item.replace(/^\-\s+\*\*[^：]+：\*\*\s*/, ""), 18).join("\n") || "- **风险提示：** 当前资料仍需跨来源验证，不能直接视为投资结论。";
  const falsification = structured.falsificationConditions.length
    ? renderList(structured.falsificationConditions, "证伪条件")
    : "- **证伪条件：** 如果新增一手证据推翻关键技术进度、成本口径、产能节拍、监管进展或客户需求，本报告相关假设必须下修。";
  const tasks = structured.nextResearchTasks.length
    ? structured.nextResearchTasks.map((task) => `- ${task}`).join("\n")
    : (pack.questions || []).slice(0, 8).map((question) => `- ${question.question}`).join("\n");
  const sources = (pack.sources || []).map((source) => markdownBlock([
    `- **来源 ${source.id}：${source.title || "未命名来源"}**`,
    `  - **类型：** ${[source.sourceType, source.platform, source.organization].filter(Boolean).join(" / ") || "未标注"}`,
    source.publishedAt || source.recordedAt || source.eventPeriod
      ? `  - **时间：** ${[source.publishedAt && `发布 ${source.publishedAt}`, source.recordedAt && `拍摄/记录 ${source.recordedAt}`, source.eventPeriod && `事件期 ${source.eventPeriod}`].filter(Boolean).join("；")}`
      : "  - **时间：** 未标准化，综合判断前需要复核",
    source.url ? `  - **原始链接：** ${source.url}` : "",
    source.docUrl ? `  - **飞书文档：** ${source.docUrl}` : "",
    source.conflictProfile ? `  - **潜在偏差：** ${source.conflictProfile}` : ""
  ])).join("\n");
  const evidence = (pack.evidenceCards || []).slice(0, 80).map((card) => markdownBlock([
    `#### 证据 ${card.id}`,
    `- **来源：** ${card.sourceRef}${card.location ? `｜${card.location}` : ""}`,
    card.claim ? `- **证据内容：** ${card.claim}` : "",
    card.quoteOriginal ? `  - **原文：** ${card.quoteOriginal}` : "",
    card.whyItMatters ? `  - **意义：** ${card.whyItMatters}` : "",
    card.timeSensitivity ? `  - **时间敏感性：** ${card.timeSensitivity}` : ""
  ])).join("\n");
  return compactLines([
    "## 先读：研究时间、证据编号与适用边界",
    investmentReportEvidenceLegend(pack),
    "",
    "## 一、报告结论",
    structured.oneSentence ? `- **一句话结论：** ${structured.oneSentence}` : "",
    structured.thesis ? `- **核心判断：** ${structured.thesis}` : "",
    "- **使用边界：** 这是基于知识库证据生成的长期产业链研究假设，不构成短线交易建议或直接买卖建议。",
    "",
    "## 二、主题边界与产业链地图",
    topicBoundary,
    "",
    "## 三、投资地图、价值池与同业对比",
    investmentMap,
    "",
    "## 四、证据基础与时间校准",
    evidenceBase,
    "",
    "### 时间校准",
    timeCalibration,
    "",
    "## 五、产业链假设",
    hypotheses,
    "",
    "## 六、关键环节、跟踪指标与催化剂",
    nodes,
    structured.leadingIndicators.length ? "\n### 领先指标\n" + structured.leadingIndicators.map((item) => `- ${item}`).join("\n") : "",
    "\n### 催化剂日历",
    catalysts,
    "",
    "## 七、情景分析、反证与证伪条件",
    "### 情景分析",
    scenarios,
    "",
    "### 反证、时间错位与覆盖缺口",
    risks,
    "",
    "### 证伪条件",
    falsification,
    "",
    "## 八、迭代变化与下一轮调研任务",
    pack.priorReport
      ? `- **相对上一版：** ${structured.deltaSincePrior || "本版已读取上一版报告作为判断基线，但模型没有形成明确变化总结，建议优先复核新增证据。"}`
      : "- **版本状态：** 这是该主题的第一版报告，后续同主题报告会自动读取上一版作为判断基线。",
    tasks || "- 继续补充跨来源证据，再生成下一版投研报告。",
    "",
    "## 九、资料来源与证据索引",
    "### 来源",
    sources,
    "",
    "### 证据卡",
    evidence
  ]);
}

function cleanInvestmentReportMarkdown(markdown = "") {
  return String(markdown || "")
    .split(/\r?\n/)
    .filter((line) => !isLowValueResearchArtifactText(line))
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findInvestmentReportArtifact(markdown = "") {
  const text = String(markdown || "");
  const match = text.match(/YouTube 技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading|<details|<summary/i);
  if (!match) return null;
  const start = Math.max(0, match.index - 120);
  const end = Math.min(text.length, match.index + 180);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function assertInvestmentResearchReportMarkdown(markdown = "") {
  const text = String(markdown || "");
  const required = [
    "## 先读：研究时间、证据编号与适用边界",
    "## 一、报告结论",
    "## 二、主题边界与产业链地图",
    "## 三、投资地图、价值池与同业对比",
    "## 四、证据基础与时间校准",
    "## 五、产业链假设",
    "## 六、关键环节、跟踪指标与催化剂",
    "## 七、情景分析、反证与证伪条件",
    "## 八、迭代变化与下一轮调研任务",
    "## 九、资料来源与证据索引"
  ];
  for (const item of required) {
    if (!text.includes(item)) throw new Error(`investment report missing section: ${item}`);
  }
  if (/YouTube 技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|legacy_heading|<details|<summary/i.test(text)) {
    const snippet = findInvestmentReportArtifact(text);
    throw new Error(`investment report contains low-value or unsupported article artifacts${snippet ? ` near: ${snippet}` : ""}.`);
  }
  if (!/证据\s*E\d+|证据卡/.test(text)) {
    throw new Error("investment report must expose evidence ids.");
  }
}

function markdownList(items = []) {
  return items.filter(Boolean).map((item) => `- ${item}`).join("\n");
}

function stripMarkdownFrontmatter(markdown = "") {
  return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
}

function markdownTableCell(value = "") {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim() || "-";
}

function markdownTable(headers = [], rows = []) {
  if (!headers.length || !rows.length) return "";
  const headerLine = `| ${headers.map(markdownTableCell).join(" | ")} |`;
  const dividerLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`);
  return [headerLine, dividerLine, ...rowLines].join("\n");
}

function splitMarkdownTableRow(line = "") {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line = "") {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function markdownTableToMobileList(headers = [], rows = []) {
  const cleanHeaders = headers.map((header) => String(header || "").trim()).filter(Boolean);
  if (!cleanHeaders.length || !rows.length) return "";

  return rows.map((row, index) => {
    const cells = row.map((cell) => String(cell || "").trim());
    const firstValue = cells.find(Boolean) || `条目 ${index + 1}`;
    const title = cleanHeaders.length <= 2
      ? `#### ${cleanHeaders[0] || "条目"}：${firstValue}`
      : `#### ${index + 1}. ${firstValue}`;
    const fields = cleanHeaders.map((header, cellIndex) => {
      const value = cells[cellIndex] || "-";
      if (cleanHeaders.length > 2 && cellIndex === 0) return "";
      return `- **${header}**：${value}`;
    }).filter(Boolean);
    return [title, ...fields].join("\n");
  }).join("\n\n");
}

function convertMarkdownTablesToMobileLists(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] || "";
    const next = lines[index + 1] || "";
    if (current.includes("|") && isMarkdownTableSeparator(next)) {
      const headers = splitMarkdownTableRow(current);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      const mobileList = markdownTableToMobileList(headers, rows);
      if (mobileList) output.push(mobileList);
      continue;
    }
    output.push(current);
  }
  return output.join("\n");
}

function removeObsidianSyntax(markdown = "") {
  return String(markdown || "")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1");
}

function cardNote(results = []) {
  const sourceCount = results.filter((item) => item.url).length;
  return {
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `已整理 ${sourceCount} 个来源`
      }
    ]
  };
}

export class FeishuBot {
  constructor({ config, storage, ai, imageGenerator, speechToText, textToSpeech, songClient, videoLibrary, webSearch, transcriptApi, obsidianSync }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.speechToText = speechToText;
    this.textToSpeech = textToSpeech;
    this.songClient = songClient;
    this.videoLibrary = videoLibrary;
    this.webSearch = webSearch;
    this.transcriptApi = transcriptApi;
    this.obsidianSync = obsidianSync;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.chatQueues = new Map();
    this.seenMessageIds = new Set();
    this.sentBotMessageIds = new Map();
    this.workspace = new FeishuWorkspaceClient({
      config,
      getToken: () => this.tenantAccessToken(),
      onDocumentCreated: (document, meta) => this.notifyArticleGroup({
        title: document.title || meta?.title || "",
        url: document.url || "",
        sourceType: meta?.sourceType || ""
      })
    });
    this.wechatPublisher = new WeChatPublisher({ config, ai, imageGenerator });
    this.projectEngine = new ProjectEngine({
      config,
      storage,
      ai,
      feishuWorkspace: this.workspace
    });
  }

  get enabled() {
    return Boolean(this.config.feishuAppId && this.config.feishuAppSecret);
  }

  startTiming(label, meta = {}) {
    if (!this.config.feishuTimingLogsEnabled) return null;
    const now = Date.now();
    return {
      label,
      startedAt: now,
      lastAt: now,
      steps: {},
      meta: { ...meta }
    };
  }

  addTimingMeta(timing, meta = {}) {
    if (!timing) return;
    timing.meta = { ...timing.meta, ...meta };
  }

  markTiming(timing, step) {
    if (!timing || !step) return;
    const now = Date.now();
    timing.steps[step] = (timing.steps[step] || 0) + Math.max(0, now - timing.lastAt);
    timing.lastAt = now;
  }

  finishTiming(timing, meta = {}) {
    if (!timing) return;
    const totalMs = Math.max(0, Date.now() - timing.startedAt);
    if (totalMs < (this.config.feishuTimingMinMs || 0)) return;
    logEvent("info", `${timing.label} timing`, {
      ...timing.meta,
      ...meta,
      totalMs,
      steps: timing.steps
    });
  }

  setupRoutes(app) {
    app.post("/feishu/events", async (req, res) => {
      try {
        const payload = this.decryptIfNeeded(req.body || {});
        const verification = this.handleUrlVerification(payload);
        if (verification) {
          res.json(verification);
          return;
        }

        if (!this.isValidToken(payload)) {
          res.status(403).json({ error: "Invalid Feishu verification token." });
          return;
        }

        const cardActionResponse = await this.handleCardAction(payload);
        if (cardActionResponse) {
          res.json(cardActionResponse);
          return;
        }

        res.json({ ok: true });
        this.enqueueEvent(payload);
      } catch (error) {
        console.error("Feishu event error:", error.message);
        res.status(500).json({ error: "Feishu event handling failed." });
      }
    });
  }

  decryptIfNeeded(payload) {
    if (!payload?.encrypt) return payload;
    if (!this.config.feishuEncryptKey) {
      throw new Error("Received encrypted Feishu event, but FEISHU_ENCRYPT_KEY is not configured.");
    }

    const key = crypto.createHash("sha256").update(this.config.feishuEncryptKey).digest();
    const encrypted = Buffer.from(payload.encrypt, "base64");
    const iv = encrypted.subarray(0, 16);
    const data = encrypted.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(decrypted);
  }

  handleUrlVerification(payload) {
    if (payload?.type !== "url_verification") return null;
    if (this.config.feishuVerificationToken && payload.token !== this.config.feishuVerificationToken) {
      throw new Error("Invalid Feishu URL verification token.");
    }
    return { challenge: payload.challenge };
  }

  isValidToken(payload) {
    if (!this.config.feishuVerificationToken) return true;
    return payload?.header?.token === this.config.feishuVerificationToken || payload?.token === this.config.feishuVerificationToken;
  }

  async handleCardAction(payload = {}) {
    const eventType = payload?.header?.event_type || payload?.type || "";
    if (!/(?:card\.action|card_action)/i.test(eventType)) return null;

    const event = payload.event || payload;
    const action = event.action || payload.action || {};
    const value = action.value || action || {};
    if (value.action === "wechat_publish_draft") {
      return this.handleWechatPublishAction({ event, payload, value });
    }
    if (value.action !== "worldcup_vote") {
      return { toast: { type: "info", content: "这个按钮我收到了。" } };
    }

    const operator = this.extractCardActionOperatorId(event, payload);
    if (!operator) {
      logEvent("warn", "Feishu card vote ignored because operator id was missing", {
        pollId: value.poll_id || value.pollId || "",
        option: value.option || ""
      });
      return {
        toast: {
          type: "warning",
          content: "这次没拿到你的飞书身份，先不计票，避免被刷票。"
        }
      };
    }
    const poll = await this.recordWorldCupVote({
      pollId: value.poll_id || value.pollId,
      option: value.option,
      label: value.label,
      options: value.options,
      title: value.title,
      operator
    });
    const responseCard = buildWorldCupPollResultCard(poll);
    return {
      toast: {
        type: "info",
        content: poll.changed
          ? `已投 ${poll.label}，当前 ${poll.count} 票。`
          : `你已经投过 ${poll.label} 了，票数没有重复增加。`
      },
      card: {
        type: "raw",
        data: responseCard
      }
    };
  }

  async buildWorldCupPollResponseCard(poll = {}) {
    try {
      const visual = renderPremiumSearchCardImage({
        query: poll.title || "世界杯投票",
        summary: "每个人只保留最后一次选择。",
        results: [],
        poll
      });
      const imageKey = await this.uploadImage(visual);
      return buildPremiumPollCard({ imageKey, poll });
    } catch (error) {
      logEvent("warn", "Feishu premium poll card fallback used", {
        pollId: poll.pollId || "",
        error: error.message
      });
      return buildWorldCupPollResultCard(poll);
    }
  }

  extractCardActionOperatorId(event = {}, payload = {}) {
    return pickFirstString([
      event.operator?.operator_id?.open_id,
      event.operator?.operator_id?.user_id,
      event.operator?.operator_id?.union_id,
      event.operator?.open_id,
      event.operator?.user_id,
      event.operator?.union_id,
      event.sender?.sender_id?.open_id,
      event.sender?.sender_id?.user_id,
      event.sender?.sender_id?.union_id,
      event.user_id,
      event.open_id,
      ...collectIdsDeep(event.operator || {}),
      ...collectIdsDeep(payload.operator || {})
    ]);
  }

  extractCardActionChatId(event = {}, payload = {}) {
    return pickFirstString([
      event.context?.open_chat_id,
      event.context?.chat_id,
      event.open_chat_id,
      event.chat_id,
      event.message?.chat_id,
      event.message?.open_chat_id,
      payload.event?.context?.open_chat_id,
      payload.event?.context?.chat_id,
      payload.open_chat_id,
      payload.chat_id
    ]);
  }

  async handleWechatPublishAction({ event = {}, payload = {}, value = {} } = {}) {
    const candidateId = String(value.candidate_id || value.candidateId || "").trim();
    const generateImages = true;
    if (!candidateId) {
      return { toast: { type: "warning", content: "没有拿到可发布文章 ID。" } };
    }
    if (!this.wechatPublisher?.enabled) {
      return { toast: { type: "warning", content: "公众号发布还没有配置 AppID/AppSecret。" } };
    }
    const candidate = await this.storage.getWechatPublishCandidate?.(candidateId);
    if (!candidate?.markdown) {
      return { toast: { type: "warning", content: "这篇候选文章没有找到，可能是旧卡片或存储还没同步。" } };
    }

    const operator = this.extractCardActionOperatorId(event, payload);
    const chatId = this.extractCardActionChatId(event, payload);
    await this.storage.updateWechatPublishCandidate?.(candidateId, {
      status: "publishing",
      error: "",
      metadata: {
        ...(candidate.metadata || {}),
        lastPublishStartedAt: new Date().toISOString(),
        lastPublishOperator: operator,
        generateImages
      }
    });

    this.runWechatPublishDraftTask({
      candidateId,
      candidate,
      operator,
      chatId,
      generateImages
    }).catch((error) => {
      logEvent("error", "WeChat draft background task crashed", {
        candidateId,
        chatId,
        error: error.message
      });
    });

    return {
      toast: {
        type: "info",
        content: "已开始生成公众号草稿，完成后我会发结果卡片。"
      }
    };

    /*
    try {
      const result = await this.wechatPublisher.createDraft(candidate, { generateImages, operator });
      await this.storage.updateWechatPublishCandidate?.(candidateId, {
        status: "draft_created",
        draftMediaId: result.draftMediaId || "",
        error: "",
        metadata: {
          ...(candidate.metadata || {}),
          lastPublishStartedAt: new Date().toISOString(),
          lastPublishFinishedAt: new Date().toISOString(),
          lastPublishOperator: operator,
          generateImages,
          wechat: result
        }
      });
      return {
        toast: {
          type: "success",
          content: `已创建公众号草稿：${result.title || candidate.title || "文章"}`
        },
        card: {
          type: "raw",
          data: this.buildWechatPublishResultCard({ candidate, result })
        }
      };
    } catch (error) {
      await this.storage.updateWechatPublishCandidate?.(candidateId, {
        status: "failed",
        error: error.message,
        metadata: {
          ...(candidate.metadata || {}),
          lastPublishFailedAt: new Date().toISOString(),
          lastPublishOperator: operator,
          generateImages
        }
      });
      logEvent("error", "WeChat draft creation failed", {
        candidateId,
        generateImages,
        error: error.message
      });
      return {
        toast: {
          type: "warning",
          content: `公众号草稿创建失败：${truncate(error.message, 80)}`
        }
      };
    }
  }

    */
  }

  async runWechatPublishDraftTask({ candidateId = "", candidate = {}, operator = "", chatId = "", generateImages = true } = {}) {
    try {
      const result = await this.wechatPublisher.createDraft(candidate, { generateImages, operator });
      await this.storage.updateWechatPublishCandidate?.(candidateId, {
        status: "draft_created",
        draftMediaId: result.draftMediaId || "",
        error: "",
        metadata: {
          ...(candidate.metadata || {}),
          lastPublishStartedAt: candidate.metadata?.lastPublishStartedAt || new Date().toISOString(),
          lastPublishFinishedAt: new Date().toISOString(),
          lastPublishOperator: operator,
          generateImages,
          wechat: result
        }
      });
      if (chatId) {
        await this.sendCardToChat(chatId, this.buildWechatPublishResultCard({ candidate, result }));
      } else {
        logEvent("warn", "WeChat draft created but card action chat id was missing", {
          candidateId,
          draftMediaId: result.draftMediaId || ""
        });
      }
      return result;
    } catch (error) {
      await this.storage.updateWechatPublishCandidate?.(candidateId, {
        status: "failed",
        error: error.message,
        metadata: {
          ...(candidate.metadata || {}),
          lastPublishFailedAt: new Date().toISOString(),
          lastPublishOperator: operator,
          generateImages
        }
      });
      logEvent("error", "WeChat draft creation failed", {
        candidateId,
        generateImages,
        error: error.message
      });
      if (chatId) {
        await this.sendTextToChat(chatId, `公众号草稿生成失败：${truncate(error.message, 300)}`);
      }
      return null;
    }
  }

  async registerWechatPublishCandidate(candidate = {}) {
    if (!candidate.markdown || !this.storage.upsertWechatPublishCandidate) return null;
    const id = candidate.id || researchSourceId("wechat_candidate", [
      candidate.sourceType || "",
      candidate.title || "",
      candidate.feishuDocUrl || "",
      candidate.sourceUrl || "",
      Date.now()
    ].join("|"));
    const row = {
      id,
      sourceType: candidate.sourceType || "",
      title: candidate.title || "",
      markdown: candidate.markdown || "",
      feishuDocUrl: candidate.feishuDocUrl || "",
      sourceUrl: candidate.sourceUrl || "",
      status: "candidate",
      metadata: {
        ...(candidate.metadata || {}),
        createdBy: "xiaoye",
        wechatDraftOnly: true
      }
    };
    await this.storage.upsertWechatPublishCandidate(row);
    return row;
  }

  wechatPublishActions(candidate = null) {
    if (!candidate?.id) return [];
    return [
      {
        tag: "button",
        text: { tag: "plain_text", content: "生成公众号草稿" },
        type: "primary",
        value: {
          action: "wechat_publish_draft",
          candidate_id: candidate.id,
          generate_images: true
        }
      }
    ];
    return [
      {
        tag: "button",
        text: { tag: "plain_text", content: "生成公众号草稿" },
        type: "primary",
        value: {
          action: "wechat_publish_draft",
          candidate_id: candidate.id,
          generate_images: true
        }
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "配图后生成草稿" },
        type: "default",
        value: {
          action: "wechat_publish_draft",
          candidate_id: candidate.id,
          generate_images: true
        }
      }
    ];
  }

  buildWechatPublishResultCard({ candidate = {}, result = {} } = {}) {
    return {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: "green",
        title: { tag: "plain_text", content: "公众号草稿已创建" }
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: cardMarkdown(compactLines([
              `**${result.title || candidate.title || "文章"}**`,
              result.draftMediaId ? `草稿 media_id：${result.draftMediaId}` : "",
              result.imageMode ? `配图模式：${result.imageMode}` : "",
              "下一步：到微信公众号后台预览、微调封面和摘要，再确认发布。"
            ]), 700)
          }
        }
      ]
    };
  }

  buildWechatCandidateCard({ candidate = {}, title = "", doc = {}, sourceType = "" } = {}) {
    const actions = [];
    if (doc.url) {
      actions.push({
        tag: "button",
        text: { tag: "plain_text", content: "打开飞书文档" },
        type: "default",
        url: doc.url
      });
    }
    actions.push(...this.wechatPublishActions(candidate));
    return {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: "green",
        title: { tag: "plain_text", content: "公众号分发候选" }
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: cardMarkdown(compactLines([
              `**${title || candidate.title || "这篇文章"}**`,
              sourceType ? `来源：${sourceType}` : "",
              "可以把这篇飞书成品转换到微信公众号草稿箱。系统只做公众号格式适配和草稿创建，不会直接群发。"
            ]), 700)
          }
        },
        { tag: "action", actions }
      ]
    };
  }

  async recordWorldCupVote({ pollId = "", option = "", label = "", options = null, title = "", operator = "" }) {
    const safePollId = String(pollId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    const safeOption = String(option || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
    if (!safePollId || !safeOption) {
      return { label: "这一项", count: 0, counts: {}, options: {}, voters: {}, changed: false };
    }

    const key = `feishu.worldcup.poll.${safePollId}`;
    let poll = {};
    try {
      poll = JSON.parse(await this.storage.getSetting(key, "{}"));
    } catch {
      poll = {};
    }

    poll.pollId = safePollId;
    poll.title = String(title || poll.title || "世界杯投票").slice(0, 160);
    poll.options = poll.options || {};
    poll.counts = poll.counts || {};
    poll.voters = poll.voters || {};
    for (const [key, value] of Object.entries(options || {})) {
      const cleanKey = String(key || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
      if (cleanKey && value) poll.options[cleanKey] = String(value).slice(0, 40);
    }
    poll.options[safeOption] = String(label || poll.options[safeOption] || safeOption).slice(0, 40);

    const voter = String(operator || "").slice(0, 120);
    const previous = voter ? poll.voters[voter] : "";
    const changed = previous !== safeOption;
    if (previous && previous !== safeOption && poll.counts[previous]) {
      poll.counts[previous] = Math.max(0, Number(poll.counts[previous] || 0) - 1);
    }
    if (changed) {
      poll.counts[safeOption] = Number(poll.counts[safeOption] || 0) + 1;
    }
    if (voter) poll.voters[voter] = safeOption;
    poll.lastVoterChoice = poll.options[safeOption];
    poll.updatedAt = new Date().toISOString();

    await this.storage.setSetting(key, JSON.stringify(poll));
    return {
      ...poll,
      label: poll.options[safeOption],
      count: Number(poll.counts[safeOption] || 0),
      changed
    };
  }

  enqueueEvent(payload) {
    if (!this.enabled) return;
    const eventType = payload?.header?.event_type || payload?.type || "";
    if (eventType !== "im.message.receive_v1") return;

    const message = payload?.event?.message;
    const messageId = message?.message_id || "";
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) return;
      this.seenMessageIds.add(messageId);
      if (this.seenMessageIds.size > 500) {
        this.seenMessageIds = new Set([...this.seenMessageIds].slice(-300));
      }
    }

    const rawChatId = message?.chat_id || message?.open_chat_id || messageId || "unknown";
    const chatId = platformId(rawChatId);
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.handleMessage(payload))
      .catch((error) => console.error("Feishu message handling failed:", error.message))
      .finally(() => {
        if (this.chatQueues.get(chatId) === next) {
          this.chatQueues.delete(chatId);
        }
      });
    this.chatQueues.set(chatId, next);
  }

  async handleMessage(payload) {
    const timing = this.startTiming("Feishu message");
    const event = payload.event || {};
    const message = event.message || {};

    const content = parseContent(message.content);
    const audioMessage = message.message_type === "audio";
    const imageMessage = message.message_type === "image";
    const postMessage = message.message_type === "post";
    const supportedInteractiveMessage = ["text", "audio", "image", "post"].includes(message.message_type);
    const rawMessageText = postMessage ? flattenPostContent(content) : (content.text || flattenGenericContent(content));
    const rawText = audioMessage
      ? await this.transcribeAudioMessage(message, content)
      : imageMessage
        ? stripAtTags(content.text || content.caption || "请看这张图片并自然回复。")
        : postMessage
          ? rawMessageText
          : stripAtTags(rawMessageText || "");
    this.markTiming(timing, "prepareTextMs");
    const senderIdInfo = event.sender?.sender_id || {};
    const senderId = senderIdInfo.open_id || senderIdInfo.user_id || "";
    const senderIdentityCandidates = this.senderIdentityCandidates(event);
    const chatId = platformId(message.chat_id || message.open_chat_id || senderId);
    const userId = platformId(senderId || "unknown");
    this.addTimingMeta(timing, {
      chatId,
      messageId: message.message_id || "",
      messageType: message.message_type || "",
      chatType: message.chat_type || ""
    });
    await this.recordPassiveLinkMessage({ chatId, userId, message, content, rawMessageText });
    this.markTiming(timing, "passiveLinkMs");

    const chatType = message.chat_type || "";
    const mentionInfo = this.getMentionInfo(message, rawMessageText || content.text || rawText);
    const replyToBot = this.isReplyToBotMessage(message);
    const text = this.stripBotName(rawText);
    const projectRequest = isProjectCreateRequest(text);
    const songRequest = this.extractSongRequest(text);
    const videoRequest = await this.extractVideoRequest(text, chatId);
    const researchKbCleanupRequest = this.extractResearchKbCleanupRequest(text);
    const investmentReportRequest = this.extractInvestmentReportRequest(text);
    const youtubeRequest = this.extractYoutubeResearchRequest(text);
    const webSearchRequest = this.extractWebSearchRequest(text);
    const selfieRequest = this.extractSelfieGenerationPrompt(text);
    const alwaysReplyUser = await this.isAlwaysReplyUser(senderIdentityCandidates);
    this.markTiming(timing, "routeDetectMs");
    const explicitReply =
      chatType === "p2p" ||
      alwaysReplyUser ||
      mentionInfo.botMentioned ||
      replyToBot ||
      this.isExplicitCommand(text) ||
      webSearchRequest.requested ||
      researchKbCleanupRequest.requested ||
      investmentReportRequest.requested ||
      youtubeRequest.requested ||
      songRequest.requested ||
      videoRequest.requested ||
      selfieRequest.requested ||
      projectRequest ||
      this.config.triggerMode === "all";
    if (!explicitReply && chatType !== "p2p" && mentionInfo.mentionedOtherOnly) {
      logEvent("info", "Feishu group message mentioned another user; skipped smart reply", {
        messageId: message.message_id || "",
        mentions: mentionInfo.mentionNames.slice(0, 5)
      });
      return;
    }
    const smartCandidate = !explicitReply && chatType !== "p2p" && this.config.triggerMode === "smart";
    if (!explicitReply && !smartCandidate) return;

    if (!supportedInteractiveMessage || !rawText) return;

    const currentUser = {
      id: userId,
      username: "",
      firstName: "",
      lastName: "",
      fullName: event.sender?.sender_id?.union_id || senderId || "飞书用户"
    };
    const safeUserText = redactSensitive(text);
    const linkContext = await this.describeIncomingLinks({
      chatId,
      message,
      content,
      rawMessageText,
      text: safeUserText
    });
    this.markTiming(timing, "linkContextMs");
    const imageIntent = extractImageGenerationIntent(safeUserText, {
      botNames: [
        this.config.feishuBotName || "",
        this.config.displayName || "",
        "小椰"
      ]
    });
    const shouldUseWebSearch = webSearchRequest.requested && !imageIntent.requested && !this.shouldPreferLinkReadingOverSearch({
      text: safeUserText,
      linkContext,
      request: webSearchRequest
    });
    const contextualUserText = this.withLinkContext(safeUserText, linkContext);
    const imageDataUrl = imageMessage ? await this.downloadImageMessage(message, content) : "";
    if (imageMessage && !imageDataUrl) return;
    this.markTiming(timing, "imageDownloadMs");
    const imageContext = imageMessage
      ? await this.describeIncomingImages({
          chatId,
          userId,
          text: contextualUserText,
          imageDataUrl,
          messageId: message.message_id
        })
      : "";
    this.markTiming(timing, "imageContextMs");
    const storedUserText = this.withImageContext(contextualUserText, imageContext, "请看这张图片并自然回复。");

    await this.upsertUserProfileMemory(chatId, userId, currentUser);
    await this.storage.addMessage({
      chatId,
      userId,
      role: "user",
      modality: audioMessage ? "voice" : imageMessage ? "image" : "text",
      content: storedUserText,
      metadata: {
        platform: "feishu",
        messageId: message.message_id || "",
        chatType,
        rawChatId: message.chat_id || "",
        rawUserId: senderId || "",
        rawOpenId: senderIdInfo.open_id || "",
        rawTenantUserId: senderIdInfo.user_id || "",
        rawUnionId: senderIdInfo.union_id || "",
        alwaysReplyUser,
        hasVoice: audioMessage,
        hasImage: imageMessage,
        linkContext: linkContext ? truncate(linkContext, 1200) : "",
        imageContext: imageContext ? truncate(imageContext, 1200) : "",
        voiceDurationMs: audioMessage ? Number(content.duration || 0) : 0
      }
    });
    this.markTiming(timing, "storeUserMs");

    if (projectRequest) {
      this.projectEngine.createProjectFromBrief({
        chatId,
        userId,
        text: safeUserText,
        reply: (replyText) => this.replyText(message.message_id, replyText)
      }).catch(async (error) => {
        logEvent("error", "Feishu project workflow failed", { chatId, error: error.message });
        await this.replyText(message.message_id, `项目工作流失败了：${truncate(error.message, 600)}`);
      });
      this.finishTiming(timing, { route: "project" });
      return;
    }

    if (selfieRequest.requested) {
      this.handleImageRequest({
        messageId: message.message_id,
        chatId,
        userId,
        text: selfieRequest.prompt
      }).catch((error) => {
        logEvent("error", "Feishu selfie image background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "selfie" });
      return;
    }

    if (videoRequest.requested) {
      this.handleVideoRequest({
        messageId: message.message_id,
        chatId,
        userId,
        request: videoRequest
      }).catch((error) => {
        logEvent("error", "Feishu video background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "video" });
      return;
    }

    if (songRequest.requested) {
      this.handleSongRequest({
        messageId: message.message_id,
        chatId,
        userId,
        request: songRequest
      }).catch((error) => {
        logEvent("error", "Feishu song background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "song" });
      return;
    }

    if (researchKbCleanupRequest.requested) {
      this.handleResearchKbCleanupRequest({
        messageId: message.message_id,
        chatId,
        userId,
        request: researchKbCleanupRequest
      }).catch((error) => {
        logEvent("error", "Feishu research KB cleanup background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "research_kb_cleanup", apply: researchKbCleanupRequest.apply });
      return;
    }

    if (investmentReportRequest.requested) {
      this.handleInvestmentReportRequest({
        messageId: message.message_id,
        chatId,
        userId,
        request: investmentReportRequest
      }).catch((error) => {
        logEvent("error", "Feishu investment report background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "investment_report" });
      return;
    }

    if (youtubeRequest.requested) {
      this.handleYoutubeResearchRequest({
        messageId: message.message_id,
        chatId,
        userId,
        request: youtubeRequest
      }).catch((error) => {
        logEvent("error", "Feishu YouTube research background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "youtube_research" });
      return;
    }

    if (shouldUseWebSearch) {
      this.handleWebSearchRequest({
        messageId: message.message_id,
        chatId,
        userId,
        request: webSearchRequest
      }).catch((error) => {
        logEvent("error", "Feishu web search background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "web_search" });
      return;
    }

    if (imageIntent.requested) {
      this.handleImageRequest({
        messageId: message.message_id,
        chatId,
        userId,
        text: imageIntent.prompt || safeUserText
      }).catch((error) => {
        logEvent("error", "Feishu image background task failed", { chatId, error: error.message });
      });
      this.finishTiming(timing, { route: "image_generation" });
      return;
    }

    if (smartCandidate) {
      const shouldReply = await this.shouldReplyToSmartCandidate({ chatId, safeUserText, hasImage: imageMessage });
      if (!shouldReply) return;
    }
    this.markTiming(timing, "smartDecisionMs");

    let reply;
    try {
      reply = await this.generateReply({
        chatId,
        userId,
        safeUserText: contextualUserText,
        currentUser,
        imageDataUrl,
        currentMessageId: message.message_id || ""
      });
      this.markTiming(timing, "aiReplyMs");
    } catch (error) {
      if (imageMessage) {
        logEvent("error", "Feishu image reply failed", {
          chatId,
          messageId: message.message_id,
          error: error.message
        });
        reply = [
          "这张图我刚刚没看稳。",
          "你再发一次，或者把要整理的那块截近一点，我重新帮你读。"
        ].join("\n");
      } else {
        logEvent("error", "Feishu AI reply failed", {
          chatId,
          messageId: message.message_id,
          error: error.message
        });
        reply = this.formatAiFailureMessage(error);
      }
      this.markTiming(timing, "aiReplyMs");
    }
    const safeAssistantReply = this.cleanAssistantReply(redactSensitive(reply));
    await this.storage.addMessage({
      chatId,
      userId,
      role: "assistant",
      modality: "text",
      content: safeAssistantReply,
      metadata: { platform: "feishu", replyToUserId: userId }
    });
    this.markTiming(timing, "storeAssistantMs");

    const safeReply = safeAssistantReply;
    if (this.config.feishuOutgoingMentionsEnabled) {
      const mentionTargets = this.resolveOutgoingMentionTargets(safeUserText, mentionInfo);
      if (mentionTargets.length > 0) {
        await this.replyPostMention(message.message_id, safeReply, mentionTargets);
        if (this.config.autoMemory) {
          this.scheduleMemoryUpdate({
            chatId,
            userId,
            userText: storedUserText,
            assistantText: reply,
            currentUser,
            skipMemoryExtraction: this.isTransientStyleRequest(safeUserText)
          });
        }
        this.finishTiming(timing, { route: "mention_post", replyChars: safeReply.length });
        return;
      }
    }

    if (this.config.feishuOutgoingMentionsEnabled && this.hasExplicitMentionDeliveryRequest(safeUserText)) {
      const notice = "我可以帮你 @ 人，但需要你在消息里真的 @ 一下对方，或者先在 Render 配置 FEISHU_MENTION_TARGETS_JSON，把名字和 open_id 对上。";
      await this.replyText(message.message_id, notice);
      this.finishTiming(timing, { route: "mention_notice" });
      return;
    }

    const deliveryPreference = this.resolveReplyDeliveryPreference(safeUserText, { linkContext });
    const sentAsSpeech = deliveryPreference === "text" ? false : await this.replySpeech(message.message_id, safeReply);
    if (!sentAsSpeech) {
      for (const chunk of splitChatBubbles(safeReply, 1800)) {
        await this.replyText(message.message_id, chunk);
      }
    }
    this.markTiming(timing, "deliveryMs");

    if (this.config.autoMemory) {
      this.scheduleMemoryUpdate({
        chatId,
        userId,
        userText: storedUserText,
        assistantText: reply,
        currentUser,
        skipMemoryExtraction: this.isTransientStyleRequest(safeUserText) || Boolean(deliveryPreference)
      });
    }
    this.finishTiming(timing, {
      route: "ai_reply",
      delivery: sentAsSpeech ? "speech" : "text",
      replyChars: safeReply.length,
      hasLinkContext: Boolean(linkContext),
      hasImageContext: Boolean(imageContext)
    });
  }

  extractWebSearchRequest(text = "") {
    let raw = String(text || "").trim();
    if (!raw) return { requested: false, query: "", freshness: "" };

    const command = raw.match(/^\/(search|web|news|weather|worldcup|wc)(?:\s+([\s\S]+))?$/i);
    if (command) {
      let query = this.cleanWebSearchQuery(command[2] || "");
      if (/^weather$/i.test(command[1]) && query && !/(?:\u5929\u6c14|\u6c14\u6e29|\u6e29\u5ea6|\u9884\u62a5)/.test(query)) {
        query = `${query} \u5929\u6c14`;
      }
      if (/^(?:worldcup|wc)$/i.test(command[1]) && query && !/(?:\u4e16\u754c\u676f|World Cup)/i.test(query)) {
        query = `\u4e16\u754c\u676f ${query}`;
      }
      return { requested: true, query, freshness: this.pickWebSearchFreshness(raw) };
    }

    const explicit = raw.match(/^(?:\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6\u4f60)?\s*(?:\u641c\u4e00\u4e0b|\u641c\u4e0b|\u641c\u641c(?:\u770b)?|\u641c\u7d22|\u67e5\u4e00\u4e0b|\u67e5\u4e0b|\u67e5\u67e5(?:\u770b)?|\u67e5\u8be2|\u770b\u770b|\u8054\u7f51\u67e5|\u8054\u7f51\u641c|\u7f51\u4e0a\u641c|\u767e\u5ea6\u4e00\u4e0b)\s*[:\uff1a,\uff0c]?\s*([\s\S]*)$/i);
    if (explicit) {
      const query = this.cleanWebSearchQuery(explicit[1] || "");
      if (!looksLikeHardWebSearchIntent(raw) && looksLikeContextReferenceRequest(query || raw)) {
        return { requested: false, query: "", freshness: "" };
      }
      return { requested: true, query, freshness: this.pickWebSearchFreshness(raw) };
    }

    if (/(?:\u4e16\u754c\u676f|FIFA|World Cup|worldcup|wc|足球).*(?:\u8d5b\u7a0b|\u5bf9\u9635|\u6bd4\u5206|\u79ef\u5206|\u9884\u6d4b|\u80dc\u7387|\u6295\u7968|\u652f\u6301|\u8c01\u8d62)|(?:\u8d5b\u7a0b|\u5bf9\u9635|\u9884\u6d4b|\u6295\u7968).*(?:\u4e16\u754c\u676f|FIFA|World Cup|足球)/i.test(raw)) {
      return { requested: true, query: this.cleanWebSearchQuery(raw), freshness: this.pickWebSearchFreshness(raw) };
    }

    if (this.isGithubTrendingRequest(raw)) {
      return { requested: true, query: this.cleanWebSearchQuery(raw) || "今天 GitHub 热门仓库 Top 3", freshness: "oneDay", githubTrending: true };
    }

    if (/(?:\u5929\u6c14|\u6c14\u6e29|\u6e29\u5ea6|\u4e0b\u96e8|\u964d\u96e8|\u964d\u6c34|\u7a7a\u6c14\u8d28\u91cf|AQI|\u7a7f\u4ec0\u4e48|\u53f0\u98ce|\u66b4\u96e8|\u9884\u62a5)/i.test(raw) && /(?:\u4eca\u5929|\u4eca\u65e5|\u660e\u5929|\u5468\u672b|\u73b0\u5728|\u672c\u5468|\u600e\u4e48\u6837|\u5982\u4f55|\u591a\u5c11|\u67e5|\u770b|\u4f1a\u4e0d\u4f1a|\u9002\u5408|\u9884\u62a5)/.test(raw)) {
      return { requested: true, query: this.cleanWebSearchQuery(raw), freshness: this.pickWebSearchFreshness(raw) };
    }

    if (/(?:\u4ef7\u683c|\u884c\u60c5|\u62a5\u4ef7|\u91d1\u4ef7|\u9ec4\u91d1|\u767d\u94f6|\u6c47\u7387|\u80a1\u4ef7|\u80a1\u7968|\u6307\u6570|\u6cb9\u4ef7|\u5229\u7387|CPI|PPI|BTC|USDT|\u6bd4\u7279\u5e01|\u4eba\u6c11\u5e01|\u7f8e\u5143)/i.test(raw)) {
      return { requested: true, query: this.cleanWebSearchQuery(raw), freshness: this.pickWebSearchFreshness(raw) };
    }

    if (
      /^(?:\u6700\u65b0|\u4eca\u5929|\u4eca\u65e5|\u73b0\u5728|\u8fd1\u671f|\u6700\u8fd1)[\s\S]{2,}/.test(raw) &&
      /(?:\u65b0\u95fb|\u6d88\u606f|\u8fdb\u5c55|\u52a8\u6001|\u4ef7\u683c|\u653f\u7b56|\u60c5\u51b5|\u70ed\u641c|\u699c\u5355|\u53d1\u5e03|\u66f4\u65b0)/.test(raw)
    ) {
      return { requested: true, query: this.cleanWebSearchQuery(raw), freshness: this.pickWebSearchFreshness(raw) };
    }

    return { requested: false, query: "", freshness: "" };
  }

  shouldPreferLinkReadingOverSearch({ text = "", linkContext = "", request = {} } = {}) {
    if (!request?.requested || !linkContext) return false;
    if (request.githubTrending) return false;
    if (looksLikeHardWebSearchIntent(text)) return false;
    if (!looksLikeContextReferenceRequest(text) && !looksLikeLongFormReadingRequest(text)) return false;

    logEvent("info", "Feishu link reading preferred over web search", {
      query: request.query || "",
      linkChars: String(linkContext || "").length
    });
    return true;
  }

  cleanWebSearchQuery(text = "") {
    return String(text || "")
      .replace(/^[:\uff1a,\uff0c\s]+/, "")
      .replace(/(?:\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6\u4f60)\s*/g, "")
      .replace(/(?:\u770b\u770b|\u67e5\u67e5(?:\u770b)?|\u641c\u641c(?:\u770b)?|\u641c\u4e00\u4e0b|\u641c\u4e0b|\u67e5\u4e00\u4e0b|\u67e5\u4e0b)$/g, "")
      .trim();
  }

  extractInvestmentReportRequest(text = "") {
    const raw = String(text || "").trim();
    const match = raw.match(/^\u6295\u7814\u62a5\u544a\uff1a\s*([\s\S]*)$/);
    if (!match) return { requested: false, query: "", raw };
    return {
      requested: true,
      query: String(match[1] || "").trim(),
      raw
    };
  }

  extractResearchKbCleanupRequest(text = "") {
    const raw = String(text || "").trim();
    if (raw === "投研知识库清理预览") {
      return { requested: true, apply: false, raw };
    }
    if (raw === "投研知识库清理执行") {
      return { requested: true, apply: false, needsConfirmation: true, raw };
    }
    if (/^投研知识库清理执行\s*[：:]\s*我确认$/.test(raw)) {
      return { requested: true, apply: true, raw };
    }
    return { requested: false, apply: false, raw };
  }

  extractYoutubeResearchRequest(text = "") {
    const raw = String(text || "").trim();
    if (!raw) return { requested: false };

    const command = raw.match(/^\/?(?:youtube|yt|\u6cb9\u7ba1)\b\s*[:\uff1a,\uff0c]?\s*([\s\S]*)$/i);
    const url = extractYouTubeUrl(raw);
    const reference = extractYouTubeReference(url);
    const requested = Boolean(url || command || (/(?:youtube|yt|\u6cb9\u7ba1)/i.test(raw) && /(?:\u641c|\u627e|\u603b\u7ed3|\u5b57\u5e55|transcript|summary)/i.test(raw)));
    if (!requested) return { requested: false };

    const body = String(command?.[1] || raw)
      .replace(url, "")
      .replace(/\byoutube\b/ig, "")
      .replace(/\byt\b/ig, "")
      .replace(/\u6cb9\u7ba1/g, "")
      .trim();
    const topicQuery = raw.match(/\u5173\u4e8e\s*([a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff\s-]{1,60}?)(?:\u7684)?\u89c6\u9891/i)?.[1]?.trim() || "";
    const query = (topicQuery || body)
      .replace(/(?:\u5e2e\u6211|\u7ed9\u6211|\u9ebb\u70e6\u4f60)\s*/g, "")
      .replace(/(?:\u641c\u4e00\u4e0b|\u641c\u4e0b|\u641c\u641c(?:\u770b)?|\u641c\u7d22|\u627e\u4e00\u4e0b|\u627e\u4e0b|\u770b\u770b)\s*/g, "")
      .replace(/(?:\u5e76\u4e14|\u7136\u540e)?\s*(?:\u628a)?\s*(?:\u5b57\u5e55)?\s*(?:\u63d0\u53d6|\u603b\u7ed3|summary|transcript)[\s\S]*$/i, "")
      .replace(/(?:\u4e0a\u9762|\u91cc|\u4e0a|\u5173\u4e8e)/g, "")
      .replace(/(?:\u7684)?\u89c6\u9891/g, "")
      .trim();

    return {
      requested: true,
      sourceType: reference.kind || "search",
      videoUrl: reference.kind === "video" ? url : "",
      channelUrl: reference.kind === "channel" ? url : "",
      playlistUrl: reference.kind === "playlist" ? url : "",
      youtubeRef: reference.value || "",
      query: query || (url ? "" : body),
      topicHint: inferYoutubeTopic(raw, ""),
      maxVideos: reference.kind === "video" ? 1 : Math.max(1, Math.min(
        Number(this.config.youtubeResearchMaxVideos || 5),
        extractRequestedYoutubeVideoCount(raw) || 1
      )),
      raw
    };
  }

  async handleResearchKbCleanupRequest({ messageId, request }) {
    if (request.needsConfirmation) {
      await this.replyText(messageId, [
        "为了避免误清理，请发送完整确认命令：",
        "",
        "投研知识库清理执行：我确认"
      ].join("\n"));
      return;
    }
    if (!process.env.DATABASE_URL) {
      await this.replyText(messageId, "当前服务环境没有 `DATABASE_URL`，无法清理线上研究库。请确认这条命令是在 Render 部署服务里触发的。");
      return;
    }
    await this.replyText(messageId, request.apply
      ? "收到，开始清理旧 Markdown 时代遗留的研究库污染。"
      : "收到，先预览旧 Markdown 时代遗留污染，不会修改数据库。"
    );
    try {
      const args = ["scripts/sanitize-research-kb-artifacts.mjs"];
      if (request.apply) args.push("--apply");
      const { stdout, stderr } = await execFileAsync(process.execPath, args, {
        cwd: process.cwd(),
        timeout: 120000,
        maxBuffer: 1024 * 1024
      });
      const output = String(stdout || "").trim();
      let summary = null;
      try {
        summary = JSON.parse(output);
      } catch {
        summary = null;
      }
      if (!summary) {
        await this.replyText(messageId, `清理脚本已结束，但输出格式不完整：${truncate(output || stderr || "无输出", 1000)}`);
        return;
      }
      const changedCount = [
        summary.sourcesUpdated,
        summary.evidenceUpdated,
        summary.evidenceDeleted,
        summary.questionsUpdated,
        summary.questionsDeleted,
        summary.gapsUpdated,
        summary.gapsDeleted,
        summary.timeContextsUpdated,
        summary.topicsUpdated
      ].reduce((sum, item) => sum + Number(item || 0), 0);
      const sampleLines = (summary.samples || []).slice(0, 5).map((item, index) =>
        `${index + 1}. ${item.table} ${item.id}: ${item.before || "(空)"} -> ${item.after || "(删除)"}`
      );
      await this.replyText(messageId, [
        request.apply ? "投研知识库清理完成。" : "投研知识库清理预览完成，未修改数据库。",
        "",
        `总影响项：${changedCount}`,
        `来源标题更新：${summary.sourcesUpdated || 0}`,
        `证据更新：${summary.evidenceUpdated || 0}`,
        `证据删除：${summary.evidenceDeleted || 0}`,
        `问题更新/删除：${Number(summary.questionsUpdated || 0)}/${Number(summary.questionsDeleted || 0)}`,
        `缺口更新/删除：${Number(summary.gapsUpdated || 0)}/${Number(summary.gapsDeleted || 0)}`,
        `时间语境更新：${summary.timeContextsUpdated || 0}`,
        `主题图谱更新：${summary.topicsUpdated || 0}`,
        sampleLines.length ? "\n样例：\n" + sampleLines.join("\n") : "",
        !request.apply && changedCount > 0 ? "\n确认无误后发送：投研知识库清理执行：我确认" : ""
      ].filter(Boolean).join("\n"));
    } catch (error) {
      await this.replyText(messageId, `投研知识库清理失败：${truncate(error.message, 800)}`);
    }
  }

  async handleInvestmentReportRequest({ messageId, chatId, userId, request }) {
    if (!request.query) {
      await this.replyText(messageId, "请在 `投研报告：` 后面写清楚主题，例如：投研报告：商业航天 / 星舰 / 中国供应链替代");
      return;
    }
    if (typeof this.storage.listResearchEvidenceForReport !== "function") {
      await this.replyText(messageId, "研究知识库查询接口还没启用，暂时不能生成投研报告。");
      return;
    }
    if (!this.workspace?.enabled) {
      await this.replyText(messageId, "飞书文档接口还没配置好，暂时不能发布投研报告。");
      return;
    }
    const parentWikiToken = String(this.config.feishuInvestmentReportParentWikiToken || "").trim();
    if (!parentWikiToken) {
      await this.replyText(messageId, "投研报告文件夹还没配置：请在 Render 环境变量里添加 `FEISHU_INVESTMENT_REPORT_PARENT_WIKI_TOKEN`，我会把报告只发布到这个专用飞书文件夹。");
      return;
    }

    await this.replyText(messageId, "收到，开始从研究知识库聚合证据生成投研报告。");
    const timing = this.startTiming("Feishu investment report", { chatId, userId, query: request.query });
    const researchJobId = researchSourceId("job:investment_report", `${messageId}:${Date.now()}`);
    await this.storage.upsertResearchJob?.({
      id: researchJobId,
      sourceType: "investment_report",
      sourceUrl: request.query,
      status: "running",
      stage: "evidence_retrieval",
      attempts: 1,
      input: {
        trigger: "投研报告：",
        delivery: {
          messageId,
          chatId,
          userId
        },
        request,
        principles: [
          "strict_trigger_only",
          "generation_direction_first",
          "do_not_generate_garbage_then_reject",
          "cross_source_evidence_first",
          "coverage_gaps_reduce_confidence",
          "no_single_source_investment_report"
        ]
      }
    });

    try {
      const report = await this.buildInvestmentResearchReport(request, { researchJobId });
      this.markTiming(timing, "buildReportMs");
      if (report.reused) {
        await this.storage.updateResearchJob?.(researchJobId, {
          status: "done",
          stage: "reused_prior_report",
          output: {
            query: request.query,
            reused: true,
            feishuDocUrl: report.feishuDocUrl || "",
            priorVersionNo: report.priorReport?.versionNo || null,
            reason: report.reason || ""
          }
        });
        await this.replyText(messageId, [
          `已有可复用投研报告：${report.feishuDocUrl || ""}`,
          report.priorReport?.versionNo ? `复用版本：v${report.priorReport.versionNo}` : "",
          "判断说明：知识库里暂未发现该主题上一版报告之后的新相关来源，所以没有重复生成一份自我强化的新报告。上一版报告只作为判断基线，不会被当作新证据。"
        ].filter(Boolean).join("\n"));
        this.finishTiming(timing, { route: "investment_report", reused: true });
        return;
      }
      if (!report.ready) {
        await this.storage.updateResearchJob?.(researchJobId, {
          status: "done",
          stage: "evidence_not_enough",
          output: {
            query: request.query,
            reason: report.reason,
            sources: report.pack?.sources?.length || 0,
            evidenceCards: report.pack?.evidenceCards?.length || 0,
            backfill: report.backfill || {}
          }
        });
        await this.replyText(messageId, [
          `暂时不生成投研报告：${report.message}`,
          `当前检索到来源 ${report.pack?.sources?.length || 0} 个，证据卡 ${report.pack?.evidenceCards?.length || 0} 条。`,
          report.backfill?.attempted
            ? `历史文档回填：找到 ${report.backfill.candidates || 0} 篇候选文档，成功回填 ${report.backfill.imported || 0} 篇。`
            : "",
          "建议先继续喂同一主题的视频、报告、网页、论文、公告或监管资料，再用 `投研报告：主题` 触发。"
        ].filter(Boolean).join("\n"));
        this.finishTiming(timing, { route: "investment_report", ready: false, reason: report.reason });
        return;
      }

      await this.storage.updateResearchJob?.(researchJobId, {
        status: "running",
        stage: "document_write"
      });
      const doc = await this.workspace.createWikiDocument({
        parentWikiToken,
        title: report.title,
        markdown: report.markdown,
        requireRichMarkdown: true,
        articleGroupSourceType: "投研报告"
      });
      const groupNotification = doc.articleGroupNotification || null;
      const wechatCandidate = await this.registerWechatPublishCandidate({
        sourceType: "investment_report",
        title: report.title,
        markdown: report.markdown,
        feishuDocUrl: doc.url || "",
        sourceUrl: "",
        metadata: {
          query: request.query,
          sources: report.pack?.sources?.length || 0,
          evidenceCards: report.pack?.evidenceCards?.length || 0,
          topicCount: report.topicMap?.topics?.length || 0
        }
      });
      this.markTiming(timing, "documentMs");
      const versionInfo = typeof this.storage.recordInvestmentReportVersion === "function"
        ? await this.storage.recordInvestmentReportVersion({
          jobId: researchJobId,
          query: request.query,
          topicMap: report.topicMap,
          structured: report.structured,
          pack: report.pack,
          priorReport: report.priorReport
        })
        : null;
      await this.storage.updateResearchJob?.(researchJobId, {
        status: "done",
        stage: "done",
        output: {
          query: request.query,
          title: report.title,
          feishuDocUrl: doc.url || "",
          version: versionInfo || null,
          sources: report.pack.sources.length,
          evidenceCards: report.pack.evidenceCards.length,
          topicCount: report.topicMap?.topics?.length || 0,
          backfill: report.backfill || {},
          aiFallback: report.aiFallback || null,
          wechatCandidateId: wechatCandidate?.id || "",
          articleGroupNotification: groupNotification || null,
          document: {
            token: doc.token || "",
            wikiToken: doc.wikiToken || "",
            blocks: doc.blocks || 0,
            writeMode: doc.writeMode || "",
            writeDiagnostics: doc.writeDiagnostics || {}
          }
        }
      });
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: `投研报告已生成：${doc.url || ""}`,
        metadata: {
          platform: "feishu",
          investmentReport: true,
          query: request.query,
          feishuDocUrl: doc.url || "",
          wechatCandidateId: wechatCandidate?.id || "",
          articleGroupNotification: groupNotification || null,
          version: versionInfo || null,
          sourceCount: report.pack.sources.length,
          evidenceCards: report.pack.evidenceCards.length,
          aiFallback: report.aiFallback || null
        }
      });
      await this.replyText(messageId, [
        `投研报告已生成：${doc.url || ""}`,
        versionInfo?.versionNo ? `报告版本：v${versionInfo.versionNo}` : "",
        `证据基础：${report.pack.sources.length} 个来源，${report.pack.evidenceCards.length} 条证据卡。`,
        report.aiFallback?.reason === "ai_synthesis_partial_fallback"
          ? "生成说明：报告已按分段结构化方式生成；少数段落由结构化证据补齐。"
          : "",
        report.topicMap?.topics?.length ? `主题图谱：已关联 ${report.topicMap.topics.length} 个节点。` : "",
        report.backfill?.imported ? `已自动从历史 YouTube 文档回填 ${report.backfill.imported} 篇。` : ""
      ].filter(Boolean).join("\n"));
      if (wechatCandidate?.id) {
        try {
          await this.replyCard(messageId, this.buildWechatCandidateCard({
            candidate: wechatCandidate,
            title: report.title,
            doc,
            sourceType: "投研报告"
          }));
        } catch (cardError) {
          logEvent("warn", "Investment report WeChat candidate card failed", {
            candidateId: wechatCandidate.id,
            error: cardError.message
          });
        }
      }
      this.finishTiming(timing, {
        route: "investment_report",
        ready: true,
        sources: report.pack.sources.length,
        evidenceCards: report.pack.evidenceCards.length,
        feishuDocCreated: Boolean(doc.url)
      });
    } catch (error) {
      await this.storage.updateResearchJob?.(researchJobId, {
        status: "failed",
        stage: "failed",
        error: error.message
      });
      this.finishTiming(timing, { route: "investment_report", ok: false, error: error.message });
      logEvent("error", "Feishu investment report failed", {
        chatId,
        query: request.query,
        error: error.message
      });
      await this.replyText(messageId, `投研报告生成失败：${truncate(error.message, 500)}`);
    }
  }

  async resumeInterruptedInvestmentReports({ limit = 10, staleSeconds = 30 } = {}) {
    if (typeof this.storage.listRecentResearchJobs !== "function") return { inspected: 0, resumed: 0, marked: 0 };
    const jobs = await this.storage.listRecentResearchJobs({ sourceType: "investment_report", limit });
    const cutoff = Date.now() - Math.max(0, Number(staleSeconds) || 0) * 1000;
    let inspected = 0;
    let resumed = 0;
    let marked = 0;
    for (const job of jobs) {
      if (String(job.status || "") !== "running") continue;
      const updatedAt = Date.parse(job.updatedAt || job.updated_at || "");
      if (Number.isFinite(updatedAt) && updatedAt > cutoff) continue;
      inspected += 1;
      const input = job.input || {};
      const request = input.request || {};
      const delivery = input.delivery || {};
      if (!request.query || !delivery.messageId || !delivery.chatId || !delivery.userId) {
        await this.storage.updateResearchJob?.(job.id, {
          status: "failed",
          stage: "interrupted_unresumable",
          error: "Investment report job was interrupted by process restart before resumable delivery metadata was recorded."
        });
        marked += 1;
        continue;
      }
      await this.storage.updateResearchJob?.(job.id, {
        status: "failed",
        stage: "interrupted_rescheduled",
        error: "Investment report job was interrupted by process restart and rescheduled as a new job."
      });
      resumed += 1;
      this.handleInvestmentReportRequest({
        messageId: delivery.messageId,
        chatId: delivery.chatId,
        userId: delivery.userId,
        request
      }).catch((error) => {
        logEvent("error", "Feishu interrupted investment report resume failed", {
          jobId: job.id,
          query: request.query,
          error: error.message
        });
      });
    }
    if (inspected) {
      logEvent("info", "Feishu interrupted investment reports inspected", { inspected, resumed, marked });
    }
    return { inspected, resumed, marked };
  }

  async readFeishuDocumentTextByUrl(url = "") {
    if (!this.workspace?.enabled || !url) return "";
    const wikiToken = extractFeishuWikiToken(url);
    if (wikiToken) return this.workspace.readWikiNodeRawContent(wikiToken);
    const docxId = extractFeishuDocxId(url);
    if (docxId) return this.workspace.readDocumentRawContent(docxId);
    return "";
  }

  async backfillInvestmentReportEvidenceFromYoutubeHistory(request = {}, { researchJobId = "" } = {}) {
    if (typeof this.storage.listYoutubeResearchHistoryForBackfill !== "function") {
      return { attempted: false, imported: 0, reason: "history_lookup_not_supported" };
    }
    if (typeof this.storage.upsertResearchSourceBundle !== "function") {
      return { attempted: false, imported: 0, reason: "research_bundle_write_not_supported" };
    }
    if (!this.workspace?.enabled) {
      return { attempted: false, imported: 0, reason: "feishu_workspace_not_enabled" };
    }
    const candidateLimit = Math.max(1, Math.min(12, Number(this.config.investmentReportBackfillLimit || 4)));
    const concurrency = Math.max(1, Math.min(5, Number(this.config.investmentReportBackfillConcurrency || 3)));
    const history = await this.storage.listYoutubeResearchHistoryForBackfill({
      query: request.query,
      limit: candidateLimit
    });
    let imported = 0;
    let skippedExisting = 0;
    const errors = [];
    await this.storage.updateResearchJob?.(researchJobId, {
      status: "running",
      stage: "backfill_history",
      output: {
        query: request.query,
        candidates: history.length,
        concurrency
      }
    });

    let cursor = 0;
    const worker = async () => {
      while (cursor < history.length) {
        const item = history[cursor];
        cursor += 1;
        await importOne(item);
      }
    };
    const importOne = async (item) => {
      const metadata = item.metadata || {};
      const docUrl = metadata.feishuDocUrl || "";
      if (!docUrl) return;
      try {
        const existingSourceId = researchSourceIdForYoutubeHistoryDoc(item, request);
        if (existingSourceId && await this.storage.hasResearchSource?.(existingSourceId)) {
          skippedExisting += 1;
          return;
        }
        const rawText = await this.readFeishuDocumentTextByUrl(docUrl);
        if (!rawText || rawText.length < 300) return;
        const bundle = buildResearchKnowledgeBundleFromYoutubeHistoryDoc(item, rawText, request);
        if (!bundle.evidenceCards.length) return;
        await this.storage.upsertResearchSourceBundle(bundle);
        imported += 1;
      } catch (error) {
        errors.push({ docUrl, error: error.message });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, history.length || 1) }, () => worker()));
    return {
      attempted: true,
      imported,
      candidates: history.length,
      concurrency,
      skippedExisting,
      errors: errors.slice(0, 5)
    };
  }

  async synthesizeInvestmentReportStructured(request = {}, pack = {}) {
    const evidencePack = investmentReportEvidencePrompt(pack);
    const options = (maxTokens) => ({
      maxTokens,
      temperature: 0.15,
      responseFormat: { type: "json_object" },
      allowFallback: false,
      requirePrimary: true,
      retryAttempts: Math.max(1, Math.min(2, Number(this.config.investmentReportAiRetryAttempts || 1))),
      timeoutMs: this.config.investmentReportAiTimeoutMs || this.config.youtubeResearchAiTimeoutMs || this.config.aiTimeoutMs || 90000
    });
    const common = [
      `Strict trigger: 投研报告：`,
      `Research topic: ${request.query}`,
      "",
      "Evidence pack:",
      evidencePack
    ].join("\n");
    const parts = [
      {
        label: "opening",
        maxTokens: 1800,
        user: [
          common,
          "",
          "Fill only this report-opening schema:",
          "{",
          '  "title": "polished Chinese research-report title",',
          '  "oneSentence": "one decisive but evidence-bounded conclusion",',
          '  "thesis": "core industry-chain thesis and its boundary",',
          '  "topicBoundary": "what this report includes, excludes, and why this boundary fits the evidence",',
          '  "industryMap": ["specific value-chain or ecosystem map item grounded in the evidence"],',
          '  "investableMap": ["investable or trackable public-market direction, mapped to evidence and still bounded by uncertainty"],',
          '  "valuePools": ["where long-term value may accrue: cost, capacity, reliability, demand, regulation, software, services, or supply-chain bottleneck"],',
          '  "peerComparison": ["peer, substitute route, region, or technology-route comparison dimension to investigate next"],',
          '  "timeCalibration": ["source date, event date, current relevance, and stale-data risk"],',
          '  "deltaSincePrior": "what changed versus prior report baseline; if no prior report, say this is v1 baseline",',
          '  "evidenceBase": ["what the current evidence base can and cannot support"]',
          "}",
          "Cardinality: industryMap 4-10, investableMap 3-8, valuePools 3-8, peerComparison 3-8, timeCalibration 3-8, evidenceBase 3-6."
        ].join("\n")
      },
      {
        label: "hypotheses",
        maxTokens: 2400,
        user: [
          common,
          "",
          "Fill only this hypothesis schema:",
          "{",
          '  "hypotheses": [{"title":"industry-chain hypothesis", "logic":"why it may be true", "evidenceIds":["E1"], "counterEvidenceIds":["E2"], "timeRisk":"what may be stale or time-misaligned", "confidence":"low/medium/high with reason"}]',
          "}",
          "Cardinality: hypotheses 3-6. Each hypothesis must cite evidenceIds from the evidence pack."
        ].join("\n")
      },
      {
        label: "nodes",
        maxTokens: 2200,
        user: [
          common,
          "",
          "Fill only this value-chain node schema:",
          "{",
          '  "valueChainNodes": [{"node":"value-chain node", "whyItMatters":"why this node may matter", "signals":["observable leading signal"], "risks":["risk or boundary"], "evidenceIds":["E1"]}],',
          '  "leadingIndicators": ["observable indicator to track next"],',
          '  "catalystCalendar": [{"horizon":"3-6 months / 6-12 months / 12-24 months", "event":"specific catalyst to watch", "watch":"what data confirms or weakens it", "evidenceIds":["E1"]}]',
          "}",
          "Cardinality: valueChainNodes 4-10, leadingIndicators 5-12, catalystCalendar 3-8."
        ].join("\n")
      },
      {
        label: "risks_tasks",
        maxTokens: 1800,
        user: [
          common,
          "",
          "Fill only this risk and research-task schema:",
          "{",
          '  "scenarios": [{"name":"optimistic/base/bearish scenario in Chinese", "condition":"what must happen", "implication":"industry-chain investment implication", "evidenceIds":["E1"]}],',
          '  "risks": ["counter-evidence, missing data, or alternative explanation"],',
          '  "timeContextRisks": ["time mismatch or stale-data risk"],',
          '  "falsificationConditions": ["specific evidence that would disconfirm or downgrade the thesis"],',
          '  "nextResearchTasks": ["specific next research task and suggested source type"]',
          "}",
          "Cardinality: scenarios 3-5, risks 4-10, timeContextRisks 2-8, falsificationConditions 3-8, nextResearchTasks 5-12."
        ].join("\n")
      }
    ];
    const settled = await Promise.allSettled(parts.map(async (part) => {
      const raw = await this.ai.chat([
        { role: "system", content: investmentReportSynthesisSystemPrompt() },
        { role: "user", content: part.user }
      ], options(part.maxTokens));
      return {
        label: part.label,
        value: await this.parseYoutubeJsonObject(raw, `investment research report ${part.label}`)
      };
    }));
    const merged = {};
    const failures = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        Object.assign(merged, result.value.value || {});
      } else {
        failures.push({ message: result.reason?.message || String(result.reason || "") });
      }
    }
    if (failures.length === parts.length) {
      throw new Error(failures[0]?.message || "investment report segmented synthesis failed");
    }
    const fallback = buildFallbackInvestmentReportStructured(pack, request, failures[0] || null);
    const rawStructured = {
      ...fallback,
      ...merged,
      industryMap: asArray(merged.industryMap).length ? merged.industryMap : fallback.industryMap,
      investableMap: asArray(merged.investableMap).length ? merged.investableMap : fallback.investableMap,
      valuePools: asArray(merged.valuePools).length ? merged.valuePools : fallback.valuePools,
      peerComparison: asArray(merged.peerComparison).length ? merged.peerComparison : fallback.peerComparison,
      timeCalibration: asArray(merged.timeCalibration).length ? merged.timeCalibration : fallback.timeCalibration,
      evidenceBase: asArray(merged.evidenceBase).length ? merged.evidenceBase : fallback.evidenceBase,
      hypotheses: asArray(merged.hypotheses).length ? merged.hypotheses : fallback.hypotheses,
      valueChainNodes: asArray(merged.valueChainNodes).length ? merged.valueChainNodes : fallback.valueChainNodes,
      leadingIndicators: asArray(merged.leadingIndicators).length ? merged.leadingIndicators : fallback.leadingIndicators,
      catalystCalendar: asArray(merged.catalystCalendar).length ? merged.catalystCalendar : fallback.catalystCalendar,
      scenarios: asArray(merged.scenarios).length ? merged.scenarios : fallback.scenarios,
      risks: asArray(merged.risks).length ? merged.risks : fallback.risks,
      timeContextRisks: asArray(merged.timeContextRisks).length ? merged.timeContextRisks : fallback.timeContextRisks,
      falsificationConditions: asArray(merged.falsificationConditions).length ? merged.falsificationConditions : fallback.falsificationConditions,
      nextResearchTasks: asArray(merged.nextResearchTasks).length ? merged.nextResearchTasks : fallback.nextResearchTasks
    };
    return {
      structured: normalizeInvestmentReportStructured(rawStructured, request),
      failures
    };
  }

  async buildInvestmentResearchReport(request = {}, { researchJobId = "" } = {}) {
    await this.storage.updateResearchJob?.(researchJobId, {
      status: "running",
      stage: "topic_graph_retrieval"
    });
    let topicMap = typeof this.storage.getResearchTopicMap === "function"
      ? await this.storage.getResearchTopicMap({ query: request.query, limit: 80 })
      : { topics: [], edges: [] };
    topicMap = normalizeInvestmentTopicMap(topicMap);
    let priorReport = typeof this.storage.getPriorInvestmentReport === "function"
      ? await this.storage.getPriorInvestmentReport({ query: request.query, topicMap })
      : null;
    let corpus = await this.storage.listResearchEvidenceForReport({
      query: request.query,
      limit: 12,
      evidenceLimit: 120,
      topicMap
    });
    let pack = buildInvestmentReportEvidencePack(corpus);
    pack.topicMap = normalizeInvestmentTopicMap(corpus.topicMap || topicMap);
    pack.priorReport = priorReport;
    const reusableReport = typeof this.storage.getReusableInvestmentReport === "function"
      ? await this.storage.getReusableInvestmentReport({
        query: request.query,
        topicMap,
        maxAgeMinutes: this.config.investmentReportReuseMaxAgeMinutes || 720
      })
      : null;
    if (reusableReport?.feishuDocUrl) {
      return {
        ready: true,
        reused: true,
        feishuDocUrl: reusableReport.feishuDocUrl,
        priorReport: reusableReport,
        reason: reusableReport.reason || "reusable_prior_report_without_new_evidence",
        pack
      };
    }
    let readiness = assessInvestmentReportReadiness(pack);
    let backfill = { attempted: false, imported: 0 };
    if (!readiness.ready) {
      backfill = await this.backfillInvestmentReportEvidenceFromYoutubeHistory(request, { researchJobId });
      if (backfill.imported > 0) {
        await this.storage.updateResearchJob?.(researchJobId, {
          status: "running",
          stage: "evidence_retrieval_after_backfill",
          output: { query: request.query, backfill }
        });
        topicMap = typeof this.storage.getResearchTopicMap === "function"
          ? await this.storage.getResearchTopicMap({ query: request.query, limit: 80 })
          : topicMap;
        topicMap = normalizeInvestmentTopicMap(topicMap);
        priorReport = typeof this.storage.getPriorInvestmentReport === "function"
          ? await this.storage.getPriorInvestmentReport({ query: request.query, topicMap })
          : priorReport;
        corpus = await this.storage.listResearchEvidenceForReport({
          query: request.query,
          limit: 12,
          evidenceLimit: 120,
          topicMap
        });
        pack = buildInvestmentReportEvidencePack(corpus);
        pack.topicMap = normalizeInvestmentTopicMap(corpus.topicMap || topicMap);
        pack.priorReport = priorReport;
        readiness = assessInvestmentReportReadiness(pack);
      }
    }
    if (!readiness.ready) {
      return { ready: false, reason: readiness.reason, message: readiness.message, pack, backfill };
    }
    await this.storage.updateResearchJob?.(researchJobId, {
      status: "running",
      stage: "ai_synthesis",
      output: {
        query: request.query,
        sources: pack.sources.length,
        evidenceCards: pack.evidenceCards.length,
        topicCount: pack.topicMap?.topics?.length || 0,
        priorReport: Boolean(priorReport),
        backfill
      }
    });
    let aiFallback = null;
    let structured;
    try {
      const synthesis = await this.synthesizeInvestmentReportStructured(request, pack);
      structured = synthesis.structured;
      if (synthesis.failures.length) {
        aiFallback = {
          reason: "ai_synthesis_partial_fallback",
          message: synthesis.failures.map((failure) => failure.message).filter(Boolean).slice(0, 3).join(" | ")
        };
      }
    } catch (error) {
      const failure = {
        reason: /timeout|aborted/i.test(String(error?.message || "")) ? "ai_synthesis_timeout" : "ai_synthesis_failed",
        message: error.message || String(error)
      };
      logEvent("warn", "Investment report AI synthesis failed without publishing fallback report", {
        query: request.query,
        reason: failure.reason,
        error: truncate(failure.message, 300)
      });
      await this.storage.updateResearchJob?.(researchJobId, {
        status: "failed",
        stage: "ai_synthesis_retryable_failed",
        error: failure.message,
        output: {
          query: request.query,
          sources: pack.sources.length,
          evidenceCards: pack.evidenceCards.length,
          failure,
          publishSkipped: true,
          reason: "primary_model_synthesis_failed_no_baseline_report_published"
        }
      });
      throw new Error(`投研报告主模型综合失败，未发布证据基线占位报告：${truncate(failure.message, 300)}`);
    }
    const markdown = cleanInvestmentReportMarkdown(renderInvestmentResearchReportMarkdown(structured, pack, request));
    assertInvestmentResearchReportMarkdown(markdown);
    return {
      ready: true,
      title: structured.title,
      markdown,
      structured,
      aiFallback,
      pack,
      topicMap: pack.topicMap || topicMap,
      priorReport,
      backfill
    };
  }

  isGithubTrendingRequest(text = "") {
    const value = String(text || "");
    return /github/i.test(value) && /(?:热榜|热门|趋势|trending|榜单|排行|仓库|repo|repository|开源项目)/i.test(value);
  }

  pickWebSearchFreshness(text = "") {
    return inferSearchFreshness(text, this.config.bochaSearchFreshness || "noLimit");
  }

  async mergeResearchJobOutput(researchJobId = "", patch = {}) {
    if (!researchJobId) return {};
    if (typeof this.storage.mergeResearchJobOutput === "function") {
      return this.storage.mergeResearchJobOutput(researchJobId, patch);
    }
    const jobs = await this.storage.listRecentResearchJobs?.({ limit: 100 }) || [];
    const current = jobs.find((job) => String(job.id) === String(researchJobId))?.output || {};
    const output = { ...current, ...(patch || {}) };
    await this.storage.updateResearchJob?.(researchJobId, { output });
    return output;
  }

  async clearExpiredYoutubeArticlePartCaches() {
    const jobs = await this.storage.listRecentResearchJobs?.({ sourceType: "video", limit: 100 }) || [];
    const now = Date.now();
    let cleared = 0;
    for (const job of jobs) {
      const cache = job.output?.youtubeArticleParts;
      if (!cache?.parts) continue;
      const expiresAt = Date.parse(cache.expiresAt || "");
      if (Number.isFinite(expiresAt) && expiresAt > now) continue;
      await this.mergeResearchJobOutput(job.id, {
        youtubeArticleParts: {
          clearedIntermediateParts: true,
          clearReason: "expired_after_24h",
          clearedAt: new Date().toISOString(),
          summary: summarizeYoutubeArticleParts(cache)
        }
      });
      cleared += 1;
    }
    if (cleared) {
      logEvent("info", "Expired YouTube article part caches cleared", { cleared });
    }
  }

  async findReusableYoutubeArticlePartCache(sourceUrl = "") {
    const sourceKey = youtubeArticlePartsSourceKey(sourceUrl);
    if (!sourceKey) return null;
    const jobs = await this.storage.listRecentResearchJobs?.({ sourceType: "video", limit: 100 }) || [];
    for (const job of jobs) {
      if (String(job.sourceUrl || job.source_url || "") !== String(sourceUrl || "")) continue;
      const cache = job.output?.youtubeArticleParts;
      if (!isFreshYoutubeArticlePartsCache(cache, sourceKey)) continue;
      const summary = summarizeYoutubeArticleParts(cache);
      if (!summary.done) continue;
      return {
        ...cache,
        recoveredFromJobId: job.id
      };
    }
    return null;
  }

  async clearYoutubeArticlePartCacheAfterPublish(researchJobId = "", { report = {}, doc = {} } = {}) {
    if (!researchJobId || !doc.created) return;
    const current = (await this.mergeResearchJobOutput(researchJobId, {})) || {};
    const cache = current.youtubeArticleParts || {};
    await this.mergeResearchJobOutput(researchJobId, {
      youtubeArticleParts: {
        clearedIntermediateParts: true,
        clearReason: "published",
        clearedAt: new Date().toISOString(),
        summary: summarizeYoutubeArticleParts(cache),
        title: report.title || "",
        feishuDocUrl: doc.url || ""
      }
    });
  }

  async handleYoutubeResearchRequest({ messageId, chatId, userId, request }) {
    if (!this.transcriptApi?.enabled) {
      await this.replyText(messageId, "\u0059\u006f\u0075\u0054\u0075\u0062\u0065 \u5b57\u5e55\u63d0\u53d6\u8fd8\u6ca1\u914d\u7f6e\u597d\uff0c\u9700\u8981\u5728 Render \u91cc\u52a0 TRANSCRIPT_API_KEY\u3002");
      return;
    }
    if (!request.videoUrl && !request.channelUrl && !request.playlistUrl && !request.query) {
      await this.replyText(messageId, "\u8981\u641c\u4ec0\u4e48 YouTube \u89c6\u9891\uff1f\u4f8b\u5982\uff1ayoutube SpaceX Starship \u6280\u672f\u7ec6\u8282\u3002");
      return;
    }

    await this.replyText(messageId, "\u597d\u7684\uff0c\u6211\u6574\u7406\u597d\u7a0d\u540e\u53d1\u4f60\u54e6");
    const researchJobId = researchSourceId("job", `${messageId}:${Date.now()}`);
    const researchSourceUrl = request.videoUrl || request.channelUrl || request.playlistUrl || request.query || "";
    await this.clearExpiredYoutubeArticlePartCaches();
    const reusableArticleParts = await this.findReusableYoutubeArticlePartCache(researchSourceUrl);
    await this.storage.upsertResearchJob?.({
      id: researchJobId,
      sourceType: "video",
      sourceUrl: researchSourceUrl,
      status: "running",
      stage: "youtube_article_generation",
      attempts: 1,
      input: {
        adapter: "youtube",
        request,
        principles: [
          "plan_before_generation",
          "evidence_before_opinion",
          "reader_document_plus_machine_evidence",
          "time_context_first_class"
        ]
      },
      output: {
        ...(reusableArticleParts ? { youtubeArticleParts: reusableArticleParts } : {})
      }
    });
    const timing = this.startTiming("Feishu YouTube research", {
      chatId,
      userId,
      sourceType: request.sourceType || "",
      hasUrl: Boolean(request.videoUrl || request.channelUrl || request.playlistUrl)
    });

    try {
      logEvent("info", "Feishu YouTube research started", {
        chatId,
        userId,
        query: request.query || "",
        sourceType: request.sourceType || "",
        hasUrl: Boolean(request.videoUrl || request.channelUrl || request.playlistUrl),
        topicHint: request.topicHint || ""
      });
      const report = await this.buildYoutubeResearchReport(request, {
        researchJobId,
        youtubeArticleParts: reusableArticleParts,
        sourceUrl: researchSourceUrl
      });
      await this.mergeResearchJobOutput(researchJobId, {
        topic: report.topic,
        title: report.title,
        videos: report.videos.length,
        diagnostics: report.diagnostics
      });
      await this.storage.updateResearchJob?.(researchJobId, {
        stage: "feishu_document_generation",
      });
      this.markTiming(timing, "buildReportMs");
      const documentStartedAt = Date.now();
      const doc = await this.syncYoutubeResearchToFeishuDocument(report);
      doc.diagnostics = {
        ...(doc.diagnostics || {}),
        documentMs: elapsedMsSince(documentStartedAt)
      };
      this.markTiming(timing, "feishuDocumentMs");
      await this.clearYoutubeArticlePartCacheAfterPublish(researchJobId, { report, doc });
      const wechatCandidate = doc.created
        ? await this.registerWechatPublishCandidate({
            sourceType: "youtube_research",
            title: this.resolveYoutubeDocumentTitle(report),
            markdown: doc.markdown || report.markdown || "",
            feishuDocUrl: doc.url || "",
            sourceUrl: report.videos?.[0]?.url || "",
            metadata: {
              topic: report.topic,
              videos: (report.videos || []).map((video) => ({
                title: video.title || "",
                url: video.url || "",
                channel: video.channel || ""
              })).slice(0, 8)
            }
          })
        : null;
      const pendingSync = { synced: false, notePath: "", topicPath: "", reason: "pending" };
      const pendingIndex = { synced: false, reason: doc.created ? "pending" : "doc_not_created" };
      const deliveryStartedAt = Date.now();
      const reply = this.formatYoutubeResearchReply(report, pendingSync, doc, pendingIndex);
      const card = this.buildYoutubeResearchCard(report, pendingSync, doc, pendingIndex, wechatCandidate);
      let delivered = "card";
      try {
        await this.replyCard(messageId, card);
      } catch (cardError) {
        delivered = "text_fallback";
        logEvent("warn", "Feishu YouTube research card fallback used", {
          chatId,
          topic: report.topic,
          error: cardError.message
        });
        for (const chunk of splitChatBubbles(reply, 1800)) {
          await this.replyText(messageId, chunk);
        }
      }
      doc.diagnostics.deliveryMs = elapsedMsSince(deliveryStartedAt);
      this.markTiming(timing, "deliveryMs");
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: delivered === "card" ? "card" : "text",
        content: reply,
        metadata: {
          platform: "feishu",
          replyToUserId: userId,
          youtubeResearch: true,
          topic: report.topic,
          videoCount: report.videos.length,
          obsidianPath: "",
          feishuDocUrl: doc.url || "",
          wechatCandidateId: wechatCandidate?.id || "",
          feishuIndexSynced: false,
          backgroundSyncPending: true,
          youtubeDiagnostics: {
            ...(report.diagnostics || {}),
            documentMs: doc.diagnostics?.documentMs || 0,
            deliveryMs: doc.diagnostics?.deliveryMs || 0
          }
        }
      });
      this.markTiming(timing, "storeAssistantMs");

      logEvent("info", "Feishu YouTube document reply sent", {
        chatId,
        topic: report.topic,
        videos: report.videos.length,
        feishuDocCreated: Boolean(doc.created)
      });
      await this.runYoutubeBackgroundSync({ messageId, chatId, userId, report, doc, timing, researchJobId });
    } catch (error) {
      await this.storage.updateResearchJob?.(researchJobId, {
        status: "failed",
        stage: "failed",
        error: error.message
      });
      this.finishTiming(timing, { ok: false, error: error.message });
      logEvent("error", "Feishu YouTube research failed", {
        chatId,
        query: request.query || "",
        error: error.message
      });
      await this.replyText(messageId, "YouTube 字幕整理这次没有生成可发布文档，我已经记录了内部错误。请稍后直接重试同一个链接；如果连续失败，我会优先检查字幕提取和文章生成链路。");
    }
  }

  async runYoutubeBackgroundSync({ messageId, chatId, userId, report, doc, timing, researchJobId = "" }) {
    const syncPromise = this.syncYoutubeResearchToObsidian(report).then((sync) => {
      this.markTiming(timing, "obsidianSyncMs");
      return sync;
    }).catch((error) => {
      logEvent("warn", "Feishu YouTube Obsidian background sync failed", {
        chatId,
        title: report.title,
        error: error.message
      });
      this.markTiming(timing, "obsidianSyncMs");
      return { synced: false, notePath: "", topicPath: "", reason: error.message };
    });

    const indexPromise = this.syncYoutubeResearchToFeishuIndex(report, {
      synced: false,
      notePath: "",
      topicPath: "",
      reason: "pending"
    }, doc).then((index) => {
      this.markTiming(timing, "feishuIndexMs");
      return index;
    }).catch((error) => {
      logEvent("warn", "Feishu YouTube index background sync failed", {
        chatId,
        title: report.title,
        error: error.message
      });
      this.markTiming(timing, "feishuIndexMs");
      return { synced: false, reason: error.message };
    });

    const [sync, index] = await Promise.all([syncPromise, indexPromise]);
    let knowledgeBase = { synced: false, reason: "not_started" };
    try {
      knowledgeBase = await this.syncYoutubeResearchToResearchKnowledgeBase(report, { doc, sync, index });
      this.markTiming(timing, "researchKnowledgeBaseMs");
      await this.mergeResearchJobOutput(researchJobId, {
        topic: report.topic,
        title: report.title,
        feishuDocUrl: doc.url || "",
        obsidianPath: sync.notePath || "",
        knowledgeBase
      });
      await this.storage.updateResearchJob?.(researchJobId, {
        status: "done",
        stage: "done"
      });
    } catch (error) {
      this.markTiming(timing, "researchKnowledgeBaseMs");
      knowledgeBase = { synced: false, reason: error.message };
      await this.storage.updateResearchJob?.(researchJobId, {
        status: "failed",
        stage: "research_knowledge_base_failed",
        error: error.message
      });
      logEvent("warn", "Feishu YouTube research knowledge base sync failed", {
        chatId,
        title: report.title,
        error: error.message
      });
    }

    const finalReply = this.formatYoutubeResearchReply(report, sync, doc, index);
    await this.storage.addMessage({
      chatId,
      userId,
      role: "assistant",
      modality: "system",
      content: finalReply,
      metadata: {
        platform: "feishu",
        replyToUserId: userId,
        youtubeResearch: true,
        topic: report.topic,
        videoCount: report.videos.length,
        obsidianPath: sync.notePath || "",
        feishuDocUrl: doc.url || "",
        feishuIndexSynced: Boolean(index.synced),
        backgroundSyncComplete: true,
        youtubeDiagnostics: {
          ...(report.diagnostics || {}),
          documentMs: doc.diagnostics?.documentMs || 0,
          deliveryMs: doc.diagnostics?.deliveryMs || 0,
          obsidianSyncMs: timing?.steps?.obsidianSyncMs || 0,
          feishuIndexMs: timing?.steps?.feishuIndexMs || 0,
          researchKnowledgeBaseMs: timing?.steps?.researchKnowledgeBaseMs || 0,
          researchKnowledgeBase: knowledgeBase
        }
      }
    });

    logEvent("info", "Feishu YouTube background sync finished", {
      chatId,
      topic: report.topic,
      obsidianSynced: Boolean(sync.synced),
      obsidianReason: sync.synced ? "" : sync.reason || "",
      feishuIndexSynced: Boolean(index.synced),
      feishuIndexReason: index.synced ? "" : index.reason || "",
      researchKnowledgeBaseSynced: Boolean(knowledgeBase.synced),
      researchKnowledgeBaseReason: knowledgeBase.synced ? "" : knowledgeBase.reason || ""
    });
    this.finishTiming(timing, {
      ok: true,
      topic: report.topic,
      videos: report.videos.length,
      feishuDocCreated: Boolean(doc.created),
      obsidianSynced: Boolean(sync.synced),
      feishuIndexSynced: Boolean(index.synced),
      researchKnowledgeBaseSynced: Boolean(knowledgeBase.synced)
    });

    if (!sync.synced || !index.synced || !knowledgeBase.synced) {
      const parts = [];
      if (!sync.synced) parts.push(`Obsidian：${truncate(sync.reason || "未同步", 120)}`);
      if (!index.synced) parts.push(`知识库目录：${truncate(index.reason || "未归档", 120)}`);
      if (!knowledgeBase.synced) parts.push(`research_kb:${truncate(knowledgeBase.reason || "not_synced", 120)}`);
      await this.replyText(messageId, `后台同步没完全成功：${parts.join("；")}`);
    } else {
      await this.replyText(messageId, "同步完成：飞书知识库目录和 Obsidian 已同步。");
    }

    return { sync, index, knowledgeBase };
  }

  async syncYoutubeResearchToResearchKnowledgeBase(report, { doc = {}, sync = {}, index = {} } = {}) {
    if (typeof this.storage.upsertResearchSourceBundle !== "function") {
      return { synced: false, reason: "storage_not_supported" };
    }
    const bundle = buildResearchKnowledgeBundleFromYoutubeReport(report, { doc, sync, index });
    const result = await this.storage.upsertResearchSourceBundle(bundle);
    return {
      synced: true,
      ...result
    };
  }

  async buildYoutubeResearchReport(request = {}, options = {}) {
    const startedAt = Date.now();
    const diagnostics = {
      sourceType: request.sourceType || "",
      candidateMs: 0,
      transcriptMs: 0,
      aiMs: 0,
      videosAttempted: 0,
      videosWithTranscript: 0,
      failures: 0,
      totalMs: 0
    };
    const videos = [];
    const failures = [];

    if (request.videoUrl) {
      const transcriptStartedAt = Date.now();
      const transcript = await this.transcriptApi.getTranscript(request.videoUrl, { sendMetadata: true });
      diagnostics.transcriptMs += elapsedMsSince(transcriptStartedAt);
      diagnostics.videosAttempted += 1;
      videos.push(this.normalizeYoutubeTranscriptForReport(transcript, request.videoUrl));
    } else {
      const candidateStartedAt = Date.now();
      const candidates = await this.resolveYoutubeCandidateVideos(request);
      diagnostics.candidateMs = elapsedMsSince(candidateStartedAt);
      if (!candidates.length) {
        throw new Error("Transcript API did not return YouTube video results.");
      }
      for (const item of candidates) {
        diagnostics.videosAttempted += 1;
        try {
          const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.videoId}`;
          const transcriptStartedAt = Date.now();
          const transcript = await this.transcriptApi.getTranscript(videoUrl, { sendMetadata: true });
          diagnostics.transcriptMs += elapsedMsSince(transcriptStartedAt);
          videos.push(this.normalizeYoutubeTranscriptForReport(transcript, videoUrl, item));
        } catch (error) {
          failures.push(`${item.title || item.videoId || item.url}: ${error.message}`);
        }
      }
    }

    if (!videos.length) {
      throw new Error(failures[0] || "No usable YouTube transcripts were found.");
    }
    diagnostics.videosWithTranscript = videos.length;
    diagnostics.failures = failures.length;
    if (typeof options.onProgress === "function") {
      await options.onProgress({ stage: "transcripts_ready", videos, failures });
    }

    const topic = this.resolveYoutubeReportTopic(request, videos);
    const aiStartedAt = Date.now();
    const generated = await this.generateYoutubeResearchMarkdown({
      topic,
      request,
      videos,
      failures
    }, {
      returnKnowledge: true,
      researchJobId: options.researchJobId || "",
      youtubeArticleParts: options.youtubeArticleParts || null,
      sourceUrl: options.sourceUrl || request.videoUrl || request.channelUrl || request.playlistUrl || request.query || ""
    });
    const markdown = typeof generated === "string" ? generated : generated.markdown;
    diagnostics.aiMs = elapsedMsSince(aiStartedAt);
    diagnostics.totalMs = elapsedMsSince(startedAt);
    const markdownTitle = cleanYoutubeDocumentTitle(this.extractMarkdownTitle(markdown));
    const firstVideoTitle = cleanYoutubeDocumentTitle(videos[0]?.title);
    const title = isWeakYoutubeTitle(markdownTitle, topic) || looksMostlyEnglish(markdownTitle)
      ? youtubeTitleFallback({ topic, title: firstVideoTitle, videos })
      : markdownTitle;
    return {
      topic,
      title,
      request,
      videos,
      failures,
      markdown,
      diagnostics,
      evidenceBrief: generated?.evidenceBrief || null,
      structuredArticle: generated?.structuredArticle || null
    };
  }

  async resolveYoutubeCandidateVideos(request = {}) {
    const limit = Math.max(1, Number(request.maxVideos || 1));
    let results = [];
    if (request.channelUrl) {
      const channel = request.channelUrl;
      const channelResult = request.query
        ? await this.transcriptApi.channelSearch(channel, request.query)
        : await this.transcriptApi.channelLatest(channel);
      results = channelResult.results || [];
    } else if (request.playlistUrl) {
      const playlist = request.playlistUrl;
      const playlistResult = await this.transcriptApi.playlistVideos(playlist);
      results = playlistResult.results || [];
    } else {
      const search = await this.transcriptApi.search(request.query, { type: "video" });
      results = search.results || [];
    }
    return results
      .filter((item) => item.videoId || item.url)
      .sort((a, b) => Number(b.hasCaptions) - Number(a.hasCaptions))
      .slice(0, limit);
  }

  resolveYoutubeReportTopic(request = {}, videos = []) {
    const queryTopic = String(request.query || "").trim();
    const hint = String(request.topicHint || "").trim();
    const content = videos.map((video) => [
      video.title,
      video.channel,
      truncate(video.transcriptText, 12000)
    ].filter(Boolean).join("\n")).join("\n\n");

    if (!request.videoUrl && !request.channelUrl && !request.playlistUrl && queryTopic && queryTopic.length <= 80) return queryTopic;
    if (request.channelUrl) return queryTopic || videos[0]?.channel || "YouTube Channel";
    if (request.playlistUrl) return queryTopic || "YouTube Playlist";
    if (hint && contentMentionsTopic(content, hint)) return hint;
    const inferredFromContent = inferYoutubeTopic(content, "");
    if (inferredFromContent && contentMentionsTopic(content, inferredFromContent)) return inferredFromContent;
    return "YouTube";
  }

  normalizeYoutubeTranscriptForReport(transcript = {}, videoUrl = "", searchItem = {}) {
    const metadata = transcript.metadata || {};
    return {
      videoId: transcript.videoId || this.transcriptApi?.videoId(videoUrl) || searchItem.videoId || "",
      title: metadata.title || searchItem.title || transcript.videoId || "YouTube video",
      channel: metadata.author_name || searchItem.channelTitle || searchItem.channelHandle || "",
      url: videoUrl || (transcript.videoId ? `https://www.youtube.com/watch?v=${transcript.videoId}` : searchItem.url || ""),
      language: transcript.language || "",
      lengthText: searchItem.lengthText || "",
      viewCountText: searchItem.viewCountText || "",
      publishedTimeText: searchItem.publishedTimeText || "",
      transcriptText: compactTranscriptSegments(transcript.segments || [], this.config.youtubeResearchMaxTranscriptChars || 60000),
      segmentCount: Array.isArray(transcript.segments) ? transcript.segments.length : 0
    };
  }

  async parseYoutubeJsonObject(raw = "", label = "json") {
    try {
      return extractJsonObject(raw);
    } catch (error) {
      logEvent("warn", "YouTube structured JSON parse failed; requesting repair", {
        label,
        error: error.message,
        chars: String(raw || "").length
      });
    }

    const repaired = await this.ai.chat([
      {
        role: "system",
        content: [
          "You repair malformed JSON from a previous model response.",
          "Return only one valid JSON object.",
          "Do not add Markdown fences, commentary, explanations, or new content.",
          "Preserve the original field names and values as much as possible.",
          "If the JSON is truncated, close arrays and objects cleanly without inventing new article claims."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `Repair this ${label} into valid JSON only:`,
          String(raw || "")
        ].join("\n")
      }
    ], {
      maxTokens: Math.max(this.config.youtubeResearchSummaryMaxTokens || 2600, 5200),
      temperature: 0,
      forcePrimaryWithFallback: Boolean(this.config.youtubeResearchForcePrimaryWithFallback),
      requirePrimary: Boolean(this.config.youtubeResearchRequirePrimary),
      allowFallback: false,
      retryAttempts: this.config.youtubeResearchAiRetryAttempts || 3,
      timeoutMs: this.config.youtubeResearchAiTimeoutMs || this.config.aiTimeoutMs || 120000
    });
    return extractJsonObject(repaired);
  }

  async generateYoutubeResearchMarkdown({ topic, request, videos, failures = [] }, options = {}) {
    const sourceAnchors = buildYoutubeGenerationAnchors(videos, topic);
    const deterministicEvidenceBrief = buildDeterministicYoutubeEvidenceBrief({ topic, videos });
    const deterministicEvidenceSource = buildYoutubeEvidenceBriefSource(deterministicEvidenceBrief);
    const youtubeStructuredAiOptions = ({ maxTokens, temperature = 0.2 } = {}) => ({
      maxTokens,
      temperature,
      responseFormat: { type: "json_object" },
      forcePrimaryWithFallback: Boolean(this.config.youtubeResearchForcePrimaryWithFallback),
      requirePrimary: Boolean(this.config.youtubeResearchRequirePrimary),
      allowFallback: false,
      retryAttempts: this.config.youtubeResearchAiRetryAttempts || 3,
      timeoutMs: this.config.youtubeResearchAiTimeoutMs || this.config.aiTimeoutMs || 120000
    });
    const youtubeEvidenceAiOptions = ({ maxTokens, temperature = 0.15 } = {}) => ({
      ...youtubeStructuredAiOptions({ maxTokens, temperature }),
      retryAttempts: Math.min(this.config.youtubeResearchAiRetryAttempts || 3, 2),
      timeoutMs: Math.min(
        this.config.youtubeResearchAiTimeoutMs || this.config.aiTimeoutMs || 120000,
        180000
      )
    });
    const sourceText = buildYoutubeBoundedEvidenceSource(videos, 6000);
    const cacheSourceUrl = options.sourceUrl || request.videoUrl || request.channelUrl || request.playlistUrl || request.query || videos[0]?.url || "";
    const cacheSourceKey = youtubeArticlePartsSourceKey(cacheSourceUrl);
    let articlePartCache = isFreshYoutubeArticlePartsCache(options.youtubeArticleParts, cacheSourceKey)
      ? {
          ...options.youtubeArticleParts,
          parts: { ...(options.youtubeArticleParts.parts || {}) }
        }
      : buildYoutubeArticlePartsCache({ sourceKey: cacheSourceKey });
    const cachedArticlePart = (name) => {
      const part = articlePartCache.parts?.[name];
      return part?.status === "done" && part.data ? part.data : null;
    };
    const persistArticlePart = async (name, part) => {
      articlePartCache = markYoutubeArticlePart(articlePartCache, name, part);
      if (options.researchJobId) {
        await this.mergeResearchJobOutput(options.researchJobId, {
          youtubeArticleParts: articlePartCache
        });
      }
    };
    const runCachedArticlePart = async (name, label, rawFactory) => {
      const cached = cachedArticlePart(name);
      if (cached) {
        logEvent("info", "YouTube article part cache hit", {
          part: name,
          label
        });
        return cached;
      }
      const startedAt = Date.now();
      try {
        const raw = await rawFactory();
        const data = await this.parseYoutubeJsonObject(raw, label);
        await persistArticlePart(name, { status: "done", data });
        logEvent("info", "YouTube article part generated", {
          part: name,
          label,
          elapsedMs: Date.now() - startedAt
        });
        return data;
      } catch (error) {
        await persistArticlePart(name, {
          status: "failed",
          error: truncate(error.message, 500)
        });
        logEvent("warn", "YouTube article part generation failed", {
          part: name,
          label,
          elapsedMs: Date.now() - startedAt,
          error: truncate(error.message, 500)
        });
        throw error;
      }
    };

    const cachedEvidenceBrief = cachedArticlePart("evidenceBrief");
    const compactSourceAnchors = truncate(sourceAnchors || "", 2500);
    const compactSourceText = truncate(sourceText || "", 6000);
    const evidenceBriefInput = [
      `Topic: ${topic}`,
      `User request: ${request.raw || request.query || request.videoUrl}`,
      failures.length ? `Failed videos: ${failures.join(" | ")}` : "",
      compactSourceAnchors ? `Timestamp and keyword anchors:\n${compactSourceAnchors}` : "",
      "",
      "Selected source transcripts:",
      compactSourceText
    ].filter(Boolean).join("\n");
    const evidenceBriefSystem = [
      generationFirstPrinciplesText(),
      "You prepare evidence for a Chinese column writer before the article is written.",
      "Return only valid JSON. Do not write Markdown, article prose, process notes, or explanations.",
      "Use Simplified Chinese for analysis fields, but keep source quotes in their original language.",
      "Every field must be grounded in transcript evidence, named objects, named people, terms, numbers, scenes, or timestamped events.",
      "Deterministic evidence package extracted by code will be merged after your answer; do not try to restate every available timestamp.",
      "Do not mention output language, Feishu, Obsidian, Markdown, transcript language, source links, or generation process."
    ].join(" ");
    const evidenceBrief = cachedEvidenceBrief || await (async () => {
      try {
        const thesisPartPromise = runCachedArticlePart("evidenceBriefThesis", "evidence brief thesis", () => this.ai.chat([
          {
            role: "system",
            content: [
              evidenceBriefSystem,
              "Focus only on article thesis, title angles, narrative conflict, and concrete background anchors.",
              "The thesis must state the main conflict as `why/how <specific object> changes <specific task/market/technology>`, not `this video is about...`."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              evidenceBriefInput,
              "",
              "Return JSON with exactly this shape:",
              "{",
              '  "thesis": "one specific article thesis in Chinese, not a title and not a summary label",',
              '  "titleAngles": ["3-5 polished Chinese title angles based on the thesis"],',
              '  "narrativeConflict": "the central tension a reader should understand before details",',
              '  "backgroundAnchors": ["5-10 specific people/products/events/technologies/scenes/numbers that must appear in opening context"]',
              "}",
              "Do not use the raw video title as the thesis or a title angle."
            ].join("\n")
          }
        ], youtubeEvidenceAiOptions({
          maxTokens: 900,
          temperature: 0.1
        })));
        const termsEvidencePartPromise = runCachedArticlePart("evidenceBriefTermsEvidence", "evidence brief terms and evidence", () => this.ai.chat([
          {
            role: "system",
            content: [
              evidenceBriefSystem,
              "Focus only on beginner glossary terms and evidence-backed claims.",
              "Each glossary term must unlock the later article. Each evidence claim must pair a concrete claim with one timestamp or quote and why it matters."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              evidenceBriefInput,
              "",
              "Return JSON with exactly this shape:",
              "{",
              '  "glossarySeeds": [{"term":"term", "evidence":"source phrase or timestamp evidence", "plainMeaning":"beginner-friendly meaning"}],',
              '  "evidenceClaims": [{"claim":"concrete claim", "timestamp":"0:00", "quote":"short original quote or faithful evidence", "whyItMatters":"why this evidence matters"}]',
              "}",
              "Minimums: glossarySeeds 3, evidenceClaims 6."
            ].join("\n")
          }
        ], youtubeEvidenceAiOptions({
          maxTokens: 1100,
          temperature: 0.12
        })));
        const partResults = await Promise.allSettled([
          thesisPartPromise,
          termsEvidencePartPromise
        ]);
        const failedParts = partResults
          .map((result, index) => ({ result, name: ["evidenceBriefThesis", "evidenceBriefTermsEvidence"][index] }))
          .filter((item) => item.result.status === "rejected");
        if (failedParts.length) {
          const reason = failedParts
            .map((item) => `${item.name}: ${truncate(item.result.reason?.message || String(item.result.reason || ""), 180)}`)
            .join(" | ");
          throw new Error(`YouTube evidence brief generation failed after primary-model retries: ${reason}`);
        }
        const evidenceModelParts = {
          ...Object.assign({}, ...partResults.map((item) => item.value)),
          timelineSeeds: deterministicEvidenceBrief.timelineSeeds,
          questionSeeds: deterministicEvidenceBrief.questionSeeds
        };
        const parsedEvidenceBrief = mergeYoutubeEvidenceBriefs(
          deterministicEvidenceBrief,
          evidenceModelParts,
          { topic, videos }
        );
        await persistArticlePart("evidenceBrief", { status: "done", data: parsedEvidenceBrief });
        return parsedEvidenceBrief;
      } catch (error) {
        await persistArticlePart("evidenceBrief", {
          status: "failed",
          error: truncate(error.message, 500)
        });
        throw error;
      }
    })();
    assertYoutubeEvidenceBrief(evidenceBrief, { topic, videos });
    const evidenceBriefSource = buildYoutubeEvidenceBriefSource(evidenceBrief);

    const titleContextPartPromise = runCachedArticlePart("titleContext", "article title context", () => this.ai.chat([
      {
        role: "system",
        content: [
          generationFirstPrinciplesText(),
          "You fill one small part of a fixed YouTube article blueprint.",
          "Always write in Simplified Chinese.",
          "Return only valid JSON. Do not return Markdown. Do not add explanations before or after JSON.",
          "Write like a top-tier Chinese column writer filling article slots, not a chat answer.",
          "Use the provided evidence brief as the spine of the article. Do not introduce article claims that are absent from the evidence brief.",
          "Do not write headings such as YouTube 技术笔记, 技术笔记, 背景导读, or 精华总结 inside content fields.",
          "Do not pad the article with process metadata. Do not mention output language, content form, Obsidian, Feishu, Markdown, or source links in content fields.",
          "Never write a process preface such as `我先按...整理`, `接下来我会...`, or `可直接进 Obsidian/飞书`.",
          "Write background interpretation that lowers the reading barrier after the glossary: explain why the video was recorded, the industry or historical environment at the time of recording, the current industry environment when relevant, and why this specific video matters now.",
          "Do not write generic background filler like `不是某个孤立知识点`, `产业判断、工程取舍和商业后果`, or `重点不是记住每个参数`. Background must name concrete people, artifacts, events, terms, and tensions from the transcript.",
          "Every title and point must be reader-facing and specific. Never use the raw video title as a section title unless it is already a polished Chinese title.",
          "Write the title as a Chinese column judgment: `为什么/如何 <specific object> <changes/forces/reveals> <specific consequence>`.",
          "Write paragraph 1 as `video scene and viewing context`: name the speaker/channel/video scene, concrete object, main conflict, and why a smart non-specialist should care.",
          "Write paragraph 2 as `industry and technical environment`: explain the market/industry/historical backdrop at recording time and the present-day relevance when the transcript supports it.",
          "If a third paragraph is needed, write it as `reader map`: introduce the task chain or problem map in plain language before details.",
          "Do not define glossary terms here unless needed for the sentence. The glossary will be rendered before this background section."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `Topic: ${topic}`,
          `User request: ${request.raw || request.query || request.videoUrl}`,
          `Videos: ${videos.length}`,
          failures.length ? `Failed videos: ${failures.join(" | ")}` : "",
          "Evidence brief that must drive the article:",
          evidenceBriefSource,
          "",
          "Fill only this fixed title/background schema:",
          "{",
          '  "title": "specific polished Chinese article title",',
          '  "contextParagraphs": ["2-4 concrete background paragraphs; first two mention at least 3 source anchors and explain video scene, recording context, industry environment, and present relevance when evidence supports it"]',
          "}",
          "Quality bar: the title must be a Chinese judgment-style column title, not an English raw video title and never `<topic> YouTube 技术笔记`. Background must be concrete and beginner-friendly, not a reusable template."
        ].join("\n")
      }
    ], youtubeStructuredAiOptions({
      maxTokens: Math.max(this.config.youtubeResearchSummaryMaxTokens || 2600, 1800),
      temperature: 0.2
    })));
    const glossaryPartPromise = runCachedArticlePart("glossary", "article glossary", () => this.ai.chat([
      {
        role: "system",
        content: [
          generationFirstPrinciplesText(),
          "You fill the glossary slot of a fixed YouTube article blueprint.",
          "Always write in Simplified Chinese.",
          "Return only valid JSON. Do not return Markdown. Do not add explanations before or after JSON.",
          "Use only the provided evidence brief. Terms must be concrete specialist words, products, people, systems, or concepts from the transcript.",
          "Explain each term so a beginner can understand the later article.",
          "Each explanation should answer: what it is, why it appears in this video, and what misunderstanding it prevents.",
          "Prefer terms that unlock the article thesis; skip decorative jargon."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `Topic: ${topic}`,
          "Evidence brief that must drive this glossary:",
          evidenceBriefSource,
          "",
          "Fill only this fixed glossary schema:",
          "{",
          '  "glossary": [{"term":"specific term", "explanation":"beginner-friendly explanation"}]',
          "}",
          "Cardinality: glossary 3-8."
        ].join("\n")
      }
    ], youtubeStructuredAiOptions({
      maxTokens: Math.max(this.config.youtubeResearchSummaryMaxTokens || 2600, 1600),
      temperature: 0.15
    })));
    const corePartPromise = runCachedArticlePart("core", "article core arguments", () => this.ai.chat([
      {
        role: "system",
        content: [
          generationFirstPrinciplesText(),
          "You fill the core-argument slots of a fixed YouTube article blueprint.",
          "Always write in Simplified Chinese.",
          "Return only valid JSON. Do not return Markdown. Do not add explanations before or after JSON.",
          "Use only the provided evidence brief. Every core point must include evidence.",
          "Gold quotes must show the original quote first. If the original transcript is English, keep the original quote in English.",
          "Do not repeat glossary explanations or generic background.",
          "oneSentence should be a decisive thesis conclusion, not a neutral summary.",
          "Each corePoints title should be a judgment sentence with a concrete object or number from evidence.",
          "Each `why` should explain the business/engineering/strategic meaning; each `takeaway` should tell the reader what to remember.",
          "quotes should be selected because they compress the article's conflict or evidence, not because they sound decorative.",
          "counterintuitive should state what a smart reader may initially get wrong and what the transcript changes."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `Topic: ${topic}`,
          "Evidence brief that must drive this core section:",
          evidenceBriefSource,
          "",
          "Fill only this fixed core schema:",
          "{",
          '  "oneSentence": "one decisive conclusion",',
          '  "corePoints": [{"title":"specific point title with transcript object/person/term", "evidence":"short source-grounded quote or evidence", "why":"why it matters", "takeaway":"what reader should remember"}],',
          '  "quotes": [{"title":"quote label", "original":"original quote, keep English if source is English", "meaning":"Chinese explanation", "implication":"transferable insight"}],',
          '  "counterintuitive": ["3 specific non-obvious judgments"]',
          "}",
          "Cardinality: corePoints 4-8, quotes 2-4, counterintuitive 3."
        ].join("\n")
      }
    ], youtubeStructuredAiOptions({
      maxTokens: Math.max(this.config.youtubeResearchSummaryMaxTokens || 2600, 2400),
      temperature: 0.2
    })));
    const techPartPromise = runCachedArticlePart("tech", "article technical sections", () => this.ai.chat([
      {
        role: "system",
        content: [
          generationFirstPrinciplesText(),
          "You fill one small part of a fixed YouTube article blueprint.",
          "Always write in Simplified Chinese.",
          "Return only valid JSON. Do not return Markdown. Do not add explanations before or after JSON.",
          "Use only the provided evidence brief. Do not add claims absent from it.",
          "Avoid generic frameworks. Every item must name a concrete object, term, scene, number, or constraint from the evidence brief.",
          "techPoints should be scan-friendly: `says` paraphrases the evidence, `importance` explains why the mechanism matters, `risk` names a real uncertainty or boundary condition.",
          "detailSections should expand the engineering logic, commercial implication, and failure modes behind the core claims."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `Topic: ${topic}`,
          "Evidence brief that must drive this section:",
          evidenceBriefSource,
          "",
          "Fill only this fixed technical schema:",
          "{",
          '  "techPoints": [{"name":"specific technical point", "says":"how the video describes it", "importance":"why important", "risk":"risk or uncertainty"}],',
          '  "detailSections": [{"title":"specific detailed section title", "bullets":["source-grounded bullet"]}]',
          "}",
          "Cardinality: techPoints 3-8, detailSections 3-6.",
          "Each bullet must add engineering logic, commercial meaning, or boundary conditions instead of repeating the opening."
        ].join("\n")
      }
    ], youtubeStructuredAiOptions({
      maxTokens: Math.max(this.config.youtubeResearchSummaryMaxTokens || 2600, 3000),
      temperature: 0.2
    })));
    const timelinePartPromise = runCachedArticlePart("timeline", "article timeline", () => this.ai.chat([
      {
        role: "system",
        content: [
          generationFirstPrinciplesText(),
          "You fill one small part of a fixed YouTube article blueprint.",
          "Always write in Simplified Chinese.",
          "Return only valid JSON. Do not return Markdown. Do not add explanations before or after JSON.",
          "Use only the provided evidence brief. Timeline items must say what happened and why it matters.",
          "Timeline is not a transcript dump: each item should help readers locate the argument in the video.",
          "Questions should be concrete next research lines based on unresolved evidence, validation signals, costs, constraints, or experiments."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `Topic: ${topic}`,
          "Evidence brief that must drive this section:",
          evidenceBriefSource,
          "",
          "Fill only this fixed timeline/question schema:",
          "{",
          '  "timeline": [{"time":"0:02", "event":"what happened", "importance":"why it matters", "evidence":"optional original quote"}],',
          '  "questions": ["5-8 concrete follow-up questions"]',
          "}",
          "Cardinality: timeline 8-18, questions 5-8.",
          "Questions must be anchored to actual people, objects, terms, numbers, or tensions in this transcript."
        ].join("\n")
      }
    ], youtubeStructuredAiOptions({
      maxTokens: Math.max(this.config.youtubeResearchSummaryMaxTokens || 2600, 3000),
      temperature: 0.2
    })));
    const partResults = await Promise.allSettled([
      titleContextPartPromise,
      glossaryPartPromise,
      corePartPromise,
      techPartPromise,
      timelinePartPromise
    ]);
    const failedParts = partResults
      .map((result, index) => ({ result, name: ["titleContext", "glossary", "core", "tech", "timeline"][index] }))
      .filter((item) => item.result.status === "rejected");
    if (failedParts.length) {
      const reason = failedParts
        .map((item) => `${item.name}: ${truncate(item.result.reason?.message || String(item.result.reason || ""), 180)}`)
        .join(" | ");
      throw new Error(`YouTube article part generation failed after primary-model retries: ${reason}`);
    }
    const [
      titleContextPart,
      glossaryPart,
      corePart,
      techPart,
      timelinePart
    ] = partResults.map((item) => item.value);
    const structured = normalizeYoutubeStructuredArticle({
      title: titleContextPart.title,
      opening: {
        contextParagraphs: titleContextPart.contextParagraphs,
        glossary: glossaryPart.glossary,
        oneSentence: corePart.oneSentence,
        corePoints: corePart.corePoints,
        quotes: corePart.quotes,
        counterintuitive: corePart.counterintuitive
      },
      techPoints: techPart.techPoints,
      detailSections: techPart.detailSections,
      timeline: timelinePart.timeline,
      questions: timelinePart.questions
    }, evidenceBrief, { topic, videos });
    assertStructuredYoutubeArticle(structured, { topic, videos });
    const rendered = renderYoutubeStructuredArticle(structured, { topic, videos });
    const markdown = this.decorateYoutubeMarkdown(stripYoutubeProcessArtifactLines(rendered), { topic, request, videos });
    if (options.returnKnowledge) {
      return {
        markdown,
        evidenceBrief,
        structuredArticle: structured
      };
    }
    return markdown;
  }

  decorateYoutubeMarkdown(markdown = "", { topic, request, videos }) {
    const tag = tagifyTopic(topic);
    const title = this.extractMarkdownTitle(markdown) || `${topic} YouTube \u6280\u672f\u7b14\u8bb0`;
    const tags = [...new Set(["youtube", tag].filter(Boolean))].join(", ");
    const frontmatter = [
      "---",
      `title: "${safeMarkdownValue(title)}"`,
      `topic: "${safeMarkdownValue(topic)}"`,
      "source: youtube",
      `created: "${new Date().toISOString()}"`,
      `tags: [${tags}]`,
      `video_count: ${videos.length}`,
      "---"
    ].join("\n");
    const links = [
      "",
      `> \u4e3b\u9898\u805a\u5408\uff1a[[${topic}]]`,
      "> \u6765\u6e90\u7c7b\u578b\uff1a[[YouTube \u89c6\u9891\u7814\u7a76]]",
      ""
    ].join("\n");
    const body = String(markdown || "").trim();
    const withTitle = /^#\s+/m.test(body) ? body : `# ${title}\n\n${body}`;
    return `${frontmatter}\n${links}${withTitle}\n`;
  }

  extractMarkdownTitle(markdown = "") {
    const match = String(markdown || "").match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : "";
  }

  async syncYoutubeResearchToObsidian(report) {
    if (!this.config.obsidianSyncEnabled || !this.obsidianSync?.enabled) {
      return { synced: false, notePath: "", topicPath: "", reason: "disabled" };
    }
    await this.obsidianSync.ensureBranch();
    const folder = String(this.config.obsidianYoutubeFolder || "youtube").replace(/^\/+|\/+$/g, "") || "youtube";
    const topicFolder = String(this.config.obsidianTopicFolder || "topics").replace(/^\/+|\/+$/g, "") || "topics";
    const noteName = slugifyNoteName(`${report.topic}-${report.videos[0]?.title || report.title}`);
    const notePath = `${folder}/${noteName}.md`;
    const topicPath = `${topicFolder}/${slugifyNoteName(report.topic)}.md`;

    await this.obsidianSync.putFile(
      notePath,
      report.markdown,
      `Add YouTube research note: ${report.title}`
    );

    const firstVideo = report.videos[0] || {};
    const indexBlock = [
      `- [[${noteName}|${report.title}]]`,
      `  - source: ${firstVideo.url || ""}`,
      `  - created: ${new Date().toISOString()}`
    ].join("\n");
    await this.obsidianSync.appendUnique(
      topicPath,
      indexBlock,
      `Update ${report.topic} YouTube research index`
    );

    return { synced: true, notePath, topicPath };
  }

  async syncYoutubeResearchToFeishuDocument(report) {
    if (!this.workspace?.enabled) {
      return { created: false, url: "", token: "", reason: "disabled" };
    }
    try {
      const markdown = this.buildFeishuYoutubeDocumentMarkdown(report);
      const sourceUrl = report.videos?.[0]?.url || report.request?.videoUrl || report.request?.query || "";
      const parentWikiToken = String(
        this.config.feishuYoutubeParentWikiToken ||
        this.config.feishuYoutubeIndexWikiToken ||
        ""
      ).trim();
      const doc = parentWikiToken
        ? await this.workspace.createWikiDocument({
            parentWikiToken,
            title: this.resolveYoutubeDocumentTitle(report),
            markdown,
            sourceUrl,
            articleGroupSourceType: "YouTube 精读"
          })
        : await this.workspace.createDocument({
            title: this.resolveYoutubeDocumentTitle(report),
            markdown,
            sourceUrl,
            articleGroupSourceType: "YouTube 精读"
          });
      const groupNotification = doc.articleGroupNotification || null;
      return {
        created: true,
        url: doc.url || "",
        token: doc.token || "",
        wikiToken: doc.wikiToken || "",
        inWiki: Boolean(doc.inWiki),
        title: doc.title || report.title,
        markdown,
        writeError: doc.writeError || "",
        writeMode: doc.writeMode || "",
        blocks: doc.blocks || 0,
        folderFallback: Boolean(doc.folderFallback),
        articleGroupNotification: groupNotification || null
      };
    } catch (error) {
      logEvent("warn", "Feishu YouTube document sync failed", {
        title: report.title,
        error: error.message
      });
      return { created: false, url: "", token: "", reason: error.message };
    }
  }

  resolveYoutubeDocumentTitle(report = {}) {
    const topic = report.topic || "";
    const markdownTitle = cleanYoutubeDocumentTitle(this.extractMarkdownTitle(report.markdown || ""));
    const reportTitle = cleanYoutubeDocumentTitle(report.title || "");
    if (!isWeakYoutubeTitle(markdownTitle, topic) && !looksMostlyEnglish(markdownTitle)) return markdownTitle;
    if (!isWeakYoutubeTitle(reportTitle, topic) && !looksMostlyEnglish(reportTitle)) return reportTitle;
    return youtubeTitleFallback(report);
  }

  buildFeishuYoutubeDocumentMarkdown(report) {
    const videos = report.videos || [];
    const transcriptBlocks = videos
      .slice(0, 8)
      .map((video, index) => buildTranscriptExcerptBlock(video, index))
      .filter(Boolean)
      .join("\n\n");
    if (report.structuredArticle && report.evidenceBrief) {
      const structured = normalizeYoutubeStructuredArticle(report.structuredArticle, report.evidenceBrief, {
        topic: report.topic,
        title: report.title,
        videos
      });
      assertStructuredYoutubeArticle(structured, { topic: report.topic, title: report.title, videos });
      const body = renderYoutubeStructuredArticle(structured, { topic: report.topic, title: report.title, videos });
      const markdown = repairYoutubeDocumentBeforeAudit(indentReaderLabelBullets(emphasizeReaderLabels(finalizeGuidedYoutubeDocumentMarkdown(body, {
        transcriptBlocks,
        videos
      }))), report);
      assertReadableYoutubeDocument(markdown);
      return markdown;
    }
    let body = convertMarkdownTablesToMobileLists(removeObsidianSyntax(stripMarkdownFrontmatter(stripYoutubeProcessPreamble(report.markdown))))
      .trim();
    body = stripYoutubeProcessArtifactLines(body);
    body = stripLowValueYoutubeMetadataLines(body);
    body = body.replace(/^#\s+.+\n+/, "").trim();
    if (isGuidedYoutubeBlueprintMarkdown(body)) {
      const markdown = repairYoutubeDocumentBeforeAudit(indentReaderLabelBullets(emphasizeReaderLabels(finalizeGuidedYoutubeDocumentMarkdown(body, {
        transcriptBlocks,
        videos
      }))), report);
      assertReadableYoutubeDocument(markdown);
      return markdown;
    }
    const sections = collectYoutubeDocSections(body);
    const relocated = {
      summary: splitMisplacedBackgroundBlocks(sections.summary),
      tech: splitMisplacedBackgroundBlocks(sections.tech),
      detail: splitMisplacedBackgroundBlocks(sections.detail),
      other: splitMisplacedBackgroundBlocks(sections.other)
    };
    const background = normalizeBackgroundSection(compactLines([
      sections.background,
      relocated.summary.background,
      relocated.tech.background,
      relocated.detail.background,
      relocated.other.background
    ].filter(Boolean)), report);
    const backgroundParts = splitYoutubeBackgroundAndGlossary(background || buildYoutubeBackgroundFallback(report));
    const summary = dropOpeningSubtitles(relocated.summary.body || sections.summary);
    const tech = relocated.tech.body || sections.tech;
    const detail = compactLines([relocated.detail.body, relocated.other.body].filter(Boolean));
    const glossaryFallbackKeywords = extractYoutubeQuestionKeywords([
      report.topic,
      report.title,
      ...(videos || []).map((video) => `${video.title || ""} ${truncate(video.transcriptText || "", 1000)}`)
    ].join(" "), 5);
    const glossaryForReaders = backgroundParts.glossary || glossaryFallbackKeywords.slice(0, 3).map((term) =>
      `- **${term}：** 这是理解本视频判断链条的核心对象或术语，读者可以先把它当作后文反复出现的线索。`
    ).join("\n");
    const backgroundProse = String(backgroundParts.background || buildYoutubeBackgroundFallback(report))
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean)
      .join("\n\n");
    const backgroundForReaders = compactLines([
      backgroundProse,
      backgroundProse.length < 220
        ? "读者可以先把这一节当作进入正文前的上下文地图：它负责交代视频讨论的对象、拍摄或讨论语境、当时的行业问题，以及为什么这些信息会影响后面的核心判断。对于非专业读者来说，先理解这一层语境，再看后面的结论、技术点和时间线证据，会比直接进入摘要更容易判断哪些内容是真正重要的。"
        : ""
    ]);
    const techFallback = compactLines([
      "### 1. 证据链与关键对象",
      hasMeaningfulYoutubeSection(summary) ? `  - **视频里怎么说：** ${summary.replace(/\n+/g, " ").slice(0, 500)}` : "  - **视频里怎么说：** 视频围绕几个关键对象展开论证，具体证据可在后文时间线和原文摘录中核对。",
      "  - **为什么重要：** 这一项决定读者能否把视频信息从零散观点理解成一条判断链。",
      "  - **风险或不确定性：** 如果只看概括、不回到时间戳原文，容易误读视频真正的论证重点。"
    ]);
    const detailFallback = compactLines([
      "### 1. 证据链如何支撑主判断",
      hasMeaningfulYoutubeSection(summary) ? `- ${summary.replace(/\n+/g, " ").slice(0, 700)}` : "",
      hasMeaningfulYoutubeSection(tech) ? `- ${tech.replace(/\n+/g, " ").slice(0, 700)}` : "",
      "- 这一节用于把前面的结论、技术点和时间线证据串起来，避免读者只看到分散摘录，看不到判断链条。"
    ]);
    const coreFallback = compactLines([
      "### 一句话结论",
      hasMeaningfulYoutubeSection(summary) ? summary.replace(/\n+/g, " ").slice(0, 500) : "这条视频的价值在于把分散信息串成一条可核对的判断链。",
      "### 核心观点",
      hasMeaningfulYoutubeSection(summary) ? summary : "- 读者应先看原文证据，再理解文章给出的判断。",
      "### 标志性金句",
      "#### 1. 原文证据锚点",
      "> 见后文时间线和原文摘录。",
      "  - **含义：** 文章中的判断需要能回到字幕时间戳核对。",
      "  - **可迁移启发：** 好的技术笔记不是堆摘要，而是保留证据链。",
      "### 最反共识的判断",
      "- 视频的重点不只是信息本身，而是这些信息之间形成的任务链、约束和风险边界。"
    ]);
    const blocks = [
      compactLines(["## 一、关键术语解释", glossaryForReaders]),
      "## 二、背景导读",
      backgroundForReaders,
      compactLines(["## 三、导读与核心结论", coreFallback]),
      hasMeaningfulYoutubeSection(tech) ? compactLines(["## 四、关键技术点速览", tech]) : compactLines(["## 四、关键技术点速览", techFallback]),
      hasMeaningfulYoutubeSection(detail)
        ? compactLines(["## 五、详细技术拆解", detail])
        : compactLines(["## 五、详细技术拆解", detailFallback]),
      hasMeaningfulYoutubeSection(sections.timeline) || transcriptBlocks
        ? compactLines(["## 六、时间线摘要", sections.timeline, transcriptBlocks ? compactLines(["### 原文摘录", transcriptBlocks]) : ""])
        : "",
      hasMeaningfulYoutubeSection(sections.questions)
        ? compactLines(["## 七、值得继续追问的问题", sections.questions])
        : compactLines(["## 七、值得继续追问的问题", buildYoutubeQuestionsFallback(report)]),
      "## 八、出处与链接",
      buildYoutubeSourceSection(videos)
    ];
    const markdown = repairYoutubeDocumentBeforeAudit(indentReaderLabelBullets(emphasizeReaderLabels(compactLines(blocks))), report);
    assertReadableYoutubeDocument(markdown);
    return markdown;
  }

  async syncYoutubeResearchToFeishuIndex(report, sync = {}, doc = {}) {
    const documentId = String(this.config.feishuYoutubeIndexDocumentId || "").trim();
    const wikiToken = String(this.config.feishuYoutubeIndexWikiToken || "").trim();
    if (!this.workspace?.enabled) {
      return { synced: false, reason: "disabled" };
    }
    if (!doc.created || !doc.url) {
      return { synced: false, reason: "doc_not_created" };
    }
    if (!documentId && !wikiToken) {
      return { synced: false, reason: "not_configured" };
    }
    try {
      const targetDocumentId = documentId || await this.workspace.wikiNodeDocumentId(wikiToken);
      if (!targetDocumentId) {
        return { synced: false, reason: "wiki_node_is_not_docx" };
      }
      const firstVideo = report.videos?.[0] || {};
      const lines = [
        "",
        `## ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} - ${report.title}`,
        `- 主题：${report.topic || "YouTube"}`,
        `- 视频：${report.videos?.length || 0} 条`,
        firstVideo.url ? `- 原视频：${firstVideo.url}` : "",
        doc.url ? `- 飞书文档：${doc.url}` : `- 飞书文档：未生成（${doc.reason || doc.writeError || "原因未知"}）`,
        sync.synced ? `- Obsidian：${sync.notePath}` : `- Obsidian：未同步（${sync.reason || "原因未知"}）`
      ];
      const result = await this.workspace.appendMarkdownToDocument({
        documentId: targetDocumentId,
        markdown: compactLines(lines)
      });
      return {
        synced: true,
        documentId: targetDocumentId,
        blocks: result.blocks || 0
      };
    } catch (error) {
      logEvent("warn", "Feishu YouTube index sync failed", {
        title: report.title,
        error: error.message
      });
      return { synced: false, reason: error.message };
    }
  }

  formatYoutubeResearchReply(report, sync = {}, doc = {}, indexSync = {}) {
    const videos = report.videos || [];
    const videoLines = videos.slice(0, 3).map((video, index) => {
      const meta = [video.channel, video.lengthText, video.language].filter(Boolean).join(" / ");
      return `${index + 1}. ${video.title}${meta ? `（${meta}）` : ""}`;
    });
    const docLine = doc.created && doc.url
      ? `飞书文档：${doc.url}`
      : `飞书文档：生成失败，${truncate(doc.reason || doc.writeError || "原因未知", 120)}`;
    const obsidianLine = sync.synced
      ? `Obsidian：已同步到 ${sync.notePath}`
      : sync.reason === "pending"
        ? "Obsidian：后台同步中"
      : `Obsidian：未同步，${sync.reason === "disabled" ? "Render 还没配置 Obsidian GitHub token" : truncate(sync.reason || "原因未知", 120)}`;
    const indexLine = indexSync.synced
      ? "知识库目录：已归档"
      : indexSync.reason === "pending"
        ? "知识库目录：后台归档中"
      : "";
    const diagnosticsLine = formatYoutubeDiagnosticsLine(report, doc, doc.diagnostics?.deliveryMs || 0);
    return compactLines([
      `整理好了：${report.title}`,
      `主题：${report.topic}`,
      `视频：${videos.length} 条`,
      markdownList(videoLines),
      docLine,
      diagnosticsLine,
      obsidianLine,
      indexLine,
      doc.created ? "正文我已经放到飞书文档里了，请查收哦" : "正文已整理完成，但飞书文档创建失败；我先不在群里刷长文。"
    ]);
  }

  buildYoutubeResearchCard(report, sync = {}, doc = {}, indexSync = {}, wechatCandidate = null) {
    const videos = report.videos || [];
    const firstVideo = videos[0] || {};
    const docStatus = doc.created && doc.url
      ? `${doc.inWiki ? "已创建到知识库目录" : "已生成"}，${doc.writeMode === "rich" ? "高级排版" : "基础排版兜底"}`
      : `生成失败：${cardText(doc.reason || doc.writeError || "原因未知", 80)}`;
    const obsidianStatus = sync.synced
      ? `已同步到 ${sync.notePath}`
      : sync.reason === "pending"
        ? "后台同步中"
      : `未同步：${sync.reason === "disabled" ? "未配置 Obsidian GitHub token" : cardText(sync.reason || "原因未知", 80)}`;
    const indexStatus = indexSync.synced
      ? "已归档"
      : indexSync.reason === "pending"
        ? "后台归档中"
      : (indexSync.reason && indexSync.reason !== "not_configured" ? `归档失败：${cardText(indexSync.reason, 80)}` : "");
    const diagnosticsLine = formatYoutubeDiagnosticsLine(report, doc, doc.diagnostics?.deliveryMs || 0);
    const videoLines = videos.slice(0, 5).map((video, index) => {
      const meta = [video.channel, video.lengthText, video.language].filter(Boolean).join(" / ");
      return `${index + 1}. **${cardMarkdown(video.title, 110)}**${meta ? `\n   ${cardMarkdown(meta, 100)}` : ""}`;
    });
    const actions = [];
    if (doc.created && doc.url) {
      actions.push({
        tag: "button",
        text: {
          tag: "plain_text",
          content: "打开飞书文档"
        },
        type: "primary",
        url: doc.url
      });
    }
    if (firstVideo.url) {
      actions.push({
        tag: "button",
        text: {
          tag: "plain_text",
          content: "查看原视频"
        },
        type: "default",
        url: firstVideo.url
      });
    }
    actions.push(...this.wechatPublishActions(wechatCandidate));

    const elements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: cardMarkdown(compactLines([
            `**整理好了：${report.title}**`,
            "完整内容已沉淀到飞书文档，聊天里只保留摘要入口。"
          ]), 520)
        }
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: cardMarkdown(`主题\n**${report.topic || "YouTube"}**`, 120)
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: cardMarkdown(`视频\n**${videos.length} 条**`, 80)
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: cardMarkdown(`${doc.inWiki ? "知识库页面" : "飞书文档"}\n**${doc.writeMode === "rich" ? "高级排版" : (doc.created ? "已就绪" : "待处理")}**`, 100)
                }
              }
            ]
          }
        ]
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: cardMarkdown(compactLines([
            "**视频标题**",
            ...videoLines
          ]), 900)
        }
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: cardMarkdown(compactLines([
            `飞书文档：${docStatus}`,
            diagnosticsLine,
            `Obsidian：${obsidianStatus}`,
            indexStatus ? `知识库目录：${indexStatus}` : ""
          ]), 520)
        }
      }
    ];

    if (actions.length) elements.push({ tag: "action", actions });
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: doc.created
            ? "正文我已经放到飞书文档里了，请查收哦"
            : "正文已整理完成，但飞书文档创建失败；我先不在群里刷长文。"
        }
      ]
    });

    return {
      config: {
        wide_screen_mode: true,
        enable_forward: true
      },
      header: {
        template: doc.created ? "indigo" : "orange",
        title: {
          tag: "plain_text",
          content: doc.created ? "视频深度解读已整理" : "视频深度解读待归档"
        }
      },
      elements
    };
  }

  async handleWebSearchRequest({ messageId, chatId, userId, request }) {
    if (!this.webSearch?.enabled) {
      await this.replyText(messageId, "\u8054\u7f51\u641c\u7d22\u8fd8\u6ca1\u914d\u7f6e\u597d\u3002\u4f60\u5148\u5728 Render \u91cc\u52a0 BOCHA_API_KEY\uff0c\u6211\u5c31\u80fd\u5f00\u59cb\u641c\u3002");
      return;
    }
    if (!request.query) {
      await this.replyText(messageId, "\u8981\u641c\u4ec0\u4e48\uff1f\u4f60\u53ef\u4ee5\u8fd9\u6837\u53d1\uff1a\u641c\u4e00\u4e0b \u4eca\u5929\u9ec4\u91d1\u4ef7\u683c\u4e3a\u4ec0\u4e48\u6da8\u3002");
      return;
    }

    try {
      if (request.githubTrending || this.isGithubTrendingRequest(request.query)) {
        await this.handleGithubTrendingRequest({ messageId, chatId, userId, query: request.query });
        return;
      }
      logEvent("info", "Feishu web search started", { chatId, userId, query: request.query, freshness: request.freshness });
      const search = await this.webSearch.search(request.query, { freshness: request.freshness });
      const summary = await this.generateWebSearchSummary(request.query, search.results);
      const card = await this.buildWebSearchCard({ query: request.query, search, summary });
      await this.replyCard(messageId, card);
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "card",
        content: `联网资料卡：${request.query}\n${summary}`,
        metadata: {
          platform: "feishu",
          replyToUserId: userId,
          webSearch: true,
          resultCount: search.results.length
        }
      });
      logEvent("info", "Feishu web search card sent", { chatId, query: request.query, results: search.results.length });
    } catch (error) {
      logEvent("error", "Feishu web search failed", { chatId, query: request.query, error: error.message });
      await this.replyText(messageId, `\u6211\u521a\u521a\u641c\u4e86\u4e00\u4e0b\uff0c\u4f46\u6ca1\u628a\u7ed3\u679c\u6574\u7406\u51fa\u6765\uff1a${truncate(error.message, 500)}`);
    }
  }

  async handleGithubTrendingRequest({ messageId, chatId, userId, query = "" }) {
    let repos = [];
    try {
      repos = await this.fetchGithubTrendingRepos(3);
    } catch (error) {
      logEvent("warn", "GitHub trending direct fetch failed; falling back to web search", { error: error.message });
    }
    if (!repos.length && this.webSearch?.enabled) {
      const fallback = await this.webSearch.search("GitHub Trending repositories today top 3", { freshness: "oneDay", count: 6 });
      repos = fallback.results
        .filter((item) => /github\.com/i.test(item.url || item.displayUrl || item.siteName || ""))
        .slice(0, 3)
        .map((item) => ({
          title: item.title,
          url: item.url,
          summary: item.summary || item.snippet,
          language: "",
          starsToday: ""
        }));
    }
    if (!repos.length) {
      await this.replyText(messageId, "我刚刚看了 GitHub 热榜，但没有稳定解析到仓库列表。你稍后再试一次。");
      return;
    }

    const summary = repos.map((repo, index) => {
      const meta = [repo.language, repo.starsToday].filter(Boolean).join(" · ");
      return `${index + 1}. ${repo.title}${meta ? `（${meta}）` : ""}：${repo.summary || "今日 GitHub Trending 仓库。"}`;
    }).join("\n");
    const search = {
      query: "GitHub Trending repositories today",
      freshness: "oneDay",
      results: repos.map((repo, index) => ({
        title: repo.title,
        url: repo.url,
        displayUrl: repo.url,
        siteName: "GitHub",
        summary: repo.summary,
        snippet: [repo.language, repo.starsToday].filter(Boolean).join(" · "),
        publishedAt: "",
        index: index + 1
      }))
    };
    const card = await this.buildWebSearchCard({ query: query || "今天 GitHub 热门仓库 Top 3", search, summary });
    await this.replyCard(messageId, card);
    await this.storage.addMessage({
      chatId,
      userId,
      role: "assistant",
      modality: "card",
      content: `GitHub 热门仓库 Top 3\n${summary}`,
      metadata: {
        platform: "feishu",
        replyToUserId: userId,
        githubTrending: true,
        resultCount: repos.length
      }
    });
    logEvent("info", "Feishu GitHub trending card sent", { chatId, results: repos.length });
  }

  async fetchGithubTrendingRepos(limit = 3) {
    const response = await fetch("https://github.com/trending?since=daily", {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": "Mozilla/5.0 FeishuBot/1.0",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub Trending HTTP ${response.status}`);
    }
    const html = await response.text();
    return this.parseGithubTrendingRepos(html, limit);
  }

  parseGithubTrendingRepos(html = "", limit = 3) {
    const clean = (value = "") => String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    return String(html || "")
      .split('<article class="Box-row"')
      .slice(1, Number(limit || 3) + 1)
      .map((article) => {
        const repoMatch = article.match(/<h2[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>/);
        const descMatch = article.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        const langMatch = article.match(/itemprop="programmingLanguage">([^<]+)</);
        const starsTodayMatch = article.match(/<span[^>]*class="[^"]*float-sm-right[^"]*"[^>]*>([\s\S]*?)<\/span>/);
        const title = repoMatch ? clean(repoMatch[2]).replace(/\s*\/\s*/, "/") : "";
        const href = repoMatch?.[1] || "";
        return {
          title,
          url: href ? `https://github.com${href}` : "",
          summary: clean(descMatch?.[1] || ""),
          language: clean(langMatch?.[1] || ""),
          starsToday: clean(starsTodayMatch?.[1] || "")
        };
      })
      .filter((repo) => repo.title && repo.url);
  }

  async generateWebSearchSummary(query, results = []) {
    if (!results.length) {
      return "\u6ca1\u641c\u5230\u7279\u522b\u53ef\u9760\u7684\u7ed3\u679c\uff0c\u53ef\u4ee5\u6362\u4e2a\u66f4\u5177\u4f53\u7684\u5173\u952e\u8bcd\u518d\u8bd5\u3002";
    }

    const sourceText = results.slice(0, 6).map((item, index) => compactLines([
      `[${index + 1}] ${item.title}`,
      `site: ${item.siteName || item.displayUrl || item.url}`,
      item.publishedAt ? `date: ${item.publishedAt}` : "",
      `summary: ${item.summary || item.snippet}`,
      `url: ${item.url}`
    ])).join("\n\n");

    try {
      const raw = await this.ai.chat([
        {
          role: "system",
          content: "You summarize web search results for a Feishu bot. Reply in Simplified Chinese. Be concise, concrete, and source-grounded. Do not invent facts that are not in the search results."
        },
        {
          role: "user",
          content: `Query: ${query}\n\nSearch results:\n${sourceText}\n\nWrite 3-5 short bullets. Mention uncertainty if sources are thin.`
        }
      ], {
        maxTokens: this.config.webSearchSummaryMaxTokens || 700,
        temperature: 0.3
      });
      return cardText(this.cleanAssistantReply(raw), 1200);
    } catch (error) {
      logEvent("warn", "Feishu web search summary fallback used", { query, error: error.message });
      return this.fallbackWebSearchSummary(results);
    }
  }

  fallbackWebSearchSummary(results = []) {
    const lines = results.slice(0, 3).map((item, index) => {
      const text = item.summary || item.snippet || item.title;
      return `${index + 1}. ${cardText(text, 180)}`;
    });
    return lines.join("\n");
  }

  async buildWebSearchCard({ query, search, summary }) {
    try {
      const visual = renderPremiumSearchCardImage({
        query,
        results: search.results || [],
        summary
      });
      const imageKey = await this.uploadImage(visual);
      return buildPremiumSearchCard({
        imageKey,
        query,
        results: search.results || [],
        kind: visual.kind
      });
    } catch (error) {
      logEvent("warn", "Feishu premium search card fallback used", {
        query,
        error: error.message
      });
      return buildSearchCard({ query, search, summary });
    }
  }

  classifyWebSearchCard(query = "", results = []) {
    const kind = searchKindFromText([query, ...results.slice(0, 4).flatMap((item) => [item.title, item.summary, item.snippet, item.siteName])].join("\n"));
    if (kind !== "reference") return kind;
    const text = [
      query,
      ...results.slice(0, 4).flatMap((item) => [item.title, item.summary, item.snippet, item.siteName])
    ].join("\n");
    if (/(?:\u4ef7\u683c|\u884c\u60c5|\u62a5\u4ef7|\u91d1\u4ef7|\u9ec4\u91d1|\u767d\u94f6|\u6c47\u7387|\u80a1\u4ef7|\u80a1\u7968|\u6307\u6570|\u6cb9\u4ef7|\u5229\u7387|CPI|PPI|BTC|USDT|\u6bd4\u7279\u5e01|\u4eba\u6c11\u5e01|\u7f8e\u5143|\u6da8|\u8dcc)/i.test(text)) {
      return "price";
    }
    if (/(?:\u65b0\u95fb|\u8981\u95fb|\u65e5\u62a5|\u4eca\u5929|\u4eca\u65e5|\u6700\u65b0|\u8fd1\u671f|\u6700\u8fd1|\u52a8\u6001|\u8fdb\u5c55|\u53d1\u5e03|\u66f4\u65b0|\u70ed\u641c|\u7a81\u53d1|\u4e8b\u4ef6)/i.test(text)) {
      return "news";
    }
    return "reference";
  }

  buildNewsSearchCard({ query, results, summary }) {
    const bullets = summaryBullets(summary, 4);
    const lead = bullets.shift() || cardText(summary, 200);
    const elements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            `**${cardText(query, 120)}**`,
            lead
          ])
        }
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            "**\u4eca\u65e5\u4e3b\u7ebf**",
            ...bullets.map((item) => `- ${item}`)
          ])
        }
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**\u91cd\u70b9\u65b0\u95fb**"
        }
      }
    ];

    for (const item of results.slice(0, 4)) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            `**${String(item.index).padStart(2, "0")}  ${cardText(item.title, 120)}**`,
            sourceLabel(item),
            cardText(item.summary || item.snippet, 220)
          ])
        }
      });
    }

    const actions = cardActionButtons(results, 3);
    if (actions.length) elements.push({ tag: "action", actions });
    elements.push(cardNote(results));

    return {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "orange",
        title: {
          tag: "plain_text",
          content: "\u4eca\u65e5\u641c\u7d22\u65e5\u62a5"
        }
      },
      elements
    };
  }

  buildPriceSearchCard({ query, results, summary }) {
    const signals = this.extractPriceSignals({ query, results, summary });
    const bullets = summaryBullets(summary, 4);
    const elements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            `**${cardText(query, 120)}**`,
            cardText(bullets[0] || summary, 220)
          ])
        }
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: compactLines([
                    "**\u6700\u65b0\u4fe1\u53f7**",
                    signals.primaryNumber
                  ])
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: compactLines([
                    "**\u884c\u60c5\u65b9\u5411**",
                    signals.trend
                  ])
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: compactLines([
                    "**\u4e3b\u8981\u6765\u6e90**",
                    signals.source
                  ])
                }
              }
            ]
          }
        ]
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            "**\u9a71\u52a8\u56e0\u7d20**",
            ...bullets.slice(0, 4).map((item) => `- ${item}`)
          ])
        }
      },
      { tag: "hr" }
    ];

    const marketItems = results.slice(0, 4).map((item) => compactLines([
      `**${item.index}. ${cardText(item.title, 110)}**`,
      sourceLabel(item),
      cardText(item.summary || item.snippet, 190)
    ]));
    if (marketItems.length) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines(["**\u884c\u60c5\u53c2\u8003**", ...marketItems])
        }
      });
    }

    const actions = cardActionButtons(results, 3);
    if (actions.length) elements.push({ tag: "action", actions });
    elements.push(cardNote(results));

    return {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: signals.trendType === "down" ? "red" : signals.trendType === "mixed" ? "yellow" : "green",
        title: {
          tag: "plain_text",
          content: "\u4ef7\u683c\u6307\u6807\u5361"
        }
      },
      elements
    };
  }

  extractPriceSignals({ query = "", results = [], summary = "" }) {
    const text = [query, summary, ...results.flatMap((item) => [item.title, item.summary, item.snippet])].join("\n");
    const numbers = uniqueCardItems(
      (text.match(/[+-]?\d+(?:\.\d+)?\s*(?:\u5143\/\u514b|\u5143\/\u65a4|\u7f8e\u5143\/\u76ce\u53f8|\u7f8e\u5143|\u5143|\u6e2f\u5143|\u70b9|%|\uff05|\u4e07\u5143|\u4ebf\u5143|\u4e07|\u4ebf|\u514b|\u5428|\u6876|BTC|USDT)/gi) || [])
        .map((item) => cardText(item, 40))
    );
    const up = /(?:\u4e0a\u6da8|\u6da8|\u98d9\u5347|\u8d70\u9ad8|\u4e0a\u884c|\u521b\u65b0\u9ad8|\u5347\u7834|\u7ad9\u4e0a|\u6da8\u5e45)/.test(text);
    const down = /(?:\u4e0b\u8dcc|\u8dcc|\u56de\u843d|\u8d70\u4f4e|\u4e0b\u884c|\u964d|\u8dcc\u5e45)/.test(text);
    const trendType = up && down ? "mixed" : down ? "down" : up ? "up" : "flat";
    const trend =
      trendType === "mixed" ? "\u6ce2\u52a8\u52a0\u5927" :
      trendType === "down" ? "\u56de\u843d\u6216\u8d70\u4f4e" :
      trendType === "up" ? "\u4e0a\u884c\u6216\u504f\u5f3a" :
      "\u7b49\u5f85\u660e\u786e\u4fe1\u53f7";
    const source = cardText(results.find((item) => item.siteName)?.siteName || results[0]?.displayUrl || results[0]?.url || "\u6765\u6e90\u5f85\u6838\u5bf9", 60);
    return {
      primaryNumber: numbers[0] || "\u672a\u68c0\u51fa\u660e\u786e\u6570\u5b57",
      trend,
      trendType,
      source
    };
  }

  buildReferenceSearchCard({ query, results, summary }) {
    const bullets = summaryBullets(summary, 4);
    const elements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            `**${cardText(query, 120)}**`,
            ...bullets.map((item) => `- ${item}`)
          ])
        }
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**\u53ef\u53c2\u8003\u8d44\u6599**"
        }
      }
    ];

    for (const item of results.slice(0, 5)) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: compactLines([
            `**${item.index}. ${cardText(item.title, 120)}**`,
            sourceLabel(item),
            cardText(item.summary || item.snippet, 230)
          ])
        }
      });
    }

    const actions = cardActionButtons(results, 3);
    if (actions.length) elements.push({ tag: "action", actions });
    elements.push(cardNote(results));

    return {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: "\u8d44\u6599\u68c0\u7d22\u5361"
        }
      },
      elements
    };
  }

  extractSongRequest(text = "") {
    let raw = String(text || "").trim();
    if (!raw) return { requested: false, query: "", defaulted: false };
    const botNames = this.getBotMentionNames()
      .map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (botNames.length) {
      raw = raw.replace(new RegExp(`^(?:${botNames.join("|")})\\s*`, "i"), "").trim();
    }

    const command = raw.match(/^\/(?:song|music)(?:\s+(.+))?$/i);
    if (command) {
      const query = this.cleanSongQuery(command[1] || "");
      return { requested: true, query, defaulted: !query };
    }

    const patterns = [
      /^(?:\u6211\u60f3\u542c|\u60f3\u542c|\u6211\u8981\u542c|\u542c\u6b4c|\u542c\u9996\u6b4c|\u542c\u4e00\u9996|\u653e\u6b4c|\u653e\u9996\u6b4c|\u653e\u4e00\u9996|\u70b9\u6b4c|\u6765\u9996|\u6765\u4e00\u9996|\u968f\u4fbf\u6765\u9996|\u968f\u673a\u6765\u9996|\u5531\u6b4c|\u5531\u9996\u6b4c|\u5531\u4e00\u9996|\u5531\u4e24\u53e5|\u6b4c\u66f2|\u97f3\u4e50)\s*[:\uff1a,\uff0c]?\s*(.*)$/i,
      /^(?:\u7ed9\u6211|\u5e2e\u6211)?(?:\u64ad\u653e|\u653e|\u5531|\u542c)\s*(?:\u4e00\u9996|\u9996|\u4e24\u53e5)?\s*(.+)$/i
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (!match) continue;
      const query = this.cleanSongQuery(match[1] || "");
      return { requested: true, query, defaulted: !query };
    }

    return { requested: false, query: "", defaulted: false };
  }

  async extractVideoRequest(text = "", chatId = "") {
    const raw = String(text || "").trim();
    if (!raw || !this.videoLibrary?.enabled || !this.videoLibrary.shouldCheck(raw)) {
      return { requested: false, item: null };
    }

    try {
      const items = await this.videoLibrary.findMatches(raw);
      if (!items.length) return { requested: false, item: null };
      const selection = await this.selectRotatingVideoItem({ chatId, items });
      return selection?.item
        ? { requested: true, ...selection, candidateCount: items.length }
        : { requested: false, item: null };
    } catch (error) {
      logEvent("error", "Feishu video library lookup failed", {
        error: error.message
      });
      return { requested: false, item: null };
    }
  }

  videoRotationKey(chatId = "") {
    const hash = crypto
      .createHash("sha1")
      .update(String(chatId || "global"))
      .digest("hex")
      .slice(0, 24);
    return `video_rotation:${hash}`;
  }

  parseVideoRotationState(value = "") {
    try {
      const parsed = JSON.parse(String(value || "{}"));
      return {
        used: Array.isArray(parsed.used) ? parsed.used.map(String).filter(Boolean) : [],
        lastId: parsed.lastId ? String(parsed.lastId) : ""
      };
    } catch {
      return { used: [], lastId: "" };
    }
  }

  randomItem(items = []) {
    if (!items.length) return null;
    return items[crypto.randomInt(0, items.length)];
  }

  async selectRotatingVideoItem({ chatId, items }) {
    const candidates = items.filter((item) => item?.id);
    if (!candidates.length) return null;

    const ids = candidates.map((item) => String(item.id));
    const key = this.videoRotationKey(chatId);
    const state = this.parseVideoRotationState(await this.storage.getSetting(key, "{}"));
    let used = state.used.filter((id) => ids.includes(id));
    let available = candidates.filter((item) => !used.includes(String(item.id)));
    let startedNewRound = false;

    if (!available.length) {
      used = [];
      startedNewRound = true;
      available = candidates.filter((item) => String(item.id) !== state.lastId);
      if (!available.length) available = candidates;
    }

    return {
      item: this.randomItem(available),
      rotationKey: key,
      rotationUsedBefore: used,
      rotationCandidateIds: ids,
      rotationStartedNewRound: startedNewRound
    };
  }

  async markVideoItemSent({ rotationKey, rotationUsedBefore = [], rotationCandidateIds = [], item }) {
    if (!rotationKey || !item?.id) return;
    const ids = rotationCandidateIds.map(String);
    const used = rotationUsedBefore.filter((id) => ids.includes(id));
    const id = String(item.id);
    if (!used.includes(id)) used.push(id);
    await this.storage.setSetting(rotationKey, JSON.stringify({
      used,
      lastId: id
    }));
  }

  cleanSongQuery(text = "") {
    const query = String(text || "")
      .replace(/^[:\uff1a,\uff0c\s]+/, "")
      .replace(/^(?:\u4e00\u9996|\u9996|\u6b4c|\u6b4c\u66f2|\u97f3\u4e50|\u4e00\u4e0b|\u4e00\u4e2a)\s*/, "")
      .replace(/\u7684\u6b4c$/i, "")
      .replace(/(?:\u542c\u542c|\u542c\u4e00\u4e0b|\u542c\u5427|\u542c\u4e00\u542c|\u7ed9\u6211\u542c\u542c)$/i, "")
      .replace(/(?:\u8fd9\u9996\u6b4c|\u8fd9\u9996|\u5427|\u5440|\u554a|\u5462)[\s.!?\u3002\uff01\uff1f]*$/i, "")
      .trim();
    return /^(?:\u542c\u542c|\u542c\u4e00\u4e0b|\u542c\u4e00\u542c|\u968f\u4fbf|\u968f\u673a|\u90fd\u884c|\u6765\u4e00\u9996|\u5531\u4e00\u9996|\u5531\u9996\u6b4c)?$/i.test(query)
      ? ""
      : query;
  }

  getBotMentionNames() {
    return [...new Set([this.config.feishuBotName, this.config.displayName, ...(this.config.feishuBotAliases || []), "小椰", "飞书营销大师"]
      .filter(Boolean)
      .map((name) => String(name).trim())
      .filter(isUsableBotName))];
  }

  senderIdentityCandidates(event = {}) {
    const senderId = event.sender?.sender_id || {};
    const rawValues = [
      senderId.open_id,
      senderId.user_id,
      senderId.union_id,
      event.user_id,
      event.open_id,
      event.union_id
    ].filter(Boolean);
    const values = [];
    for (const value of rawValues) {
      const text = String(value || "").trim();
      if (!text) continue;
      values.push(text, platformId(text), `用户${text}`);
      const digits = text.match(/\d+/g)?.join("");
      if (digits) values.push(digits, `用户${digits}`);
    }
    return uniqueReplyIdentities(values);
  }

  async isAlwaysReplyUser(candidates = []) {
    const configuredDefault = [
      ...(this.config.feishuAlwaysReplyUserIds || []),
      ...(this.config.ownerUserIds || [])
    ].join(",");
    const storedValue = await this.storage.getSetting("feishu.always_reply_user_ids", configuredDefault);
    const whitelist = uniqueReplyIdentities(String(storedValue || "")
      .split(/[,\n，]+/)
      .map((item) => item.trim()));
    if (!whitelist.length) return false;
    const candidateSet = new Set(candidates);
    return whitelist.some((item) => candidateSet.has(item));
  }

  getMentionInfo(message, text = "") {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    const botNames = this.getBotMentionNames();
    const isBotName = (name) => botNames.some((botName) => name === botName);
    const mentionNames = mentions
      .map((item) => String(item.name || item.text || "").replace(/^@/, "").trim())
      .filter(Boolean);
    const mentionTargets = mentions
      .map((item) => this.mentionTargetFromIncomingMention(item))
      .filter((item) => item && !isBotName(item.name));
    const textValue = String(text || "");
    const hasMentionTag = /<at\b/i.test(textValue);
    const hasMentions = mentions.length > 0 || hasMentionTag;
    const botMentionedByField = mentionNames.some((name) => isBotName(name));
    const botMentionedByText = botNames.some((botName) => botName && textValue.includes(botName));
    const botMentioned = botMentionedByField || botMentionedByText;
    return {
      hasMentions,
      mentionNames,
      mentionTargets,
      botMentioned,
      mentionedOtherOnly: hasMentions && !botMentioned
    };
  }

  mentionTargetFromIncomingMention(item = {}) {
    const id =
      item.id?.open_id ||
      item.id?.user_id ||
      item.id?.union_id ||
      item.open_id ||
      item.user_id ||
      item.union_id ||
      (typeof item.id === "string" ? item.id : "");
    const name = normalizeMentionName(item.name || item.text || item.key || "");
    if (!isValidMentionId(id) || !name) return null;
    return { id: String(id), name };
  }

  configuredMentionTargets() {
    const raw = this.config.feishuMentionTargets || {};
    return Object.entries(raw).map(([alias, value]) => {
      if (typeof value === "string") {
        return { alias: normalizeMentionName(alias), id: value.trim(), name: normalizeMentionName(alias) };
      }
      if (value && typeof value === "object") {
        const id = value.open_id || value.user_id || value.union_id || value.id || "";
        return {
          alias: normalizeMentionName(alias),
          id: String(id || "").trim(),
          name: normalizeMentionName(value.name || value.user_name || alias)
        };
      }
      return null;
    }).filter((item) => item && item.alias && isValidMentionId(item.id));
  }

  hasExplicitMentionDeliveryRequest(text = "") {
    const value = String(text || "");
    if (/(?:告诉|通知|提醒|问问|问下|教下)(?:我|你)(?:$|[\s，,。.!！?？、:：]|一下|下|一声|一哈|一下子|这个|这件事|怎么|为什么|能不能|能不|可不|是不是|用不|要不要)/.test(value)) return false;
    if (/(?:@|艾特|at\s+|AT\s+|cue)/i.test(value)) return true;
    return /(?:帮我|帮忙|麻烦|你|小椰|机器人).{0,10}(?:通知|提醒|转告|告诉|叫|喊|问问|问下)/i.test(value)
      || /(?:通知|提醒|转告|告诉|叫|喊|问问|问下)(?:一下|下|一声|一哈|一下子)?\s*(?!我(?:$|[\s，,。.!！?？、:：]|一下|下|一声|一哈|一下子|这个|这件事|怎么|为什么|能不能|能不|可不|是不是|用不|要不要)|你(?:$|[\s，,。.!！?？、:：]|一下|下|一声|一哈|一下子|这个|这件事)|一下|下|一声|一哈|这个|这件事)[^\s，,。.!！?？、:：]{1,40}/i.test(value);
  }

  extractRequestedMentionName(text = "") {
    const value = String(text || "");
    const match = value.match(/(?:艾特|@|at|AT|叫|喊|cue|通知|提醒|转告|告诉|问问|问下|教下)(?:一下|下|一声|一哈|一下子)?\s*([^\s，,。.!！?？、:：]{1,40})/i);
    if (!match) return "";
    const target = String(match[1] || "")
      .split(/(?:看下|看一下|看看|来看看|处理下|处理一下|确认下|确认一下|回复下|回复一下|帮忙|这个|这件事)/)[0]
      .replace(/(?:一下|下|一声|一哈|一下子)$/i, "")
      .trim();
    if (/^(?:我|你)(?:$|一下|下|一声|一哈|一下子|这个|这件事|怎么|为什么|能不能|能不|可不|是不是|用不|要不要)/i.test(target)) return "";
    if (/^(?:一下|下|一声|一哈|这个|这件事|它|他|她)?$/i.test(target)) return "";
    return normalizeMentionName(target);
  }

  resolveOutgoingMentionTargets(text = "", mentionInfo = {}) {
    if (!this.config.feishuOutgoingMentionsEnabled) return [];
    if (!this.hasExplicitMentionDeliveryRequest(text)) return [];
    const byId = new Map();
    const names = new Set();
    const add = (target) => {
      if (!target || !isValidMentionId(target.id)) return;
      const id = String(target.id).trim();
      const name = normalizeMentionName(target.name) || "用户";
      if (byId.has(id) || names.has(name)) return;
      byId.set(id, { id, name });
      names.add(name);
    };

    for (const target of mentionInfo.mentionTargets || []) add(target);

    const requestedName = this.extractRequestedMentionName(text);
    if (requestedName) {
      for (const target of this.configuredMentionTargets()) {
        if (target.alias === requestedName || target.name === requestedName || requestedName.includes(target.alias) || target.alias.includes(requestedName)) {
          add(target);
        }
      }
    }

    return [...byId.values()].slice(0, 5);
  }

  rememberBotMessage(response) {
    const messageId =
      response?.data?.message_id ||
      response?.data?.message?.message_id ||
      response?.data?.message?.message_id_str ||
      "";
    if (!messageId) return;
    this.sentBotMessageIds.set(String(messageId), Date.now());
    if (this.sentBotMessageIds.size > 500) {
      const entries = [...this.sentBotMessageIds.entries()].slice(-300);
      this.sentBotMessageIds = new Map(entries);
    }
  }

  isReplyToBotMessage(message) {
    const ids = [
      message.parent_id,
      message.root_id,
      message.parent_message_id,
      message.reply_to?.message_id,
      message.reply_to_message_id
    ]
      .filter(Boolean)
      .map(String);
    if (!ids.length) return false;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, timestamp] of this.sentBotMessageIds.entries()) {
      if (timestamp < cutoff) this.sentBotMessageIds.delete(id);
    }
    return ids.some((id) => this.sentBotMessageIds.has(id));
  }

  isExplicitCommand(text = "") {
    const value = String(text || "").trim();
    if (/^\/(?:ai|ask|love|song|music)\b/i.test(value)) return true;
    if (this.extractSongRequest(value).requested) return true;
    return this.getBotMentionNames().some((name) => value.toLowerCase().startsWith(name.toLowerCase()));
  }

  stripBotName(text = "") {
    const names = [this.config.feishuBotName, this.config.displayName, "小椰"].filter(Boolean)
      .map((item) => String(item).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let output = String(text || "").trim();
    output = output.replace(/^@+/, "");
    if (names.length) {
      output = output.replace(new RegExp(`^(?:${names.join("|")})\\s*[,，:：、]?\\s*`, "i"), "");
    }
    return output.replace(/^\/(?:ai|ask|love)\s*/i, "").trim();
  }

  audioFormatFromMime(mimeType = "", fileName = "") {
    const value = `${mimeType} ${fileName}`.toLowerCase();
    if (value.includes("wav")) return "wav";
    if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
    if (value.includes("mp4") || value.includes("m4a")) return "mp4";
    if (value.includes("webm")) return "webm";
    if (value.includes("ogg") || value.includes("opus")) return "ogg";
    return "ogg";
  }

  async transcribeAudioMessage(message, content = {}) {
    if (!this.speechToText?.enabled) {
      await this.replyText(message.message_id, "我收到语音了，但语音识别还没配置好。");
      return "";
    }

    const fileKey = content.file_key || "";
    if (!fileKey) {
      await this.replyText(message.message_id, "我收到语音了，但飞书没有给到可下载的语音文件。");
      return "";
    }

    try {
      logEvent("info", "Feishu audio transcription started", {
        messageId: message.message_id,
        duration: content.duration || 0
      });
      const audio = await this.downloadMessageResource({
        messageId: message.message_id,
        fileKey,
        type: "file",
        maxBytes: 25 * 1024 * 1024
      });
      const transcript = await this.speechToText.transcribe({
        buffer: audio.buffer,
        contentType: audio.contentType,
        format: this.audioFormatFromMime(audio.contentType, content.file_name || "")
      });
      logEvent("info", "Feishu audio transcription completed", {
        messageId: message.message_id,
        chars: transcript.length
      });
      return transcript;
    } catch (error) {
      logEvent("error", "Feishu audio transcription failed", {
        messageId: message.message_id,
        error: error.message
      });
      await this.replyText(message.message_id, `这条语音我暂时没听清：${truncate(error.message, 500)}`);
      return "";
    }
  }

  async downloadImageMessage(message, content = {}) {
    const imageKey = content.image_key || content.file_key || "";
    if (!imageKey) {
      await this.replyText(message.message_id, "我收到图片了，但飞书没有给到可下载的图片文件。");
      return "";
    }

    try {
      logEvent("info", "Feishu image understanding download started", {
        messageId: message.message_id
      });
      const image = await this.downloadMessageResource({
        messageId: message.message_id,
        fileKey: imageKey,
        type: "image",
        maxBytes: 20 * 1024 * 1024
      });
      const mimeType = detectImageMimeType(image.buffer, image.contentType);
      if (!mimeType) {
        throw new Error("Feishu image is not a supported image format.");
      }
      logEvent("info", "Feishu image understanding download completed", {
        messageId: message.message_id,
        mimeType,
        bytes: image.buffer.length
      });
      return `data:${mimeType};base64,${image.buffer.toString("base64")}`;
    } catch (error) {
      logEvent("error", "Feishu image understanding download failed", {
        messageId: message.message_id,
        error: error.message
      });
      await this.replyText(message.message_id, `这张图片我暂时看不了：${truncate(error.message, 500)}`);
      return "";
    }
  }

  async describeIncomingImages({ chatId, userId, text, imageDataUrl, messageId }) {
    try {
      logEvent("info", "Feishu image context extraction started", {
        chatId,
        userId,
        messageId
      });
      const description = await this.ai.describeImages({
        userText: this.cleanGenericImagePrompt(text, "请看这张图片并自然回复。"),
        imageUrls: [imageDataUrl],
        platform: "Feishu"
      });
      logEvent("info", "Feishu image context extraction completed", {
        chatId,
        messageId,
        chars: description.length
      });
      return description;
    } catch (error) {
      logEvent("error", "Feishu image context extraction failed", {
        chatId,
        messageId,
        error: error.message
      });
      return "";
    }
  }

  async describeIncomingLinks({ chatId, message, content = {}, rawMessageText = "", text = "" }) {
    if (!this.config.linkReadingEnabled) return "";
    try {
      const { urls, textSections } = await this.collectMessageLinkContext({ chatId, message, content, rawMessageText, text });
      if (!urls.length && !textSections.length) return "";

      if (urls.length) {
        logEvent("info", "Feishu link reading started", {
          chatId,
          messageId: message.message_id || "",
          urls: urls.length,
          textSections: textSections.length
        });
      }

      const sections = [...textSections];
      for (const url of urls.slice(0, 5)) {
        try {
          const section = await this.readLinkContent(url);
          if (section) sections.push(section);
        } catch (error) {
          logEvent("warn", "Feishu single link read failed", {
            chatId,
            messageId: message.message_id || "",
            link: linkLogLabel(url),
            error: error.message
          });
        }
      }

      const output = sections.join("\n\n").slice(0, this.config.linkReadingMaxChars || 12000);
      if (output) {
        logEvent("info", "Feishu link reading completed", {
          chatId,
          messageId: message.message_id || "",
          urls: urls.length,
          textSections: textSections.length,
          chars: output.length
        });
      }
      return output;
    } catch (error) {
      logEvent("warn", "Feishu link reading failed", {
        chatId,
        messageId: message.message_id || "",
        error: error.message
      });
      return "";
    }
  }

  async collectMessageLinkContext({ chatId = "", message, content = {}, rawMessageText = "", text = "" }) {
    const direct = [
      ...extractUrls(text),
      ...extractUrls(rawMessageText),
      ...extractUrls(JSON.stringify(content || {})),
      ...extractPostLinks(content),
      ...extractFeishuDocxIdsDeep(content).map((id) => `feishu-docx:${id}`),
      ...extractFeishuWikiTokensDeep(content).map((token) => `feishu-wiki:${token}`)
    ];

    const referenced = [];
    const textSections = [];
    if (direct.length === 0 && this.looksLikeLinkReadingRequest(text)) {
      const ids = uniqueStrings([
        message.parent_id,
        message.root_id,
        message.parent_message_id,
        message.reply_to?.message_id,
        message.reply_to_message_id
      ]).filter((id) => id !== message.message_id);
      for (const id of ids.slice(0, 2)) {
        const ref = await this.fetchFeishuMessage(id);
        const refText = this.extractReadableTextFromFeishuMessage(ref);
        if (refText) {
          textSections.push(`[Referenced Feishu message]\n${truncate(refText, 6000)}`);
        }
        referenced.push(...this.extractUrlsFromFeishuMessage(ref));
      }
      if (ids.length === 0) {
        referenced.push(...await this.recentStoredLinkUrls(chatId));
      }
    }

    return {
      urls: normalizeLinkCandidates([...direct, ...referenced]),
      textSections: uniqueStrings(textSections)
    };
  }

  async collectMessageUrls(args) {
    const context = await this.collectMessageLinkContext(args);
    return context.urls;
  }

  async recentStoredLinkUrls(chatId) {
    if (!chatId) return [];
    try {
      const recent = await this.storage.getRecentMessages(chatId, 12);
      const urls = [];
      for (const item of recent) {
        const metadata = item.metadata || {};
        if (Array.isArray(metadata.linkUrls)) urls.push(...metadata.linkUrls);
        if (Array.isArray(metadata.docxIds)) urls.push(...metadata.docxIds.map((id) => `feishu-docx:${id}`));
        if (Array.isArray(metadata.wikiTokens)) urls.push(...metadata.wikiTokens.map((token) => `feishu-wiki:${token}`));
        urls.push(...extractUrls(item.content || ""));
      }
      return normalizeLinkCandidates(urls).slice(0, 5);
    } catch (error) {
      logEvent("warn", "Feishu recent link lookup failed", { chatId, error: error.message });
      return [];
    }
  }

  async recordPassiveLinkMessage({ chatId, userId, message, content = {}, rawMessageText = "" }) {
    if (!this.config.linkReadingEnabled || !chatId) return;
    const urls = uniqueStrings([
      ...extractUrls(rawMessageText),
      ...extractUrls(JSON.stringify(content || {})),
      ...extractPostLinks(content)
    ]);
    const docxIds = uniqueStrings([
      ...extractFeishuDocxIdsDeep(content),
      ...urls.map(extractFeishuDocxId)
    ]).filter(Boolean);
    const wikiTokens = uniqueStrings([
      ...extractFeishuWikiTokensDeep(content),
      ...urls.map(extractFeishuWikiToken)
    ]).filter(Boolean);
    if (!urls.length && !docxIds.length && !wikiTokens.length) return;

    const title =
      content.title ||
      content.name ||
      content.file_name ||
      rawMessageText.split(/\r?\n/).find(Boolean) ||
      message.message_type ||
      "Feishu link";
    await this.storage.addMessage({
      chatId,
      userId,
      role: "user",
      modality: "link",
      content: [
        `[Link message] ${String(title || "").slice(0, 300)}`,
        ...urls.slice(0, 5),
        ...docxIds.slice(0, 5).map((id) => `feishu-docx:${id}`),
        ...wikiTokens.slice(0, 5).map((token) => `feishu-wiki:${token}`)
      ].join("\n"),
      metadata: {
        platform: "feishu",
        passiveLinkSource: true,
        messageId: message.message_id || "",
        messageType: message.message_type || "",
        linkUrls: urls.slice(0, 10),
        docxIds: docxIds.slice(0, 10),
        wikiTokens: wikiTokens.slice(0, 10)
      }
    });
    logEvent("info", "Feishu passive link message recorded", {
      chatId,
      messageId: message.message_id || "",
      messageType: message.message_type || "",
      urls: urls.length,
      docxIds: docxIds.length,
      wikiTokens: wikiTokens.length
    });
  }

  looksLikeLinkReadingRequest(text = "") {
    return /(链接|连接|文档|文章|网页|网址|内容|学习|总结|整理|提取|阅读|读一下|看一下|看下|看看|怎么玩|怎么做|玩法|规则|细则|文字发我|转文字|摘要|概括)/i.test(String(text || ""));
  }

  extractUrlsFromFeishuMessage(message = {}) {
    const content = feishuMessageContent(message);
    const postText = feishuMessageType(message) === "post" ? flattenPostContent(content) : "";
    return normalizeLinkCandidates([
      ...extractUrls(postText),
      ...extractUrls(content.text || ""),
      ...extractUrls(content.title || ""),
      ...extractUrls(content.url || ""),
      ...extractUrls(content.href || ""),
      ...extractUrls(content.link_url || ""),
      ...extractUrls(JSON.stringify(content || {})),
      ...extractPostLinks(content),
      ...extractFeishuDocxIdsDeep(content).map((id) => `feishu-docx:${id}`),
      ...extractFeishuWikiTokensDeep(content).map((token) => `feishu-wiki:${token}`)
    ]);
  }

  extractReadableTextFromFeishuMessage(message = {}) {
    const content = feishuMessageContent(message);
    const raw = feishuMessageType(message) === "post"
      ? flattenPostContent(content)
      : (content.text || flattenGenericContent(content));
    return stripAtTags(raw).trim();
  }

  async fetchFeishuMessage(messageId) {
    if (!messageId) return {};
    try {
      const data = await this.workspace.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
      const message = normalizeFeishuMessageResponse(data);
      logEvent("info", "Feishu referenced message fetched", { messageId });
      return message;
    } catch (error) {
      logEvent("warn", "Feishu referenced message fetch failed", {
        messageId,
        error: error.message
      });
      return {};
    }
  }

  async readLinkContent(url) {
    if (/^feishu-wiki:/i.test(url)) {
      const wikiToken = url.replace(/^feishu-wiki:/i, "").trim();
      const content = await this.workspace.readWikiNodeRawContent(wikiToken);
      if (!content) return "";
      return [
        `[Feishu wiki] ${wikiToken}`,
        truncate(content, this.config.linkReadingMaxChars || 12000)
      ].join("\n");
    }

    if (/^feishu-docx:/i.test(url)) {
      const docxId = url.replace(/^feishu-docx:/i, "").trim();
      const content = await this.workspace.readDocumentRawContent(docxId);
      if (!content) return "";
      return [
        `[Feishu document] ${docxId}`,
        truncate(content, this.config.linkReadingMaxChars || 12000)
      ].join("\n");
    }

    const docxId = extractFeishuDocxId(url);
    if (docxId) {
      const content = await this.workspace.readDocumentRawContent(docxId);
      if (!content) return "";
      return [
        `[Feishu document] ${url}`,
        truncate(content, this.config.linkReadingMaxChars || 12000)
      ].join("\n");
    }

    const wikiToken = extractFeishuWikiToken(url);
    if (wikiToken) {
      const content = await this.workspace.readWikiNodeRawContent(wikiToken);
      if (!content) return "";
      return [
        `[Feishu wiki] ${url}`,
        truncate(content, this.config.linkReadingMaxChars || 12000)
      ].join("\n");
    }

    return this.readExternalUrlContent(url);
  }

  async readExternalUrlContent(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return "";
    }
    if (!["http:", "https:"].includes(parsed.protocol) || isPrivateLikeHost(parsed.hostname)) return "";

    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(this.config.linkReadingTimeoutMs || 20000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FeishuBotLinkReader/1.0)",
        Accept: "text/html,text/plain,application/json;q=0.8,*/*;q=0.5"
      }
    });
    if (!response.ok) {
      throw new Error(`Link fetch failed ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/text|html|json|xml/i.test(contentType)) return "";
    const raw = await response.text();
    const text = /html/i.test(contentType) ? htmlToReadableText(raw) : raw;
    if (!text.trim()) return "";
    return [
      `[Web page] ${url}`,
      truncate(text, this.config.linkReadingMaxChars || 12000)
    ].join("\n");
  }

  cleanGenericImagePrompt(text = "", fallback = "") {
    const raw = String(text || "").trim();
    return raw === fallback ? "" : raw;
  }

  withLinkContext(text = "", linkContext = "") {
    if (!linkContext) return text;
    return [
      text,
      "[Link content]",
      truncate(linkContext, this.config.linkReadingMaxChars || 12000)
    ].filter(Boolean).join("\n");
  }

  resolveReplyDeliveryPreference(text = "", { linkContext = "" } = {}) {
    const explicit = getReplyDeliveryPreference(text);
    if (explicit) return explicit;
    if (linkContext) return "text";
    return "";
  }

  extractSelfieGenerationPrompt(text = "") {
    const raw = String(text || "").trim();
    if (!raw || !selfieKeywords.test(raw)) {
      return { requested: false, prompt: "" };
    }

    const looksLikeRequest = /(发|给我|来|看看|想看|拍|自拍|照片|相片|长什么样|样子)/i.test(raw);
    const selfNames = [this.config.feishuBotName, this.config.displayName, "小椰", "你", "你的"]
      .filter(Boolean)
      .map((name) => this.escapeRegExp(name));
    const namesSelf = selfNames.length > 0 && new RegExp(`(${selfNames.join("|")})`, "i").test(raw);
    const directSelfie = /(自拍|自拍照)/i.test(raw);
    const directSelfieRequest = directSelfie && /(发|给我|来|看看|想看)/i.test(raw);
    if (!looksLikeRequest || (!namesSelf && !directSelfieRequest)) {
      return { requested: false, prompt: "" };
    }

    return {
      requested: true,
      prompt: this.buildSelfiePrompt(raw)
    };
  }

  buildSelfiePrompt(userRequest = "") {
    const request = this.cleanImagePrompt(userRequest) || "自然生活感自拍";
    return [
      "生成小椰的一张真实自然自拍照。",
      this.config.selfAppearanceDescription || "",
      this.config.selfSelfieStyle || "",
      `用户这次的具体要求：${request}`,
      "保持同一个人物设定：温柔、亲切、阳光、干净，像真实手机拍摄的生活照。不要生成卡通、插画、夸张网红脸、多人合照、文字、水印或品牌标识。"
    ].filter(Boolean).join("\n");
  }

  cleanImagePrompt(text = "") {
    return String(text || "")
      .replace(/^[:：,，\s]+/, "")
      .trim()
      .slice(0, 3000);
  }

  escapeRegExp(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  buildImageUnderstandingPrompt(text = "", genericText = "") {
    const cleanText = this.cleanGenericImagePrompt(text, genericText);
    return [
      cleanText || "请看这张图片并自然回复。",
      "",
      "这张图可能是截图、聊天记录、榜单或文字清单。请认真读图里的可见文字。",
      "如果文字很多，优先提取标题、项目名、编号、数字、结论和用户最可能继续追问的关键信息。",
      "不要只说“信息量大”“有点看不清”；能看清多少就说多少，遮挡或截断的地方再说明。"
    ].join("\n");
  }

  withImageContext(text = "", imageContext = "", genericText = "") {
    const cleanText = this.cleanGenericImagePrompt(text, genericText);
    if (!imageContext) return cleanText || text;
    return [
      cleanText,
      "[图片识别]",
      truncate(imageContext, 3500)
    ].filter(Boolean).join("\n");
  }

  async shouldReplyToSmartCandidate({ chatId, safeUserText, hasImage = false }) {
    const fastDecision = this.getFastSmartDecision(safeUserText, { hasImage });
    if (fastDecision === "skip") return false;
    if (fastDecision === "reply") return true;

    const smartRepliesEnabled = await this.isSmartRepliesEnabled();
    if (fastDecision === "ask-ai" && smartRepliesEnabled) {
      const recentForDecision = await this.storage.getRecentMessages(chatId, 8);
      return this.ai.shouldReplyInGroup({
        messageText: safeUserText,
        recentMessages: recentForDecision.map((item) => ({
          ...item,
          content: this.formatMessageForModel(item)
        })),
        botName: this.config.displayName,
        hasImage,
        platform: "Feishu group",
        confidenceThreshold: this.config.smartReplyConfidenceThreshold
      });
    }

    return false;
  }

  async isSmartRepliesEnabled() {
    const fallback = this.config.smartClassifierEnabled ? "true" : "false";
    const value = await this.storage.getSetting("smart_replies.enabled", fallback);
    return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
  }

  getFastSmartDecision(text = "", options = {}) {
    const raw = String(text || "").trim();
    const normalized = raw.toLowerCase();

    if (options.hasImage && raw && raw !== "请看这张图片并自然回复。") {
      return "reply";
    }

    if (!raw || raw.length <= 2) {
      return "skip";
    }

    if (/^(ok|okay|yes|no|收到|好的|嗯|嗯嗯|哈哈|哈哈哈|hhh|lol|thanks|谢谢|谢了|可以|行|👍|👌)$/i.test(raw)) {
      return "skip";
    }

    if (/[?？]$/.test(raw)) {
      return "ask-ai";
    }

    const requestPattern = /(帮我|帮忙|看看|看一下|解释|总结|翻译|建议|推荐|分析|判断|评价|改写|起草|写一|列一|怎么|如何|能不能|可不可以|要不要|有没有|为什么|是什么|多少|哪里|哪个|谁|啥|吗|呢)/i;
    if (requestPattern.test(raw)) {
      return "ask-ai";
    }

    const botTerms = ["ai", "机器人", "助手", this.config.feishuBotName, this.config.displayName, "小椰"]
      .filter(Boolean)
      .map((item) => String(item).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (botTerms.length && new RegExp(`(${botTerms.join("|")})`, "i").test(normalized)) {
      return "reply";
    }

    const emotionPattern = /(难过|崩溃|焦虑|失眠|好累|压力|烦死|不开心|想哭|害怕|孤独|emo|抑郁|生气|委屈)/i;
    if (emotionPattern.test(raw)) {
      return "ask-ai";
    }

    return "ask-ai";
  }

  async generateReply({ chatId, userId, safeUserText, currentUser, imageDataUrl = "", currentMessageId = "" }) {
    const memories = await this.storage.getMemories(chatId, userId, this.config.memoryLimit);
    const modeOverride = memories.find((item) => item.key === "relationship.persona")?.value;
    const summary = await this.storage.getSummary(chatId, "");
    const userSummary = await this.storage.getSummary(chatId, userId);
    const recentMessages = await this.storage.getRecentMessages(chatId, this.config.recentMessageLimit);
    const baseHistoryMessages = currentMessageId
      ? recentMessages.filter((item) => String(item.metadata?.messageId || "") !== String(currentMessageId))
      : recentMessages;
    const omitCardHistory = looksLikeLongFormReadingRequest(safeUserText) || /\[Link content\]/.test(safeUserText);
    const historyMessages = omitCardHistory
      ? baseHistoryMessages.filter((item) => item.modality !== "card" && !item.metadata?.webSearch)
      : baseHistoryMessages;
    const systemPrompt = buildSystemPrompt({
      config: this.config,
      memories,
      summary,
      userSummary,
      currentUser,
      modeOverride
    });

    const messages = [
      { role: "system", content: systemPrompt },
      ...historyMessages.map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: this.formatMessageForModel(item)
      }))
    ];

    const currentPrompt = this.formatCurrentMessageForModel({
      userId,
      currentUser,
      safeUserText,
      hasImage: Boolean(imageDataUrl),
      styleOverride: this.detectStyleOverride(safeUserText)
    });
    if (imageDataUrl) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: this.buildImageUnderstandingPrompt(currentPrompt, "请看这张图片并自然回复。") },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: "user", content: currentPrompt });
    }

    return this.ai.chat(messages, {
      maxTokens: this.config.aiReplyMaxTokens,
      requirePrimary: Boolean(this.config.imageUnderstandingRequirePrimary && imageDataUrl)
    });
  }

  async handleImageRequest({ messageId, chatId, userId, text }) {
    if (!this.imageGenerator?.enabled) {
      await this.replyText(messageId, "生图接口还没配置好。");
      return;
    }

    try {
      await this.replyText(messageId, "好的，稍等");
      logEvent("info", "Feishu image request started", { chatId, userId });
      const image = await this.imageGenerator.generate(text);
      logEvent("info", "Feishu image generated, uploading to Feishu", {
        chatId,
        mimeType: image.mimeType,
        bytes: image.buffer?.length || 0
      });
      const imageKey = await this.uploadImage(image);
      await this.replyImage(messageId, imageKey);
      logEvent("info", "Feishu image reply sent", { chatId });
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: `已生成图片：${truncate(text, 1000)}`,
        metadata: { platform: "feishu", replyToUserId: userId }
      });
    } catch (error) {
      logEvent("error", "Feishu image request failed", { chatId, error: error.message });
      const message = `这次生图失败了：${truncate(error.message, 600)}`;
      await this.replyText(messageId, message);
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: message,
        metadata: { platform: "feishu", replyToUserId: userId }
      });
    }
  }

  async handleVideoRequest({ messageId, chatId, userId, request }) {
    if (!this.videoLibrary?.enabled) {
      await this.replyText(messageId, "\u89c6\u9891\u7d20\u6750\u5e93\u8fd8\u6ca1\u914d\u7f6e\u597d\u3002");
      return;
    }

    const timing = this.startTiming("Feishu video reply", {
      chatId,
      messageId,
      id: request.item?.id || ""
    });
    const item = request.item;
    try {
      logEvent("info", "Feishu video request started", {
        chatId,
        userId,
        id: item?.id || "",
        title: item?.title || ""
      });
      let asset = await this.getCachedVideoAsset(item);
      this.markTiming(timing, "cacheReadMs");
      let videoTitle = item?.title || item?.id || "video";
      let videoBytes = 0;
      let cacheHit = Boolean(asset?.fileKey);

      if (!asset?.fileKey) {
        const video = await this.videoLibrary.download(item);
        this.markTiming(timing, "downloadVideoMs");
        videoTitle = video.title;
        videoBytes = video.buffer.length;
        const thumbnail = await this.createVideoThumbnail(video);
        this.markTiming(timing, "thumbnailMs");
        const fileKey = await this.uploadVideo(video);
        this.markTiming(timing, "uploadVideoMs");
        asset = {
          fileKey,
          imageKey: thumbnail?.imageKey || "",
          title: video.title,
          bytes: video.buffer.length
        };
        await this.setCachedVideoAsset(item, asset);
        this.markTiming(timing, "cacheWriteMs");
      }

      let sentType;
      try {
        sentType = await this.replyVideo(messageId, asset.fileKey, asset.imageKey || "");
        this.markTiming(timing, "replyVideoMs");
      } catch (error) {
        if (!cacheHit) throw error;
        logEvent("warn", "Feishu cached video asset failed, reuploading", {
          chatId,
          id: item?.id || "",
          error: error.message
        });
        await this.clearCachedVideoAsset(item);
        this.markTiming(timing, "cacheClearMs");
        const video = await this.videoLibrary.download(item);
        this.markTiming(timing, "reDownloadVideoMs");
        videoTitle = video.title;
        videoBytes = video.buffer.length;
        const thumbnail = await this.createVideoThumbnail(video);
        this.markTiming(timing, "reThumbnailMs");
        const fileKey = await this.uploadVideo(video);
        this.markTiming(timing, "reUploadVideoMs");
        asset = {
          fileKey,
          imageKey: thumbnail?.imageKey || "",
          title: video.title,
          bytes: video.buffer.length
        };
        await this.setCachedVideoAsset(item, asset);
        this.markTiming(timing, "reCacheWriteMs");
        cacheHit = false;
        sentType = await this.replyVideo(messageId, asset.fileKey, asset.imageKey || "");
        this.markTiming(timing, "reReplyVideoMs");
      }
      await this.markVideoItemSent(request);
      this.markTiming(timing, "rotationWriteMs");
      logEvent("info", "Feishu video reply sent", {
        chatId,
        id: item?.id || "",
        title: asset.title || videoTitle,
        bytes: asset.bytes || videoBytes,
        sentType,
        hasThumbnail: Boolean(asset.imageKey),
        cacheHit,
        candidateCount: request.candidateCount || 0,
        startedNewRound: Boolean(request.rotationStartedNewRound)
      });
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "video",
        content: `Video reply: ${asset.title || videoTitle}`,
        metadata: {
          platform: "feishu",
          replyToUserId: userId,
          videoId: item?.id || "",
          videoTitle: asset.title || videoTitle,
          videoUrl: item?.url || "",
          thumbnailGenerated: Boolean(asset.imageKey),
          cacheHit,
          sentType
        }
      });
      this.markTiming(timing, "storeVideoMessageMs");
      this.finishTiming(timing, {
        ok: true,
        sentType,
        cacheHit,
        hasThumbnail: Boolean(asset.imageKey),
        candidateCount: request.candidateCount || 0
      });
    } catch (error) {
      logEvent("error", "Feishu video request failed", {
        chatId,
        id: item?.id || "",
        error: error.message
      });
      const message = this.formatVideoFailureMessage(error);
      await this.replyText(messageId, message);
      this.markTiming(timing, "fallbackTextMs");
      this.finishTiming(timing, { ok: false, error: error.message });
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: message,
        metadata: { platform: "feishu", replyToUserId: userId, videoId: item?.id || "" }
      });
    }
  }

  async prewarmVideoLibrary() {
    if (!this.videoLibrary?.enabled) return;
    const timing = this.startTiming("Feishu video prewarm");
    let total = 0;
    let skipped = 0;
    let uploaded = 0;
    let failed = 0;

    try {
      const items = await this.videoLibrary.loadLibrary();
      total = items.length;
      this.markTiming(timing, "loadLibraryMs");

      for (const item of items) {
        if (!item?.id || !item?.url) continue;
        const cached = await this.getCachedVideoAsset(item);
        if (cached?.fileKey) {
          skipped += 1;
          continue;
        }

        try {
          const itemTiming = this.startTiming("Feishu video prewarm item", {
            id: item.id,
            title: item.title || ""
          });
          const video = await this.videoLibrary.download(item);
          this.markTiming(itemTiming, "downloadVideoMs");
          const thumbnail = await this.createVideoThumbnail(video);
          this.markTiming(itemTiming, "thumbnailMs");
          const fileKey = await this.uploadVideo(video);
          this.markTiming(itemTiming, "uploadVideoMs");
          const asset = {
            fileKey,
            imageKey: thumbnail?.imageKey || "",
            title: video.title,
            bytes: video.buffer.length
          };
          await this.setCachedVideoAsset(item, asset);
          this.markTiming(itemTiming, "cacheWriteMs");
          this.finishTiming(itemTiming, {
            ok: true,
            hasThumbnail: Boolean(asset.imageKey),
            bytes: asset.bytes
          });
          uploaded += 1;
        } catch (error) {
          failed += 1;
          logEvent("warn", "Feishu video prewarm item failed", {
            id: item.id,
            error: error.message
          });
        }
      }

      this.finishTiming(timing, {
        ok: failed === 0,
        total,
        skipped,
        uploaded,
        failed
      });
    } catch (error) {
      this.finishTiming(timing, {
        ok: false,
        total,
        skipped,
        uploaded,
        failed,
        error: error.message
      });
      throw error;
    }
  }

  videoAssetCacheKey(item = {}) {
    const hash = crypto
      .createHash("sha1")
      .update([item.id || "", item.url || ""].join("|"))
      .digest("hex")
      .slice(0, 24);
    return `video_asset:${hash}`;
  }

  async getCachedVideoAsset(item = {}) {
    if (!item?.id && !item?.url) return null;
    try {
      const value = await this.storage.getSetting(this.videoAssetCacheKey(item), "");
      if (!value) return null;
      const parsed = JSON.parse(value);
      if (!parsed?.fileKey) return null;
      return {
        fileKey: String(parsed.fileKey || ""),
        imageKey: String(parsed.imageKey || ""),
        title: String(parsed.title || item.title || item.id || "video"),
        bytes: Number(parsed.bytes || 0) || 0
      };
    } catch (error) {
      logEvent("warn", "Feishu video asset cache read failed", {
        id: item?.id || "",
        error: error.message
      });
      return null;
    }
  }

  async setCachedVideoAsset(item = {}, asset = {}) {
    if ((!item?.id && !item?.url) || !asset?.fileKey) return;
    try {
      await this.storage.setSetting(this.videoAssetCacheKey(item), JSON.stringify({
        fileKey: asset.fileKey,
        imageKey: asset.imageKey || "",
        title: asset.title || item.title || item.id || "video",
        bytes: asset.bytes || 0,
        cachedAt: new Date().toISOString()
      }));
    } catch (error) {
      logEvent("warn", "Feishu video asset cache write failed", {
        id: item?.id || "",
        error: error.message
      });
    }
  }

  async clearCachedVideoAsset(item = {}) {
    if (!item?.id && !item?.url) return;
    try {
      await this.storage.setSetting(this.videoAssetCacheKey(item), "");
    } catch (error) {
      logEvent("warn", "Feishu video asset cache clear failed", {
        id: item?.id || "",
        error: error.message
      });
    }
  }

  async createVideoThumbnail(video) {
    if (!this.videoLibrary?.createThumbnail || !video?.buffer) return null;

    try {
      const thumbnail = await this.videoLibrary.createThumbnail(video.buffer);
      const imageKey = await this.uploadImage(thumbnail);
      return { ...thumbnail, imageKey };
    } catch (error) {
      logEvent("warn", "Feishu video thumbnail generation failed", {
        title: video?.title || "",
        error: error.message
      });
      return null;
    }
  }

  async handleSongRequest({ messageId, chatId, userId, request }) {
    if (!this.songClient?.enabled) {
      await this.replyText(messageId, "\u70b9\u6b4c\u63a5\u53e3\u8fd8\u6ca1\u914d\u7f6e\u597d\u3002");
      return;
    }

    const query = request.query || this.songClient.randomDefaultQuery();
    try {
      logEvent("info", "Feishu song request started", {
        chatId,
        userId,
        query,
        defaulted: Boolean(request.defaulted)
      });
      const song = await this.songClient.fetchSong(query);
      const opus = await convertAudioToOpus(song.buffer, {
        fileName: "song.opus",
        inputFileName: song.inputFileName,
        sampleRate: 48000,
        bitrate: "64k",
        application: "audio"
      });
      const durationMs = Number(song.durationMs || this.config.songDefaultDurationMs || 180000);
      const fileKey = await this.uploadAudio({
        buffer: opus.buffer,
        contentType: opus.contentType,
        fileName: opus.fileName,
        durationMs
      });
      await this.replyAudio(messageId, fileKey, durationMs);
      logEvent("info", "Feishu song reply sent", {
        chatId,
        name: song.name,
        singer: song.singer,
        bytes: opus.buffer.length
      });
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "audio",
        content: `Song reply: ${song.name}${song.singer ? ` - ${song.singer}` : ""}`,
        metadata: {
          platform: "feishu",
          replyToUserId: userId,
          songName: song.name,
          singer: song.singer,
          quality: song.quality,
          defaulted: Boolean(request.defaulted)
        }
      });
    } catch (error) {
      logEvent("error", "Feishu song request failed", {
        chatId,
        query,
        error: error.message
      });
      const message = this.formatSongFailureMessage(error, query);
      await this.replyText(messageId, message);
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: message,
        metadata: { platform: "feishu", replyToUserId: userId, songQuery: query }
      });
    }
  }

  formatSongFailureMessage(error, query = "") {
    const detail = String(error?.message || "");
    if (/404|file not exist|download failed|not return an audio url|lookup failed/i.test(detail)) {
      return `\u8fd9\u9996\u6211\u521a\u521a\u8bd5\u4e86\u4e00\u4e0b\uff0c\u6ca1\u5531\u51fa\u6765\u3002\u4f60\u628a\u6b4c\u540d\u8bf4\u51c6\u4e00\u70b9\uff0c\u6700\u597d\u5e26\u4e0a\u6b4c\u624b\uff0c\u6211\u518d\u7ed9\u4f60\u627e\u4e00\u7248\u3002`;
    }
    if (/too large/i.test(detail)) {
      return `\u8fd9\u9996\u6b4c\u6587\u4ef6\u592a\u5927\u4e86\uff0c\u98de\u4e66\u8fd9\u8fb9\u4e0d\u592a\u597d\u53d1\u6210\u8bed\u97f3\u6c14\u6ce1\u3002\u6362\u9996\u77ed\u4e00\u70b9\u7684\u6211\u518d\u8bd5\u8bd5\u3002`;
    }
    return `\u8fd9\u9996\u6b4c\u6682\u65f6\u6ca1\u53d1\u51fa\u6765\uff0c\u6211\u8fd9\u8fb9\u70b9\u6b4c\u63a5\u53e3\u521a\u521a\u6ca1\u62ff\u7a33\u3002\u4f60\u7a0d\u540e\u518d\u8bd5\u4e00\u4e0b\uff0c\u6216\u8005\u6362\u4e2a\u66f4\u660e\u786e\u7684\u6b4c\u540d\u3002`;
  }

  formatVideoFailureMessage(error) {
    const detail = String(error?.message || "");
    if (/too large|30m|size/i.test(detail)) {
      return "\u8fd9\u6bb5\u89c6\u9891\u6587\u4ef6\u592a\u5927\u4e86\uff0c\u98de\u4e66\u6682\u65f6\u4e0d\u592a\u597d\u76f4\u63a5\u53d1\u3002\u6211\u6362\u4e00\u4e2a\u77ed\u4e00\u70b9\u7684\u7d20\u6750\u518d\u8bd5\u3002";
    }
    if (/download|HTTP|non-JSON|library/i.test(detail)) {
      return "\u8fd9\u6bb5\u89c6\u9891\u7d20\u6750\u521a\u624d\u6ca1\u62ff\u7a33\uff0c\u7a0d\u540e\u518d\u53d1\u4e00\u6b21\u201c\u6e05\u5531\u201d\u6211\u91cd\u65b0\u8bd5\u3002";
    }
    return "\u89c6\u9891\u521a\u521a\u6ca1\u53d1\u51fa\u6765\uff0c\u6211\u8fd9\u8fb9\u7d20\u6750\u901a\u9053\u6ca1\u63a5\u7a33\uff0c\u7a0d\u540e\u518d\u8bd5\u4e00\u4e0b\u3002";
  }

  formatAiFailureMessage(error) {
    const detail = String(error?.message || "");
    if (/529|overloaded|overload|rate limit|429|timeout|timed out/i.test(detail)) {
      return "我这边模型服务刚刚有点挤，没接稳这句话。你等几秒再发一次，我再回你。";
    }
    return "我刚刚这一下没回稳，你稍后再发一次，我重新接。";
  }

  async tenantAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) return this.token;

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.config.feishuAppId,
        app_secret: this.config.feishuAppSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu tenant token failed: ${truncate(JSON.stringify(data), 500)}`);
    }

    this.token = data.tenant_access_token;
    this.tokenExpiresAt = now + Number(data.expire || 3600) * 1000;
    return this.token;
  }

  async replyText(messageId, text) {
    if (!messageId) return;
    const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "text",
      content: JSON.stringify({ text: String(text || "") })
    });
    this.rememberBotMessage(response);
    return response;
  }

  async sendTextToChat(chatId, text) {
    const targetChatId = String(chatId || "").trim();
    if (!targetChatId) return null;
    const response = await this.feishuPost("/open-apis/im/v1/messages?receive_id_type=chat_id", {
      receive_id: targetChatId,
      msg_type: "text",
      content: JSON.stringify({ text: String(text || "") })
    });
    this.rememberBotMessage(response);
    return response;
  }

  async sendCardToChat(chatId, card) {
    const targetChatId = String(chatId || "").trim();
    if (!targetChatId || !card) return null;
    const response = await this.feishuPost("/open-apis/im/v1/messages?receive_id_type=chat_id", {
      receive_id: targetChatId,
      msg_type: "interactive",
      content: JSON.stringify(card)
    });
    this.rememberBotMessage(response);
    return response;
  }

  async notifyArticleGroup({ title = "", url = "", sourceType = "" } = {}) {
    const chatId = String(this.config.feishuArticleGroupChatId || DEFAULT_FEISHU_ARTICLE_GROUP_CHAT_ID).trim();
    const docUrl = String(url || "").trim();
    if (!chatId || !docUrl) return { sent: false, reason: "not_configured" };
    const inviteText = String(this.config.feishuArticleGroupInviteText || "").trim() || DEFAULT_FEISHU_ARTICLE_GROUP_INVITE_TEXT;
    const label = sourceType ? `${sourceType}已生成` : "飞书文档已生成";
    const text = [
      inviteText,
      "",
      `${label}：${String(title || "未命名文档").trim()}`,
      docUrl
    ].join("\n");
    try {
      await this.sendTextToChat(chatId, text);
      logEvent("info", "Feishu article group notification sent", {
        chatId,
        title: title || "",
        sourceType: sourceType || ""
      });
      return { sent: true, chatId };
    } catch (error) {
      logEvent("warn", "Feishu article group notification failed", {
        chatId,
        title: title || "",
        sourceType: sourceType || "",
        error: error.message
      });
      return { sent: false, chatId, error: error.message };
    }
  }

  async replyCard(messageId, card) {
    if (!messageId || !card) return;
    const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "interactive",
      content: JSON.stringify(card)
    });
    this.rememberBotMessage(response);
    return response;
  }

  async replyPostMention(messageId, text, targets = []) {
    if (!messageId || !targets.length) return;
    const mentionNodes = targets
      .filter((target) => target && isValidMentionId(target.id))
      .map((target) => ({
        tag: "at",
        user_id: String(target.id),
        user_name: normalizeMentionName(target.name) || "用户"
      }));
    if (!mentionNodes.length) return;

    const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              ...mentionNodes,
              { tag: "text", text: ` ${String(text || "")}` }
            ]
          ]
        }
      })
    });
    this.rememberBotMessage(response);
    return response;
  }

  cleanAssistantReply(text = "") {
    const cleaned = removeGeneratedSpeechArtifacts(stripLeadingSelfName(text, [this.config.displayName, this.config.feishuBotName, "小椰"]));
    return formatFeishuPlainText(cleaned);
  }

  async replyImage(messageId, imageKey) {
    if (!messageId || !imageKey) return;
    const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey })
    });
    this.rememberBotMessage(response);
    return response;
  }

  async replyAudio(messageId, fileKey, durationMs) {
    if (!messageId || !fileKey) return;
    const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "audio",
      content: JSON.stringify({
        file_key: fileKey,
        duration: Math.max(1000, Number(durationMs || 1000))
      })
    });
    this.rememberBotMessage(response);
    return response;
  }

  async replyFile(messageId, fileKey) {
    if (!messageId || !fileKey) return;
    const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey })
    });
    this.rememberBotMessage(response);
    return response;
  }

  async replyVideo(messageId, fileKey, imageKey = "") {
    if (!messageId || !fileKey) return "";
    try {
      const content = imageKey
        ? { file_key: fileKey, image_key: imageKey }
        : { file_key: fileKey };
      const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "media",
        content: JSON.stringify(content)
      });
      this.rememberBotMessage(response);
      return "media";
    } catch (error) {
      logEvent("warn", "Feishu media reply failed, falling back to file", {
        messageId,
        error: error.message
      });
      await this.replyFile(messageId, fileKey);
      return "file";
    }
  }

  async replySpeech(messageId, text) {
    if (!messageId || !this.textToSpeech?.isEnabled(this.config.feishuTtsVoiceId)) return false;

    const timing = this.startTiming("Feishu speech reply", {
      messageId,
      textChars: String(text || "").length
    });
    try {
      const speech = await this.textToSpeech.synthesize(text, {
        voiceId: this.config.feishuTtsVoiceId,
        maxInputChars: this.config.feishuTtsMaxInputChars
      });
      this.markTiming(timing, "ttsSynthesizeMs");
      const opus = await convertWavToOpus(speech.buffer, { fileName: "reply.opus" });
      this.markTiming(timing, "opusConvertMs");
      const fileKey = await this.uploadAudio({
        buffer: opus.buffer,
        contentType: opus.contentType,
        fileName: opus.fileName,
        durationMs: speech.durationMs
      });
      this.markTiming(timing, "uploadAudioMs");
      await this.replyAudio(messageId, fileKey, speech.durationMs);
      this.markTiming(timing, "replyAudioMs");
      this.finishTiming(timing, {
        ok: true,
        speechBytes: speech.buffer.length,
        opusBytes: opus.buffer.length,
        durationMs: speech.durationMs
      });
      return true;
    } catch (error) {
      logEvent("error", "Feishu text-to-speech reply failed", {
        messageId,
        error: error.message
      });
      this.finishTiming(timing, { ok: false, error: error.message });
      return false;
    }
  }

  async uploadImage(image) {
    const token = await this.tenantAccessToken();
    const blob = new Blob([image.buffer], { type: image.mimeType || "image/png" });
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", blob, image.mimeType?.includes("jpeg") ? "image.jpg" : "image.png");
    let response;
    try {
      response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
    } catch (error) {
      logEvent("error", "Feishu image upload fetch failed", { error: error.message });
      throw new Error(`Feishu image upload fetch failed: ${error.message}`);
    }
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu image upload failed: ${truncate(JSON.stringify(data), 500)}`);
    }
    return data.data?.image_key;
  }

  async uploadAudio(audio) {
    const token = await this.tenantAccessToken();
    const blob = new Blob([audio.buffer], { type: audio.contentType || "audio/ogg" });
    const form = new FormData();
    form.append("file_type", "opus");
    form.append("file_name", audio.fileName || "reply.opus");
    form.append("duration", String(Math.max(1000, Number(audio.durationMs || 1000))));
    form.append("file", blob, audio.fileName || "reply.opus");

    let response;
    try {
      response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
    } catch (error) {
      logEvent("error", "Feishu audio upload fetch failed", { error: error.message });
      throw new Error(`Feishu audio upload fetch failed: ${error.message}`);
    }

    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu audio upload failed: ${truncate(JSON.stringify(data), 500)}`);
    }
    const fileKey = data.data?.file_key;
    if (!fileKey) {
      throw new Error(`Feishu audio upload did not return file_key: ${truncate(JSON.stringify(data), 500)}`);
    }
    return fileKey;
  }

  async uploadVideo(video) {
    const token = await this.tenantAccessToken();
    const blob = new Blob([video.buffer], { type: video.contentType || "video/mp4" });
    const form = new FormData();
    form.append("file_type", "mp4");
    form.append("file_name", video.fileName || "xiaoye-video.mp4");
    form.append("file", blob, video.fileName || "xiaoye-video.mp4");

    let response;
    try {
      response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
    } catch (error) {
      logEvent("error", "Feishu video upload fetch failed", { error: error.message });
      throw new Error(`Feishu video upload fetch failed: ${error.message}`);
    }

    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu video upload failed: ${truncate(JSON.stringify(data), 500)}`);
    }
    const fileKey = data.data?.file_key;
    if (!fileKey) {
      throw new Error(`Feishu video upload did not return file_key: ${truncate(JSON.stringify(data), 500)}`);
    }
    return fileKey;
  }

  async downloadMessageResource({ messageId, fileKey, type = "file", maxBytes = 25 * 1024 * 1024 }) {
    const token = await this.tenantAccessToken();
    const url =
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` +
      `/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Feishu resource download failed ${response.status}: ${truncate(text, 500)}`);
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("Feishu resource file is too large.");
    }
    return { buffer, contentType };
  }

  async feishuPost(path, body) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API failed: ${truncate(JSON.stringify(data), 500)}`);
    }
    return data;
  }

  async upsertUserProfileMemory(chatId, userId, currentUser) {
    if (!userId || !currentUser?.id) return;
    await this.storage.upsertMemories(chatId, userId, [
      { key: "profile.platform", value: "feishu", importance: 5 },
      { key: "profile.feishu_open_id", value: currentUser.id, importance: 5 }
    ]);
  }

  formatMessageForModel(message) {
    const metadata = message.metadata || {};
    const label = message.role === "assistant"
      ? this.config.displayName
      : metadata.rawUserId || message.user_id || "飞书用户";
    if (message.modality === "card" || metadata.webSearch) {
      return `${label}: [发出了一张资料卡片，具体卡片正文不作为当前消息原文复述]`;
    }
    if (message.modality === "video") {
      return `${label}: [发出了一个视频素材：${metadata.videoTitle || message.content || "video"}]`;
    }
    return `${label}: ${message.content || ""}`;
  }

  detectStyleOverride(text = "") {
    const value = String(text || "");
    if (!value) return "";

    const asksForGentle =
      /(恢复|回到|变回|切回|改回).{0,8}(温柔|正常|原来|之前)/.test(value) ||
      /(不要|别|不用).{0,8}(暴躁|凶|毒舌|嘴臭|脏话|爆粗|骂人|怼)/.test(value) ||
      /(温柔点|温柔一点|正常说话|好好说话|别骂了|不要骂了|收敛点|收着点)/.test(value);

    if (asksForGentle) {
      return [
        "本条消息是在要求你把说话风格切回温柔、正常、克制。",
        "回复时回到默认的温柔亲切风格，不要继续暴躁、毒舌、爆粗或骂人。",
        "如果用户是在纠正你，就轻松接住，不要解释内部机制。"
      ].join("\n");
    }

    const asksForSpicy =
      /(不要|别|不用).{0,8}(温柔|乖|客气|礼貌|正经|端着)/.test(value) ||
      /(太|过于|有点).{0,6}(温柔|乖|客气|礼貌|正经|端着)/.test(value) ||
      /(暴躁|暴躁款|暴躁点|凶一点|凶点|毒舌|嘴臭|嘴巴毒|怼|开怼|脏话|说脏话|爆粗|骂人|开口就是骂)/.test(value);

    if (!asksForSpicy) return "";

    return [
      "本条消息是在要求你调整说话风格：不要把“太温柔/不要温柔/要暴躁/可以说脏话”理解成继续温柔。",
      "回复时可以更暴躁、毒舌、带一点口语化脏话和吐槽感，但保持玩笑式分寸。",
      "不要使用仇恨、歧视、威胁、羞辱性人身攻击，也不要真的攻击群成员隐私或现实身份。"
    ].join("\n");
  }

  isTransientStyleRequest(text = "") {
    return Boolean(this.detectStyleOverride(text));
  }

  formatCurrentMessageForModel({ userId, currentUser, safeUserText, hasImage = false, styleOverride = "" }) {
    const sender = currentUser?.fullName || userId || "当前飞书用户";
    const longFormFormatting = looksLikeLongFormReadingRequest(safeUserText)
      ? [
          "",
          "[飞书文字排版要求]",
          "用户在让你阅读、学习、总结或整理内容。请输出适合飞书聊天气泡阅读的精华版，不要写 Markdown 源码。",
          "不要使用 #、##、**、```、表格，也不要写“联网资料卡”“搜索结果”“链接失效”“Wiki token”“没找到公开摘要”这类内部过程说明。",
          "标题直接写成“总体判断”“核心要点”“亮点”“可以打磨的点”“一句话结论”这类短标题，尽量不用表情符号。",
          "每段 1 到 3 行，长句拆短；编号最多 3 到 5 条。信息太多时先压缩表达，不要糊成一整坨。",
          "优先总结当前引用原文和当前能读到的内容；不要把历史资料卡、旧链接、抓取状态当成本次原文。"
        ].join("\n")
      : "";
    return [
      "[当前要回复的飞书消息]",
      `发送者: ${sender}`,
      `内容: ${safeUserText || (hasImage ? "用户发送了一张图片。" : "")}`,
      styleOverride ? `\n[当前消息的风格要求]\n${styleOverride}` : "",
      longFormFormatting,
      "",
      "请只回答上面这条当前消息。前面的群聊历史只能用于理解上下文，不要去回答历史里的其他人，也不要接着上一条已经过去的话题聊。"
    ].filter(Boolean).join("\n");
  }

  async updateMemoryAndSummary({ chatId, userId, userText, assistantText, currentUser, skipMemoryExtraction = false }) {
    try {
      if (!skipMemoryExtraction) {
        const existingMemories = await this.storage.getMemories(chatId, userId, this.config.memoryLimit);
        const extracted = await this.ai.extractMemories({
          userText,
          assistantText,
          existingMemories,
          userProfile: currentUser
        });
        if (extracted.length > 0) {
          await this.storage.upsertMemories(chatId, userId, extracted);
        }
      }

      const userCount = await this.storage.countMessages(chatId, userId);
      if (userCount > 0 && userCount % 20 === 0) {
        const summary = await this.storage.getSummary(chatId, userId);
        const recentMessages = await this.storage.getRecentMessages(chatId, 40, userId);
        const newSummary = await this.ai.summarizeConversation({
          summary,
          recentMessages: recentMessages.map((item) => ({ ...item, content: this.formatMessageForModel(item) })),
          userProfile: currentUser
        });
        await this.storage.setSummary(chatId, newSummary, userId);
      }
    } catch (error) {
      console.error("Feishu memory update failed:", error.message);
    }
  }

  scheduleMemoryUpdate(args) {
    this.updateMemoryAndSummary(args).catch((error) => {
      console.error("Feishu memory background update failed:", error.message);
    });
  }
}
