import {
  TelegramCommunityOps,
  shouldTelegramCommunityAutoAnswer,
  telegramCommunityNickname,
  telegramCommunitySlot
} from "../src/telegram-community-ops.js";
import { TelegramCompanionBot } from "../src/telegram.js";

function assertEqual(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
  console.log(`ok ${name}: ${actual}`);
}

function memoryStorage() {
  const settings = new Map();
  return {
    settings,
    getSetting: async (key, fallback = "") => settings.has(key) ? settings.get(key) : fallback,
    setSetting: async (key, value) => settings.set(String(key), String(value)),
    tryCreateSetting: async (key, value) => {
      if (settings.has(key)) return false;
      settings.set(String(key), String(value));
      return true;
    },
    deleteSettingIfValue: async (key, value) => {
      if (settings.get(key) !== value) return false;
      settings.delete(key);
      return true;
    }
  };
}

assertEqual("telegram welcome keeps two-char Chinese nickname", telegramCommunityNickname({ first_name: "小明" }), "小明");
assertEqual("telegram welcome shortens three-char Chinese full name", telegramCommunityNickname({ first_name: "张焕焕" }), "焕焕");
assertEqual("telegram welcome uses first English name", telegramCommunityNickname({ first_name: "Hannah Lee" }), "Hannah");
assertEqual("telegram welcome rejects numeric account names", telegramCommunityNickname({ first_name: "用户2026" }), "");
assertEqual("telegram welcome rejects symbol noise", telegramCommunityNickname({ first_name: "@@@_bot_999" }), "");

assertEqual("telegram morning slot uses Shanghai time", telegramCommunitySlot(new Date("2026-07-19T01:00:00Z"))?.key, "morning");
assertEqual("telegram noon slot uses Shanghai time", telegramCommunitySlot(new Date("2026-07-19T05:00:00Z"))?.key, "noon");
assertEqual("telegram evening slot uses Shanghai time", telegramCommunitySlot(new Date("2026-07-19T12:00:00Z"))?.key, "evening");
assertEqual("telegram outside slot stays silent", telegramCommunitySlot(new Date("2026-07-19T08:00:00Z")), null);

assertEqual("target group question triggers proactive answer", shouldTelegramCommunityAutoAnswer({
  text: "Claude API 现在为什么一直报 429？",
  botUsername: "xiaoye_bot",
  isTargetChat: true
}), true);
assertEqual("other group question keeps existing routing", shouldTelegramCommunityAutoAnswer({
  text: "Claude API 现在为什么一直报 429？",
  botUsername: "xiaoye_bot",
  isTargetChat: false
}), false);
assertEqual("question aimed at another member does not trigger Xiaoye", shouldTelegramCommunityAutoAnswer({
  text: "@seanmad 这个 API 额度怎么开？",
  botUsername: "xiaoye_bot",
  isTargetChat: true
}), false);
assertEqual("statement does not trigger proactive answer", shouldTelegramCommunityAutoAnswer({
  text: "Qwen 新模型今天开放体验",
  botUsername: "xiaoye_bot",
  isTargetChat: true
}), false);

const routingBot = Object.create(TelegramCompanionBot.prototype);
routingBot.config = { triggerMode: "smart" };
routingBot.botInfo = { id: 999, username: "xiaoye_bot" };
routingBot.extractImageGenerationPrompt = () => ({ requested: false });
routingBot.communityOps = {
  shouldAutoAnswer: () => false,
  isTargetChat: (id) => String(id) === "-1004297524617"
};
assertEqual("target group statement bypasses legacy smart classifier", routingBot.getGroupDecision({ chat: { id: "-1004297524617" } }, "Qwen 开放体验").shouldProcess, false);
assertEqual("other group keeps legacy smart classifier", routingBot.getGroupDecision({ chat: { id: "-1001111111111" } }, "Qwen 开放体验").smartCandidate, true);

const chatId = "-1004297524617";
const sent = [];
const voiceSent = [];
const storage = memoryStorage();
const bot = {
  getChat: async (id) => ({ id, title: "MaD API", type: "supergroup" }),
  sendMessage: async (id, text, options = {}) => {
    sent.push({ id: String(id), text, options });
    return { message_id: sent.length };
  }
};
const config = {
  telegramCommunityOpsEnabled: true,
  telegramCommunityOpsChatIds: [chatId],
  telegramCommunityOpsQuietMinutes: 30,
  telegramCommunityOpsForceSlot: "morning",
  telegramCommunityOpsFreshness: "oneWeek",
  telegramCommunityOpsSearchCount: 8,
  telegramCommunityOpsAiTimeoutMs: 60000
};
const fallbackProvider = { name: "fallback", apiKey: "test", url: "https://example.com/v1/chat/completions", model: "test-model" };
const authoritativeResults = [
  { title: "OpenAI API update", summary: "OpenAI published an API update for developers.", url: "https://openai.com/index/api-update", siteName: "OpenAI", publishedAt: "2026-07-19" },
  { title: "Anthropic model update", summary: "Anthropic published a model capability update.", url: "https://www.anthropic.com/news/model-update", siteName: "Anthropic", publishedAt: "2026-07-19" },
  { title: "Google Gemini API update", summary: "Google published a Gemini API update.", url: "https://developers.googleblog.com/gemini-api-update", siteName: "Google", publishedAt: "2026-07-19" },
  { title: "Reuters model market report", summary: "Reuters reported a new foundation model market development.", url: "https://www.reuters.com/technology/model-market-update", siteName: "Reuters", publishedAt: "2026-07-19" }
];
const ai = {
  fallbackProvider,
  requestChat: async (provider) => {
    assertEqual("telegram scheduled news uses fallback model only", provider.name, "fallback");
    return JSON.stringify({
      text: [
        "小椰模型情报｜早间",
        "",
        "1. OpenAI API 更新",
        "发生了什么：OpenAI 发布了开发者接口更新。",
        "为什么值得关注：需要检查现有调用参数和兼容性。",
        "来源：OpenAI｜2026-07-19｜https://openai.com/index/api-update",
        "",
        "2. Anthropic 模型更新",
        "发生了什么：Anthropic 发布了模型能力更新。",
        "为什么值得关注：需要重新评估不同任务下的模型选择。",
        "来源：Anthropic｜2026-07-19｜https://www.anthropic.com/news/model-update",
        "",
        "3. Gemini API 更新",
        "发生了什么：Google 发布了 Gemini API 更新。",
        "为什么值得关注：现有接入方需要核对接口变化。",
        "来源：Google｜2026-07-19｜https://developers.googleblog.com/gemini-api-update",
        "",
        "大家更关心模型效果变化，还是 API 成本和稳定性？"
      ].join("\n"),
      digest: "三家模型厂商更新了 API 或模型能力",
      question: "大家更关心模型效果变化，还是 API 成本和稳定性？",
      sources: [
        "https://openai.com/index/api-update",
        "https://www.anthropic.com/news/model-update",
        "https://developers.googleblog.com/gemini-api-update"
      ]
    });
  }
};
const webSearch = { enabled: true, search: async () => ({ results: authoritativeResults }) };
const ops = new TelegramCommunityOps({
  config,
  storage,
  ai,
  webSearch,
  bot,
  sendVoiceBubble: async (id, text) => {
    voiceSent.push({ id: String(id), text });
    return true;
  }
});
ops.botInfo = { id: 999, username: "xiaoye_bot", can_read_all_group_messages: true };

await ops.verifyConfiguredChats();
assertEqual("telegram target group is verified", ops.verifiedChatIds.has(chatId), true);

await ops.handleNewMembers({
  chat: { id: chatId },
  new_chat_members: [{ id: 123, first_name: "张焕焕", is_bot: false }]
});
assertEqual("telegram welcome sends one voice bubble", voiceSent.length, 1);
assertEqual("telegram welcome does not duplicate voice with text", sent.length, 0);
assertEqual("telegram voice welcome uses nickname instead of full name", voiceSent[0].text.includes("焕焕") && !voiceSent[0].text.includes("张焕焕"), true);
assertEqual("telegram casual chat prefers voice", ops.prefersVoiceReply("小椰，今天心情怎么样？"), true);
assertEqual("telegram technical question stays text", ops.prefersVoiceReply("Claude API 429 怎么解决？"), false);
assertEqual("telegram explicit text preference stays text", ops.prefersVoiceReply("小椰，文字回复我今天怎么样"), false);

const post = await ops.buildNewsPost({ key: "morning", label: "早间", focus: "模型更新" }, {});
assertEqual("telegram news produces reader-grade text", post.text.startsWith("小椰模型情报｜早间"), true);
assertEqual("telegram news removes markdown noise", /\*\*|```/.test(post.text), false);
assertEqual("telegram news keeps three verified sources", post.sources.length, 3);

const scheduledStorage = memoryStorage();
const scheduledSent = [];
const scheduledOps = new TelegramCommunityOps({
  config,
  storage: scheduledStorage,
  ai,
  webSearch,
  bot: {
    getChat: bot.getChat,
    sendMessage: async (id, text) => scheduledSent.push({ id: String(id), text })
  }
});
scheduledOps.botInfo = ops.botInfo;
scheduledOps.verifiedChatIds.add(chatId);
scheduledOps.buildNewsPost = async () => ({
  text: "小椰模型情报｜早间\n\n1. A\n内容\n\n2. B\n内容\n\n3. C\n内容",
  digest: "digest",
  question: "question",
  sources: ["https://openai.com/a"]
});
await scheduledStorage.setSetting(scheduledOps.activityKey(chatId), new Date(Date.now() - 31 * 60 * 1000).toISOString());
await scheduledOps.runScheduledCheck();
await scheduledOps.runScheduledCheck();
assertEqual("telegram slot lock prevents duplicate scheduled posts", scheduledSent.length, 1);

console.log("Telegram community ops checks passed.");
