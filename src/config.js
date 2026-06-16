function asList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function asJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function asCleanText(value, fallback) {
  const text = String(value || "").trim();
  if (!text || /^[?]+$/.test(text)) return fallback;
  return text;
}

function resolveAiEndpoint(rawUrl) {
  const input = (rawUrl || "https://api.minimaxi.com/v1/chat/completions").trim();
  const clean = input.replace(/\/+$/, "");

  if (clean.endsWith("/chat/completions") || clean.includes("/chatcompletion_v2")) {
    return clean;
  }

  if (clean.endsWith("/v1")) {
    return `${clean}/chat/completions`;
  }

  return `${clean}/v1/chat/completions`;
}

function resolveImageEndpoint(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  const clean = input.replace(/\/+$/, "");

  if (clean.endsWith("/images/generations")) {
    return clean;
  }

  if (clean.endsWith("/v1")) {
    return `${clean}/images/generations`;
  }

  return `${clean}/v1/images/generations`;
}

function resolveSttEndpoint(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  const clean = input.replace(/\/+$/, "");

  if (clean.endsWith("/audio/transcriptions")) {
    return clean;
  }

  if (clean.endsWith("/v1")) {
    return `${clean}/audio/transcriptions`;
  }

  return `${clean}/v1/audio/transcriptions`;
}

function resolveTtsEndpoint(rawUrl) {
  const input = String(rawUrl || "https://studio.mosi.cn").trim();
  const clean = input.replace(/\/+$/, "");

  if (clean.endsWith("/api/v1/audio/speech")) {
    return clean;
  }

  if (clean.endsWith("/api/v1")) {
    return `${clean}/audio/speech`;
  }

  return `${clean}/api/v1/audio/speech`;
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
  feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
  feishuBotName: asCleanText(process.env.FEISHU_BOT_NAME || process.env.BOT_DISPLAY_NAME, "小椰"),
  feishuBotAliases: asList(process.env.FEISHU_BOT_ALIASES),
  feishuProjectFolderToken: process.env.FEISHU_PROJECT_FOLDER_TOKEN || process.env.FEISHU_DRIVE_FOLDER_TOKEN || "",
  feishuDocBaseUrl: (process.env.FEISHU_DOC_BASE_URL || "https://www.feishu.cn").replace(/\/+$/, ""),
  aiApiKey: process.env.AI_API_KEY || process.env.MINIMAX_API_KEY,
  aiUrl: resolveAiEndpoint(process.env.AI_URL || process.env.AI_BASE_URL || process.env.MINIMAX_URL),
  aiModel: process.env.AI_MODEL || process.env.MINIMAX_MODEL || "MiniMax-M3",
  aiCompatibility: process.env.AI_COMPATIBILITY || process.env.MODEL_COMPATIBILITY || "minimax",
  aiMaxTokensField: process.env.AI_MAX_TOKENS_FIELD || "",
  aiExtraBody: asJsonObject(process.env.AI_EXTRA_BODY_JSON, {}),
  aiReplyMaxTokens: asNumber(process.env.AI_REPLY_MAX_TOKENS, 900),
  aiTimeoutMs: asNumber(process.env.AI_TIMEOUT_MS, 120000),
  fallbackAiApiKey: process.env.FALLBACK_AI_API_KEY || process.env.MINIMAX_API_KEY || "",
  fallbackAiUrl: resolveAiEndpoint(process.env.FALLBACK_AI_URL || process.env.FALLBACK_AI_BASE_URL || process.env.MINIMAX_URL || ""),
  fallbackAiModel: process.env.FALLBACK_AI_MODEL || process.env.MINIMAX_MODEL || "MiniMax-M3",
  fallbackAiCompatibility: process.env.FALLBACK_AI_COMPATIBILITY || "minimax",
  fallbackAiMaxTokensField: process.env.FALLBACK_AI_MAX_TOKENS_FIELD || "",
  fallbackAiExtraBody: asJsonObject(process.env.FALLBACK_AI_EXTRA_BODY_JSON, {}),
  exposeModelInfo: asBoolean(process.env.EXPOSE_MODEL_INFO, false),
  imageGenerationEnabled: asBoolean(process.env.IMAGE_GENERATION_ENABLED, true),
  imageApiKey: process.env.IMAGE_API_KEY || process.env.IMAGE2_API_KEY || "",
  imageApiUrl: resolveImageEndpoint(process.env.IMAGE_API_URL || process.env.IMAGE2_API_URL || ""),
  imageModel: process.env.IMAGE_MODEL || process.env.IMAGE2_MODEL || "gpt-image-2",
  imageSize: process.env.IMAGE_SIZE || "1024x1024",
  imageTimeoutMs: asNumber(process.env.IMAGE_TIMEOUT_MS, 600000),
  imageRetryAttempts: asNumber(process.env.IMAGE_RETRY_ATTEMPTS, 3),
  imageUnderstandingTimeoutMs: asNumber(process.env.IMAGE_UNDERSTANDING_TIMEOUT_MS, 20000),
  imageUnderstandingMaxTokens: asNumber(process.env.IMAGE_UNDERSTANDING_MAX_TOKENS, 900),
  sttEnabled: asBoolean(process.env.STT_ENABLED, Boolean(process.env.STT_API_KEY)),
  sttApiKey: process.env.STT_API_KEY || "",
  sttApiUrl: resolveSttEndpoint(process.env.STT_API_URL || process.env.STT_BASE_URL || ""),
  sttModel: process.env.STT_MODEL || "whisper-large-v3-turbo",
  sttLanguage: process.env.STT_LANGUAGE || "",
  sttPrompt: process.env.STT_PROMPT || "",
  voiceDirectInputEnabled: asBoolean(process.env.VOICE_DIRECT_INPUT_ENABLED, false),
  ttsEnabled: asBoolean(process.env.TTS_ENABLED, Boolean((process.env.TTS_API_KEY || process.env.MOSI_API_KEY) && process.env.TTS_VOICE_ID)),
  ttsApiKey: process.env.TTS_API_KEY || process.env.MOSI_API_KEY || "",
  ttsApiUrl: resolveTtsEndpoint(process.env.TTS_API_URL || process.env.TTS_BASE_URL),
  ttsModel: process.env.TTS_MODEL || "moss-tts",
  ttsVoiceId: process.env.TTS_VOICE_ID || "",
  ttsTimeoutMs: asNumber(process.env.TTS_TIMEOUT_MS, 1800000),
  ttsMaxInputChars: asNumber(process.env.TTS_MAX_INPUT_CHARS, 1200),
  ttsExpectedDurationSec: asNumber(process.env.TTS_EXPECTED_DURATION_SEC, 0),
  ttsMetaInfo: asBoolean(process.env.TTS_META_INFO, false),
  ttsMaxNewTokens: asNumber(process.env.TTS_MAX_NEW_TOKENS, 20000),
  ttsTemperature: asNumber(process.env.TTS_TEMPERATURE, 1.7),
  ttsTopP: asNumber(process.env.TTS_TOP_P, 0.8),
  ttsTopK: asNumber(process.env.TTS_TOP_K, 25),
  ttsTelegramMode: process.env.TTS_TELEGRAM_MODE || "voice",
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSsl: asBoolean(process.env.DB_SSL, false),
  displayName: asCleanText(process.env.BOT_DISPLAY_NAME, "小椰"),
  companionMode: process.env.COMPANION_MODE || "girlfriend",
  language: process.env.BOT_LANGUAGE || "zh-CN",
  selfReferenceImagePath: process.env.SELF_REFERENCE_IMAGE_PATH || "assets/persona/xiaoye-reference.jpg",
  selfAppearanceDescription:
    process.env.SELF_APPEARANCE_DESCRIPTION ||
    "小椰的固定形象：年轻温柔的东亚女性，长深棕色自然微卷发，干净明亮的眼睛，柔和自然的微笑，清爽亲切的气质。整体感觉阳光、干净、温柔，常穿简洁的白色宽松上衣，照片风格真实自然、生活感强。",
  selfSelfieStyle:
    process.env.SELF_SELFIE_STYLE ||
    "真实手机自拍风格，自然光，轻微景深，画面干净，不要夸张滤镜，不要文字、水印、logo，不要多人合照。",
  triggerMode: process.env.TRIGGER_MODE || "mention",
  smartClassifierEnabled: asBoolean(process.env.SMART_CLASSIFIER_ENABLED, (process.env.TRIGGER_MODE || "mention") === "smart"),
  smartReplyConfidenceThreshold: asNumber(process.env.SMART_REPLY_CONFIDENCE_THRESHOLD, 0.75),
  allowedChatIds: asList(process.env.ALLOWED_CHAT_IDS),
  ownerUserIds: asList(process.env.BOT_OWNER_IDS),
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  githubBackupToken: process.env.GITHUB_BACKUP_TOKEN || "",
  githubBackupRepo: process.env.GITHUB_BACKUP_REPO || "",
  githubBackupBranch: process.env.GITHUB_BACKUP_BRANCH || "memory-backups",
  githubBackupPath: process.env.GITHUB_BACKUP_PATH || "backups/render-memory.json",
  githubBackupIntervalMinutes: asNumber(process.env.GITHUB_BACKUP_INTERVAL_MINUTES, 30),
  restoreMemoryFromGithub: asBoolean(process.env.RESTORE_MEMORY_FROM_GITHUB, true),
  autoMemory: asBoolean(process.env.AUTO_MEMORY, true),
  recentMessageLimit: asNumber(process.env.RECENT_MESSAGE_LIMIT, 24),
  memoryLimit: asNumber(process.env.MEMORY_LIMIT, 24),
  maxReplyChars: asNumber(process.env.MAX_REPLY_CHARS, 3600),
  port: asNumber(process.env.PORT, 3000)
};

export function assertRequiredConfig() {
  const missing = [];
  if (!config.telegramToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.aiApiKey) missing.push("AI_API_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
