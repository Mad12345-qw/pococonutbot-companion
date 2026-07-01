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
      transcriptText: "[0:00] We need memory bandwidth.\n[0:05] Parallel compute matters."
    }
  ],
  markdown: [
    "---",
    "title: test",
    "---",
    "# building the best GPU possible YouTube 技术笔记",
    "",
    "## 一、背景导读：算力瓶颈为什么不是单个参数问题",
    "这不是一条普通的产品视频，而是在解释算力竞赛背后的硬件约束。GPU 的意义不只在峰值算力，还在带宽、并行度、软件生态和供应链共同形成的系统优势。",
    "",
    "## 二、精华总结：系统能力比单点性能更重要",
    "这里用测试内容模拟一段足够长的专栏正文。真正的好文章不会先贴阅读导航，也不会把输出语言、字幕语言、内容形态当成读者需要知道的信息。它会先建立问题，再用证据拆解判断。",
    "",
    "## 三、关键技术点速览：带宽、并行与生态",
    "| 技术点 | 视频里怎么说 | 为什么重要 |",
    "| --- | --- | --- |",
    "| GPU 架构 | 强调带宽和并行 | 影响训练效率 |",
    "",
    "## 四、详细技术拆解：从硬件参数到训练效率",
    "第一，硬件优势不是单个参数赢，而是系统能力赢。第二，真正稀缺的不是发布会概念，而是稳定量产和软件生态。第三，读者要看的是约束条件，不是口号。",
    "",
    "## 五、时间线摘要：关键论点如何出现",
    "- [0:00] 开场提出硬件架构问题。",
    "- [0:05] 转向带宽和并行度。",
    "",
    "## 六、值得继续追问的问题：哪些约束还没被验证",
    "- 这个判断能否被供应链数据验证？",
    "- 软件生态是否比硬件参数更难复制？",
    "",
    "这段补充文字用于确保测试文章达到发布长度。它模拟专栏正文继续展开：一篇可发布文章应该有清晰主线、自然段落、明确判断和克制的证据使用，而不是把原始材料一股脑倒给读者。读者不关心机器人如何整理，也不关心字幕是什么语言；读者关心自己读完之后是否更理解技术趋势。",
    "",
    "真正的专栏写法还需要控制节奏。第一屏先提出判断，中段再展开背景和证据，后段才给资料来源。证据不是越多越好，英文原句也不是越长越专业；证据的价值在于它能支撑哪个判断。只要一段材料不能推动读者理解，它就应该被删掉或放到附录，而不是进入正文抢占注意力。",
    "",
    "因此，测试样稿必须模拟一个合格成品的基本条件：标题是中文判断型标题，目录不混入内部变量，正文没有空章节，没有裸露 Markdown，没有代码块逐字稿，没有系统失败提示。只有这些条件同时满足，生成器才允许把内容写入飞书。"
    ,
    "",
    "从读者角度看，成品还必须有明确的阅读收益。它不能只是告诉读者视频里说了什么，而要回答：这件事为什么现在重要，它和已有行业认知有什么冲突，它会改变哪些判断。换句话说，生成器的目标不是保存材料，而是替读者完成一次判断压缩。材料可以进入资料来源，判断必须进入正文。",
    "",
    "这也是为什么完整逐字稿不能直接进入主文档。逐字稿适合作为检索材料，不适合作为阅读材料。主文档应该只摘出能支持判断的时间点，把读者带回原视频，而不是把原视频字幕平铺成三十页英文代码块。否则，文档越长，读者越不信任它。"
  ].join("\n")
});
assertEqual(
  "youtube Feishu doc uses a Chinese article H1",
  String(/^#\s+从「GPU」看懂一个关键判断/m.test(mobileDocMarkdown)),
  "true"
);
assertEqual(
  "youtube Feishu doc converts tables for mobile",
  String(/^\|/m.test(mobileDocMarkdown)),
  "false"
);
assertEqual(
  "youtube Feishu doc does not use a reading guide",
  String(!mobileDocMarkdown.includes("阅读导航") && !mobileDocMarkdown.includes("这篇文档由小椰") && !mobileDocMarkdown.includes("这篇笔记")),
  "true"
);
assertEqual(
  "youtube Feishu doc avoids low-value repeated metadata",
  String(!mobileDocMarkdown.includes("输出语言") && !mobileDocMarkdown.includes("内容形态") && !mobileDocMarkdown.includes("**字幕**")),
  "true"
);
assertEqual(
  "youtube Feishu doc uses a polished transcript appendix",
  String(mobileDocMarkdown.includes("### 原文核对附录") && mobileDocMarkdown.includes("`0:00` We need memory bandwidth") && !mobileDocMarkdown.includes("完整字幕逐字稿") && !mobileDocMarkdown.includes("<details>") && !mobileDocMarkdown.includes("```text")),
  "true"
);
assertEqual(
  "youtube Feishu doc has a columnist outline",
  String([
    "## 一、背景导读",
    "## 二、精华总结",
    "## 三、关键技术点速览",
    "## 四、详细技术拆解",
    "## 五、时间线摘要",
    "## 六、值得继续追问的问题",
    "## 七、出处与链接"
  ].every((heading) => mobileDocMarkdown.includes(heading)) && !mobileDocMarkdown.includes("这部分没有生成到有效内容")),
  "true"
);
assertEqual(
  "youtube Feishu doc title is Chinese for English source titles",
  String(mobileDocMarkdown.startsWith("# 从「GPU」看懂一个关键判断")),
  "true"
);

const englishFallbackDocMarkdown = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "AI note app",
  title: "How I use AI notes every day",
  videos: [
    {
      title: "How I use AI notes every day",
      channel: "Product Builder",
      url: "https://www.youtube.com/watch?v=notesfallback",
      transcriptText: "[0:00] I use AI notes to capture meetings.\n[2:00] The real value is retrieval, not summarization.\n[4:00] Most teams fail because they do not define a workflow."
    }
  ],
  markdown: ""
});
assertEqual(
  "youtube Feishu doc fallback title preserves informative English source title",
  String(englishFallbackDocMarkdown.startsWith("# How I use AI notes every day") && !englishFallbackDocMarkdown.startsWith("# How I use AI notes every day YouTube 技术笔记")),
  "true"
);

const productDocMarkdown = bot.buildFeishuYoutubeDocumentMarkdown({
  topic: "AI note app",
  title: "How I use AI notes every day",
  videos: [
    {
      title: "How I use AI notes every day",
      channel: "Product Builder",
      url: "https://www.youtube.com/watch?v=notes123456",
      transcriptText: "[0:00] I use AI notes to capture meetings.\n[2:00] The real value is retrieval, not summarization.\n[4:00] Most teams fail because they do not define a workflow."
    }
  ],
  markdown: [
    "# AI 笔记真正改变的不是记录，而是团队如何找回知识",
    "",
    "很多团队把 AI 笔记当成自动总结工具，但这条视频真正指向的是另一个问题：知识如果不能被找回，再漂亮的会议纪要也只是新的信息垃圾。",
    "",
    "## 一、背景导读：这不是记笔记工具，而是知识回收工具",
    "视频里的核心场景不是把会议内容转成文字，而是让团队在需要决策时能重新找到上下文。",
    "",
    "## 二、精华总结：真正的价值出现在会后",
    "总结只是入口，检索、关联和责任追踪才是长期价值。",
    "",
    "## 三、关键技术点速览：检索、关联和责任追踪",
    "如果团队没有定义谁记录、谁复盘、谁更新结论，AI 只会制造更多半成品。",
    "",
    "## 四、详细技术拆解：落地风险在工作流，不在模型",
    "会议内容被记录下来只是第一步，真正的工程难点在于把片段变成可追踪的知识对象。团队需要知道哪些信息进入长期记忆，哪些只是临时噪音，以及谁负责把讨论转成决策。",
    "",
    "如果没有这套流程，AI 笔记会把信息生产速度提高，但同时也会扩大知识管理的负担。一个团队真正需要的不是更多摘要，而是能够在项目复盘、客户交接和产品决策时迅速找回原始上下文，并且知道当时为什么做出那个判断。",
    "",
    "所以这类工具的价值边界很清楚：模型负责捕捉和重组材料，组织负责定义信息的生命周期。什么时候归档，什么时候更新，什么时候删除，什么时候把会议结论转成任务，这些规则如果缺席，再强的总结能力也只能制造更多看似完整、实际没人负责的文档。",
    "",
    "## 五、时间线摘要：关键时间点",
    "- [0:00] 捕捉会议只是起点。",
    "- [2:00] 找回知识比生成摘要更重要。",
    "- [4:00] 工作流缺失会让工具价值归零。",
    "",
    "## 六、值得继续追问的问题：如何避免知识库变成垃圾场",
    "- 哪些知识应该进入长期记忆？",
    "- 谁负责把会议记录转成可执行决策？"
  ].join("\n")
});
assertEqual(
  "youtube Feishu doc does not force SpaceX-specific headings onto other videos",
  String(!productDocMarkdown.includes("星舰工厂") && !productDocMarkdown.includes("马斯克") && productDocMarkdown.includes("## 一、背景导读：这不是记笔记工具，而是知识回收工具")),
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
