import TelegramBot from "node-telegram-bot-api";
import { buildSystemPrompt, getModeFromText } from "./persona.js";
import { fetchAsBuffer, fetchAsDataUrl, redactSensitive, splitTelegramMessage, truncate } from "./utils.js";

const triggerCommands = ["/ai", "/ask", "/love", "/伴侣"];
const imageGenerationCommands = ["/draw", "/image", "/imagine", "/生图", "/画图"];

export class TelegramCompanionBot {
  constructor({ config, storage, ai, imageGenerator }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.botInfo = null;
    this.chatQueues = new Map();
  }

  async start() {
    this.botInfo = await this.bot.getMe();
    this.registerHandlers();
    console.log(`Telegram bot started as @${this.botInfo.username}`);
  }

  registerHandlers() {
    this.bot.onText(/^\/start\b/i, (msg) => this.sendHelp(msg.chat.id, msg.message_id));
    this.bot.onText(/^\/help\b/i, (msg) => this.sendHelp(msg.chat.id, msg.message_id));
    this.bot.onText(/^\/ping\b/i, (msg) => this.bot.sendMessage(msg.chat.id, "在线。", { reply_to_message_id: msg.message_id }));
    this.bot.onText(/^\/memory\b/i, (msg) => this.handleMemoryCommand(msg));
    this.bot.onText(/^\/forget\b/i, (msg) => this.handleForgetCommand(msg));
    this.bot.onText(/^\/persona(?:@\w+)?\s*(.*)$/i, (msg, match) => this.handlePersonaCommand(msg, match?.[1] || ""));

    this.bot.on("message", (msg) => this.enqueueMessage(msg));
    this.bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
  }

  enqueueMessage(msg) {
    const chatId = String(msg?.chat?.id || "unknown");
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.handleMessage(msg))
      .catch((error) => this.handleError(msg, error))
      .finally(() => {
        if (this.chatQueues.get(chatId) === next) {
          this.chatQueues.delete(chatId);
        }
      });
    this.chatQueues.set(chatId, next);
  }

  async sendHelp(chatId, replyTo) {
    const help = [
      `我是 ${this.config.displayName}。`,
      "",
      "私聊里可以直接说话；群聊里用：",
      "/ai 你的问题",
      "/ask 你的问题",
      "或者 @我 再说话。",
      "",
      "我会记住稳定偏好和重要事件：",
      "/memory 查看当前记忆",
      "/forget 清空本群/本私聊记忆",
      "/persona girlfriend | boyfriend | friend | assistant",
      "",
      "文字：支持",
      "图片：支持",
      "生图：/draw 画面描述，或直接说“画图/生图/生成图片 ...”",
      "语音：会交给主模型尝试听懂；失败时会提示"
    ].join("\n");

    await this.bot.sendMessage(chatId, help, { reply_to_message_id: replyTo });
  }

  async handleMemoryCommand(msg) {
    if (!this.isAllowedChat(msg.chat.id)) return;
    const memories = await this.storage.getMemories(msg.chat.id, msg.from?.id, this.config.memoryLimit);
    const summary = await this.storage.getSummary(msg.chat.id, "");
    const userSummary = await this.storage.getSummary(msg.chat.id, msg.from?.id);
    const lines = [
      "当前记忆：",
      memories.length
        ? memories.map((item) => `- ${item.user_id ? "个人" : "公共"} / ${item.key}: ${item.value}`).join("\n")
        : "暂无长期记忆。",
      "",
      "个人摘要：",
      userSummary || "暂无个人摘要。",
      "",
      "公共摘要：",
      summary || "暂无公共摘要。"
    ];
    await this.bot.sendMessage(msg.chat.id, lines.join("\n"), { reply_to_message_id: msg.message_id });
  }

  async handleForgetCommand(msg) {
    if (!this.isAllowedChat(msg.chat.id)) return;
    if (!this.isPrivileged(msg)) {
      await this.bot.sendMessage(msg.chat.id, "这个命令只允许主人使用。", { reply_to_message_id: msg.message_id });
      return;
    }
    await this.storage.clearChat(msg.chat.id);
    await this.bot.sendMessage(msg.chat.id, "已清空这个聊天的记忆和摘要。", { reply_to_message_id: msg.message_id });
  }

  async handlePersonaCommand(msg, modeText) {
    if (!this.isAllowedChat(msg.chat.id)) return;
    if (!this.isPrivileged(msg)) {
      await this.bot.sendMessage(msg.chat.id, "这个命令只允许主人使用。", { reply_to_message_id: msg.message_id });
      return;
    }

    const mode = getModeFromText(modeText);
    if (!mode) {
      await this.bot.sendMessage(msg.chat.id, "可选：girlfriend、boyfriend、friend、assistant。", {
        reply_to_message_id: msg.message_id
      });
      return;
    }

    await this.storage.upsertMemories(msg.chat.id, "", [
      { key: "relationship.persona", value: mode, importance: 5 }
    ]);
    await this.bot.sendMessage(msg.chat.id, `已切换人格：${mode}`, { reply_to_message_id: msg.message_id });
  }

  async handleMessage(msg) {
    if (!msg || msg.from?.is_bot) return;
    if (!this.isAllowedChat(msg.chat.id)) return;
    if (this.isCommandOnly(msg)) return;

    const prepared = await this.prepareIncoming(msg);
    if (!prepared.shouldProcess) return;

    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || "");
    const currentUser = this.describeTelegramUser(msg.from);
    const safeUserText = redactSensitive(prepared.text);

    await this.upsertUserProfileMemory(chatId, userId, currentUser);

    await this.storage.addMessage({
      chatId,
      userId,
      role: "user",
      modality: prepared.modality,
      content: safeUserText,
      metadata: {
        username: msg.from?.username || "",
        firstName: msg.from?.first_name || "",
        lastName: msg.from?.last_name || "",
        fullName: currentUser.fullName || "",
        hasImage: prepared.imageUrls.length > 0
      }
    });

    const imagePrompt = this.extractImageGenerationPrompt(safeUserText);
    if (imagePrompt.requested) {
      await this.handleImageGenerationRequest({
        msg,
        chatId,
        userId,
        prompt: imagePrompt.prompt
      });
      return;
    }

    if (prepared.smartCandidate) {
      const fastDecision = this.getFastSmartDecision(prepared, safeUserText);
      let shouldReply = fastDecision === "reply";

      if (fastDecision === "skip") {
        return;
      }

      if (fastDecision === "ask-ai" && this.config.smartClassifierEnabled) {
        const recentForDecision = await this.storage.getRecentMessages(chatId, 8);
        shouldReply = await this.ai.shouldReplyInGroup({
          messageText: safeUserText,
          recentMessages: recentForDecision.map((item) => ({
            ...item,
            content: this.formatMessageForModel(item)
          })),
          botName: this.config.displayName,
          hasImage: prepared.imageUrls.length > 0
        });
      }

      if (!shouldReply) return;
    } else if (!prepared.shouldReply) {
      return;
    }

    if (prepared.modality === "voice" && !prepared.audio) {
      prepared.audio = await this.downloadAudioFromMessage(msg);
    }

    await this.bot.sendChatAction(msg.chat.id, "typing");

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

    if (prepared.imageUrls.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: safeUserText || "请看这张图片并自然回应。" },
          ...prepared.imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))
        ]
      });
    }

    if (prepared.audio) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: safeUserText || "请先听懂这段语音，再自然回复当前发言人。" },
          {
            type: "input_audio",
            input_audio: {
              data: prepared.audio.buffer.toString("base64"),
              format: prepared.audio.format
            }
          }
        ]
      });
    }

    let reply;
    try {
      reply = await this.ai.chat(messages, { maxTokens: this.config.aiReplyMaxTokens });
    } catch (error) {
      if (prepared.audio) {
        reply = [
          "语音这次没有识别成功。",
          "我已经把语音交给主模型尝试处理；如果持续失败，说明当前代理模型不接受 Telegram 的语音格式，需要再接专门的 STT 服务。",
          `错误摘要：${truncate(error.message, 500)}`
        ].join("\n");
      } else if (prepared.imageUrls.length > 0) {
        reply = [
          "我收到图片了，但当前主模型接口不接受图片输入，所以这次没法读图。",
          "这不是你发错了，是模型代理没有开放 image_url 识图能力。要真正识图，需要再接一个支持视觉输入的模型接口。",
          `错误摘要：${truncate(error.message, 500)}`
        ].join("\n");
      } else {
        throw error;
      }
    }

    const safeReply = redactSensitive(reply);
    await this.storage.addMessage({
      chatId,
      userId,
      role: "assistant",
      modality: "text",
      content: safeReply,
      metadata: { replyToUserId: userId }
    });

    for (const chunk of splitTelegramMessage(safeReply, this.config.maxReplyChars)) {
      await this.bot.sendMessage(msg.chat.id, chunk, { reply_to_message_id: msg.message_id });
    }

    if (this.config.autoMemory) {
      await this.updateMemoryAndSummary({ chatId, userId, userText: safeUserText, assistantText: safeReply, currentUser });
    }
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

      const chatCount = await this.storage.countMessages(chatId);
      if (chatCount > 0 && chatCount % 60 === 0) {
        const summary = await this.storage.getSummary(chatId, "");
        const recentMessages = await this.storage.getRecentMessages(chatId, 60);
        const newSummary = await this.ai.summarizeConversation({
          summary,
          recentMessages: recentMessages.map((item) => ({ ...item, content: this.formatMessageForModel(item) }))
        });
        await this.storage.setSummary(chatId, newSummary, "");
      }
    } catch (error) {
      console.error("Memory update failed:", error.message);
    }
  }

  async handleImageGenerationRequest({ msg, chatId, userId, prompt }) {
    if (!prompt) {
      await this.bot.sendMessage(msg.chat.id, "把想画的内容发给我，例如：/draw 一只穿宇航服的猫，电影海报风格。", {
        reply_to_message_id: msg.message_id
      });
      return;
    }

    if (!this.imageGenerator?.enabled) {
      await this.bot.sendMessage(msg.chat.id, "生图接口还没配置好。", {
        reply_to_message_id: msg.message_id
      });
      return;
    }

    await this.bot.sendChatAction(msg.chat.id, "upload_photo");

    try {
      const image = await this.imageGenerator.generate(prompt);
      const caption = `画好了：${truncate(prompt, 900)}`;
      await this.bot.sendPhoto(
        msg.chat.id,
        image.buffer,
        {
          caption,
          reply_to_message_id: msg.message_id
        },
        {
          filename: this.generatedImageFileName(image.mimeType),
          contentType: image.mimeType
        }
      );

      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: `已生成图片：${truncate(prompt, 1000)}`,
        metadata: { replyToUserId: userId }
      });
    } catch (error) {
      const message = `这次生图失败了：${truncate(error.message, 600)}`;
      await this.bot.sendMessage(msg.chat.id, message, { reply_to_message_id: msg.message_id });
      await this.storage.addMessage({
        chatId,
        userId,
        role: "assistant",
        modality: "text",
        content: message,
        metadata: { replyToUserId: userId }
      });
    }
  }

  extractImageGenerationPrompt(text = "") {
    const raw = String(text || "").trim();
    if (!raw) return { requested: false, prompt: "" };

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const username = this.botInfo?.username || "\\w+";
    for (const command of imageGenerationCommands) {
      const commandPattern = new RegExp(`^${escapeRegExp(command)}(?:@${username})?\\s*(.*)$`, "i");
      const match = raw.match(commandPattern);
      if (match) {
        return { requested: true, prompt: this.cleanImagePrompt(match[1] || "") };
      }
    }

    const naturalPattern = /^(?:请|帮我|麻烦你|给我)?\s*(?:画图|生图|生成图片|生成图像|生成一张图|生成一张图片|画一张|画一个|画个|画|做一张|做一个|做个)\s*[：:，,]?\s*(.*)$/i;
    const naturalMatch = raw.match(naturalPattern);
    if (naturalMatch) {
      return { requested: true, prompt: this.cleanImagePrompt(naturalMatch[1] || "") };
    }

    return { requested: false, prompt: "" };
  }

  cleanImagePrompt(text = "") {
    return String(text || "")
      .replace(/^[:：,，\s]+/, "")
      .trim()
      .slice(0, 3000);
  }

  generatedImageFileName(mimeType = "image/png") {
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "generated.jpg";
    if (mimeType.includes("webp")) return "generated.webp";
    return "generated.png";
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

  async downloadAudioFromMessage(msg) {
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    if (!fileId) return null;

    const telegramUrl = await this.bot.getFileLink(fileId);
    const downloaded = await fetchAsBuffer(telegramUrl, 25 * 1024 * 1024);
    return {
      ...downloaded,
      format: this.audioFormatFromMime(downloaded.contentType, msg.audio?.file_name || "")
    };
  }

  describeTelegramUser(from = {}) {
    const firstName = String(from?.first_name || "").trim();
    const lastName = String(from?.last_name || "").trim();
    const username = String(from?.username || "").trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ") || username || String(from?.id || "");
    return {
      id: String(from?.id || ""),
      username,
      firstName,
      lastName,
      fullName
    };
  }

  async upsertUserProfileMemory(chatId, userId, currentUser) {
    if (!userId || !currentUser?.id) return;

    const desired = [
      { key: "profile.telegram_id", value: currentUser.id, importance: 5 },
      { key: "profile.display_name", value: currentUser.fullName, importance: 4 }
    ];

    if (currentUser.username) {
      desired.push({ key: "profile.telegram_username", value: `@${currentUser.username}`, importance: 4 });
    }

    const existing = await this.storage.getMemories(chatId, userId, Math.max(this.config.memoryLimit, 50));
    const existingForUser = new Map(
      existing
        .filter((item) => String(item.user_id || "") === String(userId))
        .map((item) => [item.key, item.value])
    );
    const changed = desired.filter((item) => item.value && existingForUser.get(item.key) !== item.value);
    if (changed.length > 0) {
      await this.storage.upsertMemories(chatId, userId, changed);
    }
  }

  formatSenderLabel(message) {
    if (message.role === "assistant") return this.config.displayName;
    const metadata = message.metadata || {};
    const fullName = metadata.fullName || [metadata.firstName, metadata.lastName].filter(Boolean).join(" ");
    const username = metadata.username ? `@${metadata.username}` : "";
    const name = [fullName, username].filter(Boolean).join(" ");
    return name || (message.user_id ? `Telegram用户${message.user_id}` : "未知用户");
  }

  formatMessageForModel(message) {
    const label = this.formatSenderLabel(message);
    return `${label}: ${message.content || ""}`;
  }

  getFastSmartDecision(prepared, text = "") {
    const raw = String(text || "").trim();
    const normalized = raw.toLowerCase();

    if (this.extractImageGenerationPrompt(raw).requested) {
      return "reply";
    }

    if (prepared.modality === "voice") {
      return raw ? "reply" : "skip";
    }

    if (prepared.imageUrls.length > 0) {
      return raw && raw !== "请看这张图片并自然回应。" ? "reply" : "skip";
    }

    if (!raw || raw.length <= 2) {
      return "skip";
    }

    if (/^(ok|okay|好|好的|嗯|嗯嗯|收到|已阅|哈哈|hhh|lol|thanks|谢谢|谢了|行|可以|👌|👍)$/i.test(raw)) {
      return "skip";
    }

    if (/[?？]$/.test(raw)) {
      return "reply";
    }

    const requestPattern = /(帮我|帮忙|看看|看一下|解释|总结|翻译|建议|推荐|分析|判断|评价|改写|起草|写一|列一下|怎么办|怎么做|怎么弄|能不能|可不可以|要不要|有没有|为什么|是什么|如何|多少|哪里|哪个|谁|几|吗|呢)/i;
    if (requestPattern.test(raw)) {
      return "reply";
    }

    const escapeRegExp = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const botTerms = ["\\bai\\b", "机器人", "助手"];
    if (this.botInfo?.username) botTerms.push(`@${escapeRegExp(this.botInfo.username)}`);
    if (this.config.displayName) botTerms.push(escapeRegExp(this.config.displayName));
    const botPattern = new RegExp(`(${botTerms.join("|")})`, "i");
    if (botPattern.test(normalized)) {
      return "reply";
    }

    const emotionPattern = /(难过|崩溃|焦虑|失眠|好累|压力|烦死|不开心|想哭|害怕|孤独|emo|抑郁|生气|委屈)/i;
    if (emotionPattern.test(raw)) {
      return "reply";
    }

    return "ask-ai";
  }

  async prepareIncoming(msg) {
    const chatType = msg.chat?.type || "private";
    const isPrivate = chatType === "private";
    const text = msg.text || msg.caption || "";
    const groupDecision = isPrivate
      ? { shouldProcess: true, shouldReply: true, smartCandidate: false }
      : this.getGroupDecision(msg, text);
    const shouldProcess = isPrivate || groupDecision.shouldProcess;

    if (!shouldProcess) {
      return { shouldProcess: false, shouldReply: false, smartCandidate: false, text: "", modality: "text", imageUrls: [] };
    }

    if (msg.voice || msg.audio) {
      const audio = groupDecision.shouldReply || isPrivate
        ? await this.downloadAudioFromMessage(msg)
        : null;

      return {
        shouldProcess: true,
        shouldReply: groupDecision.shouldReply,
        smartCandidate: groupDecision.smartCandidate,
        text: "用户发送了一条语音消息，请听懂后自然回复。",
        modality: "voice",
        imageUrls: [],
        audio
      };
    }

    let cleanText = this.stripTrigger(text).trim();
    const imageUrls = [];

    if (msg.photo?.length) {
      const hasUserText = Boolean(cleanText);
      if (!cleanText) cleanText = "请看这张图片并自然回应。";

      if (groupDecision.shouldReply || isPrivate || (groupDecision.smartCandidate && hasUserText)) {
        const largest = msg.photo[msg.photo.length - 1];
        const telegramUrl = await this.bot.getFileLink(largest.file_id);
        imageUrls.push(await fetchAsDataUrl(telegramUrl));
      }

      return {
        shouldProcess: true,
        shouldReply: groupDecision.shouldReply,
        smartCandidate: groupDecision.smartCandidate,
        text: cleanText,
        modality: "image",
        imageUrls
      };
    }

    if (!cleanText) {
      return {
        shouldProcess: false,
        shouldReply: false,
        smartCandidate: false,
        text: "",
        modality: "text",
        imageUrls: []
      };
    }

    return {
      shouldProcess: true,
      shouldReply: groupDecision.shouldReply,
      smartCandidate: groupDecision.smartCandidate,
      text: cleanText,
      modality: "text",
      imageUrls
    };
  }

  getGroupDecision(msg, text) {
    if (this.config.triggerMode === "all") {
      return { shouldProcess: true, shouldReply: true, smartCandidate: false };
    }

    const username = this.botInfo?.username;
    const lowered = String(text || "").trim().toLowerCase();
    const explicit =
      triggerCommands.some((command) => lowered.startsWith(command)) ||
      imageGenerationCommands.some((command) => lowered.startsWith(command.toLowerCase())) ||
      /^(?:请|帮我|麻烦你|给我)?\s*(?:画图|生图|生成图片|生成图像|生成一张图|生成一张图片|画一张|画一个|画个|做一张|做一个|做个)/i.test(String(text || "").trim()) ||
      (username && lowered.includes(`@${username.toLowerCase()}`)) ||
      (msg.reply_to_message?.from?.id && msg.reply_to_message.from.id === this.botInfo?.id);

    if (explicit) {
      return { shouldProcess: true, shouldReply: true, smartCandidate: false };
    }

    if (this.config.triggerMode === "smart") {
      return { shouldProcess: true, shouldReply: false, smartCandidate: true };
    }

    return { shouldProcess: false, shouldReply: false, smartCandidate: false };
  }

  stripTrigger(text = "") {
    let output = String(text || "");
    const username = this.botInfo?.username;
    for (const command of triggerCommands) {
      const commandPattern = new RegExp(`^${command}(?:@${username || "\\w+"})?\\s*`, "i");
      output = output.replace(commandPattern, "");
    }
    if (username) {
      output = output.replace(new RegExp(`@${username}\\b`, "ig"), "").trim();
    }
    return output;
  }

  isCommandOnly(msg) {
    const text = msg.text || "";
    return /^\/(?:start|help|ping|memory|forget|persona)(?:@\w+)?\b/i.test(text);
  }

  isAllowedChat(chatId) {
    if (this.config.allowedChatIds.length === 0) return true;
    return this.config.allowedChatIds.includes(String(chatId));
  }

  isPrivileged(msg) {
    if (this.config.ownerUserIds.length === 0) return true;
    return this.config.ownerUserIds.includes(String(msg.from?.id || ""));
  }

  async handleError(msg, error) {
    console.error("Message handling error:", error);
    if (!msg?.chat?.id) return;
    const message = `刚刚处理失败了：${truncate(error.message, 700)}`;
    await this.bot.sendMessage(msg.chat.id, message, { reply_to_message_id: msg.message_id });
  }
}
