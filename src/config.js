const required = ["TELEGRAM_BOT_TOKEN", "MINIMAX_API_KEY"];

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

function resolveMiniMaxEndpoint(rawUrl) {
  const input = (rawUrl || "https://api.minimaxi.com/v1/chat/completions").trim();
  const clean = input.replace(/\/+$/, "");

  if (clean.endsWith("/chat/completions") || clean.includes("/chatcompletion_v2")) {
    return clean;
  }

  if (clean.endsWith("/v1")) {
    return `${clean}/chat/completions`;
  }

  return clean;
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  minimaxApiKey: process.env.MINIMAX_API_KEY,
  minimaxUrl: resolveMiniMaxEndpoint(process.env.MINIMAX_URL),
  minimaxModel: process.env.MINIMAX_MODEL || "MiniMax-M3",
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSsl: asBoolean(process.env.DB_SSL, false),
  displayName: process.env.BOT_DISPLAY_NAME || "小伴",
  companionMode: process.env.COMPANION_MODE || "girlfriend",
  language: process.env.BOT_LANGUAGE || "zh-CN",
  triggerMode: process.env.TRIGGER_MODE || "mention",
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
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
