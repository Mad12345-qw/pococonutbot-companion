import { truncate } from "./utils.js";

const allowedSttExtensions = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "opus", "wav", "webm"]);

function extensionOf(fileName = "") {
  const match = String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function sniffAudio(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (data.length < 4) return {};
  const ascii4 = data.toString("ascii", 0, 4);
  if (ascii4 === "OggS") return { extension: "ogg", mimeType: "audio/ogg" };
  if (ascii4 === "RIFF" && data.toString("ascii", 8, 12) === "WAVE") return { extension: "wav", mimeType: "audio/wav" };
  if (ascii4 === "fLaC") return { extension: "flac", mimeType: "audio/flac" };
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return { extension: "webm", mimeType: "audio/webm" };
  }
  if (data.toString("ascii", 4, 8) === "ftyp") return { extension: "m4a", mimeType: "audio/mp4" };
  if (data.toString("ascii", 0, 3) === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) {
    return { extension: "mp3", mimeType: "audio/mpeg" };
  }
  return {};
}

function audioMimeType(format = "", contentType = "") {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;

  switch (String(format || "").toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
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

function normalizeAudioUpload(audio = {}) {
  const buffer = audio?.buffer;
  const sniffed = sniffAudio(buffer);
  let extension = extensionOf(audio?.fileName) || String(audio?.format || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let mimeType = audioMimeType(extension, audio?.contentType);

  if (!allowedSttExtensions.has(extension)) {
    extension = sniffed.extension || "ogg";
  }

  if (!mimeType || mimeType === "application/octet-stream") {
    mimeType = sniffed.mimeType || audioMimeType(extension, "");
  }

  return {
    fileName: `voice.${extension === "mp4" ? "m4a" : extension}`,
    mimeType
  };
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
    this.lastUploadFileName = "";
    this.lastUploadMimeType = "";
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

    const upload = normalizeAudioUpload(audio);
    this.lastUploadFileName = upload.fileName;
    this.lastUploadMimeType = upload.mimeType;
    const mimeType = upload.mimeType;
    const blob = new Blob([audio.buffer], { type: mimeType });
    const form = new FormData();
    form.append("file", blob, upload.fileName || audioFileName(audio?.format));
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
