import { TelegramCompanionBot } from "../src/telegram.js";

const bot = Object.create(TelegramCompanionBot.prototype);
bot.botInfo = { username: "xiaoye_bot" };
bot.config = { displayName: "小椰" };

const cases = [
  ["帮我生成一张跨境电商做独立站的攻略图?", true],
  ["小椰，你生成一张番茄的电商图", true],
  ["你生成一张番茄的电商图", true],
  ["生成一张图 跨境电商独立站攻略", true],
  ["小椰，先按照她的要求给她生成一张她这样要求的男友 自拍图", true],
  ["先按照她的要求给她生成一张她这样要求的男友 自拍图", true],
  ["帮我生成一张男友自拍图", true],
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
