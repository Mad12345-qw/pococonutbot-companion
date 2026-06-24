import crypto from "node:crypto";
import { extractImageGenerationIntent } from "./image-intent.js";
import { buildSearchCard, buildWorldCupPollResultCard, inferSearchFreshness, searchKindFromText } from "./feishu-card-templates.js";
import { buildPremiumPollCard, buildPremiumSearchCard, renderPremiumSearchCardImage } from "./feishu-premium-card-renderer.js";
import { buildSystemPrompt } from "./persona.js";
import { FeishuWorkspaceClient } from "./feishu-workspace.js";
import { isProjectCreateRequest, ProjectEngine } from "./project-engine.js";
import { logEvent } from "./runtime-log.js";
import { convertAudioToOpus, convertWavToOpus } from "./tts-client.js";
import { detectImageMimeType, getReplyDeliveryPreference, redactSensitive, removeGeneratedSpeechArtifacts, splitChatBubbles, stripLeadingSelfName, truncate } from "./utils.js";

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

function compactLines(lines = []) {
  return lines.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
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
  constructor({ config, storage, ai, imageGenerator, speechToText, textToSpeech, songClient, videoLibrary, webSearch }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.speechToText = speechToText;
    this.textToSpeech = textToSpeech;
    this.songClient = songClient;
    this.videoLibrary = videoLibrary;
    this.webSearch = webSearch;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.chatQueues = new Map();
    this.seenMessageIds = new Set();
    this.sentBotMessageIds = new Map();
    this.workspace = new FeishuWorkspaceClient({
      config,
      getToken: () => this.tenantAccessToken()
    });
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
    const senderIdInfo = event.sender?.sender_id || {};
    const senderId = senderIdInfo.open_id || senderIdInfo.user_id || "";
    const senderIdentityCandidates = this.senderIdentityCandidates(event);
    const chatId = platformId(message.chat_id || message.open_chat_id || senderId);
    const userId = platformId(senderId || "unknown");
    await this.recordPassiveLinkMessage({ chatId, userId, message, content, rawMessageText });

    const chatType = message.chat_type || "";
    const mentionInfo = this.getMentionInfo(message, rawMessageText || content.text || rawText);
    const replyToBot = this.isReplyToBotMessage(message);
    const text = this.stripBotName(rawText);
    const projectRequest = isProjectCreateRequest(text);
    const songRequest = this.extractSongRequest(text);
    const videoRequest = await this.extractVideoRequest(text, chatId);
    const webSearchRequest = this.extractWebSearchRequest(text);
    const selfieRequest = this.extractSelfieGenerationPrompt(text);
    const alwaysReplyUser = await this.isAlwaysReplyUser(senderIdentityCandidates);
    const explicitReply =
      chatType === "p2p" ||
      alwaysReplyUser ||
      mentionInfo.botMentioned ||
      replyToBot ||
      this.isExplicitCommand(text) ||
      webSearchRequest.requested ||
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
    const imageContext = imageMessage
      ? await this.describeIncomingImages({
          chatId,
          userId,
          text: contextualUserText,
          imageDataUrl,
          messageId: message.message_id
        })
      : "";
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
      return;
    }

    if (smartCandidate) {
      const shouldReply = await this.shouldReplyToSmartCandidate({ chatId, safeUserText, hasImage: imageMessage });
      if (!shouldReply) return;
    }

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
        return;
      }
    }

    if (this.config.feishuOutgoingMentionsEnabled && this.hasExplicitMentionDeliveryRequest(safeUserText)) {
      const notice = "我可以帮你 @ 人，但需要你在消息里真的 @ 一下对方，或者先在 Render 配置 FEISHU_MENTION_TARGETS_JSON，把名字和 open_id 对上。";
      await this.replyText(message.message_id, notice);
      return;
    }

    const deliveryPreference = this.resolveReplyDeliveryPreference(safeUserText, { linkContext });
    const sentAsSpeech = deliveryPreference === "text" ? false : await this.replySpeech(message.message_id, safeReply);
    if (!sentAsSpeech) {
      for (const chunk of splitChatBubbles(safeReply, 1800)) {
        await this.replyText(message.message_id, chunk);
      }
    }

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

  isGithubTrendingRequest(text = "") {
    const value = String(text || "");
    return /github/i.test(value) && /(?:热榜|热门|趋势|trending|榜单|排行|仓库|repo|repository|开源项目)/i.test(value);
  }

  pickWebSearchFreshness(text = "") {
    return inferSearchFreshness(text, this.config.bochaSearchFreshness || "noLimit");
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
    if (linkContext && looksLikeLongFormReadingRequest(text)) return "text";
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

    const item = request.item;
    try {
      logEvent("info", "Feishu video request started", {
        chatId,
        userId,
        id: item?.id || "",
        title: item?.title || ""
      });
      let asset = await this.getCachedVideoAsset(item);
      let videoTitle = item?.title || item?.id || "video";
      let videoBytes = 0;
      let cacheHit = Boolean(asset?.fileKey);

      if (!asset?.fileKey) {
        const video = await this.videoLibrary.download(item);
        videoTitle = video.title;
        videoBytes = video.buffer.length;
        const thumbnail = await this.createVideoThumbnail(video);
        const fileKey = await this.uploadVideo(video);
        asset = {
          fileKey,
          imageKey: thumbnail?.imageKey || "",
          title: video.title,
          bytes: video.buffer.length
        };
        await this.setCachedVideoAsset(item, asset);
      }

      let sentType;
      try {
        sentType = await this.replyVideo(messageId, asset.fileKey, asset.imageKey || "");
      } catch (error) {
        if (!cacheHit) throw error;
        logEvent("warn", "Feishu cached video asset failed, reuploading", {
          chatId,
          id: item?.id || "",
          error: error.message
        });
        await this.clearCachedVideoAsset(item);
        const video = await this.videoLibrary.download(item);
        videoTitle = video.title;
        videoBytes = video.buffer.length;
        const thumbnail = await this.createVideoThumbnail(video);
        const fileKey = await this.uploadVideo(video);
        asset = {
          fileKey,
          imageKey: thumbnail?.imageKey || "",
          title: video.title,
          bytes: video.buffer.length
        };
        await this.setCachedVideoAsset(item, asset);
        cacheHit = false;
        sentType = await this.replyVideo(messageId, asset.fileKey, asset.imageKey || "");
      }
      await this.markVideoItemSent(request);
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
    } catch (error) {
      logEvent("error", "Feishu video request failed", {
        chatId,
        id: item?.id || "",
        error: error.message
      });
      const message = this.formatVideoFailureMessage(error);
      await this.replyText(messageId, message);
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

    try {
      const speech = await this.textToSpeech.synthesize(text, {
        voiceId: this.config.feishuTtsVoiceId,
        maxInputChars: this.config.feishuTtsMaxInputChars
      });
      const opus = await convertWavToOpus(speech.buffer, { fileName: "reply.opus" });
      const fileKey = await this.uploadAudio({
        buffer: opus.buffer,
        contentType: opus.contentType,
        fileName: opus.fileName,
        durationMs: speech.durationMs
      });
      await this.replyAudio(messageId, fileKey, speech.durationMs);
      return true;
    } catch (error) {
      logEvent("error", "Feishu text-to-speech reply failed", {
        messageId,
        error: error.message
      });
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
