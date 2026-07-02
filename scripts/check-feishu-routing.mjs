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
    "我先按你给的时间戳骨架整理成中文技术简报，重点只保留能直接落在原文锚点上的结论、术语和证据。",
    "接下来我会把“100倍更重”“12次以上补加注”串成一篇可直接进 Obsidian/飞书的笔记。",
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
  String(mobileDocMarkdown.includes("## 一、关键术语解释") && mobileDocMarkdown.includes("## 二、背景导读") && mobileDocMarkdown.includes("## 三、导读与核心结论") && !mobileDocMarkdown.includes("## 二、精华总结") && mobileDocMarkdown.includes("### 核心结论")),
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
  String(mobileDocMarkdown.includes("- **市场/技术环境：** 这里同样属于背景，不属于正文观点。")),
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
  String(keywordFallbackDoc.includes("  - **为什么重要：** 内存带宽会限制并行计算实际效率。") && keywordFallbackDoc.includes("  - **风险或不确定性：** 缓存局部性和软件栈也会改变瓶颈位置。")),
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
    if (structuredChatCalls === 1) return JSON.stringify(hlsEvidenceBrief);
    articlePromptIncludedEvidenceBrief = articlePromptIncludedEvidenceBrief ||
      (userContent.includes("Evidence brief that must drive") && userContent.includes("Starship HLS 的核心难题"));
    if (structuredChatCalls === 2) return JSON.stringify(hlsOpeningPart);
    if (structuredChatCalls === 3) return JSON.stringify(hlsGlossaryPart);
    if (structuredChatCalls === 4) return JSON.stringify(hlsCorePart);
    if (structuredChatCalls === 5) return JSON.stringify(hlsTechPart);
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
assertEqual(
  "youtube structured pipeline renders reader-grade article",
  String(structuredFeishuDoc.includes("## 一、关键术语解释") && structuredFeishuDoc.includes("## 二、背景导读") && structuredFeishuDoc.includes("## 三、导读与核心结论") && structuredFeishuDoc.includes("## 四、关键技术点速览") && structuredFeishuDoc.includes("## 八、出处与链接") && !structuredFeishuDoc.includes("YouTube 技术笔记") && !structuredFeishuDoc.includes("我先按")),
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
assertEqual(
  "youtube structured pipeline plans from evidence before writing",
  String(structuredChatCalls === 6 && articlePromptIncludedEvidenceBrief),
  "true"
);
assertEqual(
  "youtube structured pipeline asks model for json object directly",
  String(structuredResponseFormats.join(",") === "json_object,json_object,json_object,json_object,json_object,json_object"),
  "true"
);
assertEqual(
  "youtube structured pipeline positively guides each writing slot",
  String([
    "Build a writer-ready brief",
    "Write paragraph 1 as `video scene and viewing context`",
    "Each explanation should answer",
    "Each corePoints title should be a judgment sentence",
    "techPoints should be scan-friendly",
    "Timeline is not a transcript dump"
  ].every((needle) => structuredPromptText.join("\n").includes(needle))),
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
    if (missingTimelineCalls === 1) {
      return JSON.stringify({
        ...hlsEvidenceBrief,
        timelineSeeds: []
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
  String(missingTimelineCalls === 6 && missingTimelinePromptReceivedFallbackSeeds && missingTimelineDoc.includes("月球版星舰的真正难题")),
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
    if (userContent.includes("Repair this evidence brief")) return JSON.stringify(hlsEvidenceBrief);
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
  String(jsonRepairCalls === 7 && repairedJsonDoc.includes("月球版星舰的真正难题")),
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
