process.env.BOT_DISPLAY_NAME = "??";
process.env.FEISHU_BOT_NAME = "??";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.AI_API_KEY = "test-key";

const { config } = await import("../src/config.js");

if (config.displayName !== "小椰") {
  console.error(`Expected displayName fallback, got ${config.displayName}`);
  process.exit(1);
}

if (config.feishuBotName !== "小椰") {
  console.error(`Expected feishuBotName fallback, got ${config.feishuBotName}`);
  process.exit(1);
}

console.log("Config checks passed.");
