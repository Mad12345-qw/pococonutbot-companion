import { spawn } from "node:child_process";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import ffmpegPath from "ffmpeg-static";
import { truncate } from "./utils.js";

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function safeFileName(value = "video.mp4") {
  const clean = String(value || "video.mp4")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100);
  return clean || "video.mp4";
}

function inferVideoFileName(item = {}, url = "") {
  const explicit = item.fileName || item.filename;
  if (explicit) return safeFileName(explicit);
  try {
    const base = path.basename(new URL(url).pathname);
    if (base) return safeFileName(base);
  } catch {
    // Fall through to the stable fallback.
  }
  return "xiaoye-video.mp4";
}

function isHttpUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static did not provide a binary path."));
      return;
    }

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg timed out while extracting video thumbnail."));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      const detail = Buffer.concat(stderr).toString("utf8");
      reject(new Error(`FFmpeg thumbnail extraction failed ${code}: ${truncate(detail, 800)}`));
    });
  });
}

export class VideoLibraryClient {
  constructor(config) {
    this.config = config;
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.config.videoLibraryEnabled && this.config.videoLibraryUrl);
  }

  shouldCheck(text = "") {
    if (!this.enabled) return false;
    const value = normalizeText(text);
    if (!value) return false;
    if (/^\/(?:video|mv|media)\b/i.test(String(text || "").trim())) return true;
    return (this.config.videoLibraryTriggerHints || []).some((hint) => {
      const clean = normalizeText(hint);
      return clean && value.includes(clean);
    });
  }

  async loadLibrary() {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) return this.cache;

    const response = await fetch(this.config.videoLibraryUrl, {
      method: "GET",
      signal: AbortSignal.timeout(this.config.videoLibraryTimeoutMs),
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "telegram-ai-companion/1.0"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Video library HTTP ${response.status}: ${truncate(text, 500)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Video library returned non-JSON response: ${truncate(text, 300)}`);
    }

    const items = Array.isArray(parsed) ? parsed : asArray(parsed?.items || parsed?.videos);
    this.cache = items
      .filter((item) => item && typeof item === "object" && isHttpUrl(item.url))
      .map((item) => ({
        ...item,
        keywords: [
          ...asArray(item.keywords),
          ...asArray(item.aliases),
          item.title,
          item.id
        ].filter(Boolean)
      }));
    this.cacheExpiresAt = now + Math.max(10_000, Number(this.config.videoLibraryCacheMs || 300_000));
    return this.cache;
  }

  async findMatch(text = "") {
    if (!this.shouldCheck(text)) return null;
    const value = normalizeText(text);
    const command = String(text || "").trim().match(/^\/(?:video|mv|media)(?:\s+(.+))?$/i);
    const query = normalizeText(command?.[1] || text);
    const items = await this.loadLibrary();

    return items.find((item) => {
      const keywords = asArray(item.keywords).map(normalizeText).filter(Boolean);
      return keywords.some((keyword) => value.includes(keyword) || query.includes(keyword));
    }) || null;
  }

  async download(item) {
    if (!item?.url || !isHttpUrl(item.url)) {
      throw new Error("Video library item does not have a valid URL.");
    }

    const response = await fetch(item.url, {
      method: "GET",
      signal: AbortSignal.timeout(this.config.videoLibraryDownloadTimeoutMs),
      headers: {
        Accept: "video/mp4,video/*,*/*",
        "User-Agent": "telegram-ai-companion/1.0"
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Video download failed ${response.status}: ${truncate(text, 500)}`);
    }

    const contentType = response.headers.get("content-type") || item.mimeType || "video/mp4";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.config.videoLibraryMaxBytes) {
      throw new Error("Video file is too large for Feishu upload.");
    }

    return {
      item,
      buffer,
      contentType,
      fileName: inferVideoFileName(item, item.url),
      title: item.title || item.id || "video"
    };
  }

  async createThumbnail(videoBuffer, options = {}) {
    const tempDir = await mkdtemp(path.join(tmpdir(), "xiaoye-video-thumb-"));
    const inputPath = path.join(tempDir, "input.mp4");
    const outputPath = path.join(tempDir, "cover.jpg");

    try {
      await writeFile(inputPath, videoBuffer);
      await runFfmpeg([
        "-y",
        "-ss", String(options.seekSeconds ?? 1),
        "-i", inputPath,
        "-frames:v", "1",
        "-vf", "scale='min(720,iw)':-2",
        "-q:v", "3",
        outputPath
      ]);

      return {
        buffer: await readFile(outputPath),
        mimeType: "image/jpeg",
        fileName: "cover.jpg"
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
