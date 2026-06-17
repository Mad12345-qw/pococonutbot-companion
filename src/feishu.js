import crypto from "node:crypto";
import { extractImageGenerationIntent } from "./image-intent.js";
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

function parseContent(content = "") {
  if (!content) return {};
  if (typeof content === "object") return content;
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
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

export class FeishuBot {
  constructor({ config, storage, ai, imageGenerator, speechToText, textToSpeech, songClient }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.speechToText = speechToText;
    this.textToSpeech = textToSpeech;
    this.songClient = songClient;
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
    if (!["text", "audio", "image", "post"].includes(message.message_type)) return;

    const content = parseContent(message.content);
    const audioMessage = message.message_type === "audio";
    const imageMessage = message.message_type === "image";
    const postMessage = message.message_type === "post";
    const rawMessageText = postMessage ? flattenPostContent(content) : content.text || "";
    const rawText = audioMessage
      ? await this.transcribeAudioMessage(message, content)
      : imageMessage
        ? stripAtTags(content.text || content.caption || "请看这张图片并自然回复。")
        : postMessage
          ? rawMessageText
          : stripAtTags(content.text || "");
    if (!rawText) return;

    const chatType = message.chat_type || "";
    const mentionInfo = this.getMentionInfo(message, rawMessageText || content.text || rawText);
    const replyToBot = this.isReplyToBotMessage(message);
    const text = this.stripBotName(rawText);
    const projectRequest = isProjectCreateRequest(text);
    const songRequest = this.extractSongRequest(text);
    const selfieRequest = this.extractSelfieGenerationPrompt(text);
    const explicitReply =
      chatType === "p2p" ||
      mentionInfo.botMentioned ||
      replyToBot ||
      this.isExplicitCommand(text) ||
      songRequest.requested ||
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

    const senderId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || "";
    const chatId = platformId(message.chat_id || message.open_chat_id || senderId);
    const userId = platformId(senderId || "unknown");
    const currentUser = {
      id: userId,
      username: "",
      firstName: "",
      lastName: "",
      fullName: event.sender?.sender_id?.union_id || senderId || "飞书用户"
    };
    const safeUserText = redactSensitive(text);
    const imageDataUrl = imageMessage ? await this.downloadImageMessage(message, content) : "";
    if (imageMessage && !imageDataUrl) return;
    const imageContext = imageMessage
      ? await this.describeIncomingImages({
          chatId,
          userId,
          text: safeUserText,
          imageDataUrl,
          messageId: message.message_id
        })
      : "";
    const storedUserText = this.withImageContext(safeUserText, imageContext, "请看这张图片并自然回复。");

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
        hasVoice: audioMessage,
        hasImage: imageMessage,
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

    const imageIntent = extractImageGenerationIntent(safeUserText, {
      botNames: [
        this.config.feishuBotName || "",
        this.config.displayName || "",
        "小椰"
      ]
    });
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
        safeUserText,
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
    const mentionTargets = this.resolveOutgoingMentionTargets(safeUserText, mentionInfo);
    if (mentionTargets.length > 0) {
      await this.replyPostMention(message.message_id, safeReply, mentionTargets);
      if (this.config.autoMemory) {
        await this.updateMemoryAndSummary({
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

    if (this.hasExplicitMentionDeliveryRequest(safeUserText)) {
      const notice = "我可以帮你 @ 人，但需要你在消息里真的 @ 一下对方，或者先在 Render 配置 FEISHU_MENTION_TARGETS_JSON，把名字和 open_id 对上。";
      await this.replyText(message.message_id, notice);
      return;
    }

    const deliveryPreference = getReplyDeliveryPreference(safeUserText);
    const sentAsSpeech = deliveryPreference === "text" ? false : await this.replySpeech(message.message_id, safeReply);
    if (!sentAsSpeech) {
      for (const chunk of splitChatBubbles(safeReply, 1800)) {
        await this.replyText(message.message_id, chunk);
      }
    }

    if (this.config.autoMemory) {
      await this.updateMemoryAndSummary({
        chatId,
        userId,
        userText: storedUserText,
        assistantText: reply,
        currentUser,
        skipMemoryExtraction: this.isTransientStyleRequest(safeUserText) || Boolean(deliveryPreference)
      });
    }
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

  hasMentionRequest(text = "") {
    return /(?:艾特|@|at|AT|叫|喊|cue|通知|提醒|转告|告诉|问问|问下|教下|帮.+?(?:找|叫|喊|问|通知|提醒|告诉))/i.test(String(text || ""));
  }

  hasExplicitMentionDeliveryRequest(text = "") {
    return /(?:艾特|@|at|AT|cue|通知|提醒|转告|告诉|帮.+?(?:叫|喊|通知|提醒|告诉)|(?:叫|喊)(?:一下|下|一声|一哈|一下子))/i.test(String(text || ""));
  }

  extractRequestedMentionName(text = "") {
    const value = String(text || "");
    const match = value.match(/(?:艾特|@|at|AT|叫|喊|cue|通知|提醒|转告|告诉|问问|问下|教下)(?:一下|下|一声|一哈|一下子)?\s*([^\s，,。.!！?？、:：]{1,40})/i);
    if (!match) return "";
    return normalizeMentionName(match[1]);
  }

  resolveOutgoingMentionTargets(text = "", mentionInfo = {}) {
    if (!this.hasMentionRequest(text)) return [];
    const byId = new Map();
    const add = (target) => {
      if (!target || !isValidMentionId(target.id)) return;
      const id = String(target.id).trim();
      if (!byId.has(id)) byId.set(id, { id, name: normalizeMentionName(target.name) || "用户" });
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

  cleanGenericImagePrompt(text = "", fallback = "") {
    const raw = String(text || "").trim();
    return raw === fallback ? "" : raw;
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
    const historyMessages = currentMessageId
      ? recentMessages.filter((item) => String(item.metadata?.messageId || "") !== String(currentMessageId))
      : recentMessages;
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
      return `\u8fd9\u9996\u6b4c\u7684\u97f3\u6e90\u94fe\u63a5\u597d\u50cf\u5931\u6548\u4e86\uff0c\u6211\u521a\u521a\u81ea\u52a8\u6362\u4e86\u51e0\u4e2a\u7ed3\u679c\u4e5f\u6ca1\u62ff\u5230\u53ef\u64ad\u653e\u7248\u672c\u3002\u4f60\u6362\u4e2a\u6b4c\u540d\u6216\u52a0\u4e0a\u6b4c\u624b\u518d\u8bd5\u8bd5\u3002`;
    }
    if (/too large/i.test(detail)) {
      return `\u8fd9\u9996\u6b4c\u6587\u4ef6\u592a\u5927\u4e86\uff0c\u98de\u4e66\u8fd9\u8fb9\u4e0d\u592a\u597d\u53d1\u6210\u8bed\u97f3\u6c14\u6ce1\u3002\u6362\u9996\u77ed\u4e00\u70b9\u7684\u6211\u518d\u8bd5\u8bd5\u3002`;
    }
    return `\u8fd9\u9996\u6b4c\u6682\u65f6\u6ca1\u53d1\u51fa\u6765\uff0c\u6211\u8fd9\u8fb9\u70b9\u6b4c\u63a5\u53e3\u521a\u521a\u6ca1\u62ff\u7a33\u3002\u4f60\u7a0d\u540e\u518d\u8bd5\u4e00\u4e0b\uff0c\u6216\u8005\u6362\u4e2a\u66f4\u660e\u786e\u7684\u6b4c\u540d\u3002`;
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
    return removeGeneratedSpeechArtifacts(stripLeadingSelfName(text, [this.config.displayName, this.config.feishuBotName, "小椰"]));
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
    return [
      "[当前要回复的飞书消息]",
      `发送者: ${sender}`,
      `内容: ${safeUserText || (hasImage ? "用户发送了一张图片。" : "")}`,
      styleOverride ? `\n[当前消息的风格要求]\n${styleOverride}` : "",
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
}
