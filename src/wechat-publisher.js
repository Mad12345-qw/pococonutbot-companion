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
  if (/^[A-Za-z][A-Za-z0-9+ .\-]{1,48}\s*[:\uff1a]\s*/.test(clean)) return true;
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
  if (/^#{1,3}\s+[\u4e00-\u9fff\d]{1,4}[、.．]\s*\S+/.test(text)) return true;
  if (/^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}、\S+/.test(text)) return true;
  const clean = stripLeadingDecor(stripMarkdown(text.replace(/^#{1,3}\s+/, "")));
  if (/^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}、\S+/.test(clean)) return true;
  return false;
}

function cleanWechatHeading(line = "") {
  return stripLeadingDecor(stripMarkdown(String(line || "").replace(/^#{1,3}\s+/, "")));
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
  for (const rawLine of lines) {
    const line = String(rawLine || "").trimEnd();
    if (/^```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
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

function trimWechatPublicBody(markdown = "") {
  const sections = splitWechatSections(markdown);
  if (!sections.length) return String(markdown || "").trim();
  const picked = [];
  let total = 0;
  for (const section of sections) {
    const heading = section.heading;
    const rendered = trimSectionForWechat(section.lines, heading);
    if (!rendered) continue;
    const isSource = /出处|来源|链接|资料/.test(heading);
    const maxTotal = isSource ? 22_000 : 20_000;
    const length = stripMarkdown(rendered).length;
    if (total + length > maxTotal && !isSource) continue;
    picked.push(rendered);
    total += length;
  }
  return picked.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function readerOpeningFromSections(markdown = "", title = "") {
  const sections = splitWechatSections(markdown);
  const preferred = [/背景/, /导读|核心结论|精华|总结/, /技术|拆解/];
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
  if (/关键术语解释|术语解释|^[A-Za-z][A-Za-z0-9+ .\-]{1,48}\s*[:：]/.test(fallback)) {
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

function normalizeWechatMarkdownFromFeishu(candidate = {}) {
  const source = stripFeishuSourceMarkdown(candidate.markdown || "");
  const title = cleanPublicTitle(normalizeTitle(candidate.title || extractMarkdownTitle(source), extractMarkdownTitle(source)), extractMarkdownTitle(source));
  let body = source.replace(/^#\s+.+\n+/, "").trim();
  body = removeLegacyWechatPrelude(body);
  body = collapseTranscriptDumpForWechat(body)
    .replace(/^##\s+[八九十]+、出处与链接/gm, "## 资料来源")
    .replace(/^##\s+[八九十]+、资料来源与证据索引/gm, "## 资料来源与证据索引")
    .replace(/\[证据\s+([A-Z]?\d+)]\(#证据-[^)]+\)/gi, "证据 $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  return text;
}

function styleFor(tag) {
  if (tag === "h1") return "font-size:22px;line-height:1.45;font-weight:700;margin:24px 0 14px;color:#111827;";
  if (tag === "h2") return "font-size:18px;line-height:1.55;font-weight:700;margin:34px 0 16px;color:#111827;padding:0 0 8px;border-bottom:1px solid #e5e7eb;";
  if (tag === "h3") return "font-size:16px;line-height:1.55;font-weight:700;margin:24px 0 10px;color:#111827;";
  if (tag === "blockquote") return "margin:18px 0;padding:14px 16px;background:#f7f8fa;border-left:4px solid #111827;color:#374151;line-height:1.85;font-size:15px;";
  if (tag === "li") return "margin:8px 0;line-height:1.85;color:#263238;font-size:15px;";
  if (tag === "p") return "margin:15px 0;line-height:1.95;font-size:15.5px;color:#263238;letter-spacing:0;";
  return "";
}

function sectionHeadingHtml(text = "") {
  return [
    '<section style="margin:36px 0 18px;">',
    '<p style="margin:0 0 8px;width:36px;height:3px;background:#07C160;border-radius:999px;"></p>',
    `<h2 style="${styleFor("h2")}">${inlineMarkdown(text)}</h2>`,
    "</section>"
  ].join("");
}

function termCardHtml(term = "", description = "") {
  return [
    '<section style="margin:12px 0;padding:13px 15px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;">',
    `<p style="margin:0 0 6px;font-size:15px;line-height:1.55;color:#111827;font-weight:700;">${inlineMarkdown(term)}</p>`,
    `<p style="margin:0;font-size:14.5px;line-height:1.85;color:#4b5563;">${inlineMarkdown(description)}</p>`,
    "</section>"
  ].join("");
}

function transcriptLineHtml(line = "") {
  const match = String(line || "").trim().match(/^(\[\d{1,2}:\d{2}(?::\d{2})?])\s*(.+)$/);
  if (!match) return "";
  return [
    '<section style="margin:8px 0;padding:9px 12px;background:#f6f8fa;border-radius:6px;">',
    `<span style="display:inline-block;margin-right:8px;color:#6b7280;font-size:12px;font-family:Menlo,Consolas,monospace;">${escapeHtml(match[1])}</span>`,
    `<span style="color:#374151;font-size:13.5px;line-height:1.7;">${inlineMarkdown(match[2])}</span>`,
    "</section>"
  ].join("");
}

function paragraphHtml(line = "") {
  const text = String(line || "").trim();
  const colon = text.match(/^([^:\uff1a]{2,28})[:\uff1a]\s*(.+)$/);
  if (colon && /[\u4e00-\u9fff]/.test(colon[1])) {
    return `<p style="${styleFor("p")}"><strong style="color:#111827;">${inlineMarkdown(colon[1])}：</strong>${inlineMarkdown(colon[2])}</p>`;
  }
  return `<p style="${styleFor("p")}">${inlineMarkdown(text)}</p>`;
}

function markdownToWechatHtml(markdown = "", { leadImageUrl = "", openingHook = "", cta = "" } = {}) {
  const html = [];
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let listOpen = false;
  let currentSection = "";
  let skippedOpening = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  if (openingHook) {
    html.push([
      '<section style="margin:4px 0 24px;padding:16px 18px;background:#f7fbf8;border:1px solid #dcefe4;border-radius:10px;">',
      '<p style="margin:0 0 8px;color:#07C160;font-size:13px;font-weight:700;">先说结论</p>',
      `<p style="margin:0;color:#1f2937;line-height:1.9;font-size:15.5px;font-weight:500;">${inlineMarkdown(openingHook)}</p>`,
      "</section>"
    ].join(""));
  }
  if (leadImageUrl) {
    html.push(`<p style="margin:16px 0;"><img src="${escapeHtml(leadImageUrl)}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto;" /></p>`);
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line)) {
      closeList();
      if (!inCode) {
        html.push('<pre style="white-space:pre-wrap;background:#f6f8fa;border-radius:6px;padding:12px;line-height:1.65;font-size:13px;color:#24292f;overflow:auto;">');
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
      const match = line.match(/^!\[([^\]]*)]\((https?:\/\/[^)\s]+)\)/);
      html.push(`<p style="margin:16px 0;"><img src="${escapeHtml(match[2])}" alt="${escapeHtml(match[1] || "")}" style="max-width:100%;display:block;margin:0 auto;" /></p>`);
      continue;
    }
    const decoratedLine = stripLeadingDecor(line.trim());
    const bareHeading = decoratedLine.match(/^([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3})\u3001(.+)$/);
    if (bareHeading) {
      closeList();
      currentSection = bareHeading[2].trim();
      html.push(sectionHeadingHtml(`${bareHeading[1]}、${currentSection}`));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      if (tag === "h2") {
        currentSection = stripMarkdown(heading[2]);
        html.push(sectionHeadingHtml(heading[2]));
      } else {
        html.push(`<${tag} style="${styleFor(tag)}">${inlineMarkdown(heading[2])}</${tag}>`);
      }
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote style="${styleFor("blockquote")}">${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    const transcriptHtml = transcriptLineHtml(line);
    if (transcriptHtml) {
      closeList();
      html.push(transcriptHtml);
      continue;
    }
    const term = line.trim().match(/^([A-Za-z][A-Za-z0-9+ .\-]{1,48})\s*[:\uff1a]\s*(.{12,})$/);
    if (term && (/术语|解释|关键/.test(currentSection) || currentSection === "")) {
      closeList();
      html.push(termCardHtml(term[1], term[2]));
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        html.push('<ul style="padding-left:1.2em;margin:10px 0 16px;">');
        listOpen = true;
      }
      html.push(`<li style="${styleFor("li")}">${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      if (!listOpen) {
        html.push('<ul style="padding-left:1.2em;margin:10px 0 16px;">');
        listOpen = true;
      }
      html.push(`<li style="${styleFor("li")}">${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }
    closeList();
    html.push(paragraphHtml(line));
  }
  closeList();
  if (inCode) html.push("</pre>");
  if (cta) {
    html.push(`<section style="margin:28px 0 8px;padding:14px 16px;background:#f6f8fa;border-radius:8px;line-height:1.8;font-size:15px;color:#374151;">${inlineMarkdown(cta)}</section>`);
  }
  return html.join("\n");
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
    article.cta = this.config.wechatMpCtaText || "如果你也在长期追踪 AI、机器人、商业航天和产业链机会，欢迎关注这个号。后面会继续把小椰筛出来的高价值材料整理成可读、可复核的版本。";
    return article;
  }

  async generateImageOrFallback(prompt, plan) {
    if (this.imageGenerator?.enabled) {
      return this.imageGenerator.generate(prompt);
    }
    throw new Error("微信公众号封面生图未配置，且没有可用默认 thumb_media_id；已停止创建草稿，避免使用千篇一律的低质封面。");
  }

  async createDraft(candidate = {}, { generateImages = false, generateLeadImage = false, coverImage = null, operator = "" } = {}) {
    if (!this.enabled) throw new Error("WeChat MP publishing is not configured.");
    const startedAt = Date.now();
    const plan = await this.buildDistributionPlan(candidate, { generateImages });
    let coverMediaId = this.config.wechatMpDefaultThumbMediaId || "";
    let coverUrl = "";
    let leadImageUrl = "";
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
