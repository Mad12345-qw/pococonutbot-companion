import { truncate } from "./utils.js";
import { logEvent } from "./runtime-log.js";

function parseDataUrl(value = "") {
  const match = String(value).match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || "image/png",
    buffer: Buffer.from(match[2], "base64")
  };
}

function guessMimeType(url = "", fallback = "image/png") {
  const lower = String(url).toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  return fallback;
}

function isTimeoutError(error) {
  const message = String(error?.message || "");
  return error?.name === "TimeoutError" || /timeout|aborted/i.test(message);
}

function formatTimeoutMessage(timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  return `生图接口超过 ${seconds} 秒还没返回，可能是图片模型排队或冷启动。你可以稍后再试，或者把描述简化一点。`;
}

export class ImageGenerationClient {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(this.config.imageGenerationEnabled && this.config.imageApiKey && this.config.imageApiUrl);
  }

  async generate(prompt) {
    if (!this.enabled) {
      throw new Error("Image generation API is not configured.");
    }

    const body = {
      model: this.config.imageModel,
      prompt,
      size: this.config.imageSize,
      n: 1,
      response_format: "b64_json"
    };

    const timeoutMs = this.config.imageTimeoutMs || 600000;
    const startedAt = Date.now();

    logEvent("info", "Image generation request started", {
      model: this.config.imageModel,
      size: this.config.imageSize,
      timeoutMs
    });

    let response;
    try {
      response = await fetch(this.config.imageApiUrl, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${this.config.imageApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      logEvent("error", "Image API fetch failed", {
        error: error.message,
        name: error.name,
        model: this.config.imageModel,
        timeoutMs,
        elapsedMs
      });
      if (isTimeoutError(error)) {
        throw new Error(formatTimeoutMessage(timeoutMs));
      }
      throw new Error(`Image API fetch failed: ${error.message}`);
    }

    const text = await response.text();
    if (!response.ok) {
      logEvent("error", "Image API returned error", {
        status: response.status,
        body: truncate(text, 300),
        elapsedMs: Date.now() - startedAt
      });
      throw new Error(`Image API error ${response.status}: ${truncate(text, 500)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const parsedDataUrl = parseDataUrl(text.trim());
      if (parsedDataUrl) return parsedDataUrl;
      throw new Error(`Image API returned non-JSON response: ${truncate(text, 300)}`);
    }

    const image = data?.data?.[0] || {};
    if (image.b64_json) {
      logEvent("info", "Image generation returned base64 image", {
        model: this.config.imageModel,
        elapsedMs: Date.now() - startedAt
      });
      return {
        buffer: Buffer.from(image.b64_json, "base64"),
        mimeType: "image/png"
      };
    }

    if (image.url) {
      let imageResponse;
      try {
        imageResponse = await fetch(image.url);
      } catch (error) {
        logEvent("error", "Generated image download fetch failed", { error: error.message });
        throw new Error(`Generated image download fetch failed: ${error.message}`);
      }
      if (!imageResponse.ok) {
        throw new Error(`Generated image download failed: ${imageResponse.status}`);
      }
      const mimeType = imageResponse.headers.get("content-type") || guessMimeType(image.url);
      logEvent("info", "Image generation returned downloadable image", {
        mimeType,
        elapsedMs: Date.now() - startedAt
      });
      return {
        buffer: Buffer.from(await imageResponse.arrayBuffer()),
        mimeType
      };
    }

    throw new Error(`Image API response did not contain an image: ${truncate(JSON.stringify(data), 500)}`);
  }
}
