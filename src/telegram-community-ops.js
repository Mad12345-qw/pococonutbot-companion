import { logEvent } from "./runtime-log.js";
import { parseJsonObject, truncate } from "./utils.js";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function stableIndex(value = "", size = 1) {
  if (size <= 1) return 0;
  let hash = 0;
  for (const char of String(value || "")) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  return hash % size;
}

function cleanPlainText(value = "") {
  return String(value || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1：$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedName(value = "") {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function telegramCommunityNickname(user = {}) {
  const firstName = normalizedName(user.first_name || user.firstName || "");
  if (!firstName || firstName.length > 24) return "";
  if (/https?:\/\/|t\.me\/|@|[_=+\\/|<>\[\]{}]/i.test(firstName)) return "";
  if (/\d/.test(firstName)) return "";

  if (/^[\u4e00-\u9fff]{1,6}$/.test(firstName)) {
    return firstName.length <= 2 ? firstName : firstName.slice(-2);
  }

  const firstToken = firstName.split(" ")[0] || "";
  if (/^[A-Za-z][A-Za-z'.-]{1,15}$/.test(firstToken)) return firstToken;
  return "";
}

export function telegramCommunitySlot(date = new Date(), forced = "") {
  const slots = {
    morning: { key: "morning", label: "早间", focus: "模型发布、能力更新和官方公告" },
    noon: { key: "noon", label: "午间", focus: "API、token 价格、限额和调用稳定性" },
    evening: { key: "evening", label: "晚间", focus: "开源模型、推理成本和生态变化" }
  };
  const forcedKey = String(forced || "").trim().toLowerCase();
  if (slots[forcedKey]) return slots[forcedKey];

  const hourPart = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    hour: "2-digit",
    hour12: false
  }).formatToParts(date).find((part) => part.type === "hour");
  const hour = Number(hourPart?.value || 0);
  if (hour >= 8 && hour < 11) return slots.morning;
  if (hour >= 12 && hour < 15) return slots.noon;
  if (hour >= 18 && hour < 22) return slots.evening;
  return null;
}

export function shouldTelegramCommunityAutoAnswer({ text = "", botUsername = "", isTargetChat = false } = {}) {
  if (!isTargetChat) return false;
  const raw = String(text || "").trim();
  if (!raw || raw.length < 3 || raw.length > 2500) return false;
  if (/^(?:ok|okay|好的|收到|谢谢|哈哈+|hhh+|lol|赞|可以|行)[.!！。\s]*$/i.test(raw)) return false;

  const botMention = botUsername ? `@${String(botUsername).replace(/^@/, "").toLowerCase()}` : "";
  const mentions = raw.toLowerCase().match(/@[a-z0-9_]{3,}/g) || [];
  if (mentions.some((mention) => mention !== botMention)) return false;

  const explicitQuestion = /[?？]/.test(raw);
  const naturalQuestion = /(怎么|怎样|如何|为什么|为何|能不能|可不可以|是否|有没有|哪个|哪家|多少|哪里|谁知道|求助|怎么办|是什么|什么意思|靠谱吗|稳定吗|推荐吗|支持吗|报错|失败了)/i.test(raw);
  return explicitQuestion || naturalQuestion;
}

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function authorityRank(result = {}) {
  const rawUrl = String(result.url || "");
  const label = `${result.siteName || ""} ${result.title || ""}`.toLowerCase();
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return 0;
  }

  const officialHosts = [
    "openai.com", "anthropic.com", "deepmind.google", "ai.google.dev", "developers.googleblog.com",
    "blog.google", "meta.com", "ai.meta.com", "x.ai", "docs.x.ai", "mistral.ai", "cohere.com",
    "qwenlm.github.io", "alibabacloud.com", "deepseek.com", "api-docs.deepseek.com", "moonshot.cn",
    "zhipuai.cn", "bigmodel.cn", "huggingface.co", "github.com", "nvidia.com"
  ];
  if (officialHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) return 3;

  const newsHosts = [
    "reuters.com", "bloomberg.com", "ft.com", "wsj.com", "theverge.com", "techcrunch.com",
    "arstechnica.com", "venturebeat.com", "semianalysis.com", "wired.com", "cnbc.com", "scmp.com",
    "eeo.com.cn", "36kr.com", "jiqizhixin.com", "qbitai.com", "ithome.com", "donews.com",
    "tech.ifeng.com", "news.qq.com", "caixin.com", "news.cn"
  ];
  if (newsHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) return 2;
  if (/openai|anthropic|google|deepmind|meta ai|xai|qwen|deepseek|mistral|reuters|bloomberg/.test(label)) return 1;
  return 0;
}

function normalizeNewsResult(result = {}, queryLabel = "") {
  const title = String(result.title || result.name || "").replace(/\s+/g, " ").trim();
  const summary = String(result.summary || result.snippet || result.description || "").replace(/\s+/g, " ").trim();
  const url = String(result.url || result.link || "").trim();
  if (!title || !url || !summary) return null;
  const normalized = {
    queryLabel,
    title: truncate(title, 180),
    summary: truncate(summary, 520),
    url,
    siteName: truncate(result.siteName || result.site_name || result.displayUrl || "", 100),
    publishedAt: truncate(result.publishedAt || result.datePublished || result.date || "", 80)
  };
  const publishedTimestamp = Date.parse(normalized.publishedAt);
  normalized.publishedTimestamp = Number.isFinite(publishedTimestamp) ? publishedTimestamp : 0;
  normalized.authorityRank = authorityRank(normalized);
  return normalized.authorityRank > 0 ? normalized : null;
}

export class TelegramCommunityOps {
  constructor({ config, storage, ai, webSearch, bot, sendVoiceBubble = null }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.webSearch = webSearch;
    this.bot = bot;
    this.sendVoiceBubble = sendVoiceBubble;
    this.botInfo = null;
    this.chatIdSet = new Set((config.telegramCommunityOpsChatIds || []).map(String).filter(Boolean));
    this.verifiedChatIds = new Set();
    this.activityWrites = new Map();
  }

  get enabled() {
    return Boolean(this.config.telegramCommunityOpsEnabled && this.chatIdSet.size > 0);
  }

  isTargetChat(chatId = "") {
    return this.enabled && this.chatIdSet.has(String(chatId || ""));
  }

  isTechnicalConversation(text = "") {
    return /(api|token|key|密钥|模型|gpt|claude|gemini|grok|deepseek|qwen|kimi|glm|llama|mistral|openai|anthropic|接口|额度|价格|计费|上下文|参数|代码|报错|错误|429|限流|超时|中转|base\s*url|endpoint|兼容|部署|配置|充值|调用|推理|benchmark)/i.test(String(text || ""));
  }

  prefersVoiceReply(text = "") {
    const raw = String(text || "").trim();
    if (!this.enabled || !raw) return false;
    if (/(文字回复|打字回复|只发文字|不要语音|别发语音|text only)/i.test(raw)) return false;
    if (/(语音回复|用语音|发语音|念一下|说给我听)/i.test(raw)) return true;
    return !this.isTechnicalConversation(raw);
  }

  answerSystemPrompt({ voiceReply = false } = {}) {
    const common = [
      "当前对话发生在 Telegram 群 MaD API，这是一个全球 AI 大模型、API 和 token 使用交流群。",
      "涉及价格、额度、模型版本、服务状态或近期变化时，明确区分已知事实与不确定信息，不要编造实时数据。",
      "不要索取或复述任何完整 API key、token、密码或账号秘密；发现敏感信息时提醒立即撤回并轮换。",
      "不要使用 Markdown 粗体符号、表格、过程话或正式公文腔。"
    ];
    if (voiceReply) {
      common.push("这是群里的轻松闲聊，回复会被转换成语音气泡。像真实群友一样自然接话，控制在一到三句，不要播音腔，不要每次都重复介绍群主题。");
    } else {
      common.push("这是模型、API 或 token 相关技术交流。先给结论，再给必要步骤或判断依据，回复保持简洁、友好、可复制操作。");
    }
    return common.join("\n");
  }

  shouldAutoAnswer(msg = {}, text = "") {
    return shouldTelegramCommunityAutoAnswer({
      text,
      botUsername: this.botInfo?.username || "",
      isTargetChat: this.isTargetChat(msg.chat?.id)
    });
  }

  async start(botInfo = null) {
    this.botInfo = botInfo || this.botInfo;
    if (!this.enabled) return;

    await this.verifyConfiguredChats().catch((error) => {
      logEvent("warn", "Telegram community ops chat verification failed", { error: error.message });
    });
    const runCheck = () => this.runScheduledCheck().catch((error) => {
      logEvent("warn", "Telegram community ops scheduled check failed", { error: error.message });
    });
    const initialTimer = setTimeout(runCheck, 30 * 1000);
    initialTimer.unref?.();
    const startupWindowTimer = setTimeout(runCheck, 10 * 60 * 1000);
    startupWindowTimer.unref?.();
    const intervalMs = Math.max(5 * 60 * 1000, Number(this.config.telegramCommunityOpsCheckIntervalMs || 30 * 60 * 1000));
    this.scheduler = setInterval(runCheck, intervalMs);
    this.scheduler.unref?.();
  }

  async verifyConfiguredChats() {
    for (const chatId of this.chatIdSet) {
      try {
        const chat = await this.bot.getChat(chatId);
        this.verifiedChatIds.add(chatId);
        const activityKey = this.activityKey(chatId);
        const existingActivity = await this.storage.getSetting(activityKey, "");
        if (!existingActivity) {
          await this.storage.setSetting(activityKey, new Date().toISOString());
        }
        logEvent("info", "Telegram community ops chat verified", {
          chatId,
          title: chat.title || "",
          type: chat.type || "",
          botCanReadAllGroupMessages: Boolean(this.botInfo?.can_read_all_group_messages)
        });
      } catch (error) {
        this.verifiedChatIds.delete(chatId);
        logEvent("warn", "Telegram community ops chat unavailable", { chatId, error: truncate(error.message, 300) });
      }
    }
  }

  activityKey(chatId = "") {
    return `telegram.community_ops.activity.${String(chatId || "")}`;
  }

  stateKey(chatId = "", date = new Date()) {
    return `telegram.community_ops.daily.${String(chatId || "")}.${dateKey(date)}`;
  }

  lockKey(chatId = "", slotKey = "", date = new Date()) {
    return `telegram.community_ops.slot.${String(chatId || "")}.${dateKey(date)}.${slotKey}`;
  }

  async recordActivity(msg = {}, { force = false } = {}) {
    const chatId = String(msg.chat?.id || "");
    if (!this.isTargetChat(chatId)) return;
    const timestamp = Number(msg.date || 0) > 0 ? new Date(Number(msg.date) * 1000) : new Date();
    await this.recordActivityAt(chatId, timestamp, { force });
  }

  async recordActivityAt(chatId = "", timestamp = new Date(), { force = false } = {}) {
    if (!this.isTargetChat(chatId)) return;
    const now = Date.now();
    const lastWrite = Number(this.activityWrites.get(String(chatId)) || 0);
    if (!force && now - lastWrite < 30 * 1000) return;
    this.activityWrites.set(String(chatId), now);
    try {
      await this.storage.setSetting(this.activityKey(chatId), timestamp.toISOString());
    } catch (error) {
      logEvent("warn", "Telegram community activity write failed", { chatId: String(chatId), error: truncate(error.message, 240) });
    }
  }

  async handleNewMembers(msg = {}) {
    const chatId = String(msg.chat?.id || "");
    if (!this.isTargetChat(chatId)) return false;
    const members = (msg.new_chat_members || []).filter((member) => member && !member.is_bot && String(member.id) !== String(this.botInfo?.id || ""));
    if (!members.length) return false;

    for (const member of members.slice(0, 5)) {
      const nickname = telegramCommunityNickname(member);
      const namedTemplates = [
        `哈喽，${nickname}，欢迎来 MaD API。这里主要聊全球大模型、API 和 token 使用，最近在折腾哪个模型，直接抛出来就行。`,
        `欢迎，${nickname}。这里不讲客套，模型效果、接口稳定性、token 成本和踩坑记录都可以直接聊。`,
        `${nickname} 来啦，欢迎。最近在用哪家模型或 API，可以直接说说，群里一起对比。`,
        `嗨，${nickname}，欢迎加入。这里大家会交换模型实测、API 调用和 token 使用经验，有问题直接问。`
      ];
      const anonymousTemplates = [
        "欢迎新朋友加入 MaD API。这里主要聊全球大模型、API 和 token 使用，有问题或实测体验直接发就行。",
        "欢迎新朋友。模型效果、API 稳定性、token 成本和踩坑记录都可以直接聊。",
        "新朋友来啦，欢迎。最近在用什么模型或接口，随时可以丢出来一起对比。"
      ];
      const templates = nickname ? namedTemplates : anonymousTemplates;
      const text = templates[stableIndex(member.id || nickname, templates.length)];
      try {
        const voiceSent = typeof this.sendVoiceBubble === "function"
          ? await this.sendVoiceBubble(chatId, text)
          : false;
        if (!voiceSent) {
          await this.bot.sendMessage(chatId, text, { disable_web_page_preview: true });
        }
        await this.recordActivityAt(chatId, new Date(), { force: true });
        logEvent("info", "Telegram community welcome sent", {
          chatId,
          personalized: Boolean(nickname),
          voiceSent
        });
      } catch (error) {
        logEvent("warn", "Telegram community welcome failed", { chatId, error: truncate(error.message, 300) });
      }
    }
    return true;
  }

  async readState(chatId = "") {
    try {
      const parsed = JSON.parse(await this.storage.getSetting(this.stateKey(chatId), "{}"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async saveState(chatId = "", state = {}) {
    await this.storage.setSetting(this.stateKey(chatId), JSON.stringify({
      sentSlots: Array.isArray(state.sentSlots) ? state.sentSlots.slice(0, 3) : [],
      usedUrls: Array.isArray(state.usedUrls) ? state.usedUrls.slice(-20) : [],
      lastDigest: truncate(state.lastDigest || "", 300),
      lastQuestion: truncate(state.lastQuestion || "", 240),
      lastSentAt: state.lastSentAt || ""
    }));
  }

  async isQuietEnough(chatId = "") {
    const value = await this.storage.getSetting(this.activityKey(chatId), "");
    if (!value) return true;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return false;
    const quietMinutes = Math.max(5, Number(this.config.telegramCommunityOpsQuietMinutes || 30));
    return Date.now() - timestamp >= quietMinutes * 60 * 1000;
  }

  async reserveSlot(chatId = "", slotKey = "") {
    const key = this.lockKey(chatId, slotKey);
    const token = `reserved:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    if (typeof this.storage.tryCreateSetting !== "function") return { ok: true, key, token };
    return { ok: await this.storage.tryCreateSetting(key, token), key, token };
  }

  async releaseSlot(reservation = {}) {
    if (!reservation.key || typeof this.storage.deleteSettingIfValue !== "function") return;
    await this.storage.deleteSettingIfValue(reservation.key, reservation.token);
  }

  async markSlotSent(reservation = {}) {
    if (!reservation.key) return;
    await this.storage.setSetting(reservation.key, `sent:${new Date().toISOString()}`);
  }

  newsQueries(slot = {}) {
    const today = dateKey();
    return [
      { label: "全球模型", query: `${today} latest OpenAI Anthropic Google Gemini Meta xAI official model release API update` },
      { label: "中国模型", query: `${today} latest Qwen DeepSeek Kimi GLM large model API pricing token update` },
      { label: slot.focus || "模型生态", query: `${today} latest AI model API pricing context window rate limit open source inference cost Reuters Bloomberg` }
    ];
  }

  async collectNews(slot = {}, state = {}) {
    if (!this.webSearch?.enabled) return { items: [], errors: ["web_search_not_configured"] };
    const errors = [];
    const results = await Promise.all(this.newsQueries(slot).map(async (entry) => {
      try {
        const response = await this.webSearch.search(entry.query, {
          freshness: this.config.telegramCommunityOpsFreshness || "oneWeek",
          count: Number(this.config.telegramCommunityOpsSearchCount || 8),
          summary: true
        });
        return (response.results || []).map((item) => normalizeNewsResult(item, entry.label)).filter(Boolean);
      } catch (error) {
        errors.push(`${entry.label}: ${error.message}`);
        return [];
      }
    }));

    const usedUrls = new Set((state.usedUrls || []).map(String));
    const seen = new Set();
    const items = results.flat()
      .sort((a, b) => (b.authorityRank - a.authorityRank) || (b.publishedTimestamp - a.publishedTimestamp))
      .filter((item) => {
        const key = item.url.replace(/[?#].*$/, "").toLowerCase();
        if (!key || seen.has(key) || usedUrls.has(item.url)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 15);
    return { items, errors };
  }

  parseNewsOutput(raw = "", candidateUrls = new Set(), slot = {}) {
    const parsed = parseJsonObject(raw);
    const text = cleanPlainText(parsed?.text || parsed?.content || "");
    const sources = Array.isArray(parsed?.sources) ? uniqueStrings(parsed.sources).filter((url) => candidateUrls.has(url)).slice(0, 3) : [];
    const valid =
      text.startsWith(`小椰模型情报｜${slot.label}`) &&
      /(^|\n)1[.、]/.test(text) && /(^|\n)2[.、]/.test(text) && /(^|\n)3[.、]/.test(text) &&
      !/根据搜索结果|作为AI|我是AI|\*\*|```/i.test(text) &&
      sources.length >= 1;
    if (!valid) return null;
    return {
      text: truncate(text, 1500),
      digest: truncate(parsed?.digest || "", 300),
      question: truncate(parsed?.question || "", 240),
      sources
    };
  }

  buildNewsMessages(slot = {}, state = {}, items = [], strict = false) {
    const compact = items.slice(0, strict ? 8 : 12).map((item) => ({
      category: item.queryLabel,
      title: item.title,
      summary: item.summary,
      source: item.siteName,
      publishedAt: item.publishedAt,
      url: item.url,
      authorityRank: item.authorityRank
    }));
    return [
      {
        role: "system",
        content: [
          "你是小椰，负责运营 Telegram 群 MaD API。群主题是全球 AI 大模型、API 和 token 使用交流。",
          "现在生成一条可直接发送到群里的纯文字模型资讯。只能使用 newsCandidates 中明确提供的事实，不得补写候选外的数字、版本、价格或发布时间。",
          "优先官方来源，其次 Reuters、Bloomberg 等权威媒体。旧消息只能作为避免重复的基线，不能当作今天的新证据。",
          "媒体若使用“消息称、传闻、预计、即将”等措辞，正文必须保留不确定性，不能改写成已经发生的事实。",
          "三条资讯必须分别说明发生了什么、对模型/API/token 用户意味着什么，并保留来源名称、日期和 URL。",
          "不要使用 Markdown 粗体、标题符号、表格、代码块、过程话或 AI 自称。",
          strict ? "严格按要求输出，不要解释输入，不要返回空字段。" : "表达自然、紧凑，像群管理员递来三条真正有用的行业信息。",
          "只返回 JSON 对象：{\"text\":\"...\",\"digest\":\"...\",\"question\":\"...\",\"sources\":[\"候选URL\"]}"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          slot,
          requirements: {
            title: `小椰模型情报｜${slot.label}`,
            maxLength: 1300,
            itemCount: 3,
            itemShape: "编号 + 短标题；发生了什么；为什么值得关注；来源名称、发布日期和原始 URL",
            ending: "最后提出一个与今天三条信息直接相关、适合群友交流的具体问题"
          },
          previousState: {
            lastDigest: state.lastDigest || "",
            lastQuestion: state.lastQuestion || "",
            usedUrls: state.usedUrls || []
          },
          newsCandidates: compact
        })
      }
    ];
  }

  async buildNewsPost(slot = {}, state = {}) {
    const news = await this.collectNews(slot, state);
    if (news.items.length < 3) {
      logEvent("warn", "Telegram community news skipped: insufficient authoritative candidates", {
        slot: slot.key,
        candidates: news.items.length,
        errors: news.errors
      });
      return null;
    }

    const provider = this.ai?.fallbackProvider;
    if (!provider?.apiKey || !provider?.url || !provider?.model) {
      logEvent("warn", "Telegram community news skipped: fallback AI is not configured", { slot: slot.key });
      return null;
    }
    const candidateUrls = new Set(news.items.map((item) => item.url));
    let raw = "";
    let parsed = null;
    try {
      raw = await this.ai.requestChat(provider, this.buildNewsMessages(slot, state, news.items, false), {
        temperature: 0.25,
        maxTokens: 1600,
        timeoutMs: Number(this.config.telegramCommunityOpsAiTimeoutMs || 60000),
        responseFormat: { type: "json_object" },
        retryAttempts: 2
      });
      parsed = this.parseNewsOutput(raw, candidateUrls, slot);
      if (!parsed) {
        logEvent("warn", "Telegram community news retrying strict output contract", {
          slot: slot.key,
          rawTextChars: String(raw || "").length
        });
        raw = await this.ai.requestChat(provider, this.buildNewsMessages(slot, state, news.items, true), {
          temperature: 0.15,
          maxTokens: 1600,
          timeoutMs: Number(this.config.telegramCommunityOpsAiTimeoutMs || 60000),
          responseFormat: { type: "json_object" },
          retryAttempts: 1
        });
        parsed = this.parseNewsOutput(raw, candidateUrls, slot);
      }
    } catch (error) {
      logEvent("warn", "Telegram community news generation failed", { slot: slot.key, error: truncate(error.message, 300) });
      return null;
    }
    if (!parsed) {
      logEvent("warn", "Telegram community news skipped: output failed reader contract", {
        slot: slot.key,
        rawTextChars: String(raw || "").length
      });
      return null;
    }
    return parsed;
  }

  async runScheduledCheck() {
    if (!this.enabled) return;
    const slot = telegramCommunitySlot(new Date(), this.config.telegramCommunityOpsForceSlot || "");
    if (!slot) return;

    for (const chatId of this.chatIdSet) {
      if (!this.verifiedChatIds.has(chatId)) {
        await this.verifyConfiguredChats();
        if (!this.verifiedChatIds.has(chatId)) continue;
      }
      const state = await this.readState(chatId);
      const sentSlots = Array.isArray(state.sentSlots) ? state.sentSlots : [];
      if (sentSlots.includes(slot.key) || sentSlots.length >= 3) continue;
      if (!(await this.isQuietEnough(chatId))) {
        logEvent("info", "Telegram community news deferred during active conversation", { chatId, slot: slot.key });
        continue;
      }

      const reservation = await this.reserveSlot(chatId, slot.key);
      if (!reservation.ok) continue;
      let release = true;
      try {
        const post = await this.buildNewsPost(slot, state);
        if (!post?.text) continue;
        await this.bot.sendMessage(chatId, post.text, { disable_web_page_preview: true });
        const nextState = {
          ...state,
          sentSlots: uniqueStrings([...sentSlots, slot.key]),
          usedUrls: uniqueStrings([...(state.usedUrls || []), ...post.sources]),
          lastDigest: post.digest,
          lastQuestion: post.question,
          lastSentAt: new Date().toISOString()
        };
        await this.saveState(chatId, nextState);
        await this.markSlotSent(reservation);
        await this.recordActivityAt(chatId, new Date(), { force: true });
        release = false;
        logEvent("info", "Telegram community news sent", { chatId, slot: slot.key, sources: post.sources.length });
      } catch (error) {
        logEvent("warn", "Telegram community news send failed", { chatId, slot: slot.key, error: truncate(error.message, 300) });
      } finally {
        if (release) await this.releaseSlot(reservation);
      }
    }
  }
}
