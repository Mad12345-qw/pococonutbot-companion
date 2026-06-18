import { truncate } from "./utils.js";

function cleanText(value = "", max = 800) {
  return truncate(String(value || "").replace(/\s+/g, " ").trim(), max);
}

function normalizeFreshness(value = "") {
  const raw = String(value || "").trim();
  const allowed = new Set(["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"]);
  if (allowed.has(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}(?:\.\.\d{4}-\d{2}-\d{2})?$/.test(raw)) return raw;
  return "noLimit";
}

function normalizeResult(item = {}, index = 0) {
  const title = cleanText(item.name || item.title || item.siteName || item.site_name || `Result ${index + 1}`, 180);
  const url = String(item.url || item.displayUrl || item.link || "").trim();
  const summary = cleanText(item.summary || item.snippet || item.description || "", 900);
  const snippet = cleanText(item.snippet || item.description || item.summary || "", 500);
  const siteName = cleanText(item.siteName || item.site_name || item.provider || item.displayUrl || "", 80);
  const publishedAt = cleanText(item.datePublished || item.dateLastCrawled || item.date_last_crawled || item.date || "", 80);
  return {
    title,
    url,
    displayUrl: String(item.displayUrl || item.display_url || url).trim(),
    summary,
    snippet,
    siteName,
    publishedAt,
    index: index + 1
  };
}

export class BochaWebSearchClient {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(this.config.webSearchEnabled && this.config.bochaApiKey);
  }

  async search(query, options = {}) {
    if (!this.enabled) {
      throw new Error("Bocha web search is not configured.");
    }

    const payload = {
      query: String(query || "").trim(),
      freshness: normalizeFreshness(options.freshness || this.config.bochaSearchFreshness),
      summary: options.summary ?? this.config.bochaSearchSummary,
      count: Math.max(1, Math.min(50, Number(options.count || this.config.bochaSearchCount || 6)))
    };
    if (!payload.query) throw new Error("Search query is empty.");

    const apiKey = String(this.config.bochaApiKey || "");
    const authorization = /^Bearer\s+/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
    const response = await fetch(this.config.bochaSearchUrl, {
      method: "POST",
      signal: AbortSignal.timeout(this.config.bochaSearchTimeoutMs || 30000),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Bocha web search API error ${response.status}: ${truncate(text, 500)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Bocha web search returned non-JSON response: ${truncate(text, 300)}`);
    }

    if (data?.code && Number(data.code) !== 200) {
      throw new Error(`Bocha web search failed: ${truncate(data?.msg || JSON.stringify(data), 500)}`);
    }

    const webPages = data?.data?.webPages || data?.webPages || {};
    const rawResults =
      webPages.value ||
      webPages.values ||
      data?.data?.results ||
      data?.results ||
      [];
    const results = Array.isArray(rawResults)
      ? rawResults.map(normalizeResult).filter((item) => item.url || item.summary || item.snippet)
      : [];

    return {
      query: data?.data?.queryContext?.originalQuery || payload.query,
      freshness: payload.freshness,
      webSearchUrl: webPages.webSearchUrl || "",
      totalEstimatedMatches: Number(webPages.totalEstimatedMatches || 0),
      results
    };
  }
}
