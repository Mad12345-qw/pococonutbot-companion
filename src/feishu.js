import crypto from "node:crypto";
import { extractImageGenerationIntent } from "./image-intent.js";
import { buildSystemPrompt } from "./persona.js";
import { FeishuWorkspaceClient } from "./feishu-workspace.js";
import { isProjectCreateRequest, ProjectEngine } from "./project-engine.js";
import { logEvent } from "./runtime-log.js";
import { convertWavToOpus } from "./tts-client.js";
import { detectImageMimeType, redactSensitive, splitChatBubbles, stripLeadingSelfName, truncate } from "./utils.js";

const imageNounPattern = /(图|图片|图像|配图|攻略图|信息图|流程图|海报|封面|头像|壁纸|插画|漫画|表情包|infographic|poster|cover|wallpaper)$/i;

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

export class FeishuBot {
  constructor({ config, storage, ai, imageGenerator, speechToText, textToSpeech }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.speechToText = speechToText;
    this.textToSpeech = textToSpeech;
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
    if (!["text", "audio", "image"].includes(message.message_type)) return;

    const content = parseContent(message.content);
    const audioMessage = message.message_type === "audio";
    const imageMessage = message.message_type === "image";
    const rawText = audioMessage
      ? await this.transcribeAudioMessage(message, content)
      : imageMessage
        ? stripAtTags(content.text || content.caption || "请看这张图片并自然回复。")
        : stripAtTags(content.text || "");
    if (!rawText) return;

    const chatType = message.chat_type || "";
    const mentionInfo = this.getMentionInfo(message, content.text || rawText);
    const replyToBot = this.isReplyToBotMessage(message);
    const text = this.stripBotName(rawText);
    const projectRequest = isProjectCreateRequest(text);
    const explicitReply =
      chatType === "p2p" ||
      mentionInfo.botMentioned ||
      replyToBot ||
      this.isExplicitCommand(text) ||
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
      reply = await this.generateReply({ chatId, userId, safeUserText, currentUser, imageDataUrl });
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
        throw error;
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
    const sentAsSpeech = await this.replySpeech(message.message_id, safeReply);
    if (!sentAsSpeech) {
      for (const chunk of splitChatBubbles(safeReply, 1800)) {
        await this.replyText(message.message_id, chunk);
      }
    }

    if (this.config.autoMemory) {
      await this.updateMemoryAndSummary({ chatId, userId, userText: storedUserText, assistantText: reply, currentUser });
    }
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
    const mentionNames = mentions
      .map((item) => String(item.name || item.text || "").replace(/^@/, "").trim())
      .filter(Boolean);
    const textValue = String(text || "");
    const hasMentionTag = /<at\b/i.test(textValue);
    const hasMentions = mentions.length > 0 || hasMentionTag;
    const botMentionedByField = mentionNames.some((name) => botNames.some((botName) => name === botName));
    const botMentionedByText = botNames.some((botName) => botName && textValue.includes(botName));
    const botMentioned = botMentionedByField || botMentionedByText;
    return {
      hasMentions,
      mentionNames,
      botMentioned,
      mentionedOtherOnly: hasMentions && !botMentioned
    };
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
    if (/^\/(?:ai|ask|love)\b/i.test(value)) return true;
    return this.getBotMentionNames().some((name) => value.toLowerCase().startsWith(name.toLowerCase()));
  }

  stripBotName(text = "") {
    const names = [this.config.feishuBotName, this.config.displayName, "小椰"].filter(Boolean)
      .map((item) => String(item).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let output = String(text || "").trim();
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

  async generateReply({ chatId, userId, safeUserText, currentUser, imageDataUrl = "" }) {
    const memories = await this.storage.getMemories(chatId, userId, this.config.memoryLimit);
    const modeOverride = memories.find((item) => item.key === "relationship.persona")?.value;
    const summary = await this.storage.getSummary(chatId, "");
    const userSummary = await this.storage.getSummary(chatId, userId);
    const recentMessages = await this.storage.getRecentMessages(chatId, this.config.recentMessageLimit);
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
      ...recentMessages.map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: this.formatMessageForModel(item)
      }))
    ];

    if (imageDataUrl) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: this.buildImageUnderstandingPrompt(safeUserText, "请看这张图片并自然回复。") },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      });
    }

    return this.ai.chat(messages, {
      maxTokens: this.config.aiReplyMaxTokens,
      requirePrimary: Boolean(imageDataUrl)
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

  cleanAssistantReply(text = "") {
    return stripLeadingSelfName(text, [this.config.displayName, this.config.feishuBotName, "小椰"]);
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
      const response = await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "audio",
        content: JSON.stringify({
          file_key: fileKey,
          duration: speech.durationMs
        })
      });
      this.rememberBotMessage(response);
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

  async updateMemoryAndSummary({ chatId, userId, userText, assistantText, currentUser }) {
    try {
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
