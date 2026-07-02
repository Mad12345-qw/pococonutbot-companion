import { truncate } from "./utils.js";
import { logEvent } from "./runtime-log.js";

function compactLines(lines = []) {
  return lines.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
}

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripMarkdown(value = "") {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstParagraph(markdown = "") {
  return String(markdown || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\n{2,}/)
    .map((part) => stripMarkdown(part))
    .find((part) => part.length >= 24) || "";
}

function extractMarkdownTitle(markdown = "", fallback = "") {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return stripMarkdown(match?.[1] || fallback).slice(0, 64);
}

function normalizeTitle(value = "", fallback = "") {
  const text = stripMarkdown(value || fallback)
    .replace(/^(整理好了|已整理|已生成|生成好了|文章整理好了)\s*[：:]\s*/i, "")
    .replace(/[<>]/g, "")
    .trim();
  return (text || stripMarkdown(fallback) || "值得认真读的一篇研究").slice(0, 64);
}

function normalizeDigest(value = "", fallback = "") {
  const text = stripMarkdown(value || fallback).replace(/[<>]/g, "").trim();
  return (text || "一篇来自小椰工作流的深度整理，适合对同一主题长期关注的人收藏阅读。").slice(0, 120);
}

function cleanPublicTitle(value = "", fallback = "") {
  const text = stripMarkdown(value || fallback)
    .replace(/^(?:\u6574\u7406\u597d\u4e86|\u5df2\u6574\u7406|\u5df2\u751f\u6210|\u751f\u6210\u597d\u4e86|\u6587\u7ae0\u6574\u7406\u597d\u4e86)\s*[\uff1a:]\s*/i, "")
    .replace(/[<>]/g, "")
    .trim();
  return (text || stripMarkdown(fallback) || "").slice(0, 64);
}

function removeDuplicateTitleLine(markdown = "", title = "") {
  const cleanTitle = stripMarkdown(title);
  if (!cleanTitle) return String(markdown || "").trim();
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length) {
    const first = stripMarkdown(lines[0]);
    if (first === cleanTitle || cleanTitle.includes(first) || first.includes(cleanTitle)) {
      lines.shift();
    }
  }
  return lines.join("\n").trim();
}

function isBareSectionHeading(line = "") {
  return /^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}\u3001\S+/.test(String(line || "").trim());
}

function isWeakOpeningLine(line = "", title = "") {
  const clean = stripMarkdown(line);
  if (!clean || clean.length < 18) return true;
  if (clean === stripMarkdown(title)) return true;
  if (isBareSectionHeading(clean)) return true;
  if (/^\[\d{1,2}:\d{2}/.test(clean)) return true;
  if (/^https?:\/\//i.test(clean)) return true;
  if (/^[A-Za-z][A-Za-z0-9+ .\/\-]{1,48}\s*[:\uff1a]\s*/.test(clean)) return true;
  return false;
}

function readerOpeningHook(markdown = "", title = "") {
  const paragraphs = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.replace(/\n+/g, " ").trim())
    .filter(Boolean);
  const picked = paragraphs.find((part) => !isWeakOpeningLine(part, title)) || "";
  return stripMarkdown(picked);
}

function trimToSentence(value = "", max = 150) {
  const text = stripMarkdown(value).trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const punct = Math.max(
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("！"),
    clipped.lastIndexOf("？"),
    clipped.lastIndexOf(";"),
    clipped.lastIndexOf("；")
  );
  if (punct >= 48) return clipped.slice(0, punct + 1);
  const comma = Math.max(clipped.lastIndexOf("，"), clipped.lastIndexOf(","));
  if (comma >= 60) return `${clipped.slice(0, comma)}。`;
  return `${clipped.replace(/[，,；;：:\\s]+$/g, "")}。`;
}

function cleanArticleText(value = "", max = 1200) {
  return stripMarkdown(String(value || ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stripFeishuSourceMarkdown(markdown = "") {
  return String(markdown || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^>\s*主题聚合：.*$/gm, "")
    .replace(/^>\s*来源类型：.*$/gm, "")
    .replace(/^\s*\[\[[^\]]+]]\s*$/gm, "")
    .replace(/\[\[([^|\]]+)\|([^\]]+)]]/g, "$2")
    .replace(/\[\[([^\]]+)]]/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripFeishuPublicLinks(markdown = "") {
  return String(markdown || "")
    .replace(/^\s*https?:\/\/\S*feishu\.cn\/\S*\s*$/gim, "")
    .replace(/\[[^\]]*]\(https?:\/\/[^)]*feishu\.cn\/[^)]*\)/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseTranscriptDumpForWechat(markdown = "") {
  const text = String(markdown || "");
  return text
    .replace(
      /\n###\s+原文摘录\s*\n```(?:text)?[\s\S]*?```\s*(?=\n##\s+[一二三四五六七八九十]+、|\n###\s+|\s*$)/g,
      "\n### 原文核对\n本文保留关键时间线和精选原文证据，完整原文索引可回到来源材料核对。\n"
    )
    .replace(/```(?:text)?\n([\s\S]*?)```/g, (_match, inner) => {
      const lines = String(inner || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
      return lines.length ? lines.map((line) => `> ${line}`).join("\n") : "";
    });
}

function stripLeadingDecor(value = "") {
  return String(value || "").replace(/^[^\u4e00-\u9fffA-Za-z0-9#]+/, "").trim();
}

function stripWechatInlineDecor(value = "") {
  return stripLeadingDecor(String(value || ""))
    .replace(/^[\u25c6\u25c7\u25cf\u25cb\u25a0\u25a1\u2022\u00b7]+\s*/, "")
    .trim();
}

function removeLegacyWechatPrelude(markdown = "") {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const badIndex = lines.findIndex((line) => (
    /YouTube\s*技术笔记/i.test(line) ||
    /我先按|接下来我会|Obsidian|可直接进/.test(line)
  ));
  if (badIndex < 0) return String(markdown || "");
  const nextArticleStart = lines.findIndex((line, index) => {
    if (index <= badIndex) return false;
    const clean = stripLeadingDecor(stripMarkdown(line.replace(/^#{1,3}\s+/, "")));
    return /^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}、\S+/.test(clean);
  });
  return nextArticleStart > 0 ? lines.slice(nextArticleStart).join("\n").trim() : String(markdown || "");
}

function isWechatTopSectionLine(line = "") {
  const text = String(line || "").trim();
  if (/^#{1,2}\s+[\u4e00-\u9fff\d]{1,4}[、.．]\s*\S+/.test(text)) return true;
  if (/^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}、\S+/.test(text)) return true;
  const clean = stripLeadingDecor(stripMarkdown(text.replace(/^#{1,3}\s+/, "")));
  if (/^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}、\S+/.test(clean)) return true;
  return false;
}

function cleanWechatHeading(line = "") {
  return stripWechatInlineDecor(stripMarkdown(String(line || "").replace(/^#{1,3}\s+/, "")));
}

function splitWechatSections(markdown = "") {
  const sections = [];
  let current = { heading: "", lines: [] };
  for (const rawLine of String(markdown || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (isWechatTopSectionLine(line)) {
      if (current.heading || current.lines.some((item) => item.trim())) sections.push(current);
      current = { heading: cleanWechatHeading(line), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading || current.lines.some((item) => item.trim())) sections.push(current);
  return sections;
}

function sectionLimitForWechat(heading = "") {
  if (/关键术语|术语解释/.test(heading)) return 5200;
  if (/背景/.test(heading)) return 2600;
  if (/导读|核心结论|精华|总结/.test(heading)) return 3200;
  if (/技术点|速览/.test(heading)) return 3600;
  if (/详细|拆解|工程/.test(heading)) return 4200;
  if (/时间线/.test(heading)) return 3200;
  if (/追问|问题/.test(heading)) return 1800;
  if (/出处|来源|链接|资料/.test(heading)) return 900;
  return 2200;
}

function trimSectionForWechat(lines = [], heading = "") {
  const limit = sectionLimitForWechat(heading);
  const output = [];
  let chars = 0;
  let timelineItems = 0;
  let inCode = false;
  let skippingPublicSubsection = false;
  for (const rawLine of lines) {
    const line = String(rawLine || "").trimEnd();
    if (/^```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const cleanLine = stripWechatInlineDecor(stripMarkdown(line.replace(/^#{1,6}\s+/, ""))).trim();
    if (/^(标志性金句|最反共识的判断)$/.test(cleanLine)) {
      skippingPublicSubsection = true;
      continue;
    }
    if (skippingPublicSubsection && /^(一句话结论|一句话总结|核心观点|关键术语解释)$/.test(cleanLine)) {
      skippingPublicSubsection = false;
    }
    if (skippingPublicSubsection) continue;
    if (/raw transcript|完整逐字稿|完整字幕|全文逐字/i.test(line)) continue;
    if (/^\[\d{1,2}:\d{2}/.test(line) || /^[-*]\s+\[\d{1,2}:\d{2}/.test(line)) {
      timelineItems += 1;
      if (timelineItems > 12) continue;
    }
    const nextChars = stripMarkdown(line).length;
    if (chars + nextChars > limit && output.length > 3) continue;
    output.push(line);
    chars += nextChars;
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function compactText(value = "", max = 120) {
  const text = stripMarkdown(value)
    .replace(/\s+/g, " ")
    .replace(/^(即|就是|指)\s*/, "")
    .trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const punct = Math.max(clipped.lastIndexOf("。"), clipped.lastIndexOf("；"), clipped.lastIndexOf(";"));
  if (punct >= 42) return clipped.slice(0, punct + 1);
  const comma = Math.max(clipped.lastIndexOf("，"), clipped.lastIndexOf(","));
  if (comma >= 42) return `${clipped.slice(0, comma)}。`;
  return `${clipped.replace(/[，,；;：:\s]+$/g, "")}。`;
}

function compactGlossaryForWechat(lines = []) {
  const entries = [];
  const bodyLines = lines
    .slice(isWechatTopSectionLine(lines[0] || "") ? 1 : 0)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  for (let index = 0; index < bodyLines.length && entries.length < 5; index += 1) {
    const line = bodyLines[index];
    let match = line.match(/^[-*•]?\s*(?:\*\*)?([^:*：]{2,48})(?:\*\*)?\s*[:：]\s*(.{8,})$/);
    if (match) {
      entries.push({ term: match[1], desc: match[2] });
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9+ .\/\-]{1,48}$/.test(line) && bodyLines[index + 1]) {
      entries.push({ term: line, desc: bodyLines[index + 1] });
      index += 1;
    }
  }
  if (!entries.length) return "";
  return [
    "二、关键术语速览",
    "",
    ...entries.map((entry) => `${entry.term}: ${compactText(entry.desc, 105)}`)
  ].join("\n");
}

function sectionKindForWechat(heading = "") {
  if (/关键术语|术语解释/.test(heading)) return "glossary";
  if (/背景/.test(heading)) return "background";
  if (/导读|核心结论|核心判断|精华|总结/.test(heading)) return "conclusion";
  if (/关键证据/.test(heading)) return "thinEvidence";
  if (/详细|拆解|工程/.test(heading)) return "deepAnalysis";
  if (/技术点|速览/.test(heading)) return "technicalOverview";
  if (/时间线/.test(heading)) return "timeline";
  if (/追问|问题/.test(heading)) return "questions";
  if (/出处|来源|链接|资料/.test(heading)) return "source";
  return "other";
}

function sortSectionsForWechat(sections = []) {
  const order = {
    background: 10,
    glossary: 20,
    conclusion: 30,
    deepAnalysis: 40,
    technicalOverview: 50,
    thinEvidence: 90,
    timeline: 50,
    questions: 60,
    source: 70,
    other: 80
  };
  return sections
    .map((section, index) => ({ ...section, kind: sectionKindForWechat(section.heading), index }))
    .sort((a, b) => (order[a.kind] || 99) - (order[b.kind] || 99) || a.index - b.index);
}

function renumberWechatTopSections(markdown = "") {
  const numerals = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  let index = 0;
  return String(markdown || "").replace(
    /^(#{0,3}\s*)[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}、/gm,
    (match, prefix) => `${prefix}${numerals[index++] || index}、`
  );
}

function trimWechatPublicBody(markdown = "") {
  const sections = splitWechatSections(markdown);
  if (!sections.length) return String(markdown || "").trim();
  const picked = [];
  let total = 0;
  const seenKinds = new Set();
  for (const section of sortSectionsForWechat(sections)) {
    const heading = section.heading;
    if (section.kind === "timeline" || section.kind === "source" || section.kind === "thinEvidence" || section.kind === "technicalOverview") continue;
    if (section.kind === "questions" && seenKinds.has("questions")) continue;
    const rendered = section.kind === "glossary"
      ? compactGlossaryForWechat(section.lines)
      : trimSectionForWechat(section.lines, heading);
    if (!rendered) continue;
    const isSource = /出处|来源|链接|资料/.test(heading);
    const maxTotal = isSource ? 22_000 : 20_000;
    const length = stripMarkdown(rendered).length;
    if (total + length > maxTotal && !isSource) continue;
    picked.push(rendered);
    seenKinds.add(section.kind);
    total += length;
  }
  return renumberWechatTopSections(picked.join("\n\n").replace(/\n{3,}/g, "\n\n").trim());
}

function readerOpeningFromSections(markdown = "", title = "") {
  const sections = splitWechatSections(markdown);
  const preferred = [/核心结论|核心判断|精华|总结/, /背景|导读/, /技术|拆解/];
  const paragraphsFrom = (section) => section.lines
    .slice(isWechatTopSectionLine(section.lines[0] || "") ? 1 : 0)
    .join("\n")
    .split(/\n{2,}/)
    .map((part) => part.replace(/\n+/g, " ").trim())
    .filter(Boolean);
  for (const pattern of preferred) {
    for (const section of sections) {
      if (!pattern.test(section.heading)) continue;
      const paragraph = paragraphsFrom(section).find((part) => !isWeakOpeningLine(part, title));
      if (paragraph) return stripMarkdown(paragraph);
    }
  }
  for (const section of sections) {
    if (/关键术语|术语解释|时间线|出处|来源|链接|资料/.test(section.heading)) continue;
    const paragraph = paragraphsFrom(section).find((part) => !isWeakOpeningLine(part, title));
    if (paragraph) return stripMarkdown(paragraph);
  }
  const fallback = readerOpeningHook(markdown, title);
  if (/关键术语解释|术语解释|^[A-Za-z][A-Za-z0-9+ .\/\-]{1,48}\s*[:：]/.test(fallback)) {
    return title ? `这篇文章围绕「${title}」展开，先把关键概念、背景语境和核心判断整理成适合公开阅读的版本。` : "";
  }
  return fallback;
}

function extractWechatCoverAnchors(title = "", markdown = "") {
  const text = stripMarkdown(`${title}\n${markdown}`);
  const terms = [];
  const weakLabels = /^(为什么重要|读者该抓住什么|视频里怎么说|风险或不确定性|含义|一句话结论|核心观点|原文证据|资料来源|背景导读|时间线摘要)$/;
  const push = (value) => {
    const clean = String(value || "")
      .replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean && clean.length >= 2 && clean.length <= 48 && !weakLabels.test(clean) && !terms.includes(clean)) terms.push(clean);
  };
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9+.-]{2,}\b/g)) {
    push(match[0]);
  }
  for (const match of String(markdown || "").matchAll(/\*\*([^*：:]{2,40})[：:]/g)) {
    push(match[1]);
  }
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
    const value = match[0];
    if (!/^(这段|视频|读者|为什么|重要|核心|观点|资料|来源|问题|结论|文章|如果|一个|不是|需要|可以)$/.test(value)) {
      push(value);
    }
  }
  return terms.slice(0, 12);
}

function buildWechatCoverPrompt({ title = "", digest = "", bodyMarkdown = "" } = {}) {
  const anchors = extractWechatCoverAnchors(title, bodyMarkdown);
  const context = cleanArticleText(firstParagraph(bodyMarkdown) || digest || title, 360);
  return [
    "Create a premium editorial cover image for a Chinese WeChat official account article.",
    "Format: wide 2.35:1 feature image, polished magazine/research newsletter style, high contrast, strong focal subject, mobile-readable composition.",
    `Article title: ${title}`,
    anchors.length ? `Concrete visual anchors from the article: ${anchors.join(", ")}` : "",
    context ? `Central context: ${context}` : "",
    "Visual direction: turn the article's real subject, industry setting, technical object, or strategic tension into one specific scene; avoid generic abstract gradients.",
    "No text, no Chinese characters, no English letters, no logos, no watermarks, no UI screenshots, no fake charts with readable numbers."
  ].filter(Boolean).join("\n");
}

function buildWechatLeadImagePrompt({ title = "", bodyMarkdown = "" } = {}) {
  const anchors = extractWechatCoverAnchors(title, bodyMarkdown).slice(0, 8);
  return [
    "Create one clean inline editorial illustration for a WeChat article section.",
    "Style: refined explainer graphic, specific to the article topic, not decorative filler.",
    `Topic: ${title}`,
    anchors.length ? `Use these concrete anchors: ${anchors.join(", ")}` : "",
    "No text, no logos, no watermarks, no unreadable pseudo-labels."
  ].filter(Boolean).join("\n");
}

function youtubeVideoIdFromUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (host.endsWith("youtube.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v") || "";
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || "";
    }
  } catch {
    const match = text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{8,})/i);
    return match?.[1] || "";
  }
  return "";
}

function youtubeThumbnailUrls(sourceUrl = "") {
  const id = youtubeVideoIdFromUrl(sourceUrl);
  if (!id) return [];
  return [
    `https://i.ytimg.com/vi/${encodeURIComponent(id)}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
  ];
}

function normalizeWechatMarkdownFromFeishu(candidate = {}) {
  const source = stripFeishuSourceMarkdown(candidate.markdown || "");
  const title = cleanPublicTitle(normalizeTitle(candidate.title || extractMarkdownTitle(source), extractMarkdownTitle(source)), extractMarkdownTitle(source));
  let body = source.replace(/^#\s+.+\n+/, "").trim();
  body = removeDuplicateTitleLine(body, title);
  body = removeLegacyWechatPrelude(body);
  body = collapseTranscriptDumpForWechat(body)
    .replace(/^##\s+[八九十]+、出处与链接/gm, "## 资料来源")
    .replace(/^##\s+[八九十]+、资料来源与证据索引/gm, "## 资料来源与证据索引")
    .replace(/^\s*(?:[-*•]\s*)?(字幕语言|本文输出语言|输出语言|内容形式|内容形态)[:：].*$/gm, "")
    .replace(/\[证据\s+([A-Z]?\d+)]\(#证据-[^)]+\)/gi, "证据 $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  body = stripFeishuPublicLinks(body);
  body = trimWechatPublicBody(body);
  body = removeDuplicateTitleLine(body, title);
  const first = readerOpeningFromSections(body, title) || firstParagraph(body);
  return {
    title,
    digest: normalizeDigest(first, title),
    openingHook: trimToSentence(first, 150),
    bodyMarkdown: body,
    cta: "",
    coverPrompt: buildWechatCoverPrompt({ title, digest: first, bodyMarkdown: body }),
    leadImagePrompt: buildWechatLeadImagePrompt({ title, bodyMarkdown: body })
  };
}

function assertWechatSourceArticleReady(article = {}, candidate = {}) {
  const title = cleanArticleText(article.title, 100);
  const body = String(article.bodyMarkdown || "");
  if (!candidate.markdown) throw new Error("公众号草稿需要已生成的飞书成品文档内容；当前候选缺少正文。");
  if (!title || title.length < 8) throw new Error("公众号草稿格式检查失败：标题太弱。");
  if (!body || stripMarkdown(body).length < 700) throw new Error("公众号草稿格式检查失败：正文太短，不能作为公众号草稿。");
  const forbidden = [
    /YouTube\s*技术笔记/i,
    /阅读导航|输出语言|内容形态|字幕语言|raw transcript/i,
    /Obsidian|Markdown/i,
    /我先按|接下来我会|可直接进|这部分没有生成到有效内容|证据基线占位/i,
    /<\/?details|<summary/i,
    /```/
  ];
  const hit = forbidden.find((pattern) => pattern.test(`${title}\n${body}`));
  if (hit) throw new Error(`公众号草稿格式检查失败：检测到不适合对外发布的内容 ${hit}`);
}

function inlineMarkdown(value = "") {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*/g, "").replace(/__/g, "");
  return text;
}

function inlineWechatText(value = "") {
  return inlineMarkdown(
    String(value || "")
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .trim()
  );
}

function styleFor(tag) {
  if (tag === "h1") return "font-size:22px;line-height:1.45;font-weight:700;margin:24px 0 14px;color:#161616;word-break:break-word;";
  if (tag === "h2") return "font-size:18px;line-height:1.55;font-weight:700;margin:34px 0 16px;color:#161616;padding:0 0 8px;border-bottom:1px solid #e8e2d8;word-break:break-word;";
  if (tag === "h3") return "font-size:16px;line-height:1.6;font-weight:700;margin:24px 0 10px;color:#202124;word-break:break-word;";
  if (tag === "blockquote") return "margin:18px 0;padding:15px 17px;background:#fffaf6;border-left:3px solid #ff7a00;color:#34302b;line-height:1.85;font-size:15px;word-break:break-word;";
  if (tag === "li") return "margin:9px 0;line-height:1.9;color:#333333;font-size:15px;word-break:break-word;";
  if (tag === "p") return "margin:15px 0;line-height:1.98;font-size:15.5px;color:#303030;letter-spacing:0;word-break:break-word;";
  return "";
}

function wechatSectionDisplayTitle(text = "") {
  const heading = stripWechatInlineDecor(stripMarkdown(text)).replace(/^[一二三四五六七八九十]+、\s*/, "").trim();
  if (/关键术语|术语解释|术语速览/.test(heading)) return "读前先懂这几个词";
  if (/背景/.test(heading)) return "这件事为什么现在值得看";
  if (/导读|核心结论|核心判断|精华|总结/.test(heading)) return "真正值得带走的判断";
  if (/详细|拆解|工程/.test(heading)) return "详细技术拆解";
  if (/关键证据/.test(heading)) return "为什么这个判断站得住";
  if (/技术点|速览/.test(heading)) return "关键技术点速览";
  if (/详细|拆解|工程|技术/.test(heading)) return "技术细节背后的产业含义";
  if (/时间线/.test(heading)) return "按时间线核对原文";
  if (/追问|问题/.test(heading)) return "接下来最该追问什么";
  if (/出处|来源|链接|资料/.test(heading)) return "资料来源";
  return heading || text;
}

function sectionHeadingHtml(text = "") {
  const title = wechatSectionDisplayTitle(text);
  return [
    '<section style="margin:44px 0 20px;padding:13px 16px;background:#ffffff;border:1px solid #ececec;border-left:4px solid #ff7a00;border-radius:8px;text-align:center;">',
    `<h2 style="font-size:19px;line-height:1.55;font-weight:700;margin:0;color:#161616;word-break:break-word;">${inlineMarkdown(title)}</h2>`,
    "</section>"
  ].join("");
}

function subsectionHeadingHtml(text = "") {
  let clean = stripWechatInlineDecor(stripMarkdown(text)).trim();
  if (clean === "一句话结论") clean = "一句话总结";
  return [
    '<section style="margin:24px 0 12px;padding:0 0 8px;border-bottom:1px solid #ececec;">',
    `<p style="margin:0;font-size:16px;line-height:1.6;font-weight:700;color:#1f1f1f;word-break:break-word;">${inlineMarkdown(clean)}</p>`,
    "</section>"
  ].join("");
}

function termCardHtml(term = "", description = "") {
  return [
    '<section style="margin:11px 0;padding:13px 15px;background:#ffffff;border:1px solid #ececec;border-radius:8px;">',
    `<p style="margin:0 0 6px;font-size:15px;line-height:1.55;color:#161616;font-weight:700;word-break:break-word;">${inlineMarkdown(term)}</p>`,
    `<p style="margin:0;font-size:14.5px;line-height:1.85;color:#4a4a4a;word-break:break-word;">${inlineMarkdown(description)}</p>`,
    "</section>"
  ].join("");
}

function transcriptLineHtml(line = "") {
  const match = String(line || "").trim().match(/^(\[\d{1,2}:\d{2}(?::\d{2})?])\s*(.+)$/);
  if (!match) return "";
  return [
    '<section style="margin:8px 0;padding:9px 12px;background:#f7f7f7;border-radius:6px;">',
    `<span style="display:inline-block;margin-right:8px;color:#81766b;font-size:12px;font-family:Menlo,Consolas,monospace;">${escapeHtml(match[1])}</span>`,
    `<span style="color:#4a4a4a;font-size:13.5px;line-height:1.7;word-break:break-word;">${inlineMarkdown(match[2])}</span>`,
    "</section>"
  ].join("");
}

function paragraphHtml(line = "") {
  const text = String(line || "").trim();
  const colon = text.match(/^([^:\uff1a]{2,28})[:\uff1a]\s*(.+)$/);
  if (colon && /[\u4e00-\u9fff]/.test(colon[1])) {
    return `<p style="${styleFor("p")}"><strong style="color:#161616;">${inlineMarkdown(colon[1])}：</strong>${inlineMarkdown(colon[2])}</p>`;
  }
  return `<p style="${styleFor("p")}">${inlineMarkdown(text)}</p>`;
}

function isBareEnglishLongLine(value = "") {
  const text = stripMarkdown(value).trim();
  if (text.length < 48) return false;
  const ascii = (text.match(/[A-Za-z0-9 ,.;:'"!?()[\]/+-]/g) || []).length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return chinese === 0 && ascii / Math.max(text.length, 1) > 0.82;
}

function subPointHeadingHtml(text = "") {
  const clean = stripWechatInlineDecor(text).replace(/^\d+[.)、]\s*/, "");
  return [
    '<section style="margin:20px 0 10px;padding:0;">',
    `<p style="margin:0;font-size:16px;line-height:1.65;font-weight:700;color:#161616;word-break:break-word;">${inlineWechatText(clean)}</p>`,
    "</section>"
  ].join("");
}

function numberedWechatHeading(text = "", fallbackNumber = 1) {
  const clean = stripWechatInlineDecor(stripMarkdown(text)).trim();
  const match = clean.match(/^(\d+)[.)、]\s*(.+)$/);
  const rawNumber = match ? Number(match[1]) : fallbackNumber;
  return {
    number: String(Number.isFinite(rawNumber) && rawNumber > 0 ? rawNumber : fallbackNumber).padStart(2, "0"),
    title: (match ? match[2] : clean).trim()
  };
}

function wechatCardBulletHtml(text = "") {
  return `<p style="margin:9px 0 0;padding-left:12px;border-left:2px solid #ffb04a;line-height:1.85;font-size:14.5px;color:#333333;word-break:break-word;">${inlineWechatText(text)}</p>`;
}

function wechatCardQuoteHtml(text = "") {
  return `<section style="margin:10px 0 12px;padding:10px 12px;background:#fffaf6;border:1px solid #f1e3d3;border-radius:6px;color:#444444;line-height:1.78;font-size:14px;word-break:break-word;">${inlineWechatText(text)}</section>`;
}

function wechatCardParagraphHtml(line = "") {
  const text = String(line || "").trim();
  const colon = text.match(/^([^:\uff1a]{2,28})[:\uff1a]\s*(.+)$/);
  if (colon && /[\u4e00-\u9fff]/.test(colon[1])) {
    return `<p style="margin:9px 0 0 44px;padding-left:12px;border-left:2px solid #ffb04a;line-height:1.85;font-size:14.5px;color:#333333;word-break:break-word;"><strong style="color:#161616;">${inlineMarkdown(colon[1])}：</strong>${inlineMarkdown(colon[2])}</p>`;
  }
  return `<p style="margin:9px 0 0 44px;padding-left:12px;border-left:2px solid #ffb04a;line-height:1.85;font-size:14.5px;color:#333333;word-break:break-word;">${inlineMarkdown(text)}</p>`;
}

function wechatReaderCardHtml({ kind = "core", number = "01", title = "", body = [] } = {}) {
  const isTech = kind === "technical";
  const badgeBg = isTech ? "#1d1d1f" : "#ff7a00";
  const border = isTech ? "#e6e6e6" : "#f1e3d3";
  const bg = isTech ? "#ffffff" : "#fffaf6";
  return [
    `<section style="margin:14px 0 18px;padding:16px 16px 14px;background:${bg};border:1px solid ${border};border-radius:8px;">`,
    `<p style="margin:0 0 10px;padding:0;font-size:16px;line-height:1.65;font-weight:700;color:#171717;word-break:break-word;"><span style="display:inline-block;min-width:34px;height:28px;line-height:28px;text-align:center;border-radius:16px;background:${badgeBg};color:#ffffff;font-size:13px;font-weight:700;margin:0 8px 0 0;vertical-align:1px;">${escapeHtml(number)}</span><strong style="font-weight:700;color:#171717;">${inlineWechatText(title)}</strong></p>`,
    body.join("\n"),
    "</section>"
  ].join("\n");
}

function wechatQuestionHtml(number = 1, text = "") {
  return [
    '<section style="margin:12px 0;padding:13px 15px;background:#ffffff;border:1px solid #ececec;border-radius:8px;">',
    `<p style="margin:0;font-size:15.5px;line-height:1.85;color:#202124;word-break:break-word;"><span style="display:inline-block;min-width:28px;height:24px;line-height:24px;text-align:center;border-radius:14px;background:#ff7a00;color:#ffffff;font-size:12px;font-weight:700;margin:0 8px 0 0;vertical-align:1px;">${String(number)}</span>${inlineWechatText(text)}</p>`,
    "</section>"
  ].join("");
}

function isWechatLabelHeading(line = "") {
  const clean = stripWechatInlineDecor(stripMarkdown(line));
  return /^(核心观点|一句话结论|一句话总结|关键术语解释|标志性金句|最反共识的判断)$/.test(clean);
}

function formatOpeningHookForWechat(value = "") {
  const text = String(value || "").trim().replace(/[。！？!?；;]+$/u, "");
  return text ? `“${text}”` : "";
}

function normalizeWechatCtaText(value = "") {
  const fallback = "关注我，持续追踪SpaceX、AI、Robot！\n原视频点击左下方「阅读原文」并加入我们！";
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (!text.includes("原视频点击左下方")) return fallback;
  return fallback;
}

function markdownToWechatHtml(markdown = "", { leadImageUrl = "", leadImageCaption = "", openingHook = "", cta = "" } = {}) {
  const html = [];
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let listOpen = false;
  let currentSection = "";
  let currentSubsection = "";
  let activeCard = null;
  let coreCardCount = 0;
  let technicalCardCount = 0;
  let questionCount = 0;
  let skippedOpening = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };
  const flushCard = () => {
    if (activeCard) {
      html.push(wechatReaderCardHtml(activeCard));
      activeCard = null;
    }
  };
  const pushBlock = (fragment) => {
    if (activeCard) activeCard.body.push(fragment);
    else html.push(fragment);
  };
  const isCoreContext = () => /核心观点|核心判断/.test(currentSubsection) || /核心观点|核心判断/.test(currentSection);
  const isTechnicalContext = () => /详细|拆解|工程/.test(currentSection) || /详细|拆解|工程/.test(currentSubsection);
  const startReaderCard = (kind, titleText) => {
    closeList();
    flushCard();
    const fallback = kind === "technical" ? technicalCardCount + 1 : coreCardCount + 1;
    const headingInfo = numberedWechatHeading(titleText, fallback);
    if (kind === "technical") technicalCardCount = Number(headingInfo.number);
    else coreCardCount = Number(headingInfo.number);
    activeCard = {
      kind,
      number: headingInfo.number,
      title: headingInfo.title,
      body: []
    };
  };

  if (leadImageUrl) {
    html.push(`<p style="margin:4px 0 12px;"><img src="${escapeHtml(leadImageUrl)}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto;" /></p>`);
    if (leadImageCaption) {
      const captionLines = String(leadImageCaption || "")
        .split(/\r?\n/)
        .map((line) => inlineMarkdown(line.trim()))
        .filter(Boolean)
        .join("<br />");
      html.push(`<p style="margin:0 0 22px;text-align:center;color:#8a8178;font-size:12px;line-height:1.75;">${captionLines}</p>`);
    }
  }
  if (openingHook) {
    const displayOpeningHook = formatOpeningHookForWechat(openingHook);
    html.push([
      '<section style="margin:4px 0 26px;padding:18px 18px;background:#ffffff;border:1px solid #ececec;border-top:4px solid #ff7a00;border-radius:10px;">',
      '<p style="margin:0 0 10px;color:#161616;font-size:19px;line-height:1.55;font-weight:700;text-align:center;">先说结论</p>',
      `<p style="margin:0;color:#2b2723;line-height:1.9;font-size:14.8px;font-weight:600;word-break:break-word;">${inlineMarkdown(displayOpeningHook)}</p>`,
      "</section>"
    ].join(""));
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      closeList();
      flushCard();
      if (!inCode) {
        html.push('<pre style="white-space:pre-wrap;background:#f7f7f7;border-radius:6px;padding:12px;line-height:1.65;font-size:13px;color:#303030;overflow:auto;">');
        inCode = true;
      } else {
        html.push("</pre>");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(line));
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (openingHook && !skippedOpening) {
      const cleanLine = stripMarkdown(line);
      if (cleanLine === openingHook || cleanLine.includes(openingHook) || openingHook.includes(cleanLine)) {
        skippedOpening = true;
        continue;
      }
    }
    if (/^!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/.test(line)) {
      closeList();
      flushCard();
      const match = line.match(/^!\[([^\]]*)]\((https?:\/\/[^)\s]+)\)/);
      html.push(`<p style="margin:18px 0 24px;"><img src="${escapeHtml(match[2])}" alt="${escapeHtml(match[1] || "")}" style="max-width:100%;display:block;margin:0 auto;border-radius:8px;" /></p>`);
      continue;
    }
    const decoratedLine = stripWechatInlineDecor(line.trim());
    if (isWechatLabelHeading(decoratedLine)) {
      closeList();
      flushCard();
      currentSubsection = stripWechatInlineDecor(stripMarkdown(decoratedLine));
      html.push(subsectionHeadingHtml(decoratedLine));
      continue;
    }
    if (/^\d+[.)、]\s+\S+/.test(decoratedLine)) {
      if (isCoreContext()) {
        startReaderCard("core", decoratedLine);
      } else if (isTechnicalContext()) {
        startReaderCard("technical", decoratedLine);
      } else {
        closeList();
        flushCard();
        html.push(subPointHeadingHtml(decoratedLine));
      }
      continue;
    }
    const bareHeading = decoratedLine.match(/^([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3})\u3001(.+)$/);
    if (bareHeading) {
      closeList();
      flushCard();
      currentSection = bareHeading[2].trim();
      currentSubsection = "";
      questionCount = 0;
      html.push(sectionHeadingHtml(`${bareHeading[1]}、${currentSection}`));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      if (tag === "h2") {
        flushCard();
        currentSection = stripMarkdown(heading[2]);
        currentSubsection = "";
        coreCardCount = 0;
        technicalCardCount = 0;
        questionCount = 0;
        html.push(sectionHeadingHtml(heading[2]));
      } else if (level >= 4) {
        const headingText = stripWechatInlineDecor(heading[2]);
        if (isCoreContext()) {
          startReaderCard("core", headingText);
        } else if (isTechnicalContext()) {
          startReaderCard("technical", headingText);
        } else {
          flushCard();
          html.push(subPointHeadingHtml(headingText));
        }
      } else {
        const headingText = stripWechatInlineDecor(stripMarkdown(heading[2]));
        if (/^\d+[.)、]\s+\S+/.test(headingText) && isCoreContext()) {
          startReaderCard("core", headingText);
        } else if (/^\d+[.)、]\s+\S+/.test(headingText) && isTechnicalContext()) {
          startReaderCard("technical", headingText);
        } else {
          flushCard();
          currentSubsection = headingText;
          html.push(subsectionHeadingHtml(heading[2]));
        }
      }
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      const quoteText = line.replace(/^>\s?/, "");
      pushBlock(activeCard ? wechatCardQuoteHtml(quoteText) : `<blockquote style="${styleFor("blockquote")}">${inlineMarkdown(quoteText)}</blockquote>`);
      continue;
    }
    const transcriptHtml = transcriptLineHtml(line);
    if (transcriptHtml) {
      closeList();
      flushCard();
      html.push(transcriptHtml);
      continue;
    }
    const term = decoratedLine.match(/^([A-Za-z][A-Za-z0-9+ .\/\-]{1,48})\s*[:\uff1a]\s*(.{12,})$/);
    if (term && (/术语|解释|关键/.test(currentSection) || /术语|解释|关键/.test(currentSubsection) || currentSection === "")) {
      closeList();
      flushCard();
      html.push(termCardHtml(term[1], term[2]));
      continue;
    }
    const bullet = decoratedLine.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      if (activeCard) {
        activeCard.body.push(wechatCardBulletHtml(bullet[1]));
        continue;
      }
      if (/追问|问题/.test(currentSection)) {
        closeList();
        flushCard();
        questionCount += 1;
        html.push(wechatQuestionHtml(questionCount, bullet[1]));
        continue;
      }
      if (!listOpen) {
        html.push('<ul style="padding-left:1.2em;margin:10px 0 18px;">');
        listOpen = true;
      }
      html.push(`<li style="${styleFor("li")}">${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    const ordered = decoratedLine.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      if (activeCard) {
        activeCard.body.push(wechatCardBulletHtml(ordered[1]));
        continue;
      }
      if (/追问|问题/.test(currentSection)) {
        closeList();
        flushCard();
        questionCount += 1;
        html.push(wechatQuestionHtml(questionCount, ordered[1]));
        continue;
      }
      if (!listOpen) {
        html.push('<ul style="padding-left:1.2em;margin:10px 0 18px;">');
        listOpen = true;
      }
      html.push(`<li style="${styleFor("li")}">${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }
    closeList();
    if (isBareEnglishLongLine(decoratedLine)) continue;
    if (/追问|问题/.test(currentSection)) {
      flushCard();
      questionCount += 1;
      html.push(wechatQuestionHtml(questionCount, decoratedLine));
      continue;
    }
    pushBlock(activeCard ? wechatCardParagraphHtml(decoratedLine) : paragraphHtml(decoratedLine));
  }
  closeList();
  flushCard();
  if (inCode) html.push("</pre>");
  if (cta) {
    const ctaHtml = String(cta || "")
      .split(/\r?\n/)
      .map((line) => inlineMarkdown(line.trim()))
      .filter(Boolean)
      .join("<br />");
    html.push(`<section style="margin:30px 0 8px;padding:16px 18px;background:#f7f7f7;border-left:4px solid #ff7a00;border-right:4px solid #ff7a00;border-radius:8px;line-height:1.85;font-size:15px;color:#303030;text-align:center;font-weight:600;">${ctaHtml}</section>`);
  }
  return html.join("\n").replace(/一句话结论/g, "一句话总结");
}

export class WeChatPublisher {
  constructor({ config, ai, imageGenerator }) {
    this.config = config;
    this.ai = ai;
    this.imageGenerator = imageGenerator;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.config.wechatMpEnabled && this.config.wechatMpAppId && this.config.wechatMpAppSecret);
  }

  async accessTokenForMp() {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    if (!this.enabled) throw new Error("WeChat MP publishing is not configured.");
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", this.config.wechatMpAppId);
    url.searchParams.set("secret", this.config.wechatMpAppSecret);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.errcode) {
      throw new Error(`WeChat access_token failed: ${truncate(JSON.stringify(data), 500)}`);
    }
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = now + Number(data.expires_in || 7200) * 1000;
    return this.accessToken;
  }

  async wechatJson(path, body) {
    const token = await this.accessTokenForMp();
    const url = new URL(`https://api.weixin.qq.com${path}`);
    url.searchParams.set("access_token", token);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || data.errcode) {
      throw new Error(`WeChat API ${path} failed: ${truncate(JSON.stringify(data), 800)}`);
    }
    return data;
  }

  async uploadPermanentImage(image, filename = "cover.png") {
    const token = await this.accessTokenForMp();
    const url = new URL("https://api.weixin.qq.com/cgi-bin/material/add_material");
    url.searchParams.set("access_token", token);
    url.searchParams.set("type", "image");
    const blob = new Blob([image.buffer], { type: image.mimeType || "image/png" });
    const form = new FormData();
    form.append("media", blob, filename);
    const response = await fetch(url, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok || data.errcode) {
      throw new Error(`WeChat permanent image upload failed: ${truncate(JSON.stringify(data), 800)}`);
    }
    if (!data.media_id) throw new Error(`WeChat permanent image upload missing media_id: ${truncate(JSON.stringify(data), 500)}`);
    return data;
  }

  async uploadArticleImage(image, filename = "inline.png") {
    const token = await this.accessTokenForMp();
    const url = new URL("https://api.weixin.qq.com/cgi-bin/media/uploadimg");
    url.searchParams.set("access_token", token);
    const blob = new Blob([image.buffer], { type: image.mimeType || "image/png" });
    const form = new FormData();
    form.append("media", blob, filename);
    const response = await fetch(url, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok || data.errcode) {
      throw new Error(`WeChat article image upload failed: ${truncate(JSON.stringify(data), 800)}`);
    }
    if (!data.url) throw new Error(`WeChat article image upload missing url: ${truncate(JSON.stringify(data), 500)}`);
    return data.url;
  }

  async buildDistributionPlan(candidate = {}, _options = {}) {
    const article = normalizeWechatMarkdownFromFeishu(candidate);
    assertWechatSourceArticleReady(article, candidate);
    article.cta = normalizeWechatCtaText(this.config.wechatMpCtaText);
    return article;
  }

  async generateImageOrFallback(prompt, plan) {
    if (this.imageGenerator?.enabled) {
      return this.imageGenerator.generate(prompt);
    }
    throw new Error("微信公众号封面生图未配置，且没有可用默认 thumb_media_id；已停止创建草稿，避免使用千篇一律的低质封面。");
  }

  async downloadFirstAvailableImage(urls = []) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const mimeType = response.headers.get("content-type") || "image/jpeg";
        if (!/^image\//i.test(mimeType)) continue;
        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          mimeType,
          sourceUrl: url
        };
      } catch (error) {
        logEvent("warn", "WeChat source video thumbnail download failed", {
          url,
          error: error.message
        });
      }
    }
    return null;
  }

  async createDraft(candidate = {}, { generateImages = false, generateLeadImage = false, coverImage = null, operator = "" } = {}) {
    if (!this.enabled) throw new Error("WeChat MP publishing is not configured.");
    const startedAt = Date.now();
    const plan = await this.buildDistributionPlan(candidate, { generateImages });
    let coverMediaId = this.config.wechatMpDefaultThumbMediaId || "";
    let coverUrl = "";
    let leadImageUrl = "";
    let leadImageCaption = "";
    let imageMode = "default_thumb";
    let coverImageForInline = null;

    if (coverImage?.buffer) {
      coverImageForInline = coverImage;
      const uploaded = await this.uploadPermanentImage(coverImage, "wechat-cover.png");
      coverMediaId = uploaded.media_id;
      coverUrl = uploaded.url || "";
      imageMode = "provided_cover";
    } else if (generateImages || !coverMediaId) {
      const cover = await this.generateImageOrFallback(plan.coverPrompt, plan);
      coverImageForInline = cover;
      const uploaded = await this.uploadPermanentImage(cover, "wechat-cover.png");
      coverMediaId = uploaded.media_id;
      coverUrl = uploaded.url || "";
      imageMode = this.imageGenerator?.enabled ? "generated_cover" : "fallback_cover";
    }

    if (generateLeadImage && this.imageGenerator?.enabled) {
      try {
        const lead = await this.imageGenerator.generate(plan.leadImagePrompt);
        leadImageUrl = await this.uploadArticleImage(lead, "wechat-inline.png");
      } catch (error) {
        logEvent("warn", "WeChat inline image generation skipped", {
          candidateId: candidate.id || "",
          error: error.message
        });
      }
    }
    if (!leadImageUrl && candidate.sourceUrl) {
      const thumbnail = await this.downloadFirstAvailableImage(youtubeThumbnailUrls(candidate.sourceUrl));
      if (thumbnail?.buffer) {
        try {
          leadImageUrl = await this.uploadArticleImage(thumbnail, "wechat-video-thumbnail.jpg");
          leadImageCaption = "封面来自原视频，完整资料与原视频见文末「阅读原文」";
        } catch (error) {
          logEvent("warn", "WeChat source video thumbnail upload skipped", {
            candidateId: candidate.id || "",
            error: error.message
          });
        }
      }
    }
    if (!leadImageUrl && coverImageForInline?.buffer) {
      try {
        leadImageUrl = await this.uploadArticleImage(coverImageForInline, "wechat-lead.png");
      } catch (error) {
        logEvent("warn", "WeChat cover reuse as inline image skipped", {
          candidateId: candidate.id || "",
          error: error.message
        });
      }
    }

    const content = markdownToWechatHtml(plan.bodyMarkdown || "", {
      leadImageUrl,
      leadImageCaption,
      openingHook: plan.openingHook,
      cta: plan.cta
    });
    const data = await this.wechatJson("/cgi-bin/draft/add", {
      articles: [
        {
          title: plan.title,
          author: this.config.wechatMpAuthor || "",
          digest: plan.digest,
          content,
          content_source_url: candidate.feishuDocUrl || candidate.sourceUrl || "",
          thumb_media_id: coverMediaId,
          need_open_comment: Number(this.config.wechatMpOpenComment ? 1 : 0),
          only_fans_can_comment: Number(this.config.wechatMpOnlyFansCanComment ? 1 : 0)
        }
      ]
    });

    logEvent("info", "WeChat draft created", {
      candidateId: candidate.id || "",
      mediaId: data.media_id || "",
      operator,
      generateImages: Boolean(generateImages),
      imageMode,
      elapsedMs: Date.now() - startedAt
    });
    return {
      ok: true,
      draftMediaId: data.media_id || "",
      title: plan.title,
      digest: plan.digest,
      coverMediaId,
      coverUrl,
      leadImageUrl,
      imageMode,
      elapsedMs: Date.now() - startedAt
    };
  }
}
