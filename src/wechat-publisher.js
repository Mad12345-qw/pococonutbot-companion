import { Resvg } from "@resvg/resvg-js";
import { parseJsonObject, truncate } from "./utils.js";
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
  const text = stripMarkdown(value || fallback).replace(/[<>]/g, "").trim();
  return (text || stripMarkdown(fallback) || "值得认真读的一篇研究").slice(0, 64);
}

function normalizeDigest(value = "", fallback = "") {
  const text = stripMarkdown(value || fallback).replace(/[<>]/g, "").trim();
  return (text || "一篇来自小椰工作流的深度整理，适合对同一主题长期关注的人收藏阅读。").slice(0, 120);
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
  if (tag === "h2") return "font-size:19px;line-height:1.5;font-weight:700;margin:28px 0 12px;color:#111827;border-left:4px solid #07C160;padding-left:10px;";
  if (tag === "h3") return "font-size:17px;line-height:1.5;font-weight:700;margin:22px 0 10px;color:#1f2937;";
  if (tag === "blockquote") return "margin:16px 0;padding:12px 14px;background:#f6f8fa;border-left:4px solid #d0d7de;color:#374151;line-height:1.8;";
  if (tag === "li") return "margin:6px 0;line-height:1.85;color:#1f2937;";
  if (tag === "p") return "margin:14px 0;line-height:1.9;font-size:15.5px;color:#1f2937;";
  return "";
}

function markdownToWechatHtml(markdown = "", { leadImageUrl = "", openingHook = "", cta = "" } = {}) {
  const html = [];
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  if (openingHook) {
    html.push(`<section style="margin:0 0 18px;padding:14px 16px;background:#f7fbf8;border-radius:8px;color:#1f2937;line-height:1.8;font-size:15px;">${inlineMarkdown(openingHook)}</section>`);
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
    if (/^!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/.test(line)) {
      closeList();
      const match = line.match(/^!\[([^\]]*)]\((https?:\/\/[^)\s]+)\)/);
      html.push(`<p style="margin:16px 0;"><img src="${escapeHtml(match[2])}" alt="${escapeHtml(match[1] || "")}" style="max-width:100%;display:block;margin:0 auto;" /></p>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      html.push(`<${tag} style="${styleFor(tag)}">${inlineMarkdown(heading[2])}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote style="${styleFor("blockquote")}">${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
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
    html.push(`<p style="${styleFor("p")}">${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) html.push("</pre>");
  if (cta) {
    html.push(`<section style="margin:28px 0 8px;padding:14px 16px;background:#f6f8fa;border-radius:8px;line-height:1.8;font-size:15px;color:#374151;">${inlineMarkdown(cta)}</section>`);
  }
  return html.join("\n");
}

function createFallbackCover({ title = "", subtitle = "" } = {}) {
  const safeTitle = escapeHtml(stripMarkdown(title).slice(0, 42));
  const safeSubtitle = escapeHtml(stripMarkdown(subtitle).slice(0, 70));
  const svg = `
  <svg width="900" height="383" viewBox="0 0 900 383" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="383" fill="#f7faf8"/>
    <rect x="38" y="38" width="824" height="307" rx="24" fill="#ffffff" stroke="#d8e6dd" stroke-width="2"/>
    <rect x="72" y="72" width="86" height="8" rx="4" fill="#07C160"/>
    <text x="72" y="160" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="#111827">${safeTitle}</text>
    <text x="72" y="220" font-family="Arial, sans-serif" font-size="24" fill="#4b5563">${safeSubtitle}</text>
    <text x="72" y="292" font-family="Arial, sans-serif" font-size="20" fill="#6b7280">Xiaoye Research Notes</text>
  </svg>`;
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 900 } }).render().asPng();
  return { buffer: Buffer.from(png), mimeType: "image/png" };
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

  async buildDistributionPlan(candidate = {}, { generateImages = false } = {}) {
    const markdown = candidate.markdown || "";
    const fallbackTitle = normalizeTitle(candidate.title || extractMarkdownTitle(markdown));
    const fallbackDigest = normalizeDigest(firstParagraph(markdown));
    const fallback = {
      title: fallbackTitle,
      digest: fallbackDigest,
      openingHook: `这篇不是简单搬运，而是把原始材料重新整理成一条可判断、可收藏、可继续追问的线索。`,
      cta: this.config.wechatMpCtaText || "如果你也在长期关注 AI、产业链和内容自动化，欢迎关注这个号。后面会继续把小椰筛出来的高价值研究整理成可读版本。",
      coverPrompt: `A clean editorial cover image for a Chinese WeChat article about: ${fallbackTitle}. Sophisticated, readable, high signal, no text, no logos.`,
      leadImagePrompt: `A concise editorial infographic style illustration for: ${fallbackTitle}. No text, no logos.`
    };
    if (!this.ai) return fallback;
    try {
      const raw = await this.ai.chat([
        {
          role: "system",
          content: [
            "You are a WeChat official account distribution editor.",
            "Rewrite a generated research article for traffic and conversion without clickbait.",
            "Return strict JSON only."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceType: candidate.sourceType || "",
            title: candidate.title || "",
            feishuDocUrl: candidate.feishuDocUrl || "",
            generateImages,
            articleExcerpt: markdown.slice(0, 8000),
            requiredSchema: {
              title: "Chinese WeChat title, under 64 chars, concrete and curiosity-driven",
              digest: "under 120 Chinese chars",
              openingHook: "one short Chinese paragraph explaining why this is worth reading now",
              cta: "one short Chinese CTA for same-frequency readers",
              coverPrompt: "English image prompt, no text/logos/watermarks",
              leadImagePrompt: "English image prompt, no text/logos/watermarks"
            }
          })
        }
      ], {
        maxTokens: 900,
        temperature: 0.45,
        responseFormat: { type: "json_object" },
        timeoutMs: this.config.wechatMpAiTimeoutMs || 60000
      });
      const parsed = parseJsonObject(raw);
      return {
        title: normalizeTitle(parsed.title, fallback.title),
        digest: normalizeDigest(parsed.digest, fallback.digest),
        openingHook: String(parsed.openingHook || fallback.openingHook).slice(0, 220),
        cta: String(parsed.cta || fallback.cta).slice(0, 240),
        coverPrompt: String(parsed.coverPrompt || fallback.coverPrompt).slice(0, 1000),
        leadImagePrompt: String(parsed.leadImagePrompt || fallback.leadImagePrompt).slice(0, 1000)
      };
    } catch (error) {
      logEvent("warn", "WeChat distribution plan fallback used", {
        candidateId: candidate.id || "",
        error: error.message
      });
      return fallback;
    }
  }

  async generateImageOrFallback(prompt, plan) {
    if (this.imageGenerator?.enabled) {
      return this.imageGenerator.generate(prompt);
    }
    return createFallbackCover({ title: plan.title, subtitle: plan.digest });
  }

  async createDraft(candidate = {}, { generateImages = false, operator = "" } = {}) {
    if (!this.enabled) throw new Error("WeChat MP publishing is not configured.");
    const startedAt = Date.now();
    const plan = await this.buildDistributionPlan(candidate, { generateImages });
    let coverMediaId = this.config.wechatMpDefaultThumbMediaId || "";
    let coverUrl = "";
    let leadImageUrl = "";
    let imageMode = "default_thumb";

    if (generateImages || !coverMediaId) {
      const cover = await this.generateImageOrFallback(plan.coverPrompt, plan);
      const uploaded = await this.uploadPermanentImage(cover, "wechat-cover.png");
      coverMediaId = uploaded.media_id;
      coverUrl = uploaded.url || "";
      imageMode = this.imageGenerator?.enabled ? "generated_cover" : "fallback_cover";
    }

    if (generateImages && this.imageGenerator?.enabled) {
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

    const content = markdownToWechatHtml(candidate.markdown || "", {
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
