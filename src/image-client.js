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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchErrorMeta(error) {
  const cause = error?.cause || {};
  return {
    error: error?.message || "",
    name: error?.name || "",
    causeName: cause?.name || "",
    causeCode: cause?.code || cause?.errno || "",
    causeMessage: cause?.message || "",
    address: cause?.address || "",
    port: cause?.port || ""
  };
}

function isTimeoutError(error) {
  const message = String(error?.message || "");
  return error?.name === "TimeoutError" || /aborted due to timeout/i.test(message);
}

function isRetryableFetchError(error) {
  if (isTimeoutError(error)) return false;
  const meta = fetchErrorMeta(error);
  const code = String(meta.causeCode || "").toUpperCase();
  return (
    /fetch failed/i.test(meta.error) ||
    ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)
  );
}

function formatTimeoutMessage(timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  return `生图接口超过 ${seconds} 秒还没返回，可能是图片模型排队或冷启动。你可以稍后再试，或者把描述简化一点。`;
}

function formatNetworkMessage(error, attempts) {
  const meta = fetchErrorMeta(error);
  const reason = meta.causeCode || meta.causeMessage;
  const suffix = reason ? `（${reason}）` : "";
  return `生图接口连接失败${suffix}，已重试 ${attempts} 次。一般是生图后端临时不可达、连接被重置，或 Render 到生图接口的网络不稳定。`;
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
    const maxAttempts = Math.max(1, Math.floor(this.config.imageRetryAttempts || 3));
    const startedAt = Date.now();

    logEvent("info", "Image generation request started", {
      model: this.config.imageModel,
      size: this.config.imageSize,
      timeoutMs,
      maxAttempts
    });

    let response;
    let lastFetchError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        break;
      } catch (error) {
        lastFetchError = error;
        const elapsedMs = Date.now() - startedAt;
        logEvent("error", "Image API fetch failed", {
          ...fetchErrorMeta(error),
          model: this.config.imageModel,
          timeoutMs,
          elapsedMs,
          attempt,
          maxAttempts
        });
        if (isTimeoutError(error)) {
          throw new Error(formatTimeoutMessage(timeoutMs));
        }
        if (attempt < maxAttempts && isRetryableFetchError(error)) {
          await sleep(Math.min(1000 * attempt, 5000));
          continue;
        }
        throw new Error(formatNetworkMessage(error, attempt));
      }
    }
    if (!response && lastFetchError) throw new Error(formatNetworkMessage(lastFetchError, maxAttempts));

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
