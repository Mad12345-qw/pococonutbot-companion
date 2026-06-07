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

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  aiApiKey: process.env.AI_API_KEY || process.env.MINIMAX_API_KEY,
  aiUrl: resolveAiEndpoint(process.env.AI_URL || process.env.AI_BASE_URL || process.env.MINIMAX_URL),
  aiModel: process.env.AI_MODEL || process.env.MINIMAX_MODEL || "MiniMax-M3",
  aiCompatibility: process.env.AI_COMPATIBILITY || process.env.MODEL_COMPATIBILITY || "minimax",
  aiMaxTokensField: process.env.AI_MAX_TOKENS_FIELD || "",
  aiExtraBody: asJsonObject(process.env.AI_EXTRA_BODY_JSON, {}),
  aiReplyMaxTokens: asNumber(process.env.AI_REPLY_MAX_TOKENS, 900),
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
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSsl: asBoolean(process.env.DB_SSL, false),
  displayName: process.env.BOT_DISPLAY_NAME || "小伴",
  companionMode: process.env.COMPANION_MODE || "girlfriend",
  language: process.env.BOT_LANGUAGE || "zh-CN",
  triggerMode: process.env.TRIGGER_MODE || "mention",
  smartClassifierEnabled: asBoolean(process.env.SMART_CLASSIFIER_ENABLED, false),
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
