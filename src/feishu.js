import crypto from "node:crypto";
import { buildSystemPrompt } from "./persona.js";
import { logEvent } from "./runtime-log.js";
import { redactSensitive, splitTelegramMessage, truncate } from "./utils.js";

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

export class FeishuBot {
  constructor({ config, storage, ai, imageGenerator }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.chatQueues = new Map();
    this.seenMessageIds = new Set();
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
    if (message.message_type !== "text") return;

    const content = parseContent(message.content);
    const rawText = stripAtTags(content.text || "");
    if (!rawText) return;

    const chatType = message.chat_type || "";
    const mentioned = this.isMentioned(message, content.text || rawText);
    const text = this.stripBotName(rawText);
    const explicitReply = chatType === "p2p" || mentioned || this.isExplicitCommand(text) || this.config.triggerMode === "all";
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

    await this.upsertUserProfileMemory(chatId, userId, currentUser);
    await this.storage.addMessage({
      chatId,
      userId,
      role: "user",
      modality: "text",
      content: safeUserText,
      metadata: {
        platform: "feishu",
        messageId: message.message_id || "",
        chatType,
        rawChatId: message.chat_id || "",
        rawUserId: senderId || ""
      }
    });

    if (shouldTryFallbackImagePrompt(safeUserText)) {
      await this.handleImageRequest({ messageId: message.message_id, chatId, userId, text: safeUserText });
      return;
    }

    if (smartCandidate) {
      const shouldReply = await this.shouldReplyToSmartCandidate({ chatId, safeUserText });
      if (!shouldReply) return;
    }

    const reply = await this.generateReply({ chatId, userId, safeUserText, currentUser });
    await this.storage.addMessage({
      chatId,
      userId,
      role: "assistant",
      modality: "text",
      content: redactSensitive(reply),
      metadata: { platform: "feishu", replyToUserId: userId }
    });

    for (const chunk of splitTelegramMessage(reply, 1800)) {
      await this.replyText(message.message_id, chunk);
    }

    if (this.config.autoMemory) {
      await this.updateMemoryAndSummary({ chatId, userId, userText: safeUserText, assistantText: reply, currentUser });
    }
  }

  isMentioned(message, text = "") {
    const mentions = message.mentions || [];
    const names = new Set([this.config.feishuBotName, this.config.displayName, "小椰"].filter(Boolean));
    return mentions.some((item) => names.has(item.name)) ||
      [...names].some((name) => String(text).includes(name));
  }

  isExplicitCommand(text = "") {
    return /^(\/ai|\/ask|\/love|小椰|你|请|帮我|麻烦你)/i.test(String(text || "").trim());
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

  async shouldReplyToSmartCandidate({ chatId, safeUserText }) {
    const fastDecision = this.getFastSmartDecision(safeUserText);
    if (fastDecision === "skip") return false;
    if (fastDecision === "reply") return true;

    if (fastDecision === "ask-ai" && this.config.smartClassifierEnabled) {
      const recentForDecision = await this.storage.getRecentMessages(chatId, 8);
      return this.ai.shouldReplyInGroup({
        messageText: safeUserText,
        recentMessages: recentForDecision.map((item) => ({
          ...item,
          content: this.formatMessageForModel(item)
        })),
        botName: this.config.displayName,
        hasImage: false,
        platform: "Feishu group"
      });
    }

    return false;
  }

  getFastSmartDecision(text = "") {
    const raw = String(text || "").trim();
    const normalized = raw.toLowerCase();

    if (!raw || raw.length <= 2) {
      return "skip";
    }

    if (/^(ok|okay|yes|no|收到|好的|嗯|嗯嗯|哈哈|哈哈哈|hhh|lol|thanks|谢谢|谢了|可以|行|👍|👌)$/i.test(raw)) {
      return "skip";
    }

    if (/[?？]$/.test(raw)) {
      return "reply";
    }

    const requestPattern = /(帮我|帮忙|看看|看一下|解释|总结|翻译|建议|推荐|分析|判断|评价|改写|起草|写一|列一|怎么|如何|能不能|可不可以|要不要|有没有|为什么|是什么|多少|哪里|哪个|谁|啥|吗|呢)/i;
    if (requestPattern.test(raw)) {
      return "reply";
    }

    const botTerms = ["ai", "机器人", "助手", this.config.feishuBotName, this.config.displayName, "小椰"]
      .filter(Boolean)
      .map((item) => String(item).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (botTerms.length && new RegExp(`(${botTerms.join("|")})`, "i").test(normalized)) {
      return "reply";
    }

    const emotionPattern = /(难过|崩溃|焦虑|失眠|好累|压力|烦死|不开心|想哭|害怕|孤独|emo|抑郁|生气|委屈)/i;
    if (emotionPattern.test(raw)) {
      return "reply";
    }

    return "ask-ai";
  }

  async generateReply({ chatId, userId, safeUserText, currentUser }) {
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

    return this.ai.chat(
      [
        { role: "system", content: systemPrompt },
        ...recentMessages.map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: this.formatMessageForModel(item)
        }))
      ],
      { maxTokens: this.config.aiReplyMaxTokens }
    );
  }

  async handleImageRequest({ messageId, chatId, userId, text }) {
    if (!this.imageGenerator?.enabled) {
      await this.replyText(messageId, "生图接口还没配置好。");
      return;
    }

    try {
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
    await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "text",
      content: JSON.stringify({ text: String(text || "") })
    });
  }

  async replyImage(messageId, imageKey) {
    if (!messageId || !imageKey) return;
    await this.feishuPost(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey })
    });
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
