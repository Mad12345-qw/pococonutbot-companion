import { truncate } from "./utils.js";

function audioMimeType(format = "", contentType = "") {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;

  switch (String(format || "").toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    case "ogg":
    default:
      return "audio/ogg";
  }
}

function audioFileName(format = "") {
  const clean = String(format || "ogg").toLowerCase().replace(/[^a-z0-9]/g, "") || "ogg";
  const extension = clean === "mp4" ? "m4a" : clean;
  return `telegram-voice.${extension}`;
}

function extractTranscript(data) {
  return (
    data?.text ??
    data?.transcript ??
    data?.result?.text ??
    data?.choices?.[0]?.message?.content ??
    ""
  );
}

export class SpeechToTextClient {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(
      this.config.sttEnabled &&
        this.config.sttApiKey &&
        this.config.sttApiUrl &&
        this.config.sttModel
    );
  }

  async transcribe(audio) {
    if (!this.enabled) {
      throw new Error("Speech-to-text is not configured.");
    }

    const mimeType = audioMimeType(audio?.format, audio?.contentType);
    const blob = new Blob([audio.buffer], { type: mimeType });
    const form = new FormData();
    form.append("file", blob, audioFileName(audio?.format));
    form.append("model", this.config.sttModel);

    if (this.config.sttLanguage) {
      form.append("language", this.config.sttLanguage);
    }

    if (this.config.sttPrompt) {
      form.append("prompt", this.config.sttPrompt);
    }

    const response = await fetch(this.config.sttApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.sttApiKey}`
      },
      body: form
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Speech-to-text API error ${response.status}: ${truncate(text, 800)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return String(text || "").trim();
    }

    const transcript = String(extractTranscript(data) || "").trim();
    if (!transcript) {
      throw new Error(`Speech-to-text API response did not contain text: ${truncate(JSON.stringify(data), 800)}`);
    }

    return transcript;
  }
}
