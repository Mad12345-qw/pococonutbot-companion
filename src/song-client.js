import { truncate } from "./utils.js";

function pickRandom(items = []) {
  return items[Math.floor(Math.random() * items.length)];
}

function extractSongUrl(data) {
  return (
    data?.url ??
    data?.music_url ??
    data?.audio_url ??
    data?.data?.url ??
    data?.data?.music_url ??
    data?.data?.audio_url ??
    ""
  );
}

function normalizeFileName(text = "") {
  const clean = String(text || "song")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 80);
  return clean || "song";
}

function inferExtension(contentType = "", url = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("flac")) return "flac";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  if (type.includes("ogg") || type.includes("opus")) return "ogg";
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    if (match) return match[1];
  } catch {
    // Keep the generic fallback below.
  }
  return "audio";
}

function safeJsonParse(text = "") {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class SongClient {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(this.config.songApiEnabled && this.config.songApiToken && this.config.songApiUrl);
  }

  randomDefaultQuery() {
    return pickRandom(this.config.songDefaultQueries) || "\u9093\u7d2b\u68cb";
  }

  buildSearchUrl(query, index = 1) {
    const url = new URL(this.config.songApiUrl);
    url.searchParams.set("type", this.config.songApiSource || "qq");
    url.searchParams.set("msg", query);
    url.searchParams.set("n", String(index || 1));
    url.searchParams.set("m_token", this.config.songApiToken);
    return url;
  }

  async requestSong(query, options = {}) {
    if (!this.enabled) {
      throw new Error("Song API is not configured.");
    }

    const searchQuery = String(query || this.randomDefaultQuery()).trim() || this.randomDefaultQuery();
    const response = await fetch(this.buildSearchUrl(searchQuery, options.index || 1), {
      method: "GET",
      signal: AbortSignal.timeout(this.config.songApiTimeoutMs),
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "telegram-ai-companion/1.0"
      }
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Song API error ${response.status}: ${truncate(text, 500)}`);
    }

    const data = safeJsonParse(text);
    if (!data) {
      throw new Error(`Song API returned non-JSON response: ${truncate(text, 300)}`);
    }

    const code = Number(data.code ?? data.status ?? 200);
    const audioUrl = extractSongUrl(data);
    if (code !== 200 || !audioUrl) {
      throw new Error(`Song API did not return an audio url: ${truncate(JSON.stringify(data), 500)}`);
    }

    return {
      query: searchQuery,
      name: String(data.name || data.title || searchQuery),
      singer: String(data.singer || data.artist || ""),
      quality: String(data.quality || ""),
      url: audioUrl
    };
  }

  async downloadAudio(song) {
    const response = await fetch(song.url, {
      method: "GET",
      signal: AbortSignal.timeout(this.config.songDownloadTimeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Song audio download failed ${response.status}: ${truncate(text, 300)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.config.songMaxDownloadBytes) {
      throw new Error("Downloaded song file is too large.");
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const extension = inferExtension(contentType, song.url);
    return {
      ...song,
      buffer,
      contentType,
      inputFileName: `${normalizeFileName(song.name)}.${extension}`,
      durationMs: this.config.songDefaultDurationMs
    };
  }

  async fetchSong(query, options = {}) {
    const song = await this.requestSong(query, options);
    return this.downloadAudio(song);
  }
}
