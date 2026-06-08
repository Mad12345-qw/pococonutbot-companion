import { parseJsonObject, truncate } from "./utils.js";

function isChatCompletionsEndpoint(url) {
  return url.includes("/chat/completions");
}

function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  return String(content || "");
}

function normalizeCompatibility(value = "") {
  return String(value || "openai").trim().toLowerCase();
}

function hasSameProvider(a, b) {
  return a.apiKey === b.apiKey && a.url === b.url && a.model === b.model;
}

export class AIClient {
  constructor(config, options = {}) {
    this.config = config;
    this.getSetting = options.getSetting || null;
  }

  get primaryProvider() {
    return {
      name: "primary",
      apiKey: this.config.aiApiKey,
      url: this.config.aiUrl,
      model: this.config.aiModel,
      compatibility: normalizeCompatibility(this.config.aiCompatibility),
      maxTokensField: this.config.aiMaxTokensField,
      extraBody: this.config.aiExtraBody || {}
    };
  }

  get fallbackProvider() {
    return {
      name: "fallback",
      apiKey: this.config.fallbackAiApiKey,
      url: this.config.fallbackAiUrl,
      model: this.config.fallbackAiModel,
      compatibility: normalizeCompatibility(this.config.fallbackAiCompatibility),
      maxTokensField: this.config.fallbackAiMaxTokensField,
      extraBody: this.config.fallbackAiExtraBody || {}
    };
  }

  get hasFallback() {
    const primary = this.primaryProvider;
    const fallback = this.fallbackProvider;
    return Boolean(fallback.apiKey && fallback.url && fallback.model && !hasSameProvider(primary, fallback));
  }

  async isPrimaryEnabled() {
    if (!this.getSetting) return true;
    const value = await this.getSetting("gpt.enabled", "true");
    return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
  }

  buildChatBody(provider, messages, options = {}) {
    const isMiniMaxCompatible = provider.compatibility === "minimax";
    const body = {
      model: options.model || provider.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: normalizeContent(message.content)
      })),
      ...provider.extraBody
    };

    if (isChatCompletionsEndpoint(provider.url)) {
      body.temperature = options.temperature ?? 0.8;
      const maxTokensField =
        provider.maxTokensField ||
        (isMiniMaxCompatible ? "max_completion_tokens" : "max_tokens");
      body[maxTokensField] = options.maxTokens ?? 1200;

      if (isMiniMaxCompatible) {
        body.reasoning_split = true;
        if (String(body.model).includes("MiniMax-M3")) {
          body.thinking = { type: "disabled" };
        }
      }
    }

    return body;
  }

  async requestChat(provider, messages, options = {}) {
    const response = await fetch(provider.url, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs || this.config.aiTimeoutMs || 120000),
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(this.buildChatBody(provider, messages, options))
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${provider.name} AI API error ${response.status}: ${truncate(text, 800)}`);
      error.status = response.status;
      throw error;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${provider.name} AI API returned non-JSON response: ${truncate(text, 400)}`);
    }

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.reply ??
      data?.output_text ??
      data?.text ??
      "";

    if (!content) {
      throw new Error(`${provider.name} AI API response did not contain text: ${truncate(JSON.stringify(data), 800)}`);
    }

    return String(content).trim();
  }

  async chat(messages, options = {}) {
    if (options.requirePrimary) {
      const primaryEnabled = await this.isPrimaryEnabled();
      if (!primaryEnabled) {
        throw new Error("Primary AI is disabled, but this request requires the primary model.");
      }
      return this.requestChat(this.primaryProvider, messages, { ...options, allowFallback: false });
    }

    const primaryEnabled = await this.isPrimaryEnabled();
    if (!primaryEnabled) {
      if (!this.hasFallback) {
        throw new Error("GPT is disabled, but fallback AI is not configured.");
      }
      return this.requestChat(this.fallbackProvider, messages, options);
    }

    try {
      return await this.requestChat(this.primaryProvider, messages, options);
    } catch (error) {
      if (!this.hasFallback || options.allowFallback === false || !this.shouldTryFallback(error)) {
        throw error;
      }
      console.error(`Primary AI failed, trying fallback: ${error.message}`);
      return this.requestChat(this.fallbackProvider, messages, options);
    }
  }

  async describeImages({ userText = "", imageUrls = [], platform = "chat" }) {
    const urls = imageUrls.filter(Boolean).slice(0, 4);
    if (urls.length === 0) return "";

    const prompt = [
      "请认真阅读用户发来的图片，输出一份可供后续对话继续引用的图片上下文。",
      "重点：如果图片里有文字、截图、表格、清单、项目名、链接、数字，请尽量逐条 OCR 出来，不要只概括。",
      "文字很多时，优先提取标题、项目名、编号、结论、关键说明，最多保留 30 条最重要信息。",
      "如果有被输入框、遮挡物或裁切挡住的内容，请标注“被遮挡/看不清”，不要编造。",
      "如果图片是聊天截图，请分清谁发了什么；如果是项目/榜单截图，请列出能看清的项目名和说明。",
      "输出中文，简洁但信息密度高。不要评价图片清不清楚，不要说你无法保存图片。",
      "",
      `平台：${platform}`,
      `用户附带文字：${userText || "无"}`
    ].join("\n");

    return this.chat(
      [
        {
          role: "system",
          content: "你是图片 OCR 和视觉内容提取助手。只输出图片中可见的信息和必要说明，不要寒暄。"
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...urls.map((url) => ({ type: "image_url", image_url: { url } }))
          ]
        }
      ],
      {
        temperature: 0.1,
        maxTokens: this.config.imageUnderstandingMaxTokens || 900,
        timeoutMs: this.config.imageUnderstandingTimeoutMs || 20000,
        requirePrimary: true
      }
    );
  }

  shouldTryFallback(error) {
    if (!error?.status) return true;
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }

  async extractMemories({ userText, assistantText, existingMemories, userProfile }) {
    const memoryList = existingMemories.map((item) => `${item.key}: ${item.value}`).join("\n") || "无";
    const profileText = userProfile
      ? [
          `Telegram ID: ${userProfile.id || "unknown"}`,
          `姓名: ${userProfile.fullName || "unknown"}`,
          `用户名: ${userProfile.username ? `@${userProfile.username}` : "none"}`
        ].join("\n")
      : "未知";

    const prompt = [
      "你是聊天机器人的长期记忆整理器。请只为“当前发言人”提取值得长期保存的信息。",
      "可以记录：稳定偏好、称呼、关系设定、重要经历、长期计划、待办、禁忌、纪念日、沟通风格、需要机器人长期帮忙跟进的事项。",
      "不要记录：API key、token、密码、验证码、银行卡、身份证、精确住址、一次性闲聊、无关事实、其他人的隐私。",
      "如果信息属于群里其他人，不要写进当前发言人的个人记忆。",
      "如果没有值得保存的新信息，返回 {\"memories\":[]}。",
      "返回严格 JSON，不要 Markdown。",
      "",
      "当前发言人：",
      profileText,
      "",
      "已有记忆：",
      memoryList,
      "",
      "当前发言人的本轮消息：",
      truncate(userText, 2000),
      "",
      "机器人本轮回复：",
      truncate(assistantText, 1200),
      "",
      "JSON 格式：",
      "{\"memories\":[{\"key\":\"preferences.nickname\",\"value\":\"用户喜欢被叫老板\",\"importance\":4}]}"
    ].join("\n");

    const raw = await this.chat(
      [
        { role: "system", content: "你只输出可解析 JSON，不要解释。" },
        { role: "user", content: prompt }
      ],
      { temperature: 0.1, maxTokens: 700 }
    );

    const parsed = parseJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.memories)) return [];

    return parsed.memories
      .map((item) => ({
        key: String(item.key || "").trim(),
        value: String(item.value || "").trim(),
        importance: Number.isFinite(Number(item.importance)) ? Number(item.importance) : 3
      }))
      .filter((item) => item.key && item.value)
      .slice(0, 8);
  }

  async summarizeConversation({ summary, recentMessages, userProfile }) {
    const transcript = recentMessages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");
    const profileLine = userProfile
      ? `${userProfile.fullName || "未知用户"} ${userProfile.username ? `(@${userProfile.username})` : ""}`
      : "当前聊天";

    const prompt = [
      "请更新一段简短对话摘要，供后续长期聊天上下文使用。",
      "保留关系进展、用户当前状态、未完成事项和重要偏好。不要保存敏感凭据。",
      `摘要对象：${profileLine}`,
      "",
      "旧摘要：",
      summary || "无",
      "",
      "最近消息：",
      truncate(transcript, 5000),
      "",
      "输出 200 字以内中文摘要。"
    ].join("\n");

    return this.chat(
      [
        { role: "system", content: "你是摘要器，只输出摘要正文。" },
        { role: "user", content: prompt }
      ],
      { temperature: 0.2, maxTokens: 500 }
    );
  }

  async shouldReplyInGroup({ messageText, recentMessages, botName, hasImage, platform = "group" }) {
    const transcript = recentMessages
      .slice(-10)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    const prompt = [
      `You are a timing classifier for a ${platform} AI companion bot.`,
      "Decide whether the bot should proactively reply to the latest group message.",
      "",
      "Reply true when:",
      "- Someone asks a question or requests advice, comfort, summary, translation, ideas, or an action.",
      "- Someone clearly talks to an AI, assistant, companion, bot, or the bot by name, even without @mention.",
      "- Someone sends an image and appears to want it identified, judged, explained, or reacted to.",
      "- The conversation is stuck at a point where a helpful assistant response would naturally move it forward.",
      "",
      "Reply false when:",
      "- It is normal human-to-human small talk, acknowledgement, jokes, emoji, laughter, OK, or 'received'.",
      "- The user seems to be sending several context messages and is not done yet.",
      "- The bot would feel interruptive or needy.",
      "- The message contains private or sensitive content without an explicit request for bot help.",
      "",
      `Bot display name: ${botName || "unknown"}`,
      `Latest message has image: ${hasImage ? "yes" : "no"}`,
      "",
      "Recent context:",
      transcript || "none",
      "",
      "Latest message:",
      messageText || "[no text]",
      "",
      "Return strict JSON only:",
      "{\"should_reply\":true,\"reason\":\"short reason\"}"
    ].join("\n");

    const raw = await this.chat(
      [
        { role: "system", content: "Return parseable JSON only. No Markdown." },
        { role: "user", content: prompt }
      ],
      { temperature: 0.1, maxTokens: 200 }
    );

    const parsed = parseJsonObject(raw);
    return Boolean(parsed?.should_reply);
  }
}
