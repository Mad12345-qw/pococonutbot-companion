import { truncate } from "./utils.js";

function cleanText(value = "", max = 1000) {
  return truncate(String(value || "").replace(/\s+/g, " ").trim(), max);
}

function asBooleanParam(value) {
  return value ? "true" : "false";
}

function extractYouTubeVideoId(value = "") {
  const raw = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (/youtu\.be$/i.test(url.hostname)) {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (/youtube\.com$/i.test(url.hostname) || /(^|\.)youtube\.com$/i.test(url.hostname)) {
      const id = url.searchParams.get("v") || "";
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
      const shorts = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shorts) return shorts[1];
      const embed = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embed) return embed[1];
    }
  } catch {
    return "";
  }

  return "";
}

function normalizeVideoResult(item = {}, index = 0) {
  const videoId = item.videoId || item.video_id || item.id || "";
  return {
    type: item.type || "video",
    videoId,
    title: cleanText(item.title, 220),
    channelTitle: cleanText(item.channelTitle || item.channel_title || item.author_name || item.author, 120),
    channelHandle: cleanText(item.channelHandle || item.channel_handle, 80),
    lengthText: cleanText(item.lengthText || item.length_text, 60),
    viewCountText: cleanText(item.viewCountText || item.view_count_text || item.viewCount, 80),
    publishedTimeText: cleanText(item.publishedTimeText || item.published_time_text || item.published, 80),
    hasCaptions: Boolean(item.hasCaptions ?? item.has_captions),
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : cleanText(item.url || item.link, 500),
    index: index + 1
  };
}

function normalizeTranscript(data = {}) {
  const transcript = data.transcript;
  const segments = Array.isArray(transcript)
    ? transcript.map((segment = {}) => ({
        text: cleanText(segment.text, 2000),
        start: Number(segment.start || 0),
        duration: Number(segment.duration || 0)
      })).filter((segment) => segment.text)
    : String(transcript || "")
        .split(/\n+/)
        .map((line) => ({ text: cleanText(line, 2000), start: 0, duration: 0 }))
        .filter((segment) => segment.text);

  return {
    videoId: data.video_id || data.videoId || "",
    language: data.language || "",
    metadata: data.metadata || {},
    segments,
    text: segments.map((segment) => segment.text).join(" ").trim()
  };
}

export class TranscriptApiClient {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(this.config.transcriptApiEnabled && this.config.transcriptApiKey);
  }

  videoId(value = "") {
    return extractYouTubeVideoId(value);
  }

  async request(path, params = {}, options = {}) {
    if (!this.enabled) {
      throw new Error("Transcript API is not configured.");
    }

    const url = new URL(path, this.config.transcriptApiBaseUrl || "https://transcriptapi.com");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs || this.config.transcriptApiTimeoutMs || 60000),
      headers: {
        Authorization: `Bearer ${this.config.transcriptApiKey}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Transcript API ${response.status}: ${truncate(text, 600)}`);
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after") || "";
      throw error;
    }

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Transcript API returned non-JSON response: ${truncate(text, 300)}`);
    }
  }

  async search(query, options = {}) {
    const data = await this.request("/api/v2/youtube/search", {
      q: String(query || "").trim(),
      type: options.type || "video"
    }, options);
    const results = Array.isArray(data.results)
      ? data.results.map(normalizeVideoResult).filter((item) => item.videoId || item.url)
      : [];
    return {
      results,
      resultCount: Number(data.result_count || results.length),
      hasMore: Boolean(data.has_more),
      continuationToken: data.continuation_token || ""
    };
  }

  async channelLatest(channel, options = {}) {
    const data = await this.request("/api/v2/youtube/channel/latest", {
      channel: String(channel || "").trim()
    }, options);
    const results = Array.isArray(data.results)
      ? data.results.map(normalizeVideoResult).filter((item) => item.videoId || item.url)
      : [];
    return {
      channel: data.channel || {},
      results,
      resultCount: Number(data.result_count || results.length)
    };
  }

  async channelSearch(channel, query, options = {}) {
    const data = await this.request("/api/v2/youtube/channel/search", {
      channel: String(channel || "").trim(),
      q: String(query || "").trim()
    }, options);
    const results = Array.isArray(data.results)
      ? data.results.map(normalizeVideoResult).filter((item) => item.videoId || item.url)
      : [];
    return {
      results,
      resultCount: Number(data.result_count || results.length),
      hasMore: Boolean(data.has_more),
      continuationToken: data.continuation_token || ""
    };
  }

  async playlistVideos(playlist, options = {}) {
    const data = await this.request("/api/v2/youtube/playlist/videos", {
      playlist: String(playlist || "").trim()
    }, options);
    const results = Array.isArray(data.results)
      ? data.results.map(normalizeVideoResult).filter((item) => item.videoId || item.url)
      : [];
    return {
      playlistInfo: data.playlist_info || {},
      results,
      resultCount: Number(data.result_count || results.length),
      hasMore: Boolean(data.has_more),
      continuationToken: data.continuation_token || ""
    };
  }

  async getTranscript(videoUrl, options = {}) {
    const data = await this.request("/api/v2/youtube/transcript", {
      video_url: videoUrl,
      send_metadata: asBooleanParam(options.sendMetadata ?? true),
      format: options.format || "json",
      include_timestamp: asBooleanParam(options.includeTimestamp ?? true)
    }, options);
    return normalizeTranscript(data);
  }
}
