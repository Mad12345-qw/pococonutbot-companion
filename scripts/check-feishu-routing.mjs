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

const mobileDocMarkdown = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "GPU",
  title: "building the best GPU possible YouTube 技术笔记",
  videos: [
    {
      title: "building the best GPU possible",
      channel: "Lex Fridman",
      lengthText: "01:02:03",
      language: "en",
      url: "https://www.youtube.com/watch?v=test1234567",
      transcriptText: Array.from({ length: 30 }, (_, index) => `[0:${String(index).padStart(2, "0")}] Transcript line ${index + 1}.`).join("\n")
    }
  ],
  markdown: [
    "---",
    "title: test",
    "---",
    "# building the best GPU possible YouTube 技术笔记",
    "",
    "## 二、精华总结",
    "### 初学者先理解",
    "这段应该进入背景导读，而不是留在精华总结里。",
    "这条视频真正值得读的，不是某个孤立知识点，而是它背后的产业判断、工程取舍和商业后果。",
    "### 一句话结论",
    "GPU 的瓶颈不只是算力，也包括内存带宽。",
    "### this YouTube 技术笔记",
    "- **背景导读：** 这段机器生成的背景块也必须搬回背景区，不能留在总结下面。",
    "- **市场/技术环境：** 这里同样属于背景，不属于正文观点。",
    "### 初学者先理解几个关键词",
    "- Starship / 星舰",
    "- 通常指 SpaceX 的超重型运载系统中的上面级飞船。",
    "- Super Heavy / 超重型助推器",
    "- 星舰系统的一级助推器，负责把飞船推到接近入轨条件。",
    "- 术语解释：长船与龙船：Viking longship 指维京长船，核心优势是速度和浅水航行。",
    "- **输出语言与形式：** 简体中文 Markdown 技术笔记",
    "## 三、关键技术点速览",
    "| 技术点 | 视频里怎么说 | 为什么重要 |",
    "| --- | --- | --- |",
    "| GPU 架构 | 强调带宽和并行 | 影响训练效率 |"
  ].join("\n")
});
assertEqual(
  "youtube Feishu doc avoids duplicate body H1",
  String(/^#\s+/m.test(mobileDocMarkdown)),
  "false"
);
assertEqual(
  "youtube Feishu doc converts tables for mobile",
  String(/^\|/m.test(mobileDocMarkdown)),
  "false"
);
assertEqual(
  "youtube Feishu doc removes machine reading navigation",
  String(!mobileDocMarkdown.includes("## 阅读导航") && !mobileDocMarkdown.includes("这篇文档由小椰")),
  "true"
);
assertEqual(
  "youtube Feishu doc strips generic background filler",
  String(!mobileDocMarkdown.includes("不是某个孤立知识点") && !mobileDocMarkdown.includes("产业判断、工程取舍和商业后果") && !mobileDocMarkdown.includes("重点不是记住每个参数")),
  "true"
);
assertEqual(
  "youtube Feishu doc avoids low-value repeated metadata",
  String(!mobileDocMarkdown.includes("输出语言") && !mobileDocMarkdown.includes("内容形态") && !mobileDocMarkdown.includes("**字幕**")),
  "true"
);
assertEqual(
  "youtube Feishu doc uses scroll-friendly transcript index without raw html",
  String(mobileDocMarkdown.includes("### 原文摘录") && mobileDocMarkdown.includes("原文索引") && mobileDocMarkdown.includes("```text") && mobileDocMarkdown.includes("[0:24] Transcript line 25.") && !mobileDocMarkdown.includes("[0:25] Transcript line 26.") && !mobileDocMarkdown.includes("完整字幕逐字稿") && !mobileDocMarkdown.includes("<details>")),
  "true"
);
assertEqual(
  "youtube Feishu doc relocates all background primers to background",
  String([
    "这段应该进入背景导读",
    "**背景导读：**",
    "**市场/技术环境：**"
  ].every((needle) => {
    const index = mobileDocMarkdown.indexOf(needle);
    const laterSections = [
      mobileDocMarkdown.indexOf("## 二、精华总结"),
      mobileDocMarkdown.indexOf("## 三、关键技术点速览"),
      mobileDocMarkdown.indexOf("## 四、详细技术拆解"),
      mobileDocMarkdown.indexOf("## 五、时间线摘要")
    ].filter((value) => value >= 0);
    const firstLaterSection = Math.min(...laterSections);
    return index > mobileDocMarkdown.indexOf("## 一、背景导读") && index < firstLaterSection;
  })),
  "true"
);
assertEqual(
  "youtube Feishu doc formats background term glossary",
  String(mobileDocMarkdown.includes("### 关键术语解释") && mobileDocMarkdown.includes("- **Starship / 星舰：** 通常指 SpaceX 的超重型运载系统中的上面级飞船。") && mobileDocMarkdown.includes("- **Super Heavy / 超重型助推器：** 星舰系统的一级助推器，负责把飞船推到接近入轨条件。") && mobileDocMarkdown.includes("- **长船与龙船：** Viking longship 指维京长船，核心优势是速度和浅水航行。") && !mobileDocMarkdown.includes("- Starship / 星舰\n- 通常指") && !mobileDocMarkdown.includes("术语解释：长船与龙船")),
  "true"
);
assertEqual(
  "youtube Feishu doc bolds reader labels",
  String(mobileDocMarkdown.includes("- **市场/技术环境：** 这里同样属于背景，不属于正文观点。")),
  "true"
);
assertEqual(
  "youtube Feishu doc strips machine generated youtube note headings",
  String(!/this\s+YouTube\s+技术笔记/i.test(mobileDocMarkdown) && !/it\s+YouTube\s+技术笔记/i.test(mobileDocMarkdown)),
  "true"
);
assertEqual(
  "youtube Feishu doc keeps reader-grade required sections",
  String([
    "## 一、背景导读",
    "## 三、关键技术点速览",
    "## 五、时间线摘要",
    "## 六、值得继续追问的问题",
    "## 七、出处与链接"
  ].every((heading) => mobileDocMarkdown.includes(heading))),
  "true"
);
assertEqual(
  "youtube Feishu doc never exposes generation placeholders",
  String(!mobileDocMarkdown.includes("这部分没有生成到有效内容") && !mobileDocMarkdown.includes("需要重新跑一次") && !mobileDocMarkdown.includes("当前摘要没有返回可靠时间线") && !mobileDocMarkdown.includes("it YouTube 技术笔记")),
  "true"
);
assertEqual(
  "youtube Feishu doc resolves SpaceX videos to a Chinese column title",
  bot.resolveYoutubeDocumentTitle({
    topic: "SpaceX",
    title: "First Look Inside SpaceX's Starfactory w/ Elon Musk",
    videos: [{ title: "First Look Inside SpaceX's Starfactory w/ Elon Musk" }],
    markdown: "# First Look Inside SpaceX's Starfactory w/ Elon Musk"
  }),
  "星舰工厂里的马斯克赌局：SpaceX 想把火箭变成流水线产品"
);
assertEqual(
  "youtube Feishu doc resolves Viking videos to a Chinese column title",
  bot.resolveYoutubeDocumentTitle({
    topic: "Vikings",
    title: "Vikings, Ragnar, Berserkers, Valhalla & the Warriors of the Viking Age | Lex Fridman Podcast #495",
    videos: [{ title: "Vikings, Ragnar, Berserkers, Valhalla & the Warriors of the Viking Age | Lex Fridman Podcast #495" }],
    markdown: "# this YouTube 技术笔记"
  }),
  "维京时代的真实动力：长船、恐惧与宗教叙事如何改写欧洲"
);

const vikingFallbackDoc = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "Vikings",
  title: "Vikings, Ragnar, Berserkers, Valhalla & the Warriors of the Viking Age | Lex Fridman Podcast #495",
  videos: [
    {
      title: "Vikings, Ragnar, Berserkers, Valhalla & the Warriors of the Viking Age | Lex Fridman Podcast #495",
      channel: "Lex Fridman",
      language: "en",
      url: "https://www.youtube.com/watch?v=testviking",
      transcriptText: "[0:00] The Viking longships could average 70 to 120 miles a day.\n[0:04] They could hit a place, raid it, drag off whoever they wanted, and get away before you could get your army there."
    }
  ],
  markdown: "# this YouTube 技术笔记\n\n## 二、精华总结\n### 一句话结论\n维京人的扩张依赖长船、恐惧叙事和制度适应。"
});
assertEqual(
  "youtube Feishu doc Viking fallback is concrete",
  String(vikingFallbackDoc.includes("长船带来的机动性") && vikingFallbackDoc.includes("### 关键术语解释") && vikingFallbackDoc.includes("**Longship / 长船：**") && !vikingFallbackDoc.includes("产业判断、工程取舍和商业后果")),
  "true"
);

const keywordFallbackDoc = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "GPU memory bandwidth",
  title: "Building the Best GPU Possible",
  videos: [
    {
      title: "Building the Best GPU Possible",
      channel: "Lex Fridman",
      language: "en",
      url: "https://www.youtube.com/watch?v=testgpu",
      transcriptText: "[0:00] Memory bandwidth is the bottleneck.\n[0:05] Parallel compute and cache locality change the architecture."
    }
  ],
  markdown: "# Building the Best GPU Possible\n\n## 二、精华总结\n### 一句话结论\nGPU 的瓶颈不只是算力，也包括内存带宽。"
});
assertEqual(
  "youtube Feishu doc fallback questions are keyword-specific for any topic",
  String(keywordFallbackDoc.includes("Memory") || keywordFallbackDoc.includes("bandwidth") || keywordFallbackDoc.includes("GPU")),
  "true"
);
assertEqual(
  "youtube research reply includes timing diagnostics",
  String(bot.formatYoutubeResearchReply(
    {
      title: "测试视频",
      topic: "测试主题",
      videos: [{ title: "测试视频", channel: "Test", language: "en" }],
      diagnostics: {
        candidateMs: 1200,
        transcriptMs: 2300,
        aiMs: 3400,
        totalMs: 6900
      }
    },
    { synced: false, reason: "pending" },
    { created: true, url: "https://example.com/doc", diagnostics: { documentMs: 4500 } },
    { synced: false, reason: "pending" }
  ).includes("耗时诊断：候选 1.2s / 字幕 2.3s / AI 3.4s / 飞书 4.5s / 总计 11s")),
  "true"
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
