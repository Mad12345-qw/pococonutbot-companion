import { truncate } from "./utils.js";

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

    const response = await fetch(this.config.imageApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.imageApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
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
      return {
        buffer: Buffer.from(image.b64_json, "base64"),
        mimeType: "image/png"
      };
    }

    if (image.url) {
      const imageResponse = await fetch(image.url);
      if (!imageResponse.ok) {
        throw new Error(`Generated image download failed: ${imageResponse.status}`);
      }
      const mimeType = imageResponse.headers.get("content-type") || guessMimeType(image.url);
      return {
        buffer: Buffer.from(await imageResponse.arrayBuffer()),
        mimeType
      };
    }

    throw new Error(`Image API response did not contain an image: ${truncate(JSON.stringify(data), 500)}`);
  }
}
