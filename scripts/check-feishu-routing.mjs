import fs from "node:fs";
import { extractImageGenerationIntent } from "../src/image-intent.js";
import { FeishuBot } from "../src/feishu.js";
import { FeishuWorkspaceClient, buildFeishuArticleGroupPrelude, feishuYoutubeThumbnailUrl, withFeishuArticleGroupPrelude } from "../src/feishu-workspace.js";
import { isProjectCreateRequest } from "../src/project-engine.js";
import { getReplyDeliveryPreference } from "../src/utils.js";
import { WeChatPublisher } from "../src/wechat-publisher.js";
import { buildLatestYoutubeWechatCandidate, extractWikiTokenFromFeishuUrl } from "../src/admin.js";
import { resolveImageEndpoint } from "../src/config.js";
import { ImageGenerationClient } from "../src/image-client.js";

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
  const cleanupRequest = bot.extractResearchKbCleanupRequest(text);
  const investmentReportRequest = bot.extractInvestmentReportRequest(text);
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
  if (cleanupRequest.requested) return cleanupRequest.apply ? "research_kb_cleanup:apply" : "research_kb_cleanup:preview";
  if (investmentReportRequest.requested) return "investment_report";
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

function countOccurrences(text = "", needle = "") {
  if (!needle) return 0;
  return String(text || "").split(needle).length - 1;
}

function sectionBetween(markdown = "", startHeading = "", endHeading = "") {
  const text = String(markdown || "");
  const start = text.indexOf(startHeading);
  if (start < 0) return "";
  const afterStart = start + startHeading.length;
  const end = endHeading ? text.indexOf(endHeading, afterStart) : -1;
  return (end >= 0 ? text.slice(afterStart, end) : text.slice(afterStart)).trim();
}

function countBullets(markdown = "") {
  return (String(markdown || "").match(/^\s*[-*]\s+/gm) || []).length;
}

const articleGroupConfig = {
  feishuArticleGroupChatId: "oc_test_group",
  feishuArticleGroupInviteText: "加入我们，持续追踪SpaceX、AI、Robot！"
};
const articleGroupPrelude = buildFeishuArticleGroupPrelude(articleGroupConfig);
assertEqual(
  "Feishu article group prelude uses configured invite text",
  String(articleGroupPrelude.includes(articleGroupConfig.feishuArticleGroupInviteText)),
  "true"
);
assertEqual(
  "Feishu article group prelude keeps links out of markdown so the native card owns joining",
  String(!articleGroupPrelude.includes("http") && !articleGroupPrelude.includes("加入群聊")),
  "true"
);
const articleWithPrelude = withFeishuArticleGroupPrelude("# 正文标题\n\n## 一、正文", articleGroupConfig);
assertEqual(
  "Feishu article group prelude is inserted after the document title",
  String(articleWithPrelude.startsWith("# 正文标题\n\n加入我们，持续追踪SpaceX、AI、Robot！")),
  "true"
);
assertEqual(
  "Feishu article group prelude is idempotent",
  String(countOccurrences(withFeishuArticleGroupPrelude(articleWithPrelude, articleGroupConfig), "加入我们，持续追踪SpaceX、AI、Robot！")),
  "1"
);
let articleGroupNotificationText = "";
let articleGroupTtsText = "";
bot.config.feishuArticleGroupChatId = "oc_test_group";
bot.sendTextToChat = async (_chatId, text) => {
  articleGroupNotificationText = text;
  return { message_id: "om_article_group_test" };
};
bot.sendSpeechToChat = async (_chatId, text) => {
  articleGroupTtsText = text;
  return true;
};
bot.rememberBotMessage = () => {};
await bot.notifyArticleGroup({
  title: "为什么SpaceX把火星使命改写成新航天市场规则",
  url: "https://feishu.example/wiki/test",
  sourceType: "YouTube 精读",
  markdown: [
    "## 三、导读与核心结论",
    "### 核心观点",
    "#### 1. SpaceX 一直强调火星使命，是技术路线和组织动员共同作用的结果",
    "### 最反共识的判断",
    "- 火星使命不只是愿景口号，也可能是商业航天融资和组织动员的长期工具。"
  ].join("\n")
});
assertEqual(
  "Feishu article group notification starts with a discussion prompt instead of invite copy",
  String(
    articleGroupNotificationText.includes("新整理了一篇 SpaceX / 商业航天 精读") &&
    articleGroupNotificationText.includes("SpaceX 一直强调火星使命，这到底是技术路线、组织信仰，还是商业航天的融资工具？") &&
    articleGroupNotificationText.includes("大家怎么看？") &&
    !articleGroupNotificationText.includes("加入我们")
  ),
  "true"
);
assertEqual(
  "Feishu article group TTS only reads the discussion prompt",
  String(
    articleGroupTtsText.includes("新整理了一篇 SpaceX / 商业航天 精读") &&
    articleGroupTtsText.includes("大家怎么看？") &&
    !articleGroupTtsText.includes("YouTube 精读已生成") &&
    !articleGroupTtsText.includes("https://feishu.example")
  ),
  "true"
);
const wechatActions = bot.wechatPublishActions({ id: "candidate-test" });
assertEqual(
  "WeChat publish card exposes one unified draft button",
  String(wechatActions.length),
  "1"
);
assertEqual(
  "WeChat unified draft button always generates images",
  String(wechatActions[0]?.value?.generate_images),
  "true"
);

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
  name: "strict investment report prefix triggers report route",
  text: "投研报告：商业航天 / 星舰 / 中国供应链替代",
  route: "investment_report"
});
routeCases.push({
  name: "research kb cleanup preview has strict route",
  text: "投研知识库清理预览",
  route: "research_kb_cleanup:preview"
});
routeCases.push({
  name: "research kb cleanup apply requires explicit confirmation",
  text: "投研知识库清理执行：我确认",
  route: "research_kb_cleanup:apply"
});
routeCases.push({
  name: "research kb cleanup apply without confirmation stays preview route",
  text: "投研知识库清理执行",
  route: "research_kb_cleanup:preview"
});
routeCases.push({
  name: "investment report words without strict prefix stay normal chat",
  text: "投研报告系统现在怎么用？",
  route: "ai_reply"
});
routeCases.push({
  name: "youtube link inside strict investment report prefix triggers report route",
  text: "投研报告：商业航天 https://youtu.be/aFqjoCbZ4ik",
  route: "investment_report"
});
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

const youtubeAiOptionsBot = Object.create(FeishuBot.prototype);
youtubeAiOptionsBot.config = {
  youtubeResearchSummaryMaxTokens: 2600,
  youtubeResearchMaxTranscriptChars: 60000,
  youtubeResearchAiTimeoutMs: 180000,
  youtubeResearchAiRetryAttempts: 3,
  youtubeResearchForcePrimaryWithFallback: true,
  youtubeResearchRequirePrimary: false
};
const capturedYoutubeAiOptions = [];
youtubeAiOptionsBot.ai = {
  chat: async (messages, options = {}) => {
    capturedYoutubeAiOptions.push(options);
    const content = messages.map((message) => String(message.content || "")).join("\n");
    if (content.includes("Return JSON with exactly this shape")) {
      return JSON.stringify({
        thesis: "Starship 测试把商业航天竞争从单次发射推向高频迭代能力",
        titleAngles: ["Starship 的真正门槛：不是火箭更大，而是迭代更快"],
        narrativeConflict: "视频展示的冲突是硬件规模、试验节奏和工程风险之间的拉扯。",
        backgroundAnchors: ["Starship", "Super Heavy", "SpaceX", "发射塔", "猛禽发动机"],
        glossarySeeds: [
          { term: "Starship", evidence: "0:10 Starship", plainMeaning: "SpaceX 的大型飞船系统。" },
          { term: "Super Heavy", evidence: "0:20 booster", plainMeaning: "负责把飞船送上去的一级助推器。" },
          { term: "快速复用", evidence: "0:30 reuse", plainMeaning: "让火箭像运输工具一样反复使用。" }
        ],
        evidenceClaims: [
          { claim: "发射系统的价值来自高频迭代。", timestamp: "0:10", quote: "rapid iteration", whyItMatters: "它决定成本下降速度。" },
          { claim: "回收能力改变任务经济性。", timestamp: "0:20", quote: "reuse", whyItMatters: "它影响单位发射成本。" },
          { claim: "发动机可靠性是核心约束。", timestamp: "0:30", quote: "engine", whyItMatters: "它决定能否规模化。" },
          { claim: "发射塔是系统一部分。", timestamp: "0:40", quote: "tower", whyItMatters: "它影响周转效率。" },
          { claim: "测试失败也会进入学习闭环。", timestamp: "0:50", quote: "test", whyItMatters: "它解释了试飞节奏。" },
          { claim: "商业航天竞争变成系统工程。", timestamp: "1:00", quote: "system", whyItMatters: "它影响产业链判断。" }
        ],
        timelineSeeds: Array.from({ length: 8 }, (_, index) => ({
          time: `0:${String(index + 10).padStart(2, "0")}`,
          event: `第 ${index + 1} 个关键场景`,
          importance: "帮助读者定位证据。",
          quote: "source quote"
        })),
        questionSeeds: [
          "Starship 的复用节奏何时能稳定？",
          "猛禽发动机可靠性如何验证？",
          "发射塔会不会成为产能瓶颈？",
          "供应链哪些环节最容易受益？",
          "监管节奏会如何影响商业化？"
        ]
      });
    }
    if (content.includes("fixed title/background schema")) {
      return JSON.stringify({
        title: "Starship 的真正门槛：不是火箭更大，而是迭代更快",
        contextParagraphs: [
          "这条视频的背景是 SpaceX 围绕 Starship 进行高频试验，行业关注点从单次发射成功转向可复用系统能否稳定运转。",
          "对非专业读者来说，理解这条视频要先抓住一个矛盾：火箭硬件越大，真正难的反而是制造、测试、回收和再发射组成的系统效率。"
        ]
      });
    }
    if (content.includes("fixed glossary schema")) {
      return JSON.stringify({
        glossary: [
          { term: "Starship", explanation: "SpaceX 的大型飞船系统，用来承担更重载荷和深空任务。" },
          { term: "Super Heavy", explanation: "Starship 的一级助推器，负责起飞阶段的大推力。" },
          { term: "快速复用", explanation: "火箭完成任务后尽快回收、检查并再次发射的能力。" }
        ]
      });
    }
    if (content.includes("fixed core schema")) {
      return JSON.stringify({
        oneSentence: "Starship 的核心看点不是尺寸，而是 SpaceX 能否把火箭变成可高频迭代的运输系统。",
        corePoints: Array.from({ length: 4 }, (_, index) => ({
          title: `核心判断 ${index + 1}：复用能力决定商业航天成本曲线`,
          evidence: "rapid iteration",
          why: "它决定发射成本能否持续下降。",
          takeaway: "读者应关注系统周转，而不只是单次试飞。"
        })),
        quotes: [
          { title: "高频迭代", original: "rapid iteration", meaning: "强调试验速度。", implication: "工程学习速度可能成为壁垒。" },
          { title: "复用系统", original: "reuse", meaning: "强调回收再发射。", implication: "成本结构会被重新定义。" }
        ],
        counterintuitive: [
          "火箭越大，不代表商业价值越确定。",
          "失败试飞也可能是学习资产。",
          "发射塔和地面系统可能和飞船一样关键。"
        ]
      });
    }
    if (content.includes("fixed technical schema")) {
      return JSON.stringify({
        techPoints: Array.from({ length: 3 }, (_, index) => ({
          name: `技术点 ${index + 1}`,
          says: "视频把它放在复用系统里讲。",
          importance: "它影响发射频率和成本。",
          risk: "稳定性仍需更多验证。"
        })),
        detailSections: Array.from({ length: 3 }, (_, index) => ({
          title: `技术拆解 ${index + 1}`,
          bullets: ["这一点把硬件能力和商业化效率连接起来。", "边界条件是可靠性、监管和地面系统。"]
        }))
      });
    }
    if (content.includes("fixed timeline/question schema")) {
      return JSON.stringify({
        timeline: Array.from({ length: 8 }, (_, index) => ({
          time: `0:${String(index + 10).padStart(2, "0")}`,
          event: `时间线事件 ${index + 1}`,
          importance: "这一刻帮助读者理解证据链。",
          evidence: "source quote"
        })),
        questions: [
          "复用节奏何时稳定？",
          "发动机可靠性如何验证？",
          "发射塔会不会成为瓶颈？",
          "供应链哪些环节最受益？",
          "监管节奏如何影响商业化？"
        ]
      });
    }
    throw new Error("unexpected YouTube AI prompt");
  }
};
await youtubeAiOptionsBot.generateYoutubeResearchMarkdown({
  topic: "SpaceX",
  request: { raw: "youtube https://youtu.be/test", videoUrl: "https://youtu.be/test" },
  videos: [{
    title: "Starship test",
    channel: "SpaceX",
    url: "https://youtu.be/test",
    language: "en",
    transcriptText: Array.from({ length: 20 }, (_, index) => `[0:${String(index + 10).padStart(2, "0")}] rapid iteration reuse engine tower system ${index + 1}`).join("\n")
  }]
});
assertEqual(
  "youtube structured generation never uses fallback model",
  String(capturedYoutubeAiOptions.length >= 6 && capturedYoutubeAiOptions.every((option) => option.allowFallback === false)),
  "true"
);
assertEqual(
  "youtube structured generation bounds primary retries before failing",
  String(capturedYoutubeAiOptions.every((option) => option.retryAttempts >= 1 && option.retryAttempts <= 3)),
  "true"
);

const cacheLifecycleBot = Object.create(FeishuBot.prototype);
const cacheNow = Date.now();
const cacheJobs = [
  {
    id: "fresh_job",
    sourceType: "video",
    sourceUrl: "https://youtu.be/cache-test",
    output: {
      youtubeArticleParts: {
        expiresAt: new Date(cacheNow + 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(cacheNow).toISOString(),
        parts: {
          evidenceBrief: { status: "done", data: { thesis: "cached thesis" } },
          tech: { status: "failed", error: "timeout" }
        }
      }
    }
  },
  {
    id: "expired_job",
    sourceType: "video",
    sourceUrl: "https://youtu.be/expired-cache",
    output: {
      youtubeArticleParts: {
        expiresAt: new Date(cacheNow - 60 * 1000).toISOString(),
        updatedAt: new Date(cacheNow - 25 * 60 * 60 * 1000).toISOString(),
        parts: {
          evidenceBrief: { status: "done", data: { thesis: "old thesis" } }
        }
      }
    }
  }
];
cacheLifecycleBot.storage = {
  listRecentResearchJobs: async ({ sourceType = "" } = {}) => cacheJobs.filter((job) => !sourceType || job.sourceType === sourceType),
  mergeResearchJobOutput: async (jobId, patch) => {
    const job = cacheJobs.find((item) => item.id === jobId);
    job.output = { ...(job.output || {}), ...(patch || {}) };
    return job.output;
  }
};
const reusableCache = await cacheLifecycleBot.findReusableYoutubeArticlePartCache("https://youtu.be/cache-test");
assertEqual(
  "youtube article part cache reuses fresh failed-job parts",
  String(Boolean(reusableCache?.parts?.evidenceBrief?.data?.thesis)),
  "true"
);
await cacheLifecycleBot.clearExpiredYoutubeArticlePartCaches();
assertEqual(
  "youtube article part cache clears expired parts after 24h",
  String(cacheJobs[1].output.youtubeArticleParts.clearedIntermediateParts === true && !cacheJobs[1].output.youtubeArticleParts.parts),
  "true"
);
await cacheLifecycleBot.clearYoutubeArticlePartCacheAfterPublish("fresh_job", {
  report: { title: "Published article" },
  doc: { created: true, url: "https://feishu.example/doc" }
});
assertEqual(
  "youtube article part cache clears intermediate parts after publish",
  String(cacheJobs[0].output.youtubeArticleParts.clearedIntermediateParts === true && !cacheJobs[0].output.youtubeArticleParts.parts),
  "true"
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
      transcriptText: [
        ...Array.from({ length: 30 }, (_, index) => `[0:${String(index).padStart(2, "0")}] Transcript line ${index + 1}.`),
        "[0:31] 我会把这句话保留在原文索引里，因为这是视频字幕证据，不是模型过程话。"
      ].join("\n")
    }
  ],
  markdown: [
    "我先按你给的时间戳骨架整理成中文技术简报，重点只保留能直接落在原文锚点上的结论、术语和证据。",
    "接下来我会把“100倍更重”“12次以上补加注”串成一篇可直接进 Obsidian/飞书的笔记。",
    "我先接下来我会把这条视频整理成可直接进 Obsidian/飞书的中文技术简报。",
    "我先接下来我会我会把这条视频整理成中文专栏文章，发到飞书文档里。真正的正文标题：SpaceX 如何把火箭从奢侈品改造成基础设施。",
    "我先按接下来我会我会把这条视频整理成中文专栏文章并发到飞书文档里",
    "我会把视频内容串成一篇适合飞书阅读的文章发给你",
    "接下来我会把 SpaceX、星舰基地和猛禽发动机串成一篇文章。",
    "---",
    "title: test",
    "---",
    "# 为什么 Starship HLS 会牵出“12 次以上发射加注”的月球任务链",
    "# building the best GPU possible YouTube 技术笔记",
    "",
    "## 二、精华总结",
    "### 初学者先理解",
    "这段应该进入背景导读，而不是留在精华总结里。",
    "这条视频真正值得读的，不是某个孤立知识点，而是它背后的产业判断、工程取舍和商业后果。",
    "### 一句话结论",
    "GPU 的瓶颈不只是算力，也包括内存带宽。",
    "### 100 times heavier YouTube 技术笔记",
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
  String(mobileDocMarkdown.includes("### 原文摘录") && mobileDocMarkdown.includes("原文索引") && mobileDocMarkdown.includes("```text") && mobileDocMarkdown.includes("[0:24] Transcript line 25.") && mobileDocMarkdown.includes("[0:25] Transcript line 26.") && !mobileDocMarkdown.includes("完整字幕逐字稿") && !mobileDocMarkdown.includes("<details>")),
  "true"
);
assertEqual(
  "youtube Feishu doc splits glossary background and conclusion",
  String(mobileDocMarkdown.includes("## 一、关键术语解释") && mobileDocMarkdown.includes("## 二、背景导读") && mobileDocMarkdown.includes("## 三、导读与核心结论") && !mobileDocMarkdown.includes("## 二、精华总结") && mobileDocMarkdown.includes("### 一句话结论") && mobileDocMarkdown.includes("### 核心观点")),
  "true"
);
assertEqual(
  "youtube Feishu doc keeps all opening primers in background section",
  String([
    "这段应该进入背景导读",
    "**背景导读：**",
    "**市场/技术环境：**"
  ].every((needle) => {
    const index = mobileDocMarkdown.indexOf(needle);
    const laterSections = [
      mobileDocMarkdown.indexOf("## 四、关键技术点速览"),
      mobileDocMarkdown.indexOf("## 五、详细技术拆解"),
      mobileDocMarkdown.indexOf("## 六、时间线摘要")
    ].filter((value) => value >= 0);
    const firstLaterSection = Math.min(...laterSections);
    return index > mobileDocMarkdown.indexOf("## 二、背景导读") && index < mobileDocMarkdown.indexOf("## 三、导读与核心结论") && firstLaterSection > 0;
  })),
  "true"
);
assertEqual(
  "youtube Feishu doc formats background term glossary",
  String(mobileDocMarkdown.includes("## 一、关键术语解释") && mobileDocMarkdown.includes("- **Starship / 星舰：** 通常指 SpaceX 的超重型运载系统中的上面级飞船。") && mobileDocMarkdown.includes("- **Super Heavy / 超重型助推器：** 星舰系统的一级助推器，负责把飞船推到接近入轨条件。") && mobileDocMarkdown.includes("- **长船与龙船：** Viking longship 指维京长船，核心优势是速度和浅水航行。") && !mobileDocMarkdown.includes("- Starship / 星舰\n- 通常指") && !mobileDocMarkdown.includes("术语解释：长船与龙船")),
  "true"
);
assertEqual(
  "youtube Feishu doc bolds reader labels",
  String(mobileDocMarkdown.includes("**市场/技术环境：** 这里同样属于背景，不属于正文观点。")),
  "true"
);
assertEqual(
  "youtube Feishu doc strips machine generated youtube note headings",
  String(!/this\s+YouTube\s+技术笔记/i.test(mobileDocMarkdown) && !/it\s+YouTube\s+技术笔记/i.test(mobileDocMarkdown) && !/100 times heavier\s+YouTube\s+技术笔记/i.test(mobileDocMarkdown)),
  "true"
);
assertEqual(
  "youtube Feishu doc strips assistant process prefaces",
  String(!mobileDocMarkdown.includes("我先按你给的时间戳骨架") && !mobileDocMarkdown.includes("接下来我会把") && !mobileDocMarkdown.includes("可直接进 Obsidian/飞书")),
  "true"
);
assertEqual(
  "youtube Feishu doc strips combined process-preface variants",
  String(
    !mobileDocMarkdown.includes("我先接下来我会") &&
    !mobileDocMarkdown.includes("我先按接下来") &&
    !mobileDocMarkdown.includes("我会把这条视频整理") &&
    !mobileDocMarkdown.includes("我会把视频内容串成") &&
    !mobileDocMarkdown.includes("接下来我会把 SpaceX") &&
    !mobileDocMarkdown.includes("发到飞书文档") &&
    !mobileDocMarkdown.includes("可直接进 Obsidian/飞书")
  ),
  "true"
);
assertEqual(
  "youtube Feishu doc keeps process-like phrases inside transcript evidence blocks",
  String(mobileDocMarkdown.includes("我会把这句话保留在原文索引里，因为这是视频字幕证据，不是模型过程话。")),
  "true"
);
assertEqual(
  "youtube Feishu doc keeps reader-grade required sections",
  String([
    "## 一、关键术语解释",
    "## 二、背景导读",
    "## 三、导读与核心结论",
    "## 四、关键技术点速览",
    "## 六、时间线摘要",
    "## 七、值得继续追问的问题",
    "## 八、出处与链接"
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
  String(vikingFallbackDoc.includes("长船带来的机动性") && vikingFallbackDoc.includes("## 一、关键术语解释") && vikingFallbackDoc.includes("**Longship / 长船：**") && !vikingFallbackDoc.includes("产业判断、工程取舍和商业后果")),
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
  markdown: "# Building the Best GPU Possible\n\n## 二、精华总结\n### 一句话结论\nGPU 的瓶颈不只是算力，也包括内存带宽。\n- 为什么重要：内存带宽会限制并行计算实际效率。\n- 风险或不确定性：缓存局部性和软件栈也会改变瓶颈位置。"
});
assertEqual(
  "youtube Feishu doc fallback questions are keyword-specific for any topic",
  String(keywordFallbackDoc.includes("Memory") || keywordFallbackDoc.includes("bandwidth") || keywordFallbackDoc.includes("GPU")),
  "true"
);
assertEqual(
  "youtube Feishu doc indents reader label bullets",
  String(keywordFallbackDoc.includes("  - **视频里怎么说：**") && keywordFallbackDoc.includes("  - **为什么重要：**") && keywordFallbackDoc.includes("  - **风险或不确定性：**")),
  "true"
);

const hlsEvidenceBrief = {
  thesis: "Starship HLS 的核心难题不是单次抵达月球，而是把多次发射、LEO 补加注、月球轨道转移和月面着陆串成可重复执行的任务链。",
  titleAngles: [
    "为什么 Starship HLS 会把月球任务变成一条复杂补加注链",
    "月球版星舰的真正难题：不是飞到月球，而是把补加注链条跑通",
    "从 100 times heavier 到 12 次补加注：Starship HLS 的系统赌局"
  ],
  narrativeConflict: "视频的核心冲突是：Starship HLS 的体量优势让月球任务拥有更大载荷潜力，但同样把任务复杂度从单枚火箭扩展成一条轨道物流链。",
  backgroundAnchors: ["Starship HLS", "100 times heavier", "12 or more launches", "LEO refueling", "high mounted landing thrusters", "self leveling legs"],
  glossarySeeds: [
    { term: "Starship HLS", evidence: "Starship HLS", plainMeaning: "SpaceX 为 NASA 阿尔忒弥斯月球任务设计的星舰月球着陆器版本。" },
    { term: "LEO", evidence: "LEO refueling", plainMeaning: "近地轨道，常作为补加注和任务集结的中转位置。" },
    { term: "高位着陆推进器", evidence: "high mounted landing thrusters", plainMeaning: "安装在较高位置、用于月面末端着陆的推进器，避免主发动机直接冲刷月面。" }
  ],
  evidenceClaims: [
    { claim: "100 times heavier 把任务从火箭性能问题变成轨道物流问题", timestamp: "0:00", quote: "100 times heavier", whyItMatters: "体量越大，越需要补加注和任务链管理。" },
    { claim: "12 次以上补加注意味着可靠性被连续相乘", timestamp: "1:20", quote: "12 or more launches", whyItMatters: "每次发射和对接都会成为任务风险节点。" },
    { claim: "LEO 补加注是 HLS 任务的前置条件", timestamp: "3:40", quote: "LEO refueling", whyItMatters: "月球任务先变成近地轨道燃料组织问题。" },
    { claim: "高位着陆推进器暴露月尘和发动机布局约束", timestamp: "6:10", quote: "high mounted landing thrusters", whyItMatters: "末端环境会倒逼飞船结构设计。" },
    { claim: "自调平腿把宏大任务落到机械可靠性", timestamp: "8:30", quote: "self leveling legs", whyItMatters: "月面不平整会影响乘员出舱和返航准备。" },
    { claim: "HLS 成败取决于整条任务链是否稳定", timestamp: "10:00", quote: "mission chain", whyItMatters: "单点成功不能代表系统可用。" }
  ],
  timelineSeeds: [
    { time: "0:00", event: "视频提出 HLS 重量和传统方案不是一个尺度。", importance: "建立全文主矛盾。", quote: "100 times heavier" },
    { time: "1:20", event: "转入多次发射和补加注讨论。", importance: "说明任务复杂度来自链条。", quote: "12 or more launches" },
    { time: "3:40", event: "解释 LEO 补加注的作用。", importance: "把读者视角从火箭性能转到轨道物流。", quote: "LEO refueling" },
    { time: "6:10", event: "讨论月面着陆推进器布局。", importance: "展示末端环境约束。", quote: "high mounted landing thrusters" },
    { time: "8:30", event: "提到着陆腿和姿态稳定。", importance: "把宏大任务落到机械可靠性。", quote: "self leveling legs" },
    { time: "10:00", event: "回到任务链条的可靠性问题。", importance: "形成结论闭环。", quote: "mission chain" }
  ],
  questionSeeds: [
    "12 次以上补加注的单次成功率需要达到什么水平？",
    "LEO 推进剂转移最先需要验证的是对接、低温保存还是流体管理？",
    "高位着陆推进器会给结构重量和控制系统带来多大代价？",
    "自调平腿在真实月面坡度和尘土条件下的失败模式是什么？",
    "如果某次 tanker 发射延迟，HLS 任务窗口如何重新排布？"
  ]
};
const hlsArticle = {
  title: "月球版星舰的真正难题：不是飞到月球，而是把补加注链条跑通",
  opening: {
    contextParagraphs: [
      "这条视频讨论的是 Starship HLS、LEO 轨道补加注、月球任务链条和月面着陆之间的关系。它不是在争论星舰能不能飞起来，而是在解释为什么一次月球任务会牵出多次发射、推进剂转移和高位着陆推进器这些工程约束。",
      "读者先要抓住一个矛盾：Starship HLS 体量巨大，月球任务需要的不是单次发射表演，而是一整套可重复执行的轨道物流。视频里的关键线索包括 100 times heavier、12 次以上补加注、高位着陆推进器、自调平腿和 LEO 补加注。"
    ],
    glossary: [
      { term: "Starship HLS", explanation: "SpaceX 为 NASA 阿尔忒弥斯月球任务设计的星舰月球着陆器版本。" },
      { term: "LEO", explanation: "近地轨道，常作为补加注和任务集结的中转位置。" },
      { term: "高位着陆推进器", explanation: "安装在较高位置、用于月面末端着陆的推进器，避免主发动机直接冲刷月面。" }
    ],
    oneSentence: "Starship HLS 的核心挑战不是单点性能，而是能否把多次发射、轨道补加注和月面着陆变成稳定任务链。",
    corePoints: [
      { title: "100 times heavier 把任务从火箭问题变成物流问题", evidence: "100 times heavier", why: "体量越大，越不能只看单次发射能力，必须看轨道补给链是否可重复。", takeaway: "这类任务的瓶颈在系统调度，不在一句参数口号。" },
      { title: "12 次以上补加注意味着可靠性被连续相乘", evidence: "12 or more launches", why: "每多一次发射和对接，任务链条就多一个可能延迟或失败的节点。", takeaway: "补加注不是附属动作，而是任务成败的主线。" },
      { title: "高位着陆推进器暴露了月尘和发动机布局约束", evidence: "high mounted landing thrusters", why: "月面环境会反过来改变飞船末端着陆设计。", takeaway: "真正的工程难题往往出现在最后几十米。" }
    ],
    quotes: [
      { title: "任务重量", original: "100 times heavier", meaning: "视频用重量差异说明 HLS 和传统月球着陆器不是一个尺度的问题。", implication: "尺度变化会把原来的工程题改写成系统题。" },
      { title: "补加注次数", original: "12 or more launches", meaning: "这句话把月球任务的复杂度压缩成一个可感知数字。", implication: "读者应该追问每个数字背后的链路可靠性。" }
    ],
    counterintuitive: [
      "月球任务最难的部分可能不是登陆，而是在近地轨道把燃料补齐。",
      "更大的飞船不一定带来更简单的任务，可能先带来更复杂的发射链。",
      "着陆腿和推进器位置这类细节，可能决定整套宏大方案能否落地。"
    ]
  },
  techPoints: [
    { name: "轨道补加注", says: "视频把多次 tanker 发射作为 HLS 完成任务的前置条件。", importance: "它决定任务是否从一次发射变成一条发射流水线。", risk: "任何一次延迟都会影响整体窗口。" },
    { name: "高位着陆推进器", says: "着陆阶段不能只依赖主发动机直接冲刷月面。", importance: "这关系到月尘、结构安全和着陆稳定性。", risk: "真实月面环境验证不足。" },
    { name: "自调平腿", says: "着陆器需要处理月面不平整带来的姿态问题。", importance: "乘员出舱和返航前准备都依赖稳定平台。", risk: "机构复杂度和冗余设计会增加重量。" }
  ],
  detailSections: [
    { title: "为什么补加注链条是主线", bullets: ["HLS 不是把一枚火箭发到月球那么简单，而是需要先在 LEO 建立推进剂条件。", "这会把任务成败拆成发射节奏、对接、转移、保存和窗口管理。"] },
    { title: "为什么着陆设计不能照搬地球经验", bullets: ["月面没有大气，发动机羽流和月尘会直接影响着陆安全。", "高位推进器和自调平腿都是为末端环境付出的设计代价。"] },
    { title: "商业含义", bullets: ["如果补加注链条跑通，Starship 不只是着陆器，而会变成深空运输基础设施。", "如果跑不通，HLS 的体量优势会变成任务复杂度负担。"] }
  ],
  timeline: hlsEvidenceBrief.timelineSeeds.map((item) => ({ time: item.time, event: item.event, importance: item.importance, evidence: item.quote })),
  questions: hlsEvidenceBrief.questionSeeds
};
const hlsOpeningPart = {
  title: hlsArticle.title,
  contextParagraphs: hlsArticle.opening.contextParagraphs
};
const hlsGlossaryPart = {
  glossary: hlsArticle.opening.glossary
};
const hlsCorePart = {
  oneSentence: hlsArticle.opening.oneSentence,
  corePoints: hlsArticle.opening.corePoints,
  quotes: hlsArticle.opening.quotes,
  counterintuitive: hlsArticle.opening.counterintuitive
};
const hlsTechPart = {
  techPoints: hlsArticle.techPoints,
  detailSections: hlsArticle.detailSections
};
const hlsTimelinePart = {
  timeline: hlsArticle.timeline,
  questions: hlsArticle.questions
};
let structuredChatCalls = 0;
let articlePromptIncludedEvidenceBrief = false;
const structuredResponseFormats = [];
const structuredPromptText = [];
bot.ai = {
  chat: async (messages = [], options = {}) => {
    structuredChatCalls += 1;
    structuredResponseFormats.push(options.responseFormat?.type || "");
    structuredPromptText.push(messages.map((message) => String(message.content || "")).join("\n"));
    const userContent = String(messages.at(-1)?.content || "");
    if (userContent.includes("Focus only on article thesis")) {
      return JSON.stringify({
        thesis: hlsEvidenceBrief.thesis,
        titleAngles: hlsEvidenceBrief.titleAngles,
        narrativeConflict: hlsEvidenceBrief.narrativeConflict,
        backgroundAnchors: hlsEvidenceBrief.backgroundAnchors
      });
    }
    if (userContent.includes("Focus only on beginner glossary terms")) {
      return JSON.stringify({
        glossarySeeds: hlsEvidenceBrief.glossarySeeds,
        evidenceClaims: hlsEvidenceBrief.evidenceClaims
      });
    }
    articlePromptIncludedEvidenceBrief = articlePromptIncludedEvidenceBrief ||
      (userContent.includes("Evidence brief that must drive") && userContent.includes('"thesis"'));
    if (userContent.includes("fixed title/background schema")) return JSON.stringify(hlsOpeningPart);
    if (userContent.includes("fixed glossary schema")) return JSON.stringify(hlsGlossaryPart);
    if (userContent.includes("fixed core schema")) return JSON.stringify(hlsCorePart);
    if (userContent.includes("fixed technical schema")) return JSON.stringify(hlsTechPart);
    return JSON.stringify(hlsTimelinePart);
  }
};
const structuredDoc = await bot.generateYoutubeResearchMarkdown({
  topic: "Starship HLS",
  request: { raw: "https://youtu.be/test" },
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
  }]
});
const structuredFeishuDoc = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "Starship HLS",
  title: "月球版星舰的真正难题：不是飞到月球，而是把补加注链条跑通",
  markdown: structuredDoc,
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
  }]
});
const structuredFeishuDocFromSlots = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "Starship HLS",
  title: "月球版星舰的真正难题：不是飞到月球，而是把补加注链条跑通",
  markdown: "我先按时间戳骨架整理成中文技术简报，接下来我会把内容发到飞书。",
  evidenceBrief: hlsEvidenceBrief,
  structuredArticle: hlsArticle,
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
  }]
});
assertEqual(
  "youtube structured pipeline renders reader-grade article",
  String(structuredFeishuDoc.includes("## 一、关键术语解释") && structuredFeishuDoc.includes("## 二、背景导读") && structuredFeishuDoc.includes("## 三、导读与核心结论") && structuredFeishuDoc.includes("## 四、关键技术点速览") && structuredFeishuDoc.includes("## 八、出处与链接") && !structuredFeishuDoc.includes("YouTube 技术笔记") && !structuredFeishuDoc.includes("我先按")),
  "true"
);
assertEqual(
  "youtube Feishu publishing uses structured slots instead of contaminated markdown when available",
  String(structuredFeishuDocFromSlots.includes("## 一、关键术语解释") && structuredFeishuDocFromSlots.includes("Starship HLS") && !structuredFeishuDocFromSlots.includes("我先按时间戳骨架") && !structuredFeishuDocFromSlots.includes("接下来我会")),
  "true"
);
assertEqual(
  "youtube guided blueprint is not rewrapped by legacy summary logic",
  String(!structuredFeishuDoc.includes("### 核心结论") && structuredFeishuDoc.indexOf("## 一、关键术语解释") < structuredFeishuDoc.indexOf("## 二、背景导读") && structuredFeishuDoc.indexOf("## 二、背景导读") < structuredFeishuDoc.indexOf("## 三、导读与核心结论") && structuredFeishuDoc.indexOf("### 原文摘录") > structuredFeishuDoc.indexOf("## 六、时间线摘要") && structuredFeishuDoc.indexOf("## 八、出处与链接") > structuredFeishuDoc.indexOf("## 七、值得继续追问的问题")),
  "true"
);
const finalCoreSection = sectionBetween(structuredFeishuDoc, "## 三、导读与核心结论", "## 四、关键技术点速览");
const finalGlossaryText = sectionBetween(structuredFeishuDoc, "## 一、关键术语解释", "## 二、背景导读");
const finalBackgroundText = sectionBetween(structuredFeishuDoc, "## 二、背景导读", "## 三、导读与核心结论");
const finalTimelineSection = sectionBetween(structuredFeishuDoc, "## 六、时间线摘要", "## 七、值得继续追问的问题");
const finalQuestionsSection = sectionBetween(structuredFeishuDoc, "## 七、值得继续追问的问题", "## 八、出处与链接");
assertEqual(
  "youtube finished article snapshot has no duplicated title",
  String(countOccurrences(structuredFeishuDoc, hlsArticle.title) === 0),
  "true"
);
assertEqual(
  "youtube finished article snapshot puts glossary before background",
  String(structuredFeishuDoc.indexOf("## 一、关键术语解释") < structuredFeishuDoc.indexOf("## 二、背景导读") && structuredFeishuDoc.indexOf("## 二、背景导读") < structuredFeishuDoc.indexOf("## 三、导读与核心结论")),
  "true"
);
assertEqual(
  "youtube finished article snapshot has beginner glossary first",
  String(countBullets(finalGlossaryText) >= 3 && finalGlossaryText.includes("Starship HLS") && finalGlossaryText.includes("LEO")),
  "true"
);
assertEqual(
  "youtube finished article snapshot has focused background prose",
  String(finalBackgroundText.length > 120 && finalBackgroundText.length < 1000),
  "true"
);
assertEqual(
  "youtube finished article snapshot background is prose not bullet wall",
  String(!/^[-*]\s+/m.test(finalBackgroundText)),
  "true"
);
assertEqual(
  "youtube finished article snapshot keeps opening as reader-first article structure",
  String(finalCoreSection.includes("### 一句话结论") && finalCoreSection.includes("### 核心观点") && finalCoreSection.includes("### 标志性金句") && finalCoreSection.includes("### 最反共识的判断") && countOccurrences(finalCoreSection, "## 一、关键术语解释") === 0 && countOccurrences(finalCoreSection, "## 二、背景导读") === 0),
  "true"
);
assertEqual(
  "youtube finished article snapshot keeps timeline clean",
  String(!finalTimelineSection.includes("**为什么重要：**") && !finalTimelineSection.includes("**读者该抓住什么：**") && !finalTimelineSection.includes("### 核心观点") && finalTimelineSection.includes("### 原文摘录")),
  "true"
);
assertEqual(
  "youtube finished article snapshot keeps follow-up questions as questions",
  String(countBullets(finalQuestionsSection) >= 4 && !finalQuestionsSection.includes("**为什么重要：**") && !finalQuestionsSection.includes("**读者该抓住什么：**") && !finalQuestionsSection.includes("### 原文摘录")),
  "true"
);

let repairedReaderAuditDoc = "";
let rejectedReaderAuditFailure = false;
try {
  repairedReaderAuditDoc = bot.buildFeishuYoutubeDocumentMarkdown({
    topic: "Starship HLS",
    title: "月球版星舰的真正难题：不是飞到月球，而是把补加注链条跑通",
    videos: [{
      title: "100 times heavier",
      channel: "Test Channel",
      language: "en",
      url: "https://www.youtube.com/watch?v=testhls",
      transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
    }],
    markdown: [
      "# 月球版星舰的真正难题：不是飞到月球，而是把补加注链条跑通",
      "## 一、关键术语解释",
      "- **Starship HLS：** 月球着陆器。",
      "- **LEO：** 近地轨道。",
      "- **depot：** 轨道燃料库。",
      "## 二、背景导读",
      "- 背景被写成 bullet 墙。",
      "- 这会破坏第一屏阅读体验。",
      "## 三、导读与核心结论",
      "### 一句话结论",
      "HLS 的难点是任务链。",
      "### 核心观点",
      "#### 1. 补加注是主线",
      "> evidence",
      "### 标志性金句",
      "#### 1. evidence",
      "> quote",
      "### 最反共识的判断",
      "- 不是单次发射。",
      "## 四、关键技术点速览",
      "#### 1. 补加注",
      "  - **视频里怎么说：** evidence",
      "## 五、详细技术拆解",
      "### 1. 任务链",
      "- evidence",
      "## 六、时间线摘要",
      "- [0:00] evidence",
      "### 原文摘录",
      "```text",
      "[0:00] 100 times heavier.",
      "```",
      "## 七、值得继续追问的问题",
      "- 问题一？",
      "- 问题二？",
      "- 问题三？",
      "- 问题四？",
      "## 八、出处与链接",
      "https://www.youtube.com/watch?v=testhls"
    ].join("\n")
  });
} catch {
  rejectedReaderAuditFailure = true;
}
assertEqual(
  "youtube finished article reader audit repairs bullet-wall background instead of rejecting the whole document",
  String(rejectedReaderAuditFailure),
  "false"
);
assertEqual(
  "youtube finished article reader audit keeps repaired background reader-friendly",
  String(!/## 二、背景导读[\s\S]{0,120}\n\s*[-*]\s+/.test(repairedReaderAuditDoc) && repairedReaderAuditDoc.includes("## 八、出处与链接")),
  "true"
);
assertEqual(
  "youtube structured pipeline plans from evidence before writing",
  String(structuredChatCalls === 7 && articlePromptIncludedEvidenceBrief),
  "true"
);
assertEqual(
  "youtube structured pipeline asks model for json object directly",
  String(structuredResponseFormats.join(",") === "json_object,json_object,json_object,json_object,json_object,json_object,json_object"),
  "true"
);
assertEqual(
  "youtube structured pipeline positively guides each writing slot",
  String([
    "Generation contract: get the direction right before writing",
    "Do not produce low-quality draft content and rely on later rejection or cleanup",
    "Plan from evidence first",
    "The model fills bounded content fields; code owns layout",
    "Deterministic evidence package extracted by code",
    "Focus only on article thesis",
    "Focus only on beginner glossary terms",
    "Write paragraph 1 as `video scene and viewing context`",
    "Each explanation should answer",
    "Each corePoints title should be a judgment sentence",
    "techPoints should be scan-friendly",
    "Timeline is not a transcript dump"
  ].every((needle) => structuredPromptText.join("\n").includes(needle))),
  "true"
);
assertEqual(
  "youtube structured pipeline applies generation-first contract to every model slot",
  String(structuredPromptText.length === 7 && structuredPromptText.every((prompt) =>
    prompt.includes("Generation contract: get the direction right before writing") &&
    prompt.includes("Plan from evidence first") &&
    prompt.includes("The model fills bounded content fields; code owns layout")
  )),
  "true"
);

const feishuSource = fs.readFileSync(new URL("../src/feishu.js", import.meta.url), "utf8");
const feishuWorkspaceSource = fs.readFileSync(new URL("../src/feishu-workspace.js", import.meta.url), "utf8");
const storageSource = fs.readFileSync(new URL("../src/storage.js", import.meta.url), "utf8");
assertEqual(
  "generation architecture defines one shared generation-first contract",
  String(
    feishuSource.includes("const GENERATION_FIRST_PRINCIPLES") &&
    feishuSource.includes("Do not produce low-quality draft content and rely on later rejection or cleanup") &&
    feishuSource.includes("Plan from evidence first") &&
    feishuSource.includes("code owns layout")
  ),
  "true"
);
assertEqual(
  "investment report pipeline records generation-first principle before synthesis",
  String(
    feishuSource.includes("generation_direction_first") &&
    feishuSource.includes("do_not_generate_garbage_then_reject") &&
    /generationFirstPrinciplesText\(\),[\s\S]{0,500}You are a senior long-term industry-chain investment research analyst/.test(feishuSource)
  ),
  "true"
);
const indexSource = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
assertEqual(
  "investment report jobs are restart-resumable instead of disappearing during deploys",
  String(
    feishuSource.includes("resumeInterruptedInvestmentReports") &&
    feishuSource.includes("interrupted_rescheduled") &&
    feishuSource.includes("interrupted_unresumable") &&
    /delivery:\s*\{[\s\S]{0,120}messageId,[\s\S]{0,120}chatId,[\s\S]{0,120}userId/.test(feishuSource) &&
    indexSource.includes("resumeInterruptedInvestmentReports")
  ),
  "true"
);
assertEqual(
  "investment report synthesis does not route timeout reports through weak fallback json",
  String(
    /allowFallback:\s*false,[\s\S]{0,80}requirePrimary:\s*true/.test(feishuSource) &&
    feishuSource.includes("primary_model_synthesis_failed_no_baseline_report_published") &&
    !feishuSource.includes("已先用证据基线模式生成报告")
  ),
  "true"
);
assertEqual(
  "investment report publishing requires rich Feishu blocks for evidence anchors",
  String(
    /createWikiDocument\(\{[\s\S]{0,220}requireRichMarkdown:\s*true/.test(feishuSource)
  ),
  "true"
);
assertEqual(
  "YouTube and investment Feishu documents notify the configured article group",
  String(
    feishuSource.includes("async notifyArticleGroup") &&
    feishuSource.includes("sendTextToChat") &&
    feishuSource.includes("articleGroupSourceType: \"YouTube 精读\"") &&
    feishuSource.includes("articleGroupSourceType: \"投研报告\"")
  ),
  "true"
);
assertEqual(
  "YouTube result card avoids machine-note wording",
  String(!feishuSource.includes("YouTube 技术笔记已整理") && !feishuSource.includes("YouTube 技术笔记待归档")),
  "true"
);
assertEqual(
  "Feishu documents render the group entry as a native chat card before falling back to a link",
  String(
    feishuWorkspaceSource.includes("insertArticleGroupChatCard") &&
    feishuWorkspaceSource.includes("block_type: 20") &&
    feishuWorkspaceSource.includes("chat_card") &&
    feishuWorkspaceSource.includes("linkedTextBlock(\"加入群聊\"")
  ),
  "true"
);

assertEqual(
  "YouTube Feishu documents can derive a stable thumbnail URL for document cover placement",
  feishuYoutubeThumbnailUrl("https://youtu.be/E7MQb9Y4FAE?si=Qwp_G2Nc9Gl2ht_2"),
  "https://i.ytimg.com/vi/E7MQb9Y4FAE/hqdefault.jpg"
);
assertEqual(
  "YouTube Feishu document publishing passes sourceUrl into real DocX cover application",
  String(
    feishuSource.includes("const sourceUrl = report.videos?.[0]?.url") &&
    /createWikiDocument\(\{[\s\S]{0,180}markdown,[\s\S]{0,80}sourceUrl/.test(feishuSource) &&
    /createDocument\(\{[\s\S]{0,160}markdown,[\s\S]{0,80}sourceUrl/.test(feishuSource) &&
    feishuWorkspaceSource.includes("applyDocumentCoverImage") &&
    feishuWorkspaceSource.includes("/open-apis/drive/v1/medias/upload_all") &&
    feishuWorkspaceSource.includes("parent_type\", \"docx_image\"") &&
    feishuWorkspaceSource.includes("update_cover") &&
    /const coverResult = await this\.applyDocumentCoverImage/.test(feishuWorkspaceSource)
  ),
  "true"
);
assertEqual(
  "Feishu documents enable reader-facing document statistics when created",
  String(
    feishuWorkspaceSource.includes("applyDocumentDisplaySettings") &&
    feishuWorkspaceSource.includes("update_display_setting") &&
    feishuWorkspaceSource.includes("show_authors: true") &&
    feishuWorkspaceSource.includes("show_create_time: true") &&
    feishuWorkspaceSource.includes("show_pv: true") &&
    feishuWorkspaceSource.includes("show_uv: true") &&
    feishuWorkspaceSource.includes("show_like_count: true") &&
    feishuWorkspaceSource.includes("show_comment_count: true") &&
    feishuWorkspaceSource.includes("show_related_matters: true")
  ),
  "true"
);
assertEqual(
  "Feishu documents apply sharing permissions matching the reader screenshot",
  String(
    feishuWorkspaceSource.includes("applyDocumentPermissionSettings") &&
    feishuWorkspaceSource.includes("/open-apis/drive/v2/permissions/") &&
    feishuWorkspaceSource.includes("external_access_entity: \"open\"") &&
    feishuWorkspaceSource.includes("manage_collaborator_entity: \"collaborator_full_access\"") &&
    feishuWorkspaceSource.includes("copy_entity: \"anyone_can_view\"") &&
    feishuWorkspaceSource.includes("security_entity: \"only_full_access\"") &&
    feishuWorkspaceSource.includes("comment_entity: \"anyone_can_view\"") &&
    feishuWorkspaceSource.includes("link_share_entity: \"tenant_readable\"") &&
    /const permissionSettingsResult = await this\.applyDocumentPermissionSettings/.test(feishuWorkspaceSource)
  ),
  "true"
);
assertEqual(
  "research knowledge base reuses entities by natural key instead of failing on duplicate entity ids",
  String(
    storageSource.includes("ON CONFLICT (name, entity_type)") &&
    storageSource.includes("effectiveEntityId") &&
    storageSource.includes("metadata = research_entities.metadata ||")
  ),
  "true"
);

bot.storage = {
  getSetting: async (_key, fallback) => fallback,
  getResearchTopicMap: async () => ({
    topics: [
      {
        topicKey: "spacex",
        canonicalName: "SpaceX",
        topicType: "company",
        aliases: ["Starship", "Starfactory", "100 times heavier YouTube 技术笔记", "阅读导航"]
      },
      {
        topicKey: "starship",
        canonicalName: "Starship",
        topicType: "technology_or_product",
        aliases: ["星舰"]
      }
    ],
    edges: [
      {
        fromTopicKey: "spacex",
        fromName: "SpaceX",
        toTopicKey: "starship",
        toName: "Starship",
        edgeType: "develops",
        evidenceCount: 3
      }
    ]
  }),
  getPriorInvestmentReport: async () => ({
    id: "job:prior-spacex",
    versionNo: 1,
    evidenceCutoffAt: "2026-07-01T00:00:00.000Z",
    output: { title: "SpaceX 产业链报告 v1", feishuDocUrl: "https://example.feishu.cn/wiki/prior" },
    metadata: {
      title: "SpaceX 产业链报告 v1",
      oneSentence: "上一版认为产线化是核心观察点。",
      thesis: "上一版判断只作为基线。"
    }
  }),
  getReusableInvestmentReport: async () => null,
  listResearchEvidenceForReport: async () => ({
    topicMap: {
      topics: [
        { topicKey: "spacex", canonicalName: "SpaceX", topicType: "company", aliases: ["Starship", "Starfactory"] },
        { topicKey: "starship", canonicalName: "Starship", topicType: "technology_or_product", aliases: ["星舰", "some pretty advanced concepts YouTube 技术笔记"] }
      ],
      edges: [
        { fromTopicKey: "spacex", fromName: "SpaceX", toTopicKey: "starship", toName: "Starship", edgeType: "develops", evidenceCount: 3 }
      ]
    },
    sources: [
      {
        sourceId: "source:spacex-video-1",
        sourceType: "video",
        platform: "youtube",
        title: "Inside Starfactory YouTube 技术笔记",
        organization: "Everyday Astronaut",
        publishedAt: "2024-06",
        recordedAt: "2024",
        eventPeriod: "Starfactory ramp-up",
        url: "https://youtube.com/watch?v=starfactory",
        docUrl: "https://example.feishu.cn/wiki/source1",
        conflictProfile: "speaker_and_company_access_bias_possible"
      },
      {
        sourceId: "source:spacex-video-2",
        sourceType: "video",
        platform: "youtube",
        title: "Starship Production Discussion",
        organization: "Public expert media",
        publishedAt: "2025",
        recordedAt: "2025",
        eventPeriod: "Starship flight-test iteration",
        url: "https://youtube.com/watch?v=starship2"
      }
    ],
    evidenceCards: [
      { sourceId: "source:spacex-video-1", evidenceType: "supply_chain", claim: "Starfactory 的核心变量是把星舰制造从项目制推向产线化。", quoteOriginal: "We need to build ships like aircraft.", location: "12:10", whyItMatters: "产线节拍决定成本曲线和供应链需求。", confidence: 0.82, timeSensitivity: "high", evidenceStrength: "primary_transcript", analysisLens: "supply_chain" },
      { sourceId: "source:spacex-video-1", evidenceType: "technology", claim: "不锈钢结构和大尺寸箭体让制造工艺成为瓶颈。", quoteOriginal: "The factory is the product.", location: "18:20", whyItMatters: "制造良率比单次发射展示更能解释长期能力。", confidence: 0.78, timeSensitivity: "medium", evidenceStrength: "primary_transcript", analysisLens: "technology" },
      { sourceId: "source:spacex-video-1", evidenceType: "commercialization", claim: "星舰产能会影响 Starlink 与深空任务的商业节奏。", quoteOriginal: "Launch cadence changes everything.", location: "24:00", whyItMatters: "高频发射是商业闭环的前提。", confidence: 0.74, timeSensitivity: "high", evidenceStrength: "primary_transcript", analysisLens: "commercialization" },
      { sourceId: "source:spacex-video-2", evidenceType: "risk", claim: "监管、试飞事故和发动机可靠性可能打断产线节奏。", quoteOriginal: "Delays can reset the cadence.", location: "06:40", whyItMatters: "产业链机会必须看约束而不是只看愿景。", confidence: 0.73, timeSensitivity: "high", evidenceStrength: "expert_video", analysisLens: "risk" },
      { sourceId: "source:spacex-video-2", evidenceType: "supply_chain", claim: "猛禽发动机产能是星舰放量的关键约束之一。", quoteOriginal: "Raptor production is the pacing item.", location: "09:30", whyItMatters: "发动机节拍会外溢到材料、测试和制造设备需求。", confidence: 0.76, timeSensitivity: "medium", evidenceStrength: "expert_video", analysisLens: "supply_chain" },
      { sourceId: "source:spacex-video-2", evidenceType: "market_financial", claim: "单次发射成本下降是产业链投资价值的核心假设，但仍需外部数据验证。", quoteOriginal: "Cost per launch is the unlock.", location: "14:15", whyItMatters: "成本假设决定商业航天需求弹性。", confidence: 0.7, timeSensitivity: "high", evidenceStrength: "expert_video", analysisLens: "market_financial" },
      { sourceId: "source:spacex-video-2", evidenceType: "technology", claim: "### 100 times heavier YouTube 技术笔记", quoteOriginal: "", location: "legacy_heading", whyItMatters: "阅读导航", confidence: 0.1, timeSensitivity: "low", evidenceStrength: "generated_article_backfill", analysisLens: "technology" }
    ],
    entities: [
      { sourceId: "source:spacex-video-1", name: "SpaceX", entityType: "company", role: "subject" },
      { sourceId: "source:spacex-video-1", name: "Starfactory", entityType: "infrastructure", role: "production_site" },
      { sourceId: "source:spacex-video-2", name: "Raptor", entityType: "technology_or_product", role: "engine" }
    ],
    timeContexts: [
      {
        sourceId: "source:spacex-video-1",
        videoPublishedAt: "2024-06",
        likelyRecordedAt: "2024",
        eventPeriod: "Starfactory ramp-up",
        currentRelevance: "需要用后续试飞、监管和产能数据更新判断。",
        timeSensitivity: "high",
        staleIf: "Starship flight cadence, FAA approvals, or Raptor production changes materially."
      }
    ],
    questions: [
      { sourceId: "source:spacex-video-1", question: "Raptor 月产能是否能支持目标发射节奏？", priority: 1, researchDirection: "supply_chain_validation" }
    ],
    coverageGaps: [
      { sourceId: "source:spacex-video-1", gap: "缺少独立产能和成本数据", impact: "不能只用访谈判断投资机会。", confidenceImpact: "high" }
    ]
  }),
  updateResearchJob: async () => {}
};
let investmentReportSegmentedCalls = 0;
bot.ai = {
  chat: async () => {
    investmentReportSegmentedCalls += 1;
    return JSON.stringify({
      title: "SpaceX 的真正变量：星舰工厂能否把火箭制造变成高频产线",
      oneSentence: "现有证据更支持把 SpaceX 研究重点放在产线节拍、发动机产能和监管约束，而不是单次试飞成败。",
      thesis: "Starfactory 的产业意义在于把火箭制造从项目制推向接近航空制造的节拍，但这个判断必须同时受 Raptor 产能、FAA 节奏和成本数据约束。",
      topicBoundary: "本报告只讨论 SpaceX 星舰制造和商业航天供应链，不把上一版报告当作新证据，也不覆盖短线交易建议。",
      industryMap: ["上游材料与焊接设备", "Raptor 发动机制造和测试", "整箭总装与地面设施", "发射监管与保险", "Starlink 和深空任务需求"],
      investableMap: ["不可把 SpaceX 本体直接当作可投资标的，应映射到发动机、材料、地面设施、卫星需求和监管服务等公开可跟踪环节。", "中国商业航天替代链条应单独比较技术路线和政策节奏。"],
      valuePools: ["若星舰产线化成立，价值池可能从单次发射转向发动机制造、测试设施、地面系统和卫星部署需求。", "真正兑现需要成本、产能和可靠性数据同时支持。"],
      peerComparison: ["SpaceX 与中国液氧甲烷商业火箭公司应比较发动机成熟度、发射场资源、监管节奏和客户需求。", "Starship 与 Falcon 9 的替代关系要看成本曲线和任务适配性。"],
      timeCalibration: ["主要视频证据来自 2024-2025 年，需要用 2026 年发射节奏复核。", "Starfactory 进度变化快，产能结论高度时间敏感。", "上一版报告只用于对比判断变化，不作为证据。"],
      deltaSincePrior: "相对上一版，本版把关注点从泛泛的产线化，收窄到发动机节拍、监管节奏和成本验证三条可跟踪线索。",
      evidenceBase: ["当前证据覆盖两个视频来源和六条证据卡，但缺少独立成本、产能和监管数据。"],
      hypotheses: [
        { title: "星舰产线化可能带动发动机、测试设备和地面设施需求", logic: "如果 Starfactory 形成稳定节拍，瓶颈会外溢到 Raptor 与测试环节。", evidenceIds: ["E1", "E5"], counterEvidenceIds: ["E4"], timeRisk: "监管或试飞事故会打断节拍。", confidence: "medium，因为证据来自公开视频，还缺独立产能数据。" },
        { title: "成本下降假设需要用外部数据验证", logic: "商业航天需求弹性取决于发射成本是否真实下降。", evidenceIds: ["E6"], counterEvidenceIds: [], timeRisk: "成本口径可能随任务类型变化。", confidence: "low-to-medium，仍需财务和发射数据验证。" },
        { title: "Starlink 需求可能是星舰早期商业闭环的重要牵引", logic: "高频发射能改善卫星部署节奏。", evidenceIds: ["E3"], counterEvidenceIds: ["E4"], timeRisk: "Starlink 发射需求与监管节奏可能错位。", confidence: "medium。" }
      ],
      valueChainNodes: [
        { node: "Raptor 发动机", whyItMatters: "发动机产能可能是星舰放量节拍项。", signals: ["月产量", "测试通过率"], risks: ["可靠性波动"], evidenceIds: ["E5"] },
        { node: "地面测试设施", whyItMatters: "测试能力决定产线是否能闭环。", signals: ["测试台数量", "返工率"], risks: ["事故停摆"], evidenceIds: ["E2"] },
        { node: "监管审批", whyItMatters: "FAA 节奏决定发射 cadence。", signals: ["审批周期", "事故调查时长"], risks: ["政策延迟"], evidenceIds: ["E4"] },
        { node: "发射成本", whyItMatters: "成本下降是商业需求扩张前提。", signals: ["单位发射成本", "复用次数"], risks: ["口径不透明"], evidenceIds: ["E6"] }
      ],
      leadingIndicators: ["Raptor 月产量", "Starship 年发射次数", "FAA 审批周期", "单次任务成本口径", "Starlink 发射需求"],
      catalystCalendar: [
        { horizon: "3-6 个月", event: "下一次 Starship 试飞和 FAA 审批进度", watch: "审批周期是否缩短，试飞是否支持更高 cadence", evidenceIds: ["E4"] },
        { horizon: "6-12 个月", event: "Raptor 产能和测试通过率线索", watch: "是否出现可量化月产能或测试数据", evidenceIds: ["E5"] }
      ],
      scenarios: [
        { name: "乐观情景", condition: "试飞、监管、发动机产能同步改善", implication: "地面设施、发动机和卫星部署链条优先受益", evidenceIds: ["E1", "E5"] },
        { name: "中性情景", condition: "工厂进展继续，但监管和成本数据仍不透明", implication: "维持观察清单，不形成强投资结论", evidenceIds: ["E4"] },
        { name: "悲观情景", condition: "监管延迟或发动机可靠性反复", implication: "产线化假设下修，相关供应链弹性推后", evidenceIds: ["E4", "E5"] }
      ],
      risks: ["视频来源存在公司访问偏差", "缺少独立成本数据", "监管节奏可能推翻产线假设", "发动机可靠性仍需验证"],
      timeContextRisks: ["2024 年工厂状态不能直接外推到 2026 年。", "试飞进度更新会迅速改变结论。"],
      falsificationConditions: ["若 FAA 审批周期持续拉长，年发射 cadence 假设下修。", "若 Raptor 产能和可靠性没有改善，产线化外溢需求假设下修。", "若独立成本数据不支持明显下降，商业需求弹性假设下修。"],
      nextResearchTasks: ["查 FAA 公开审批和事故调查记录", "追踪 Raptor 产能公开线索", "对比中国商业航天液氧甲烷路线", "补充 Starlink 发射需求数据", "寻找供应链设备和材料侧公开资料"]
    });
  }
};
const userPerspectiveReport = await bot.buildInvestmentResearchReport({
  query: "SpaceX",
  raw: "投研报告：SpaceX"
}, { researchJobId: "job:user-perspective-test" });
const userPerspectiveMarkdown = userPerspectiveReport.markdown || "";
const userPerspectiveOpening = sectionBetween(userPerspectiveMarkdown, "## 一、报告结论", "## 二、主题边界与产业链地图");
const userPerspectiveBoundary = sectionBetween(userPerspectiveMarkdown, "## 二、主题边界与产业链地图", "## 三、投资地图、价值池与同业对比");
const userPerspectiveInvestmentMap = sectionBetween(userPerspectiveMarkdown, "## 三、投资地图、价值池与同业对比", "## 四、证据基础与时间校准");
const userPerspectiveEvidence = sectionBetween(userPerspectiveMarkdown, "### 证据卡", "> 触发请求");
assertEqual(
  "investment report user perspective renders a readable evidence-grounded report",
  String(
    userPerspectiveReport.ready === true &&
    !userPerspectiveReport.reused &&
    investmentReportSegmentedCalls >= 4 &&
    !userPerspectiveMarkdown.includes("# SpaceX 的真正变量") &&
    userPerspectiveMarkdown.includes("## 一、报告结论") &&
    userPerspectiveMarkdown.includes("## 二、主题边界与产业链地图") &&
    userPerspectiveMarkdown.includes("## 三、投资地图、价值池与同业对比") &&
    userPerspectiveMarkdown.includes("## 四、证据基础与时间校准") &&
    userPerspectiveMarkdown.includes("## 六、关键环节、跟踪指标与催化剂") &&
    userPerspectiveMarkdown.includes("## 七、情景分析、反证与证伪条件") &&
    userPerspectiveMarkdown.includes("## 九、资料来源与证据索引") &&
    userPerspectiveMarkdown.includes("## 先读：研究时间、证据编号与适用边界") &&
    userPerspectiveOpening.includes("一句话结论") &&
    userPerspectiveBoundary.includes("研究边界") &&
    userPerspectiveInvestmentMap.includes("投资地图") &&
    userPerspectiveMarkdown.includes("[证据 E1](#证据-e1)") &&
    userPerspectiveMarkdown.includes("#### 证据 E1") &&
    userPerspectiveMarkdown.includes("S1/S2 代表资料来源，E1/E2 代表证据卡") &&
    userPerspectiveMarkdown.includes("当前证据覆盖两个视频来源") &&
    !/YouTube 技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<details|<summary|我先按|接下来我会/.test(userPerspectiveMarkdown) &&
    !userPerspectiveEvidence.includes("上一版报告")
  ),
  "true"
);
assertEqual(
  "investment report uses segmented parallel json synthesis instead of one giant call",
  String(investmentReportSegmentedCalls >= 4),
  "true"
);
assertEqual(
  "investment report user perspective removes legacy youtube-note artifacts from retrieved corpus",
  String(
    userPerspectiveReport.ready === true &&
    userPerspectiveMarkdown.includes("## 九、资料来源与证据索引") &&
    !/Inside Starfactory\s+YouTube 技术笔记|100 times heavier\s+YouTube 技术笔记|some pretty advanced concepts\s+YouTube 技术笔记|legacy_heading|阅读导航/.test(userPerspectiveMarkdown)
  ),
  "true"
);
const workspaceClient = new FeishuWorkspaceClient({
  config: { feishuDocBaseUrl: "https://rcnx3mn0vg5z.feishu.cn" },
  getToken: async () => "test-token"
});
let insertedDescendantBody = null;
workspaceClient.convertMarkdownToBlocks = async () => ({
  firstLevelBlockIds: ["body_1", "evidence_heading_1"],
  blocks: [
    {
      block_id: "body_1",
      block_type: 2,
      text: {
        elements: [
          { text_run: { content: "相关证据：" } },
          {
            text_run: {
              content: "证据 E1",
              text_element_style: {
                link: { url: encodeURIComponent("#证据-e1") }
              }
            }
          }
        ],
        style: {}
      }
    },
    {
      block_id: "evidence_heading_1",
      block_type: 6,
      heading4: {
        elements: [
          { text_run: { content: "证据 E1" } }
        ],
        style: {}
      }
    }
  ]
});
workspaceClient.request = async (_path, options = {}) => {
  insertedDescendantBody = options.body;
  return {};
};
const richInsertResult = await workspaceClient.insertRichMarkdown({
  documentId: "doc_test_123",
  parentBlockId: "doc_test_123",
  markdown: userPerspectiveMarkdown
});
const rewrittenEvidenceLink = insertedDescendantBody?.descendants?.[0]?.text?.elements?.[1]?.text_run?.text_element_style?.link?.url || "";
assertEqual(
  "Feishu rich writer rewrites evidence markdown links to real block anchors",
  String(
    richInsertResult.evidenceLinksRewritten === 1 &&
    decodeURIComponent(rewrittenEvidenceLink) === "https://rcnx3mn0vg5z.feishu.cn/docx/doc_test_123#evidence_heading_1"
  ),
  "true"
);

class TestWeChatPublisher extends WeChatPublisher {
  constructor(args) {
    super(args);
    this.lastDraftPayload = null;
  }

  async accessTokenForMp() {
    return "test-token";
  }

  async uploadPermanentImage() {
    return { media_id: "thumb_media_test", url: "https://mmbiz.qpic.cn/test-cover.png" };
  }

  async uploadArticleImage() {
    return "https://mmbiz.qpic.cn/test-inline.png";
  }

  async downloadFirstAvailableImage() {
    return { buffer: Buffer.from("test-thumbnail"), mimeType: "image/jpeg" };
  }

  async wechatJson(path, body) {
    this.lastDraftPayload = { path, body };
    return { media_id: "draft_media_test" };
  }
}

const wechatPublisher = new TestWeChatPublisher({
  config: {
    wechatMpEnabled: true,
    wechatMpAppId: "wx-test",
    wechatMpAppSecret: "secret-test",
    wechatMpAuthor: "小椰",
    wechatMpCtaText: "如果你也长期关注 AI、机器人和SpaceX，欢迎交流与关注。我会持续发布高价值研究。",
    wechatMpOpenComment: false,
    wechatMpOnlyFansCanComment: false
  },
  ai: null,
  imageGenerator: {
    enabled: true,
    generate: async () => ({ buffer: Buffer.from("test-image"), mimeType: "image/png" })
  }
});
const wechatFeishuMarkdown = [
  "---",
  "title: test",
  "---",
  "> 主题聚合：[[商业航天]]",
  "> 来源类型：[[YouTube 视频研究]]",
  "# 星舰工厂里的产线化赌局：火箭正在变成制造业问题",
  "",
  "## 一、关键术语解释",
  "- **Starship：** SpaceX 的超重型飞船系统，这里重点不是单次发射，而是产线节奏和复用逻辑。",
  "- **Raptor：** 星舰使用的发动机，决定产线能不能持续交付和快速测试。",
  "- **Stage Zero：** 发射塔、地面管线和捕获系统组成的基础设施，是高频发射的地面瓶颈。",
  "- **wet mass / dry mass：** 湿质量是满载推进剂时的质量，干质量是推进剂耗尽后的质量。",
  "- **膜冷却（film cooling）：** 膜冷却是在燃烧室内壁附近额外喷入一部分推进剂，让它形成贴着金属壁面的保护层，降低燃烧室头部和喉部被高温烧穿的风险。",
  "Raptor 2",
  "Raptor 2 是 SpaceX 星舰系统使用的新版甲烷/液氧发动机，相比 Raptor 1 删除、合并、简化了大量外部部件，并把标准工作室压提高到约 300 bar。",
  "全流量分级燃烧循环（full flow staged combustion）：全流量分级燃烧循环是一种火箭发动机循环，燃料和氧化剂在进入主燃烧室前，先分别通过各自的预燃室和涡轮泵，再以高压气体形式进入主燃烧室燃烧。",
  "",
  "## 二、背景导读",
  "这段视频的价值不在于参观工厂本身，而在于它把 SpaceX 的核心矛盾摆到台前：如果火箭仍然像传统航天项目一样按任务手工打磨，星舰就无法支撑高频发射、月球任务和 Starlink 部署。",
  "",
  "拍摄场景发生在 Starfactory 和发射设施附近，读者需要先理解它面对的是制造节拍、发动机可靠性、监管审批和地面系统协同。对非专业读者来说，这比记住某个参数更重要，因为产业链机会往往出现在瓶颈环节。",
  "",
  "## 三、导读与核心结论",
  "### 一句话结论",
  "SpaceX 真正想证明的不是火箭能飞一次，而是火箭能像工业产品一样被持续制造、测试、复用和迭代。",
  "",
  "### 核心观点",
  "#### 1. Starfactory 把航天问题改写成制造业问题",
  "> The factory is designed for rate.",
  "  - **为什么重要：** 当火箭制造从项目制转向产线制，供应链价值会从单个零件扩展到测试、工装、材料、软件和地面设备。",
  "  - **读者该抓住什么：** 真正的变量是节拍，而不是单次发射的戏剧性。",
  "",
  "#### 2. Raptor 是产线化是否成立的硬约束",
  "> Engines have to come off the line fast enough.",
  "  - **为什么重要：** 发动机生产速度和可靠性会直接影响试飞频率，也决定后续供应链是否有稳定需求。",
  "  - **读者该抓住什么：** 看商业航天不能只看火箭外形，要看发动机和测试能力。",
  "",
  "#### 3. 地面系统决定高频发射能否闭环",
  "> The launch tower is part of the vehicle.",
  "  - **为什么重要：** 发射塔、推进剂系统和捕获系统会把基础设施变成复用能力的一部分。",
  "  - **读者该抓住什么：** 产业链机会可能藏在地面设施，而不只在飞船本体。",
  "",
  "### 标志性金句",
  "#### 1. 原文证据",
  "> The factory is designed for rate.",
  "  - **含义：** SpaceX 的主线是用制造节拍压低航天成本。",
  "",
  "### 最反共识的判断",
  "- 星舰的难点不只是技术突破，而是把突破变成可重复的工业流程。",
  "- 商业航天供应链的拐点，可能先出现在测试设施和发动机节拍，而不是终端发射报价。",
  "",
  "## 四、关键技术点速览",
  "#### 1. 发动机量产",
  "  - **视频里怎么说：** Raptor 必须持续从产线下线，才能支持更高频测试。",
  "  - **为什么重要：** 发动机节拍决定发射 cadence。",
  "  - **风险或不确定性：** 可靠性、返工率和测试通过率仍需外部数据验证。",
  "",
  "#### 2. 地面发射系统",
  "  - **视频里怎么说：** 发射塔和捕获系统被视为飞行器能力的一部分。",
  "  - **为什么重要：** 复用不只是飞船返回，还要求地面系统快速恢复。",
  "  - **风险或不确定性：** 监管审批和事故调查会改变节奏。",
  "",
  "## 五、详细技术拆解",
  "### 1. 为什么产线节拍比单次成功更重要",
  "- 如果产线不能持续生产，试飞成功也很难转化为商业发射能力。",
  "- 如果测试设施跟不上，发动机和飞船会在验证环节排队。",
  "- 如果监管审批拖慢，工厂效率也无法直接变成发射频率。",
  "",
  "## 六、时间线摘要",
  "- [0:10] 镜头进入 Starfactory，重点转向制造节拍；这说明视频讨论的是工业化，而不是普通参观。",
  "  > The factory is designed for rate.",
  "- [3:20] 讨论 Raptor 产线，指向发动机供给瓶颈；这决定试飞能否持续。",
  "  > Engines have to come off the line fast enough.",
  "### 原文摘录",
  "```text",
  "[0:10] The factory is designed for rate.",
  "[0:20] This line should not be dumped into WeChat as raw transcript.",
  "[0:30] Another raw transcript line.",
  "```",
  "## 七、值得继续追问的问题",
  "- Raptor 月产量和测试通过率有没有公开信号？",
  "- FAA 审批周期是否会成为高频发射的核心约束？",
  "- 中国商业航天在液氧甲烷发动机和地面测试设施上差距在哪里？",
  "- Starlink 发射需求能否支撑星舰早期商业闭环？",
  "## 八、出处与链接",
  "### 1. First Look Inside SpaceX's Starfactory w/ Elon Musk",
  "频道：Everyday Astronaut；字幕：en",
  "https://www.youtube.com/watch?v=test1234567"
].join("\n");
const wechatCandidate = {
  id: "wechat-test-1",
  sourceType: "youtube_research",
  title: "星舰工厂里的产线化赌局：火箭正在变成制造业问题",
  markdown: wechatFeishuMarkdown,
  feishuDocUrl: "https://rcnx3mn0vg5z.feishu.cn/wiki/test",
  sourceUrl: "https://www.youtube.com/watch?v=test1234567",
  metadata: {}
};
const wechatPlan = await wechatPublisher.buildDistributionPlan(wechatCandidate);
assertEqual(
  "WeChat publisher adapts the finished Feishu article instead of regenerating from structured JSON",
  String(
    wechatPlan.bodyMarkdown.includes("Starfactory 把航天问题改写成制造业问题") &&
    wechatPlan.coverPrompt.includes("Starfactory") &&
    wechatPlan.coverPrompt.includes("Raptor") &&
    wechatPlan.coverPrompt.includes("specific scene") &&
    !wechatPlan.bodyMarkdown.includes("原文核对") &&
    !wechatPlan.bodyMarkdown.includes("时间线摘要") &&
    !wechatPlan.bodyMarkdown.includes("This line should not be dumped into WeChat as raw transcript") &&
    !wechatPlan.bodyMarkdown.includes("```") &&
    !wechatPlan.bodyMarkdown.includes("主题聚合") &&
    !wechatPlan.bodyMarkdown.includes("YouTube 技术笔记")
  ),
  "true"
);
assertEqual(
  "WeChat opening hook trims to a complete reader-facing sentence",
  String(/[。！？;；]$/.test(wechatPlan.openingHook) && !/[，,：:]$/.test(wechatPlan.openingHook)),
  "true"
);
const wechatCleanTitlePlan = await wechatPublisher.buildDistributionPlan({
  ...wechatCandidate,
  title: "整理好了：为什么 Stoke Space 把二级热盾塞进燃料回路"
});
assertEqual(
  "WeChat publisher removes machine process prefixes from public article titles",
  wechatCleanTitlePlan.title,
  "为什么 Stoke Space 把二级热盾塞进燃料回路"
);
const wechatDraftResult = await wechatPublisher.createDraft(wechatCandidate, { generateImages: false, operator: "test-user" });
const wechatDraftArticle = wechatPublisher.lastDraftPayload?.body?.articles?.[0] || {};
assertEqual(
  "WeChat draft uses official draft payload fields and WeChat HTML content from Feishu output",
  String(
    wechatDraftResult.draftMediaId === "draft_media_test" &&
    wechatPublisher.lastDraftPayload?.path === "/cgi-bin/draft/add" &&
    wechatDraftArticle.title === wechatCandidate.title &&
    wechatDraftArticle.thumb_media_id === "thumb_media_test" &&
    wechatDraftArticle.content_source_url === wechatCandidate.feishuDocUrl &&
    (wechatDraftArticle.content || "").includes("https://mmbiz.qpic.cn/test-inline.png") &&
    (wechatDraftArticle.content || "").indexOf("https://mmbiz.qpic.cn/test-inline.png") < (wechatDraftArticle.content || "").indexOf("先说结论") &&
    (wechatDraftArticle.content || "").includes('font-size:19px;line-height:1.55;font-weight:700;text-align:center;">先说结论') &&
    (wechatDraftArticle.content || "").includes("封面来自原视频，完整资料与原视频见文末「阅读原文」") &&
    !(wechatDraftArticle.content || "").includes("封面来自原视频，完整资料与原视频见文末「阅读原文」。") &&
    (wechatDraftArticle.content || "").includes("Raptor 是产线化是否成立的硬约束") &&
    (wechatDraftArticle.content || "").includes("地面系统决定高频发射能否闭环") &&
    (wechatDraftArticle.content || "").includes("wet mass / dry mass") &&
    (wechatDraftArticle.content || "").includes("关注我，持续追踪SpaceX、AI、Robot！<br />原视频点击左下方「阅读原文」并加入我们！") &&
    !(wechatDraftArticle.content || "").includes("关注我，继续追踪产业链和技术拐点。") &&
    !(wechatDraftArticle.content || "").includes("关注我，继续追踪产业链和技术拐点<br />原视频点击左下方「阅读原文」") &&
    (wechatDraftArticle.content || "").includes("border-left:4px solid #ff7a00;border-right:4px solid #ff7a00") &&
    (wechatDraftArticle.content || "").includes("text-align:center;font-weight:600") &&
    !(wechatDraftArticle.content || "").includes("把关键证据拆开看") &&
    !(wechatDraftArticle.content || "").includes("关键技术点速览") &&
    !(wechatDraftArticle.content || "").includes("标志性金句") &&
    !(wechatDraftArticle.content || "").includes("最反共识的判断") &&
    !/[🔹🎯🧩📌]/u.test(wechatDraftArticle.content || "") &&
    ((wechatDraftArticle.content || "").match(/接下来最该追问什么/g) || []).length <= 1 &&
    !(wechatDraftArticle.content || "").includes("feishu.cn/wiki/test") &&
    !(wechatDraftArticle.content || "").includes("youtube.com") &&
    !(wechatDraftArticle.content || "").includes("youtu.be") &&
    /<h2 style=/.test(wechatDraftArticle.content || "") &&
    !(wechatDraftArticle.content || "").includes("width:36px;height:3px;background:#07C160") &&
    !(wechatDraftArticle.content || "").includes("#07C160") &&
    !(wechatDraftArticle.content || "").includes("## 三、导读与核心结论") &&
    !(wechatDraftArticle.content || "").includes("**") &&
    !(wechatDraftArticle.content || "").includes("raw transcript")
  ),
  "true"
);
assertEqual(
  "WeChat glossary keywords render as consistent bold terms",
  String(
    (wechatDraftArticle.content || "").includes("<strong style=\"color:#161616;font-weight:700;\">Raptor 2：</strong>Raptor 2 是 SpaceX") &&
    (wechatDraftArticle.content || "").includes("<strong style=\"color:#161616;font-weight:700;\">全流量分级燃烧循环（full flow staged combustion）：</strong>全流量分级燃烧循环") &&
    !(wechatDraftArticle.content || "").includes("margin:0 0 6px;font-size:15px;line-height:1.55;color:#161616;font-weight:700;word-break:break-word;\">Raptor 2</p>")
  ),
  "true"
);
assertEqual(
  "WeChat opening hook renders smaller quoted copy without trailing sentence punctuation",
  String(
    (wechatDraftArticle.content || "").includes('line-height:1.9;font-size:14.8px;font-weight:600;word-break:break-word;">“') &&
    /”<\/p><\/section>/.test(wechatDraftArticle.content || "") &&
    !/[。！？!?；;]”<\/p><\/section>/.test(wechatDraftArticle.content || "")
  ),
  "true"
);
assertEqual(
  "WeChat public article hides one-sentence conclusion wording",
  String(!(wechatDraftArticle.content || "").includes(">一句话结论</p>")),
  "true"
);
assertEqual(
  "WeChat draft renders visible section bands",
  String((wechatDraftArticle.content || "").includes("border-left:4px solid #ff7a00") && (wechatDraftArticle.content || "").includes("border:1px solid #ececec") && (wechatDraftArticle.content || "").includes("border-radius:8px;text-align:center")),
  "true"
);
assertEqual(
  "WeChat draft renders boxed technical breakdown cards",
  String((wechatDraftArticle.content || "").includes("border:1px solid #e6e6e6")),
  "true"
);
assertEqual(
  "WeChat draft renders numbered core or technical cards",
  String((wechatDraftArticle.content || "").includes(">01</span><strong") && !(wechatDraftArticle.content || "").includes("max-width:82%")),
  "true"
);
assertEqual(
  "WeChat draft renders follow-up questions as numbered cards",
  String((wechatDraftArticle.content || "").includes(">1</span>Raptor 月产量") && (wechatDraftArticle.content || "").includes(">2</span>FAA 审批周期")),
  "true"
);
assertEqual(
  "WeChat draft indents card explanation lines",
  String((wechatDraftArticle.content || "").includes("padding-left:12px;border-left:2px solid #ffb04a")),
  "true"
);
const plainWechatCandidate = {
  ...wechatCandidate,
  id: "wechat-plain-text-layout",
  title: "为什么 Stoke Space 把二级热盾塞进燃料回路",
  markdown: [
    "为什么 Stoke Space 把二级热盾塞进燃料回路",
    "",
    "一、关键术语解释",
    "Hopper: Stoke Space 在 2023 年用于验证发动机和控制系统的低空试飞原型机。",
    "Zenith: Nova 二级使用的小型全流量分级燃烧发动机，和热盾冷却方案强相关。",
    "",
    "二、背景导读",
    "这段视频真正重要的地方，不是 Stoke 又做了一台火箭，而是它把二级复用从返回表演改成了热管理、发动机循环和制造节奏之间的系统工程。",
    "对非专业读者来说，二级复用最难理解的一点，是它既要在再入时扛住热流，又不能像传统防热瓦那样牺牲维护效率。Stoke 的方案把氢推进剂、热盾冷却和发动机循环绑定到一起，所以它讨论的不是一个孤立部件，而是一整套飞行器架构。",
    "如果这个路径成立，读者应该关注的不是单次试飞是否好看，而是它能否把翻修时间、发动机寿命、材料供应和发射节奏压到商业闭环里。这也是它和 SpaceX 的比较真正有意义的地方。",
    "",
    "三、核心判断",
    "Stoke 的反共识点在于，它没有照搬大型一级火箭的复用叙事，而是把最难回收、也最容易被忽略的上面级变成主战场。这个判断需要继续用飞行数据、发动机测试和资金节奏交叉验证。",
    "文章应该让读者看到工程赌注，而不是只记住 30 个小喷管这个猎奇数字。喷管数量只是表象，背后是全流量分级燃烧、再生冷却热盾和姿态控制之间的耦合。",
    "从公众号阅读体验看，这一段必须被拆成有层级的解释：先让读者知道 Hopper 是试验原型，再理解 Zenith 为什么和热盾是一体化问题，最后再把 Nova 的二级复用放回商业航天竞争里。否则读者只会看到一串英文名词和参数，完全无法形成判断。",
    "好的科普排版应该帮助读者建立路径感：第一屏抓住主判断，术语卡片降低门槛，背景导读说明为什么现在值得看，核心判断负责把信息压缩成可转述的观点，原文摘录只承担核对功能，不应该和正文抢注意力。",
    "",
    "原文摘录",
    "[0:10] Stoke is perhaps one of the most exciting rocket companies.",
    "[0:20] It features a super unique actively cooled heat shield."
  ].join("\n")
};
await wechatPublisher.createDraft(plainWechatCandidate, { generateImages: false, operator: "test-plain-layout" });
const plainWechatHtml = wechatPublisher.lastDraftPayload?.body?.articles?.[0]?.content || "";
assertEqual(
  "WeChat publisher turns plain Feishu raw text into reader-grade public-account layout",
  String(
    plainWechatHtml.includes("先说结论") &&
    plainWechatHtml.includes("读前先懂这几个词") &&
    plainWechatHtml.includes("这件事为什么现在值得看") &&
    plainWechatHtml.includes("真正值得带走的判断") &&
    !plainWechatHtml.includes("#07C160") &&
    !plainWechatHtml.includes("border-left:4px solid #07C160") &&
    !plainWechatHtml.includes("width:36px;height:3px;background:#07C160") &&
    !plainWechatHtml.includes(">SECTION<") &&
    plainWechatHtml.includes("border:1px solid #ececec") &&
    plainWechatHtml.indexOf("这件事为什么现在值得看") >= 0 &&
    plainWechatHtml.indexOf("读前先懂这几个词") > plainWechatHtml.indexOf("这件事为什么现在值得看") &&
    !plainWechatHtml.includes("这些词不用背") &&
    !plainWechatHtml.includes("[0:10] Stoke is perhaps one of the most exciting rocket companies.") &&
    !plainWechatHtml.includes("<p style=\"margin:15px 0;line-height:1.95;font-size:15.5px;color:#263238;letter-spacing:0;\">为什么 Stoke Space 把二级热盾塞进燃料回路</p>")
  ),
  "true"
);
const longWechatCandidate = {
  ...wechatCandidate,
  id: "wechat-long-feishu-source",
  markdown: [
    "# 星舰工厂里的马斯克赌局：SpaceX 想把火箭变成流水线产品",
    "一、导读与核心结论",
    "关键术语解释",
    "Starship / 星舰： SpaceX 的超重型运载系统中的上面级飞船。",
    "核心结论",
    "100 times heavier YouTube 技术笔记",
    "我先按你给的时间戳骨架整理成中文技术简报，接下来我会把内容串成一篇可直接进 Obsidian/飞书的笔记。",
    "",
    wechatFeishuMarkdown.replace("## 二、背景导读", "## **二、背景导读**"),
    "",
    "## 六、时间线摘要",
    Array.from({ length: 80 }, (_, index) => `- [${String(Math.floor(index / 2)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}] 这是一条用于模拟飞书长逐字稿索引的内容，公众号正文不应该完整搬运第 ${index + 1} 条。`).join("\n"),
    "",
    "## 八、出处与链接",
    "The Underdogs Taking On SpaceX [Stoke Space 2025]",
    "https://youtu.be/7OxNZ-N_3vE"
  ].join("\n")
};
const longWechatPlan = await wechatPublisher.buildDistributionPlan(longWechatCandidate);
const longWechatPlainText = String(longWechatPlan.bodyMarkdown || "")
  .replace(/!\[[^\]]*]\([^)]+\)/g, "")
  .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
  .replace(/[*_`>#-]/g, "")
  .replace(/\s+/g, " ")
  .trim();
assertEqual(
  "WeChat publisher turns long Feishu articles into a public-account digest instead of mirroring full transcript",
  String(
    longWechatPlainText.length < 26000 &&
    !longWechatPlan.bodyMarkdown.includes("第 80 条") &&
    !longWechatPlan.bodyMarkdown.includes("YouTube 技术笔记") &&
    !longWechatPlan.bodyMarkdown.includes("Obsidian") &&
    /[。！？;；]$/.test(longWechatPlan.openingHook) &&
    longWechatPlan.openingHook.length >= 40 &&
    !/关键术语解释|Hopper/.test(longWechatPlan.openingHook)
  ),
  "true"
);
const coverOnlyPrompts = [];
const coverOnlyWechatPublisher = new TestWeChatPublisher({
  config: {
    wechatMpEnabled: true,
    wechatMpAppId: "wx-test",
    wechatMpAppSecret: "secret-test",
    wechatMpAuthor: "test-author",
    wechatMpOpenComment: false,
    wechatMpOnlyFansCanComment: false
  },
  ai: null,
  imageGenerator: {
    enabled: true,
    generate: async (prompt) => {
      coverOnlyPrompts.push(prompt);
      return { buffer: Buffer.from("test-image"), mimeType: "image/png" };
    }
  }
});
await coverOnlyWechatPublisher.createDraft(wechatCandidate, { generateImages: true, operator: "test-cover-only" });
assertEqual(
  "WeChat latest draft generation keeps article-specific cover on the critical path without blocking on inline image",
  String(
    coverOnlyPrompts.length === 1 &&
    coverOnlyPrompts[0].includes("premium editorial cover image")
  ),
  "true"
);
const providedCoverPrompts = [];
const providedCoverWechatPublisher = new TestWeChatPublisher({
  config: {
    wechatMpEnabled: true,
    wechatMpAppId: "wx-test",
    wechatMpAppSecret: "secret-test",
    wechatMpAuthor: "test-author",
    wechatMpOpenComment: false,
    wechatMpOnlyFansCanComment: false
  },
  ai: null,
  imageGenerator: {
    enabled: true,
    generate: async (prompt) => {
      providedCoverPrompts.push(prompt);
      return { buffer: Buffer.from("should-not-run"), mimeType: "image/png" };
    }
  }
});
const providedCoverResult = await providedCoverWechatPublisher.createDraft(wechatCandidate, {
  generateImages: true,
  coverImage: { buffer: Buffer.from("provided-cover"), mimeType: "image/png" },
  operator: "test-provided-cover"
});
assertEqual(
  "WeChat draft accepts a pre-generated article-specific cover without calling the image model again",
  String(providedCoverPrompts.length === 0 && providedCoverResult.imageMode === "provided_cover"),
  "true"
);
const latestYoutubeWechatCandidate = buildLatestYoutubeWechatCandidate({
  message: {
    content: "Old generated message wrapper should not become the WeChat body",
    metadata: {
      youtubeResearch: true,
      feishuDocUrl: "https://rcnx3mn0vg5z.feishu.cn/wiki/I25ywvDhvicSQtk7Hncc6l3Ungf?from=from_copylink",
      sourceUrl: "https://www.youtube.com/watch?v=stoke-test"
    },
    createdAt: "2026-07-02T04:13:38.772Z",
    relevanceScore: 0
  },
  markdown: "# Stoke Space article title\n\nFinished Feishu article body. ".repeat(60)
});
assertEqual(
  "Admin WeChat latest-YouTube draft route is anchored to the finished Feishu wiki article",
  String(
    extractWikiTokenFromFeishuUrl(latestYoutubeWechatCandidate.feishuDocUrl) === "I25ywvDhvicSQtk7Hncc6l3Ungf" &&
    latestYoutubeWechatCandidate.sourceType === "youtube_research" &&
    latestYoutubeWechatCandidate.title === "Stoke Space article title" &&
    latestYoutubeWechatCandidate.markdown.includes("Finished Feishu article body") &&
    latestYoutubeWechatCandidate.sourceUrl === "https://www.youtube.com/watch?v=stoke-test" &&
    latestYoutubeWechatCandidate.metadata.createdBy === "admin_latest_youtube_draft"
  ),
  "true"
);
const latestYoutubeWechatCandidateWithFeishuOnlyMetadata = buildLatestYoutubeWechatCandidate({
  message: {
    content: "最新飞书文档 https://rcnx3mn0vg5z.feishu.cn/wiki/test",
    metadata: {
      feishuDocUrl: "https://rcnx3mn0vg5z.feishu.cn/wiki/test",
      sourceUrl: "https://rcnx3mn0vg5z.feishu.cn/wiki/test"
    },
    createdAt: "2026-07-02T04:13:38.772Z"
  },
  markdown: [
    "# Stoke Space article title",
    "",
    "## 八、出处与链接",
    "https://youtu.be/7OxNZ-N_3vE"
  ].join("\n")
});
assertEqual(
  "Admin WeChat latest-YouTube candidate extracts real YouTube source from finished Feishu markdown",
  latestYoutubeWechatCandidateWithFeishuOnlyMetadata.sourceUrl,
  "https://youtu.be/7OxNZ-N_3vE"
);
let weakWechatCandidateRejected = false;
try {
  await wechatPublisher.buildDistributionPlan({
    id: "wechat-bad",
    sourceType: "youtube_research",
    title: "100 times heavier YouTube 技术笔记",
    markdown: "# 100 times heavier YouTube 技术笔记\n\n## 阅读导航\n输出语言：中文\n内容形态：Markdown"
  });
} catch {
  weakWechatCandidateRejected = true;
}
assertEqual(
  "WeChat publisher refuses legacy low-value Markdown candidates instead of creating public drafts",
  String(weakWechatCandidateRejected),
  "true"
);
bot.ai = {
  chat: async () => {
    throw new Error("The operation was aborted due to timeout");
  }
};
let timeoutReportError = null;
try {
  await bot.buildInvestmentResearchReport({
    query: "SpaceX",
    raw: "投研报告：SpaceX"
  }, { researchJobId: "job:timeout-fallback-test" });
} catch (error) {
  timeoutReportError = error;
}
assertEqual(
  "investment report timeout does not publish a baseline placeholder report",
  String(
    timeoutReportError &&
    /未发布证据基线占位报告/.test(timeoutReportError.message)
  ),
  "true"
);

bot.ai = {
  chat: async () => JSON.stringify({
    thesis: "",
    titleAngles: ["100 times heavier YouTube 技术笔记"],
    narrativeConflict: "",
    backgroundAnchors: [],
    glossarySeeds: [],
    evidenceClaims: [],
    timelineSeeds: [],
    questionSeeds: []
  })
};
let rejectedWeakEvidencePlan = false;
try {
  await bot.generateYoutubeResearchMarkdown({
    topic: "Starship HLS",
    request: { raw: "https://youtu.be/test" },
    videos: [{ title: "100 times heavier", transcriptText: "[0:00] 100 times heavier." }]
  });
} catch {
  rejectedWeakEvidencePlan = true;
}
assertEqual(
  "youtube structured pipeline rejects weak evidence plan before article writing",
  String(rejectedWeakEvidencePlan),
  "true"
);

let missingTimelineCalls = 0;
let missingTimelinePromptReceivedFallbackSeeds = false;
bot.ai = {
  chat: async (messages = []) => {
    missingTimelineCalls += 1;
    const userContent = String(messages.at(-1)?.content || "");
    if (userContent.includes("Focus only on article thesis")) {
      return JSON.stringify({
        thesis: hlsEvidenceBrief.thesis,
        titleAngles: hlsEvidenceBrief.titleAngles,
        narrativeConflict: hlsEvidenceBrief.narrativeConflict,
        backgroundAnchors: hlsEvidenceBrief.backgroundAnchors
      });
    }
    if (userContent.includes("Focus only on beginner glossary terms")) {
      return JSON.stringify({
        glossarySeeds: hlsEvidenceBrief.glossarySeeds,
        evidenceClaims: hlsEvidenceBrief.evidenceClaims
      });
    }
    missingTimelinePromptReceivedFallbackSeeds = missingTimelinePromptReceivedFallbackSeeds ||
      (userContent.includes("视频在这里展开了一个关键论据") && userContent.includes("100 times heavier"));
    if (userContent.includes("fixed title/background schema")) return JSON.stringify(hlsOpeningPart);
    if (userContent.includes("fixed glossary schema")) return JSON.stringify(hlsGlossaryPart);
    if (userContent.includes("fixed core schema")) return JSON.stringify(hlsCorePart);
    if (userContent.includes("fixed technical schema")) return JSON.stringify(hlsTechPart);
    return JSON.stringify(hlsTimelinePart);
  }
};
const missingTimelineDoc = await bot.generateYoutubeResearchMarkdown({
  topic: "Starship HLS",
  request: { raw: "https://youtu.be/test" },
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain.\n[12:00] Orion waits in lunar orbit.\n[15:00] depot stores propellant."
  }]
});
assertEqual(
  "youtube structured pipeline fills missing timeline seeds from transcript",
  String(missingTimelineCalls === 7 && missingTimelinePromptReceivedFallbackSeeds && missingTimelineDoc.includes("月球版星舰的真正难题")),
  "true"
);

let timelineFailureCalls = 0;
let timelineFailurePromptSeen = false;
bot.ai = {
  chat: async (messages = []) => {
    timelineFailureCalls += 1;
    const allContent = messages.map((message) => String(message?.content || "")).join("\n");
    const userContent = String(messages.at(-1)?.content || "");
    if (allContent.includes("Focus only on article thesis")) {
      return JSON.stringify({
        thesis: hlsEvidenceBrief.thesis,
        titleAngles: hlsEvidenceBrief.titleAngles,
        narrativeConflict: hlsEvidenceBrief.narrativeConflict,
        backgroundAnchors: hlsEvidenceBrief.backgroundAnchors
      });
    }
    if (allContent.includes("Focus only on beginner glossary terms")) {
      return JSON.stringify({
        glossarySeeds: hlsEvidenceBrief.glossarySeeds,
        evidenceClaims: hlsEvidenceBrief.evidenceClaims
      });
    }
    if (userContent.includes("fixed title/background schema")) return JSON.stringify(hlsOpeningPart);
    if (userContent.includes("fixed glossary schema")) return JSON.stringify(hlsGlossaryPart);
    if (userContent.includes("fixed core schema")) return JSON.stringify(hlsCorePart);
    if (userContent.includes("fixed technical schema")) return JSON.stringify(hlsTechPart);
    if (userContent.includes("fixed timeline/question schema")) {
      timelineFailurePromptSeen = true;
      throw new Error("primary AI API response did not contain text");
    }
    throw new Error("unexpected timeline failure prompt");
  }
};
const timelineFailureDoc = await bot.generateYoutubeResearchMarkdown({
  topic: "Starship HLS",
  request: { raw: "https://youtu.be/test" },
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
  }]
});
assertEqual(
  "youtube structured pipeline rebuilds failed timeline from evidence brief",
  String(timelineFailureCalls === 7 && timelineFailurePromptSeen && timelineFailureDoc.includes("100 times heavier") && timelineFailureDoc.includes("12 or more launches")),
  "true"
);

let emptyArticleSlotCalls = 0;
bot.ai = {
  chat: async (messages = []) => {
    emptyArticleSlotCalls += 1;
    const userContent = String(messages.at(-1)?.content || "");
    if (userContent.includes("Focus only on article thesis")) {
      return JSON.stringify({
        thesis: hlsEvidenceBrief.thesis,
        titleAngles: hlsEvidenceBrief.titleAngles,
        narrativeConflict: hlsEvidenceBrief.narrativeConflict,
        backgroundAnchors: hlsEvidenceBrief.backgroundAnchors
      });
    }
    if (userContent.includes("Focus only on beginner glossary terms")) {
      return JSON.stringify({
        glossarySeeds: hlsEvidenceBrief.glossarySeeds,
        evidenceClaims: hlsEvidenceBrief.evidenceClaims
      });
    }
    if (userContent.includes("fixed title/background schema")) return JSON.stringify({ title: "", contextParagraphs: [] });
    if (userContent.includes("fixed glossary schema")) return JSON.stringify({ glossary: [] });
    if (userContent.includes("fixed core schema")) return JSON.stringify({ oneSentence: "", corePoints: [], quotes: [], counterintuitive: [] });
    if (userContent.includes("fixed technical schema")) return JSON.stringify({ techPoints: [], detailSections: [] });
    return JSON.stringify({ timeline: [], questions: [] });
  }
};
const emptyArticleSlotDoc = await bot.generateYoutubeResearchMarkdown({
  topic: "Starship HLS",
  request: { raw: "https://youtu.be/test" },
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
  }]
});
assertEqual(
  "youtube structured pipeline fills empty article slots from evidence brief",
  String(emptyArticleSlotCalls === 7 && emptyArticleSlotDoc.includes("## 一、关键术语解释") && emptyArticleSlotDoc.includes("## 七、值得继续追问的问题") && !emptyArticleSlotDoc.includes("YouTube 技术笔记")),
  "true"
);

let jsonRepairCalls = 0;
bot.ai = {
  chat: async (messages = []) => {
    jsonRepairCalls += 1;
    const userContent = String(messages.at(-1)?.content || "");
    if (jsonRepairCalls === 1) {
      return '{"thesis":"坏 JSON 测试","titleAngles":["坏 JSON 测试" "缺逗号"],"narrativeConflict":"x"}';
    }
    if (userContent.includes("Repair this evidence brief thesis")) {
      return JSON.stringify({
        thesis: hlsEvidenceBrief.thesis,
        titleAngles: hlsEvidenceBrief.titleAngles,
        narrativeConflict: hlsEvidenceBrief.narrativeConflict,
        backgroundAnchors: hlsEvidenceBrief.backgroundAnchors
      });
    }
    if (userContent.includes("Focus only on beginner glossary terms")) {
      return JSON.stringify({
        glossarySeeds: hlsEvidenceBrief.glossarySeeds,
        evidenceClaims: hlsEvidenceBrief.evidenceClaims
      });
    }
    if (userContent.includes("fixed title/background schema")) return JSON.stringify(hlsOpeningPart);
    if (userContent.includes("fixed glossary schema")) return JSON.stringify(hlsGlossaryPart);
    if (userContent.includes("fixed core schema")) return JSON.stringify(hlsCorePart);
    if (userContent.includes("fixed technical schema")) return JSON.stringify(hlsTechPart);
    return JSON.stringify(hlsTimelinePart);
  }
};
const repairedJsonDoc = await bot.generateYoutubeResearchMarkdown({
  topic: "Starship HLS",
  request: { raw: "https://youtu.be/test" },
  videos: [{
    title: "100 times heavier",
    channel: "Test Channel",
    language: "en",
    url: "https://www.youtube.com/watch?v=testhls",
    transcriptText: "[0:00] 100 times heavier.\n[1:20] 12 or more launches.\n[3:40] LEO refueling.\n[6:10] high mounted landing thrusters.\n[8:30] self leveling legs.\n[10:00] mission chain."
  }]
});
assertEqual(
  "youtube structured pipeline repairs malformed json before failing user request",
  String(jsonRepairCalls === 8 && repairedJsonDoc.includes("月球版星舰的真正难题")),
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

assertEqual(
  "Mikoto guide URL resolves to image API endpoint",
  resolveImageEndpoint("https://api.mikoto.vip/image-api-guide.html?user_id=123&token=redacted"),
  "https://api.mikoto.vip/v1/images/generations"
);

assertEqual(
  "Mikoto custom URL resolves to image API endpoint",
  resolveImageEndpoint("https://api.mikoto.vip/custom/example"),
  "https://api.mikoto.vip/v1/images/generations"
);

const originalFetchForImage = globalThis.fetch;
const imageFetchCalls = [];
globalThis.fetch = async (url, options = {}) => {
  imageFetchCalls.push({ url: String(url), method: options.method || "GET" });
  if (String(url).endsWith("/v1/images/generations/async")) {
    return new Response(JSON.stringify({ task_id: "task_test_1", status: "queued", poll_url: "/v1/images/tasks/task_test_1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (String(url).endsWith("/v1/images/tasks/task_test_1")) {
    return new Response(JSON.stringify({
      status: "success",
      result: {
        data: [{ b64_json: Buffer.from("fake-image").toString("base64") }]
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  throw new Error(`unexpected image fetch url: ${url}`);
};
try {
  const imageClient = new ImageGenerationClient({
    imageGenerationEnabled: true,
    imageApiKey: "test-key",
    imageApiUrl: "https://api.mikoto.vip/v1/images/generations",
    imageModel: "gpt-image-2",
    imageSize: "1024x1024",
    imageTimeoutMs: 20000,
    imageAsyncEnabled: true,
    imageAsyncPollIntervalMs: 3000
  });
  const image = await imageClient.generate("article-specific cover");
  assertEqual("image async client returns generated buffer", String(image.buffer.length > 0), "true");
  assertEqual(
    "image async client creates async task",
    String(imageFetchCalls.some((call) => call.method === "POST" && call.url.endsWith("/v1/images/generations/async"))),
    "true"
  );
  assertEqual(
    "image async client polls task endpoint",
    String(imageFetchCalls.some((call) => call.method === "GET" && call.url.endsWith("/v1/images/tasks/task_test_1"))),
    "true"
  );
} finally {
  globalThis.fetch = originalFetchForImage;
}

console.log("Feishu routing checks passed.");
