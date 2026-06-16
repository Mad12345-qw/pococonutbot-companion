import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { truncate } from "./utils.js";

function normalizeSpeechText(text = "", maxChars = 1200) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function extractAudioData(data) {
  return (
    data?.audio_data ??
    data?.data?.audio_data ??
    data?.result?.audio_data ??
    data?.output?.audio_data ??
    ""
  );
}

function decodeBase64Audio(audioData) {
  const clean = String(audioData || "").replace(/^data:audio\/[^;]+;base64,/i, "");
  if (!clean) return null;
  return Buffer.from(clean, "base64");
}

function runFfmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static did not provide a binary path."));
      return;
    }

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg timed out while converting Telegram voice audio."));
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
      reject(new Error(`FFmpeg exited with code ${code}: ${truncate(detail, 800)}`));
    });
  });
}

export async function convertWavToTelegramVoice(wavBuffer) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "telegram-voice-"));
  const inputPath = path.join(tempDir, "reply.wav");
  const outputPath = path.join(tempDir, "reply.ogg");

  try {
    await writeFile(inputPath, wavBuffer);
    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-vn",
      "-acodec", "libopus",
      "-b:a", "48k",
      "-vbr", "on",
      "-compression_level", "10",
      "-application", "voip",
      outputPath
    ]);

    return {
      buffer: await readFile(outputPath),
      contentType: "audio/ogg",
      fileName: "reply.ogg"
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export class TextToSpeechClient {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(
      this.config.ttsEnabled &&
        this.config.ttsApiKey &&
        this.config.ttsApiUrl &&
        this.config.ttsModel &&
        this.config.ttsVoiceId
    );
  }

  buildBody(text) {
    const body = {
      model: this.config.ttsModel,
      text,
      voice_id: this.config.ttsVoiceId,
      meta_info: this.config.ttsMetaInfo,
      sampling_params: {
        max_new_tokens: this.config.ttsMaxNewTokens,
        temperature: this.config.ttsTemperature,
        top_p: this.config.ttsTopP,
        top_k: this.config.ttsTopK
      }
    };

    if (this.config.ttsExpectedDurationSec > 0) {
      body.expected_duration_sec = this.config.ttsExpectedDurationSec;
    }

    return body;
  }

  async synthesize(text) {
    if (!this.enabled) {
      throw new Error("Text-to-speech is not configured.");
    }

    const speechText = normalizeSpeechText(text, this.config.ttsMaxInputChars);
    if (!speechText) {
      throw new Error("Text-to-speech input is empty.");
    }

    const response = await fetch(this.config.ttsApiUrl, {
      method: "POST",
      signal: AbortSignal.timeout(this.config.ttsTimeoutMs),
      headers: {
        Authorization: `Bearer ${this.config.ttsApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(this.buildBody(speechText))
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Text-to-speech API error ${response.status}: ${truncate(responseText, 800)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`Text-to-speech API returned non-JSON response: ${truncate(responseText, 400)}`);
    }

    const buffer = decodeBase64Audio(extractAudioData(data));
    if (!buffer?.length) {
      throw new Error(`Text-to-speech API response did not contain audio_data: ${truncate(JSON.stringify(data), 800)}`);
    }

    return {
      buffer,
      contentType: "audio/wav",
      fileName: "reply.wav",
      durationS: data?.duration_s ?? data?.data?.duration_s ?? null
    };
  }
}
