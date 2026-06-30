import { extractImageGenerationIntent } from "../src/image-intent.js";
import { FeishuBot } from "../src/feishu.js";
import { isProjectCreateRequest } from "../src/project-engine.js";
import { getReplyDeliveryPreference } from "../src/utils.js";

const bot = Object.create(FeishuBot.prototype);
bot.config = {
  feishuBotName: "小椰",
  displayName: "小椰",
  feishuBotAliases: [],
  feishuOutgoingMentionsEnabled: false,
  feishuMentionTargets: {
    "珠珠-SPM": "ou_test_zhuzhu"
  },
  bochaSearchFreshness: "noLimit",
  youtubeResearchMaxVideos: 5,
  selfAppearanceDescription: "",
  selfSelfieStyle: "",
  feishuAlwaysReplyUserIds: ["410351", "用户410351"],
  ownerUserIds: []
};
bot.storage = {
  getSetting: async (_key, fallback) => fallback
};

function classify(text, options = {}) {
  const linkContext = options.linkContext ? "[Feishu document] referenced content" : "";
  const projectRequest = isProjectCreateRequest(text);
  const selfieRequest = bot.extractSelfieGenerationPrompt(text);
  const songRequest = bot.extractSongRequest(text);
  const youtubeRequest = bot.extractYoutubeResearchRequest(text);
  const webSearchRequest = bot.extractWebSearchRequest(text);
  const imageRequest = extractImageGenerationIntent(text, {
    botNames: [bot.config.feishuBotName, bot.config.displayName]
  });
  const shouldUseWebSearch = webSearchRequest.requested && !bot.shouldPreferLinkReadingOverSearch({
    text,
    linkContext,
    request: webSearchRequest
  }) && !imageRequest.requested;

  if (projectRequest) return "project";
  if (selfieRequest.requested) return "selfie";
  if (songRequest.requested) return "song";
  if (youtubeRequest.requested) return "youtube_research";
  if (imageRequest.requested) return "image_generation";
  if (shouldUseWebSearch) {
    return webSearchRequest.githubTrending ? "web_search:github" : "web_search";
  }
  if (linkContext) return "ai_reply:link_context";
  return "ai_reply";
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
  console.log(`ok ${name}: ${actual}`);
}

const routeCases = [
  {
    name: "referenced summary does not become search card",
    text: "看看这个，总结一下",
    options: { linkContext: true },
    route: "ai_reply:link_context"
  },
  {
    name: "referenced document summary does not become search card",
    text: "看看这篇文档，整理重点",
    options: { linkContext: true },
    route: "ai_reply:link_context"
  },
  {
    name: "explicit search remains web card",
    text: "搜一下 今天黄金价格",
    route: "web_search"
  },
  {
    name: "price noun remains web card",
    text: "看看今天黄金价格",
    route: "web_search"
  },
  {
    name: "weather remains web card",
    text: "查下明天上海天气",
    route: "web_search"
  },
  {
    name: "github trending remains specialized web card",
    text: "今天 GitHub 热榜前三",
    route: "web_search:github"
  },
  {
    name: "world cup poll remains web card",
    text: "世界杯决赛投票支持谁",
    route: "web_search"
  },
  {
    name: "song request wins over normal chat",
    text: "唱一首",
    route: "song"
  },
  {
    name: "named song request wins over normal chat",
    text: "点歌 泡沫 邓紫棋",
    route: "song"
  },
  {
    name: "selfie request wins over generic image generation",
    text: "拍一张你自拍照看看",
    route: "selfie"
  },
  {
    name: "generic image generation stays image route",
    text: "帮我生成一张世界杯赛程海报",
    route: "image_generation"
  },
  {
    name: "project command stays project route",
    text: "新建项目：给客户做一个新品发布方案",
    route: "project"
  },
  {
    name: "ordinary chat stays ai reply",
    text: "你觉得这个方案怎么样",
    route: "ai_reply"
  }
];

routeCases.push({
  name: "youtube command uses transcript research",
  text: "youtube https://youtu.be/aFqjoCbZ4ik summarize technical details",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtu.be video link uses transcript research",
  text: "https://youtu.be/y_ecCDqTSJs?si=dsFllfrrfXWkkUWz",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube watch link uses transcript research",
  text: "https://www.youtube.com/watch?v=y_ecCDqTSJs",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube shorts link uses transcript research",
  text: "https://youtube.com/shorts/y_ecCDqTSJs?feature=share",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube live link uses transcript research",
  text: "https://www.youtube.com/live/y_ecCDqTSJs?si=test",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube embed link uses transcript research",
  text: "https://www.youtube.com/embed/y_ecCDqTSJs",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube channel link uses transcript research",
  text: "https://www.youtube.com/@SpaceX",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube channel videos link uses transcript research",
  text: "https://www.youtube.com/@SpaceX/videos",
  route: "youtube_research"
});
routeCases.push({
  name: "bare youtube playlist link uses transcript research",
  text: "https://www.youtube.com/playlist?list=PL1234567890abcdef",
  route: "youtube_research"
});
routeCases.push({
  name: "ordinary non-youtube link does not trigger transcript research",
  text: "https://example.com/article",
  route: "ai_reply"
});

for (const item of routeCases) {
  assertEqual(item.name, classify(item.text, item.options), item.route);
}

assertEqual(
  "youtube search defaults to one video",
  String(bot.extractYoutubeResearchRequest("youtube SpaceX Starship 技术细节").maxVideos),
  "1"
);
assertEqual(
  "youtube search honors explicit Chinese count",
  String(bot.extractYoutubeResearchRequest("youtube 搜 3 条 SpaceX Starship 技术视频").maxVideos),
  "3"
);
assertEqual(
  "youtube search honors explicit top count",
  String(bot.extractYoutubeResearchRequest("youtube top 5 SpaceX Starship technical videos").maxVideos),
  "5"
);
assertEqual(
  "youtube direct url stays one video",
  String(bot.extractYoutubeResearchRequest("youtube https://youtu.be/aFqjoCbZ4ik 总结技术细节").maxVideos),
  "1"
);
assertEqual(
  "bare youtu.be direct url stays one video",
  String(bot.extractYoutubeResearchRequest("https://youtu.be/y_ecCDqTSJs?si=dsFllfrrfXWkkUWz").maxVideos),
  "1"
);
assertEqual(
  "bare channel url defaults to one video",
  String(bot.extractYoutubeResearchRequest("https://www.youtube.com/@SpaceX").maxVideos),
  "1"
);
assertEqual(
  "channel url honors explicit count",
  String(bot.extractYoutubeResearchRequest("youtube https://www.youtube.com/@SpaceX 搜 3 条 Starship").maxVideos),
  "3"
);
assertEqual(
  "bare channel url is classified as channel",
  bot.extractYoutubeResearchRequest("https://www.youtube.com/@SpaceX").sourceType,
  "channel"
);
assertEqual(
  "bare playlist url is classified as playlist",
  bot.extractYoutubeResearchRequest("https://www.youtube.com/playlist?list=PL1234567890abcdef").sourceType,
  "playlist"
);

const deliveryCases = [
  ["text preference", "这段用文字回复就行", "text"],
  ["tts saving preference", "不用走tts，省点token", "text"],
  ["voice preference", "这段用语音回复", "voice"],
  ["default delivery", "正常聊两句", ""],
  ["link summary defaults to text", "看看这个，总结一下", "text", "[Referenced Feishu message]\n核心框架：角色、任务、背景、要求、输出格式。"],
  ["bare link context defaults to text", "https://example.com/article", "text", "[Referenced URL]\narticle content"]
];

for (const [name, text, expected, linkContext = ""] of deliveryCases) {
  const actual = linkContext
    ? bot.resolveReplyDeliveryPreference(text, { linkContext })
    : getReplyDeliveryPreference(text);
  assertEqual(name, actual, expected);
}

const mentionTargets = bot.resolveOutgoingMentionTargets("@珠珠-SPM 好的，你来看看这个。", {
  mentionTargets: [{ id: "ou_incoming_zhuzhu", name: "珠珠-SPM" }]
});
assertEqual("outgoing mentions are disabled by default", String(mentionTargets.length), "0");

bot.config.feishuOutgoingMentionsEnabled = true;
const enabledMentionTargets = bot.resolveOutgoingMentionTargets("@珠珠-SPM 好的，你来看看这个。", {
  mentionTargets: [{ id: "ou_incoming_zhuzhu", name: "珠珠-SPM" }]
});
assertEqual("mention delivery can be re-enabled explicitly", String(enabledMentionTargets.length), "1");

const madCandidates = bot.senderIdentityCandidates({
  sender: {
    sender_id: {
      open_id: "ou_test_mad",
      user_id: "410351",
      union_id: "on_test_mad"
    }
  }
});
assertEqual("always reply user whitelist matches tenant user id", String(await bot.isAlwaysReplyUser(madCandidates)), "true");
bot.config.feishuOutgoingMentionsEnabled = false;

bot.workspace = {
  request: async () => ({
    data: {
      message: {
        msg_type: "text",
        body: {
          content: JSON.stringify({
            text: "@小椰 看看这段引用正文。\n这里才是应该总结的内容。"
          })
        }
      }
    }
  })
};
const fetchedNestedMessage = await bot.fetchFeishuMessage("om_nested");
assertEqual(
  "nested Feishu API message body text is readable",
  String(bot.extractReadableTextFromFeishuMessage(fetchedNestedMessage).includes("应该总结的内容")),
  "true"
);

bot.fetchFeishuMessage = async () => ({
  message_type: "text",
  content: JSON.stringify({
    text: "@月亮 请你调用 lark-cli 来阅读。\n核心框架：角色、任务、背景、要求、输出格式。\nhttps://example.com/doc"
  })
});
bot.recentStoredLinkUrls = async () => [];
const quotedContext = await bot.collectMessageLinkContext({
  chatId: "feishu:test",
  message: { message_id: "om_current", parent_id: "om_parent" },
  text: "看看这个，总结一下"
});
assertEqual("quoted text is included before links", String(quotedContext.textSections.some((item) => item.includes("核心框架"))), "true");
assertEqual("quoted links are still collected", String(quotedContext.urls.includes("https://example.com/doc")), "true");

let staleRecentLinksCalled = false;
bot.fetchFeishuMessage = async () => ({ message_type: "text", content: "" });
bot.recentStoredLinkUrls = async () => {
  staleRecentLinksCalled = true;
  return ["https://stale.example.com/wiki"];
};
const emptyQuotedContext = await bot.collectMessageLinkContext({
  chatId: "feishu:test",
  message: { message_id: "om_current", parent_id: "om_parent" },
  text: "看看这个，总结一下"
});
assertEqual("quoted summary does not pull stale recent links", String(emptyQuotedContext.urls.includes("https://stale.example.com/wiki")), "false");
assertEqual("recent links are skipped when quoted id exists", String(staleRecentLinksCalled), "false");

assertEqual(
  "web search card body is hidden from chat history",
  bot.formatMessageForModel({
    role: "assistant",
    modality: "card",
    content: "联网资料卡：今天黄金价格\n很长的卡片正文",
    metadata: { webSearch: true }
  }).includes("联网资料卡"),
  false
);

console.log("Feishu routing checks passed.");
