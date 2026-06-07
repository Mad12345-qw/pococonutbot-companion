import { parseJsonObject, truncate } from "./utils.js";

function isChatCompletionsEndpoint(url) {
  return url.includes("/chat/completions");
}

function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  return String(content || "");
}

export class MiniMaxClient {
  constructor(config) {
    this.config = config;
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model || this.config.minimaxModel,
      messages: messages.map((message) => ({
        role: message.role,
        content: normalizeContent(message.content)
      }))
    };

    if (isChatCompletionsEndpoint(this.config.minimaxUrl)) {
      body.temperature = options.temperature ?? 0.8;
      body.max_completion_tokens = options.maxTokens ?? 1200;
      body.reasoning_split = true;
      if (String(body.model).includes("MiniMax-M3")) {
        body.thinking = { type: "disabled" };
      }
    }

    const response = await fetch(this.config.minimaxUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.minimaxApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MiniMax API error ${response.status}: ${truncate(text, 800)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`MiniMax returned non-JSON response: ${truncate(text, 400)}`);
    }

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.reply ??
      data?.output_text ??
      data?.text ??
      "";

    if (!content) {
      throw new Error(`MiniMax response did not contain text: ${truncate(JSON.stringify(data), 800)}`);
    }

    return String(content).trim();
  }

  async extractMemories({ userText, assistantText, existingMemories }) {
    const memoryList = existingMemories.map((item) => `${item.key}: ${item.value}`).join("\n") || "无";
    const prompt = [
      "你是聊天长期记忆整理器。请从本轮对话中提取值得长期保存的信息。",
      "只记录稳定偏好、称呼、关系设定、重要经历、长期计划、禁忌、纪念日、沟通风格。",
      "不要记录 API key、token、密码、验证码、银行卡、身份证、地址、一次性闲聊或无关事实。",
      "如果没有值得保存的新信息，返回 {\"memories\":[] }。",
      "返回严格 JSON，不要 Markdown。",
      "",
      "已有记忆：",
      memoryList,
      "",
      "用户本轮消息：",
      truncate(userText, 2000),
      "",
      "助手本轮回复：",
      truncate(assistantText, 1200),
      "",
      "JSON 格式：",
      "{\"memories\":[{\"key\":\"短键名\",\"value\":\"一句话记忆\",\"importance\":1}]}"
    ].join("\n");

    const raw = await this.chat(
      [
        { role: "system", content: "你只输出可解析 JSON。" },
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

  async summarizeConversation({ summary, recentMessages }) {
    const transcript = recentMessages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    const prompt = [
      "请更新一段简短对话摘要，供长期聊天上下文使用。",
      "保留关系进展、用户当前状态、未完成事项和重要偏好。不要保存敏感凭据。",
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

  async shouldReplyInGroup({ messageText, recentMessages, botName, hasImage }) {
    const transcript = recentMessages
      .slice(-10)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    const prompt = [
      "You are a timing classifier for a Telegram group AI companion bot.",
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
