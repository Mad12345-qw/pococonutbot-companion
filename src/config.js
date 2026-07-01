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
  feishuOutgoingMentionsEnabled: asBoolean(process.env.FEISHU_OUTGOING_MENTIONS_ENABLED, false),
  feishuMentionTargets: asJsonObject(process.env.FEISHU_MENTION_TARGETS_JSON, {}),
  feishuProjectFolderToken: process.env.FEISHU_PROJECT_FOLDER_TOKEN || process.env.FEISHU_DRIVE_FOLDER_TOKEN || "",
  feishuDocBaseUrl: (process.env.FEISHU_DOC_BASE_URL || "https://www.feishu.cn").replace(/\/+$/, ""),
  linkReadingEnabled: asBoolean(process.env.LINK_READING_ENABLED, true),
  linkReadingMaxChars: asNumber(process.env.LINK_READING_MAX_CHARS, 12000),
  linkReadingTimeoutMs: asNumber(process.env.LINK_READING_TIMEOUT_MS, 20000),
  webSearchEnabled: asBoolean(process.env.WEB_SEARCH_ENABLED, Boolean(process.env.BOCHA_API_KEY)),
  bochaApiKey: process.env.BOCHA_API_KEY || "",
  bochaSearchUrl: process.env.BOCHA_SEARCH_URL || "https://api.bochaai.com/v1/web-search",
  bochaSearchCount: asNumber(process.env.BOCHA_SEARCH_COUNT, 6),
  bochaSearchFreshness: process.env.BOCHA_SEARCH_FRESHNESS || "noLimit",
  bochaSearchSummary: asBoolean(process.env.BOCHA_SEARCH_SUMMARY, true),
  bochaSearchTimeoutMs: asNumber(process.env.BOCHA_SEARCH_TIMEOUT_MS, 30000),
  webSearchSummaryMaxTokens: asNumber(process.env.WEB_SEARCH_SUMMARY_MAX_TOKENS, 700),
  transcriptApiEnabled: asBoolean(process.env.TRANSCRIPT_API_ENABLED, Boolean(process.env.TRANSCRIPT_API_KEY)),
  transcriptApiKey: process.env.TRANSCRIPT_API_KEY || "",
  transcriptApiBaseUrl: (process.env.TRANSCRIPT_API_BASE_URL || "https://transcriptapi.com").replace(/\/+$/, ""),
  transcriptApiTimeoutMs: asNumber(process.env.TRANSCRIPT_API_TIMEOUT_MS, 60000),
  youtubeResearchMaxVideos: asNumber(process.env.YOUTUBE_RESEARCH_MAX_VIDEOS, 5),
  youtubeResearchMaxTranscriptChars: asNumber(process.env.YOUTUBE_RESEARCH_MAX_TRANSCRIPT_CHARS, 60000),
  youtubeResearchSummaryMaxTokens: asNumber(process.env.YOUTUBE_RESEARCH_SUMMARY_MAX_TOKENS, 2600),
  youtubeResearchAiTimeoutMs: asNumber(process.env.YOUTUBE_RESEARCH_AI_TIMEOUT_MS, 180000),
  youtubeResearchRequirePrimary: asBoolean(process.env.YOUTUBE_RESEARCH_REQUIRE_PRIMARY, false),
  youtubeResearchForcePrimaryWithFallback: asBoolean(process.env.YOUTUBE_RESEARCH_FORCE_PRIMARY_WITH_FALLBACK, true),
  aiApiKey: process.env.AI_API_KEY || process.env.MINIMAX_API_KEY,
  aiUrl: resolveAiEndpoint(process.env.AI_URL || process.env.AI_BASE_URL || process.env.MINIMAX_URL),
  aiModel: process.env.AI_MODEL || process.env.MINIMAX_MODEL || "MiniMax-M3",
  aiCompatibility: process.env.AI_COMPATIBILITY || process.env.MODEL_COMPATIBILITY || "minimax",
  aiMaxTokensField: process.env.AI_MAX_TOKENS_FIELD || "",
  aiExtraBody: asJsonObject(process.env.AI_EXTRA_BODY_JSON, {}),
  aiReplyMaxTokens: asNumber(process.env.AI_REPLY_MAX_TOKENS, 900),
  aiTimeoutMs: asNumber(process.env.AI_TIMEOUT_MS, 120000),
  aiRetryAttempts: asNumber(process.env.AI_RETRY_ATTEMPTS, 2),
  aiRetryDelayMs: asNumber(process.env.AI_RETRY_DELAY_MS, 800),
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
  imageUnderstandingRequirePrimary: asBoolean(process.env.IMAGE_UNDERSTANDING_REQUIRE_PRIMARY, false),
  imageUnderstandingTimeoutMs: asNumber(process.env.IMAGE_UNDERSTANDING_TIMEOUT_MS, 20000),
  imageUnderstandingMaxTokens: asNumber(process.env.IMAGE_UNDERSTANDING_MAX_TOKENS, 900),
  sttEnabled: asBoolean(process.env.STT_ENABLED, Boolean(process.env.STT_API_KEY)),
  sttApiKey: process.env.STT_API_KEY || "",
  sttApiUrl: resolveSttEndpoint(process.env.STT_API_URL || process.env.STT_BASE_URL || ""),
  sttModel: process.env.STT_MODEL || "whisper-large-v3-turbo",
  sttLanguage: process.env.STT_LANGUAGE || "",
  sttPrompt: process.env.STT_PROMPT || "",
  voiceDirectInputEnabled: asBoolean(process.env.VOICE_DIRECT_INPUT_ENABLED, false),
  ttsEnabled: asBoolean(
    process.env.TTS_ENABLED,
    Boolean((process.env.TTS_API_KEY || process.env.MOSI_API_KEY) && (process.env.TTS_VOICE_ID || process.env.FEISHU_TTS_VOICE_ID))
  ),
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
  feishuTtsVoiceId: process.env.FEISHU_TTS_VOICE_ID || "",
  feishuTtsMaxInputChars: asNumber(process.env.FEISHU_TTS_MAX_INPUT_CHARS, asNumber(process.env.TTS_MAX_INPUT_CHARS, 1200)),
  songApiEnabled: asBoolean(process.env.SONG_API_ENABLED, Boolean(process.env.SONG_API_TOKEN || process.env.SUOL_SONG_API_TOKEN)),
  songApiUrl: process.env.SONG_API_URL || "https://api.suol.cc/v1/yy_sq.php",
  songApiToken: process.env.SONG_API_TOKEN || process.env.SUOL_SONG_API_TOKEN || "",
  songApiSource: process.env.SONG_API_SOURCE || "qq",
  songApiTimeoutMs: asNumber(process.env.SONG_API_TIMEOUT_MS, 30000),
  songDownloadTimeoutMs: asNumber(process.env.SONG_DOWNLOAD_TIMEOUT_MS, 180000),
  songSearchAttempts: asNumber(process.env.SONG_SEARCH_ATTEMPTS, 3),
  songMaxDownloadBytes: asNumber(process.env.SONG_MAX_DOWNLOAD_BYTES, 80 * 1024 * 1024),
  songDefaultDurationMs: asNumber(process.env.SONG_DEFAULT_DURATION_MS, 180000),
  songDefaultQueries: asList(process.env.SONG_DEFAULT_QUERIES).length
    ? asList(process.env.SONG_DEFAULT_QUERIES)
    : [
        "\u9093\u7d2b\u68cb \u5149\u5e74\u4e4b\u5916",
        "\u9093\u7d2b\u68cb \u6ce1\u6cab",
        "\u9093\u7d2b\u68cb \u53e5\u53f7",
        "\u9093\u7d2b\u68cb \u559c\u6b22\u4f60",
        "\u9093\u7d2b\u68cb \u5012\u6570",
        "\u9093\u7d2b\u68cb \u591a\u8fdc\u90fd\u8981\u5728\u4e00\u8d77",
        "\u9093\u7d2b\u68cb \u6765\u81ea\u5929\u5802\u7684\u9b54\u9b3c"
      ],
  videoLibraryUrl: process.env.VIDEO_LIBRARY_URL || "https://szygumin.icu/xiaoye-media/library.json",
  videoLibraryEnabled: asBoolean(process.env.VIDEO_LIBRARY_ENABLED, true),
  videoLibraryTimeoutMs: asNumber(process.env.VIDEO_LIBRARY_TIMEOUT_MS, 8000),
  videoLibraryCacheMs: asNumber(process.env.VIDEO_LIBRARY_CACHE_MS, 300000),
  videoLibraryDownloadTimeoutMs: asNumber(process.env.VIDEO_LIBRARY_DOWNLOAD_TIMEOUT_MS, 120000),
  videoLibraryMaxBytes: asNumber(process.env.VIDEO_LIBRARY_MAX_BYTES, 30 * 1024 * 1024),
  videoLibraryPrewarmOnStart: asBoolean(process.env.VIDEO_LIBRARY_PREWARM_ON_START, true),
  videoLibraryTriggerHints: asList(process.env.VIDEO_LIBRARY_TRIGGER_HINTS).length
    ? asList(process.env.VIDEO_LIBRARY_TRIGGER_HINTS)
    : ["\u6e05\u5531", "\u53d1\u89c6\u9891", "\u6765\u6bb5\u89c6\u9891", "\u89c6\u9891"],
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
  feishuAlwaysReplyUserIds: process.env.FEISHU_ALWAYS_REPLY_USER_IDS !== undefined
    ? asList(process.env.FEISHU_ALWAYS_REPLY_USER_IDS)
    : ["410351", "用户410351"],
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
  obsidianSyncEnabled: asBoolean(process.env.OBSIDIAN_SYNC_ENABLED, Boolean(process.env.OBSIDIAN_GITHUB_TOKEN || process.env.GITHUB_BACKUP_TOKEN)),
  obsidianGithubToken: process.env.OBSIDIAN_GITHUB_TOKEN || process.env.GITHUB_BACKUP_TOKEN || "",
  obsidianGithubRepo: process.env.OBSIDIAN_GITHUB_REPO || "Mad12345-qw/obsidian-knowledge-sync",
  obsidianGithubBranch: process.env.OBSIDIAN_GITHUB_BRANCH || "main",
  obsidianGithubTimeoutMs: asNumber(process.env.OBSIDIAN_GITHUB_TIMEOUT_MS, 30000),
  obsidianYoutubeFolder: process.env.OBSIDIAN_YOUTUBE_FOLDER || "youtube",
  obsidianTopicFolder: process.env.OBSIDIAN_TOPIC_FOLDER || "topics",
  feishuYoutubeParentWikiToken: process.env.FEISHU_YOUTUBE_PARENT_WIKI_TOKEN || "",
  feishuYoutubeIndexWikiToken: process.env.FEISHU_YOUTUBE_INDEX_WIKI_TOKEN || "",
  feishuYoutubeIndexDocumentId: process.env.FEISHU_YOUTUBE_INDEX_DOCUMENT_ID || "",
  feishuWorkspaceTimeoutMs: asNumber(process.env.FEISHU_WORKSPACE_TIMEOUT_MS, 30000),
  autoMemory: asBoolean(process.env.AUTO_MEMORY, true),
  feishuTimingLogsEnabled: asBoolean(process.env.FEISHU_TIMING_LOGS_ENABLED, true),
  feishuTimingMinMs: asNumber(process.env.FEISHU_TIMING_MIN_MS, 0),
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
