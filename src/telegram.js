import TelegramBot from "node-telegram-bot-api";
import { extractImageGenerationIntent, imageGenerationCommands } from "./image-intent.js";
import { buildSystemPrompt, getModeFromText } from "./persona.js";
import { logEvent } from "./runtime-log.js";
import { TelegramCommunityOps } from "./telegram-community-ops.js";
import { convertWavToTelegramVoice } from "./tts-client.js";
import { fetchAsBuffer, fetchAsDataUrl, getReplyDeliveryPreference, redactSensitive, removeGeneratedSpeechArtifacts, splitChatBubbles, stripLeadingSelfName, truncate } from "./utils.js";

const triggerCommands = ["/ai", "/ask", "/love", "/伴侣"];
const selfieKeywords = /(自拍|自拍照|照片|相片|发张照|发一张照|发张照片|发一张照片|看看你|你长什么样|你的样子|小椰的样子|小椰照片|小椰自拍)/i;
const imageNounPattern = /(图|图片|图像|配图|攻略图|信息图|流程图|海报|封面|头像|壁纸|插画|漫画|表情包|infographic|poster|cover|wallpaper)$/i;

export class TelegramCompanionBot {
  constructor({ config, storage, ai, imageGenerator, speechToText, textToSpeech, webSearch }) {
    this.config = config;
    this.storage = storage;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.speechToText = speechToText;
    this.textToSpeech = textToSpeech;
    this.webSearch = webSearch;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.botInfo = null;
    this.chatQueues = new Map();
    this.communityOps = new TelegramCommunityOps({
      config,
      storage,
      ai,
      webSearch,
      bot: this.bot,
      sendVoiceBubble: (chatId, text) => this.sendCommunitySpeech(chatId, text)
    });
  }

  async start() {
    this.botInfo = await this.bot.getMe();
    this.communityOps.botInfo = this.botInfo;
    this.registerHandlers();
    await this.communityOps.start(this.botInfo);
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
      "自拍：直接说“小椰发张自拍”或“看看你长什么样”",
      "语音：会先转成文字，再自然回复"
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
    await this.communityOps.recordActivity(msg);
    if (msg?.new_chat_members?.length) {
      await this.communityOps.handleNewMembers(msg);
      return;
    }
    if (!msg || msg.from?.is_bot) return;
    if (!this.isAllowedChat(msg.chat.id)) return;
    if (this.isCommandOnly(msg)) return;

    const prepared = await this.prepareIncoming(msg);
    if (!prepared.shouldProcess) return;

    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || "");
    const currentUser = this.describeTelegramUser(msg.from);

    await this.upsertUserProfileMemory(chatId, userId, currentUser);

    if (prepared.modality === "voice") {
      const initialSafeUserText = redactSensitive(prepared.text);
      if (prepared.smartCandidate) {
        const shouldReply = await this.shouldReplyToSmartCandidate(prepared, initialSafeUserText, chatId);
        if (!shouldReply) return;
        prepared.smartCandidate = false;
        prepared.shouldReply = true;
      } else if (!prepared.shouldReply) {
        return;
      }

      const voiceReady = await this.prepareVoiceForReply(msg, prepared);
      if (!voiceReady) return;
    }

    const safeUserText = redactSensitive(prepared.text);
    const communityVoiceReply = this.communityOps.isTargetChat(chatId) && this.communityOps.prefersVoiceReply(safeUserText);
    const imageContext = prepared.imageUrls.length > 0
      ? await this.describeIncomingImages({
          chatId,
          userId,
          text: safeUserText,
          imageUrls: prepared.imageUrls
        })
      : "";
    const storedUserText = this.withImageContext(safeUserText, imageContext, "请看这张图片并自然回应。");

    await this.storage.addMessage({
      chatId,
      userId,
      role: "user",
      modality: prepared.modality,
      content: storedUserText,
      metadata: {
        username: msg.from?.username || "",
        firstName: msg.from?.first_name || "",
        lastName: msg.from?.last_name || "",
        fullName: currentUser.fullName || "",
        hasImage: prepared.imageUrls.length > 0,
        hasVoice: prepared.modality === "voice",
        transcript: prepared.transcript || "",
        imageContext: imageContext ? truncate(imageContext, 1200) : ""
      }
    });

    const selfiePrompt = this.extractSelfieGenerationPrompt(safeUserText, {
      isPrivate: msg.chat?.type === "private",
      explicit: prepared.shouldReply && !prepared.smartCandidate
    });
    if (selfiePrompt.requested) {
      this.handleImageGenerationRequest({
        msg,
        chatId,
        userId,
        prompt: selfiePrompt.prompt
      }).catch((error) => {
        logEvent("error", "Telegram image background task failed", { chatId, error: error.message });
      });
      return;
    }

    const imagePrompt = this.extractImageGenerationPrompt(safeUserText);
    if (imagePrompt.requested) {
      this.handleImageGenerationRequest({
        msg,
        chatId,
        userId,
        prompt: this.prepareImageGenerationPrompt(imagePrompt.prompt)
      }).catch((error) => {
        logEvent("error", "Telegram image background task failed", { chatId, error: error.message });
      });
      return;
    }

    if (prepared.smartCandidate) {
      const shouldReply = await this.shouldReplyToSmartCandidate(prepared, safeUserText, chatId);
      if (!shouldReply) return;
    } else if (!prepared.shouldReply) {
      return;
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
      ...(this.communityOps.isTargetChat(chatId)
        ? [{ role: "system", content: this.communityOps.answerSystemPrompt({ voiceReply: communityVoiceReply }) }]
        : []),
      ...recentMessages.map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: this.formatMessageForModel(item)
      }))
    ];

    if (prepared.imageUrls.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: this.buildImageUnderstandingPrompt(safeUserText, "请看这张图片并自然回应。") },
          ...prepared.imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))
        ]
      });
    }

    if (prepared.audio && this.config.voiceDirectInputEnabled) {
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
      reply = await this.ai.chat(messages, {
        maxTokens: this.config.aiReplyMaxTokens,
        requirePrimary: Boolean(this.config.imageUnderstandingRequirePrimary && prepared.imageUrls.length > 0)
      });
    } catch (error) {
      if (prepared.audio && this.config.voiceDirectInputEnabled) {
        reply = [
          "语音这次没有识别成功。",
          "我已经把语音交给主模型尝试处理；如果持续失败，说明当前代理模型不接受 Telegram 的语音格式，需要再接专门的 STT 服务。",
          `错误摘要：${truncate(error.message, 500)}`
        ].join("\n");
      } else if (prepared.imageUrls.length > 0) {
        logEvent("error", "Telegram image reply failed", {
          chatId,
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

    const safeReply = this.cleanAssistantReply(redactSensitive(reply));
    await this.storage.addMessage({
      chatId,
      userId,
      role: "assistant",
      modality: "text",
      content: safeReply,
      metadata: { replyToUserId: userId }
    });

    const deliveryPreference = getReplyDeliveryPreference(safeUserText);
    const forceCommunityText = this.communityOps.isTargetChat(chatId);
    const sentAsSpeech = forceCommunityText
      ? (communityVoiceReply ? await this.sendSpeechReply(msg, safeReply) : false)
      : (deliveryPreference === "text" ? false : await this.sendSpeechReply(msg, safeReply));
    if (!sentAsSpeech) {
      for (const chunk of splitChatBubbles(safeReply, this.config.maxReplyChars)) {
        await this.bot.sendMessage(msg.chat.id, chunk, { reply_to_message_id: msg.message_id });
      }
    }
    if (forceCommunityText) {
      await this.communityOps.recordActivityAt(chatId, new Date(), { force: true });
    }

    if (this.config.autoMemory) {
      await this.updateMemoryAndSummary({
        chatId,
        userId,
        userText: storedUserText,
        assistantText: safeReply,
        currentUser,
        skipMemoryExtraction: Boolean(deliveryPreference)
      });
    }
  }

  async describeIncomingImages({ chatId, userId, text, imageUrls }) {
    try {
      logEvent("info", "Telegram image context extraction started", {
        chatId,
        userId,
        imageCount: imageUrls.length
      });
      const description = await this.ai.describeImages({
        userText: this.cleanGenericImagePrompt(text, "请看这张图片并自然回应。"),
        imageUrls,
        platform: "Telegram"
      });
      logEvent("info", "Telegram image context extraction completed", {
        chatId,
        chars: description.length
      });
      return description;
    } catch (error) {
      logEvent("error", "Telegram image context extraction failed", {
        chatId,
        error: error.message
      });
      return "";
    }
  }

  cleanAssistantReply(text = "") {
    return removeGeneratedSpeechArtifacts(stripLeadingSelfName(text, [this.config.displayName, "小椰"]));
  }

  async sendSpeechReply(msg, text) {
    if (!this.textToSpeech?.enabled) return false;

    try {
      await this.bot.sendChatAction(msg.chat.id, "upload_voice");
      const speech = await this.textToSpeech.synthesize(text);
      const mode = String(this.config.ttsTelegramMode || "voice").toLowerCase();

      if (mode === "voice") {
        try {
          const voice = await convertWavToTelegramVoice(speech.buffer);
          await this.bot.sendVoice(
            msg.chat.id,
            voice.buffer,
            { reply_to_message_id: msg.message_id },
            { filename: voice.fileName, contentType: voice.contentType }
          );
          return true;
        } catch (error) {
          logEvent("error", "Telegram sendVoice failed, falling back to sendAudio", {
            chatId: String(msg.chat.id),
            error: error.message
          });
        }
      }

      await this.bot.sendAudio(
        msg.chat.id,
        speech.buffer,
        {
          reply_to_message_id: msg.message_id,
          title: this.config.displayName || "AI reply"
        },
        { filename: speech.fileName, contentType: speech.contentType }
      );
      return true;
    } catch (error) {
      logEvent("error", "Telegram text-to-speech reply failed", {
        chatId: String(msg.chat.id),
        error: error.message
      });
      return false;
    }
  }

  async sendCommunitySpeech(chatId, text) {
    if (!this.textToSpeech?.enabled) return false;
    try {
      await this.bot.sendChatAction(chatId, "upload_voice");
      const speech = await this.textToSpeech.synthesize(text);
      const voice = await convertWavToTelegramVoice(speech.buffer);
      await this.bot.sendVoice(
        chatId,
        voice.buffer,
        {},
        { filename: voice.fileName, contentType: voice.contentType }
      );
      return true;
    } catch (error) {
      logEvent("warn", "Telegram community voice bubble failed", {
        chatId: String(chatId),
        error: truncate(error.message, 300)
      });
      return false;
    }
  }

  cleanGenericImagePrompt(text = "", fallback = "") {
    const raw = String(text || "").trim();
    return raw === fallback ? "" : raw;
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

  buildImageUnderstandingPrompt(text = "", genericText = "") {
    const cleanText = this.cleanGenericImagePrompt(text, genericText);
    return [
      cleanText || "请看这张图片并自然回应。",
      "",
      "这张图可能是截图、聊天记录、榜单或文字清单。请认真读图里的可见文字。",
      "如果文字很多，优先提取标题、项目名、编号、数字、结论和用户最可能继续追问的关键信息。",
      "不要只说“信息量大”“有点看不清”；能看清多少就说多少，遮挡或截断的地方再说明。"
    ].join("\n");
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

    await this.bot.sendMessage(msg.chat.id, "好的，稍等", { reply_to_message_id: msg.message_id });
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
    return extractImageGenerationIntent(text, {
      botNames: [
        this.config.displayName || "",
        "小椰",
        this.botInfo?.username ? `@${this.botInfo.username}` : ""
      ]
    });

    const raw = String(text || "").trim();
    if (!raw) return { requested: false, prompt: "" };
    const normalizedRaw = this.normalizeImageRequestText(raw);

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const username = this.botInfo?.username || "\\w+";
    for (const command of imageGenerationCommands) {
      const commandPattern = new RegExp(`^${escapeRegExp(command)}(?:@${username})?\\s*(.*)$`, "i");
      const match = normalizedRaw.match(commandPattern);
      if (match) {
        return { requested: true, prompt: this.cleanImagePrompt(match[1] || "") };
      }
    }

    const naturalPattern = /^(?:请|帮我|麻烦你|给我)?\s*(?:画图|生图|生成图片|生成图像|生成一张图|生成一张图片|画一张|画一个|画个|画|做一张|做一个|做个)\s*[：:，,]?\s*(.*)$/i;
    const naturalMatch = normalizedRaw.match(naturalPattern);
    if (naturalMatch) {
      return { requested: true, prompt: this.cleanImagePrompt(naturalMatch[1] || "") };
    }

    const trailingImageMatch = normalizedRaw.match(/^(?:请|帮我|麻烦你|给我|你)?\s*(?:生成|做|制作|设计|画|出|来)\s*(?:一张|一个|一份|个|张)?\s*(.+)$/i);
    if (trailingImageMatch) {
      const prompt = this.cleanImagePrompt(trailingImageMatch[1] || "");
      const normalizedPrompt = prompt.replace(/[？?！!。.\s]+$/g, "");
      if (imageNounPattern.test(normalizedPrompt)) {
        return { requested: true, prompt };
      }
    }

    return { requested: false, prompt: "" };
  }

  normalizeImageRequestText(text = "") {
    let output = String(text || "").trim();
    const names = [
      this.config.displayName || "",
      "小椰",
      this.botInfo?.username ? `@${this.botInfo.username}` : ""
    ].filter(Boolean).map((value) => this.escapeRegExp(value));
    if (names.length > 0) {
      output = output.replace(new RegExp(`^(?:${names.join("|")})\\s*[,，:：、]?\\s*`, "i"), "");
    }
    output = output.replace(/^(?:你|妳)\s*/, "");
    return output.trim();
  }

  extractSelfieGenerationPrompt(text = "", options = {}) {
    const raw = String(text || "").trim();
    if (!raw || !selfieKeywords.test(raw)) {
      return { requested: false, prompt: "" };
    }

    const looksLikeRequest = /(发|给我|来|看看|想看|拍|自拍|照片|相片|长什么样|样子)/i.test(raw);
    const namesSelf = new RegExp(`(${this.escapeRegExp(this.config.displayName || "小椰")}|小椰|你|你的)`, "i").test(raw);
    const directSelfie = /(自拍|自拍照)/i.test(raw);
    const canUseDirectSelfie = Boolean(options.isPrivate || options.explicit);
    if (!looksLikeRequest || (!namesSelf && !(directSelfie && canUseDirectSelfie))) {
      return { requested: false, prompt: "" };
    }

    return {
      requested: true,
      prompt: this.buildSelfiePrompt(raw)
    };
  }

  prepareImageGenerationPrompt(prompt = "") {
    const raw = this.cleanImagePrompt(prompt);
    if (!raw) return raw;
    if (!this.isSelfiePrompt(raw)) return raw;
    return this.buildSelfiePrompt(raw);
  }

  isSelfiePrompt(prompt = "") {
    const raw = String(prompt || "");
    const namesSelf = new RegExp(`(${this.escapeRegExp(this.config.displayName || "小椰")}|小椰|你|你的)`, "i").test(raw);
    return namesSelf && selfieKeywords.test(raw);
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

  async prepareVoiceForReply(msg, prepared) {
    if (!prepared.audio) {
      prepared.audio = await this.downloadAudioFromMessage(msg);
    }

    if (!prepared.audio) {
      await this.bot.sendMessage(msg.chat.id, "我收到语音了，但没有拿到可读取的音频文件。你可以再发一次，或者先发文字。", {
        reply_to_message_id: msg.message_id
      });
      return false;
    }

    if (this.speechToText?.enabled) {
      await this.bot.sendChatAction(msg.chat.id, "typing");
      try {
        const transcript = await this.speechToText.transcribe(prepared.audio);
        prepared.transcript = transcript;
        prepared.text = transcript;
        prepared.audio = null;
        return true;
      } catch (error) {
        console.error("Speech-to-text failed:", error.message);
        if (this.config.voiceDirectInputEnabled) return true;

        await this.bot.sendMessage(
          msg.chat.id,
          [
            "我收到语音了，但这次没有转写成功。",
            "现在需要接一个稳定的语音转文字接口，接好后我就能先听懂语音，再正常回复和记忆。",
            `错误摘要：${truncate(error.message, 500)}`
          ].join("\n"),
          { reply_to_message_id: msg.message_id }
        );
        return false;
      }
    }

    if (this.config.voiceDirectInputEnabled) {
      return true;
    }

    await this.bot.sendMessage(
      msg.chat.id,
      [
        "我收到语音了，但现在还没配置语音转文字接口。",
        "主聊天接口目前不能稳定听 Telegram 语音。接上 STT 后，我会先把语音转成文字，再按你的话正常聊天和记忆。"
      ].join("\n"),
      { reply_to_message_id: msg.message_id }
    );
    return false;
  }

  async shouldReplyToSmartCandidate(prepared, safeUserText, chatId) {
    const fastDecision = this.getFastSmartDecision(prepared, safeUserText);
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
        hasImage: prepared.imageUrls.length > 0
      });
    }

    return false;
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
    if (this.communityOps.shouldAutoAnswer(msg, text)) {
      return { shouldProcess: true, shouldReply: true, smartCandidate: false };
    }

    const username = this.botInfo?.username;
    const lowered = String(text || "").trim().toLowerCase();
    const explicit =
      triggerCommands.some((command) => lowered.startsWith(command)) ||
      imageGenerationCommands.some((command) => lowered.startsWith(command.toLowerCase())) ||
      this.extractImageGenerationPrompt(text).requested ||
      (username && lowered.includes(`@${username.toLowerCase()}`)) ||
      (msg.reply_to_message?.from?.id && msg.reply_to_message.from.id === this.botInfo?.id);

    if (explicit) {
      return { shouldProcess: true, shouldReply: true, smartCandidate: false };
    }

    if (this.communityOps.isTargetChat(msg.chat?.id)) {
      return { shouldProcess: false, shouldReply: false, smartCandidate: false };
    }

    if (this.config.triggerMode === "all") {
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
