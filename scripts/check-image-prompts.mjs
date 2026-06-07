import { TelegramCompanionBot } from "../src/telegram.js";

const bot = Object.create(TelegramCompanionBot.prototype);
bot.botInfo = { username: "xiaoye_bot" };
bot.config = { displayName: "小椰" };

const cases = [
  ["帮我生成一张跨境电商做独立站的攻略图?", true],
  ["生成一张图 跨境电商独立站攻略", true],
  ["帮我写一份跨境电商独立站攻略", false],
  ["小椰发张自拍", false]
];

let failed = 0;
for (const [text, expected] of cases) {
  const actual = bot.extractImageGenerationPrompt(text).requested;
  if (actual !== expected) {
    failed += 1;
    console.error(`FAIL ${JSON.stringify(text)} expected=${expected} actual=${actual}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log("Image prompt checks passed.");
