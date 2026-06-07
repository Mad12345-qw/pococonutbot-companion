import TelegramBot from "node-telegram-bot-api";
import { buildSystemPrompt, getModeFromText } from "./persona.js";
import { fetchAsDataUrl, redactSensitive, splitTelegramMessage, truncate } from "./utils.js";

const triggerCommands = ["/ai", "/ask", "/love", "/伴侣"];

export class TelegramCompanionBot {
  constructor({ config, storage, minimax }) {
    this.config = config;
    this.storage = storage;
    this.minimax = minimax;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.botInfo = null;
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

    this.bot.on("message", (msg) => this.handleMessage(msg).catch((error) => this.handleError(msg, error)));
    this.bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
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
      "图片：支持；默认用 MiniMax-M3 的 image_url 输入",
      "语音识别：当前未接 STT，收到 voice 会提示你发文字"
    ].join("\n");

    await this.bot.sendMessage(chatId, help, { reply_to_message_id: replyTo });
  }

  async handleMemoryCommand(msg) {
    if (!this.isAllowedChat(msg.chat.id)) return;
    const memories = await this.storage.getMemories(msg.chat.id, msg.from?.id, this.config.memoryLimit);
    const summary = await this.storage.getSummary(msg.chat.id);
    const lines = [
      "当前记忆：",
      memories.length ? memories.map((item) => `- ${item.key}: ${item.value}`).join("\n") : "暂无长期记忆。",
      "",
      "摘要：",
      summary || "暂无摘要。"
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

    if (prepared.modality === "voice") {
      if (prepared.shouldReply) {
        await this.bot.sendMessage(
          msg.chat.id,
          "我收到语音了，但当前项目还没接语音转文字。MiniMax 官方文档里 Speech 主要是 TTS 语音合成；要让我听懂语音，需要再接一个 STT 服务。先发文字给我就可以聊。",
          { reply_to_message_id: msg.message_id }
        );
      }
      return;
    }

    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || "");
    const safeUserText = redactSensitive(prepared.text);

    await this.storage.addMessage({
      chatId,
      userId,
      role: "user",
      modality: prepared.modality,
      content: safeUserText,
      metadata: {
        username: msg.from?.username || "",
        firstName: msg.from?.first_name || "",
        hasImage: prepared.imageUrls.length > 0
      }
    });

    if (prepared.smartCandidate) {
      const recentForDecision = await this.storage.getRecentMessages(chatId, 12);
      const shouldReply = await this.minimax.shouldReplyInGroup({
        messageText: safeUserText,
        recentMessages: recentForDecision,
        botName: this.config.displayName,
        hasImage: prepared.imageUrls.length > 0
      });

      if (!shouldReply) return;
    } else if (!prepared.shouldReply) {
      return;
    }

    await this.bot.sendChatAction(msg.chat.id, "typing");

    const memories = await this.storage.getMemories(chatId, userId, this.config.memoryLimit);
    const modeOverride = memories.find((item) => item.key === "relationship.persona")?.value;
    const summary = await this.storage.getSummary(chatId);
    const recentMessages = await this.storage.getRecentMessages(chatId, this.config.recentMessageLimit);
    const systemPrompt = buildSystemPrompt({ config: this.config, memories, summary, modeOverride });

    const messages = [
      { role: "system", content: systemPrompt },
      ...recentMessages.map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content
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

    let reply;
    try {
      reply = await this.minimax.chat(messages);
    } catch (error) {
      if (prepared.imageUrls.length > 0) {
        reply = [
          "图片这次没有识别成功。",
          "常见原因是当前 MiniMax URL 或模型不接受 OpenAI-compatible image_url / data URL 图片输入。",
          `错误摘要：${truncate(error.message, 500)}`
        ].join("\n");
      } else {
        throw error;
      }
    }

    const safeReply = redactSensitive(reply);
    await this.storage.addMessage({
      chatId,
      userId: "",
      role: "assistant",
      modality: "text",
      content: safeReply,
      metadata: {}
    });

    for (const chunk of splitTelegramMessage(safeReply, this.config.maxReplyChars)) {
      await this.bot.sendMessage(msg.chat.id, chunk, { reply_to_message_id: msg.message_id });
    }

    if (this.config.autoMemory) {
      await this.updateMemoryAndSummary({ chatId, userId, userText: safeUserText, assistantText: safeReply });
    }
  }

  async updateMemoryAndSummary({ chatId, userId, userText, assistantText }) {
    try {
      const existingMemories = await this.storage.getMemories(chatId, userId, this.config.memoryLimit);
      const extracted = await this.minimax.extractMemories({ userText, assistantText, existingMemories });
      if (extracted.length > 0) {
        await this.storage.upsertMemories(chatId, userId, extracted);
      }

      const count = await this.storage.countMessages(chatId);
      if (count > 0 && count % 30 === 0) {
        const summary = await this.storage.getSummary(chatId);
        const recentMessages = await this.storage.getRecentMessages(chatId, 40);
        const newSummary = await this.minimax.summarizeConversation({ summary, recentMessages });
        await this.storage.setSummary(chatId, newSummary);
      }
    } catch (error) {
      console.error("Memory update failed:", error.message);
    }
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
      return {
        shouldProcess: true,
        shouldReply: groupDecision.shouldReply,
        smartCandidate: groupDecision.smartCandidate,
        text: "",
        modality: "voice",
        imageUrls: []
      };
    }

    let cleanText = this.stripTrigger(text).trim();
    const imageUrls = [];

    if (msg.photo?.length) {
      if (!cleanText) cleanText = "请看这张图片并自然回应。";

      if (groupDecision.shouldReply || groupDecision.smartCandidate || isPrivate) {
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
      cleanText = text || "继续";
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
