import { Resvg } from "@resvg/resvg-js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { worldCupPollId } from "./feishu-card-templates.js";

const WIDTH = 900;
const HEIGHT = 1120;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let bundledFontFiles = null;

function premiumFontFiles() {
  if (bundledFontFiles) return bundledFontFiles;
  const fontFile = path.resolve(__dirname, "..", "assets", "fonts", "LXGWWenKaiScreen.ttf");
  bundledFontFiles = existsSync(fontFile) ? [fontFile] : [];
  return bundledFontFiles;
}

function stripUnsupportedGlyphs(value = "") {
  return String(value || "")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/[\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value = "", max = 160) {
  const cleaned = stripUnsupportedGlyphs(value)
    .replace(/\.\.\.\[truncated\]/gi, "")
    .replace(/\[truncated\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function xml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function lines(text = "", maxChars = 24, maxLines = 2) {
  const raw = safeText(text, maxChars * maxLines + 16);
  const output = [];
  let current = "";
  for (const char of raw) {
    const charWidth = /[A-Za-z0-9 .,/%:+-]/.test(char) ? 0.55 : 1;
    const currentWidth = [...current].reduce((sum, item) => sum + (/[A-Za-z0-9 .,/%:+-]/.test(item) ? 0.55 : 1), 0);
    if (currentWidth + charWidth > maxChars && current) {
      let line = current.trimEnd();
      let next = char;
      if (/[A-Za-z0-9.%％℃°~+\-/]/.test(char)) {
        const token = line.match(/[A-Za-z0-9.,/%％:+~℃°+\-/]+$/)?.[0] || "";
        if (token && line.length > token.length) {
          line = line.slice(0, -token.length).trimEnd();
          next = `${token}${char}`;
        }
      }
      output.push(line);
      current = next;
      if (output.length >= maxLines) break;
    } else {
      current += char;
    }
  }
  if (current && output.length < maxLines) output.push(current.trimEnd());
  if (output.length === maxLines && textWidth(raw) > maxChars * maxLines) {
    output[maxLines - 1] = fitLine(output[maxLines - 1], maxChars);
  }
  return output;
}

function textWidth(text = "") {
  return [...String(text || "")].reduce((sum, char) => sum + (/[A-Za-z0-9 .,/%:+-]/.test(char) ? 0.56 : 1), 0);
}

function fitLine(text = "", maxChars = 24) {
  const raw = safeText(text, Math.max(8, maxChars * 3));
  if (textWidth(raw) <= maxChars) return raw;
  let output = "";
  for (const char of raw) {
    if (textWidth(`${output}${char}...`) > maxChars) break;
    output += char;
  }
  return `${output.trimEnd()}...`;
}

function fitSize(text = "", baseSize = 30, maxPx = 160, minSize = 22) {
  const width = Math.max(1, textWidth(text)) * baseSize;
  if (width <= maxPx) return baseSize;
  return Math.max(minSize, Math.floor((maxPx / width) * baseSize));
}

function textBlock({ text = "", x = 0, y = 0, size = 28, weight = 500, fill = "#111827", maxChars = 24, maxLines = 2, lineHeight = 1.25 }) {
  const blockLines = maxLines === 1 ? [fitLine(text, maxChars)] : lines(text, maxChars, maxLines);
  return blockLines
    .map((line, index) => {
      const dy = index === 0 ? 0 : size * lineHeight * index;
      return `<text x="${x}" y="${y + dy}" font-size="${size}" font-weight="${weight}" fill="${fill}">${xml(line)}</text>`;
    })
    .join("");
}

function splitMetricValue(value = "") {
  const raw = safeText(value, 28);
  const range = raw.match(/^([+-]?\d+(?:\.\d+)?)(?:\s*(?:~|至|-|—|－)\s*([+-]?\d+(?:\.\d+)?))\s*(℃|度|°C|°c)$/);
  if (range) return { main: `${range[1]}~${range[2]}`, unit: range[3] === "度" || /^°c$/i.test(range[3]) ? "℃" : range[3] };
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)(.*)$/);
  if (!match) return { main: raw, unit: "" };
  const unit = match[2].trim();
  return { main: match[1], unit: /^°c$/i.test(unit) ? "℃" : unit };
}

function summaryBullets(text = "", limit = 3) {
  const raw = safeText(text, 320)
    .replace(/以下是根据搜索结果整理的?/g, "")
    .replace(/综合多个地区[，,、]?\s*仅供参考/g, "多地天气，仅供参考")
    .replace(/天气信息/g, "天气")
    .trim();
  if (!raw) return [];
  const byLine = raw
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:(?:[-*•]|\d+[.)、])\s*)+/, "").trim())
    .filter(Boolean);
  const items = byLine.length > 1
    ? byLine
    : raw.split(/[。！？?；;]\s*/).map((line) => line.trim()).filter(Boolean);
  return items
    .map((item) => item.replace(/^\s*(?:(?:[-*•]|\d+[.)、])\s*)+/, "").trim())
    .filter((item) => item && !/^(?:天气)?[（(]?多地天气[，,、]?\s*仅供参考[）)]?$/.test(item))
    .slice(0, limit)
    .map((item) => safeText(item, 44));
}

function extractNumbers(text = "") {
  return [...String(text || "").matchAll(/[+-]?\d+(?:\.\d+)?\s*(?:℃|度|°C|°c|%|％|美元\/盎司|美元|元\/克|元|点|BTC|USDT)?/g)]
    .map((match) => match[0].trim())
    .filter(Boolean)
    .slice(0, 6);
}

function extractTemperatures(text = "") {
  return [...String(text || "").matchAll(/[+-]?\d+(?:\.\d+)?\s*(?:~|至|-|—|－)?\s*[+-]?\d*(?:\.\d+)?\s*(?:℃|度|°C|°c)/g)]
    .map((match) => match[0].replace(/\s+/g, "").trim())
    .filter(Boolean)
    .filter((value) => !/^20\d{2}/.test(value))
    .slice(0, 4);
}

function extractPercentages(text = "") {
  return [...String(text || "").matchAll(/[+-]?\d+(?:\.\d+)?\s*(?:%|％)/g)]
    .map((match) => match[0].replace(/\s+/g, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

function extractMarketValues(text = "") {
  const values = [...String(text || "").matchAll(/[+-]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:美元\/盎司|美元|元\/克|元|点|BTC|USDT|%|％)/g)]
    .map((match) => match[0].replace(/\s+/g, "").trim())
    .filter(Boolean)
    .filter((value) => !/^20\d{2}(?:年|美元|元|点)?$/.test(value));
  return [...new Set(values)].slice(0, 6);
}

function combineText({ query = "", results = [], summary = "" }) {
  return [query, summary, ...results.flatMap((item) => [item.title, item.summary, item.snippet, item.siteName])].join("\n");
}

function classifyPremiumKind(query = "", results = []) {
  const text = [query, ...results.slice(0, 4).flatMap((item) => [item.title, item.summary, item.snippet, item.siteName])].join("\n");
  if (/(?:世界杯|FIFA|World Cup|worldcup|足球|比赛|赛程|对阵|比分|积分|预测|胜率|投票|支持哪队)/i.test(text)) {
    if (/(?:投票|支持|猜|选哪|站哪边|谁赢)/i.test(text)) return "worldcup_poll";
    if (/(?:预测|胜率|谁会赢|分析|看好|赔率)/i.test(text)) return "worldcup_prediction";
    return "worldcup_schedule";
  }
  if (/(?:天气|气温|温度|下雨|降雨|降水|空气质量|AQI|穿什么|台风|暴雨|预报|晴|多云|雷阵雨)/i.test(text)) return "weather";
  if (/(?:价格|行情|报价|金价|黄金|白银|汇率|股价|股票|指数|油价|利率|CPI|PPI|BTC|USDT|比特币|人民币|美元|上涨|下跌|涨|跌)/i.test(text)) return "price";
  if (/(?:新闻|要闻|日报|今天|今日|最新|近期|最近|动态|进展|发布|更新|热搜|突发|事件)/i.test(text)) return "news";
  return "reference";
}

function extractTeams(query = "") {
  const cleaned = String(query || "")
    .replace(/(?:世界杯|FIFA|World Cup|worldcup|wc|投票|预测|赛程|比赛|猜一下|开个投票|谁赢)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(/([\u4e00-\u9fa5A-Za-z0-9·.\-\s]{2,24})\s*(?:vs|VS|对阵|对|打|和)\s*([\u4e00-\u9fa5A-Za-z0-9·.\-\s]{2,24})/);
  return {
    home: safeText(match?.[1] || "A 队", 18),
    away: safeText(match?.[2] || "B 队", 18)
  };
}

function pollTotal(poll = {}) {
  return Object.values(poll.counts || {}).reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
}

function palette(kind = "reference") {
  if (kind === "weather") {
    return {
      accent: "#18A0FB",
      accent2: "#80E7D7",
      warm: "#FFD66B",
      title: "天气速览",
      eyebrow: "WEATHER"
    };
  }
  if (kind === "price") {
    return {
      accent: "#F5B841",
      accent2: "#34D399",
      warm: "#FF7A59",
      title: "价格指标卡",
      eyebrow: "MARKET"
    };
  }
  if (kind === "news") {
    return {
      accent: "#6366F1",
      accent2: "#22C55E",
      warm: "#FF6B8A",
      title: "今日简报",
      eyebrow: "BRIEF"
    };
  }
  if (kind.startsWith("worldcup")) {
    return {
      accent: "#2563EB",
      accent2: "#A3E635",
      warm: "#F97316",
      title: kind === "worldcup_poll" ? "世界杯投票" : kind === "worldcup_prediction" ? "世界杯预测" : "世界杯赛程",
      eyebrow: "WORLD CUP"
    };
  }
  return {
    accent: "#14B8A6",
    accent2: "#8B5CF6",
    warm: "#F59E0B",
    title: "资料卡",
    eyebrow: "REFERENCE"
  };
}

function baseSvg({ kind, title, subtitle, metrics = [], bullets = [], poll = null, query = "" }) {
  const p = palette(kind);
  const metricCards = metrics.slice(0, 3).map((item, index) => {
    const x = 76 + index * 242;
    const cx = x + 106;
    const value = splitMetricValue(item.value);
    const valueSize = fitSize(value.main, 33, 144, 24);
    const unitText = value.unit || "";
    return `
      <rect x="${x}" y="430" width="212" height="132" rx="34" fill="#F6F8FC" stroke="#E7ECF3"/>
      <text x="${cx}" y="478" text-anchor="middle" font-size="25" font-weight="600" fill="#64748B">${xml(fitLine(item.label, 7))}</text>
      <text x="${cx}" y="526" text-anchor="middle" font-size="${valueSize}" font-weight="780" fill="#0F172A">${xml(fitLine(value.main, 8))}</text>
      ${unitText ? `<text x="${cx}" y="554" text-anchor="middle" font-size="20" font-weight="650" fill="#64748B">${xml(fitLine(unitText, 8))}</text>` : ""}
    `;
  }).join("");

  const bulletRows = bullets.slice(0, 3).map((item, index) => {
    const y = 638 + index * 102;
    return `
      <circle cx="92" cy="${y - 10}" r="9" fill="${p.accent}" opacity="${0.9 - index * 0.18}"/>
      ${textBlock({ text: item, x: 122, y, size: 27, weight: 560, fill: "#1F2937", maxChars: 24, maxLines: 2, lineHeight: 1.24 })}
    `;
  }).join("");

  return `
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${WIDTH}" y2="${HEIGHT}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FFFFFF"/>
        <stop offset="0.48" stop-color="#F7FAFF"/>
        <stop offset="1" stop-color="#FFFDF7"/>
      </linearGradient>
      <linearGradient id="hero" x1="48" y1="44" x2="852" y2="380" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FFFFFF"/>
        <stop offset="0.32" stop-color="${p.accent}" stop-opacity="0.18"/>
        <stop offset="0.68" stop-color="${p.accent2}" stop-opacity="0.16"/>
        <stop offset="1" stop-color="${p.warm}" stop-opacity="0.18"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="30" stdDeviation="32" flood-color="#1E293B" flood-opacity="0.14"/>
        <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#0F172A" flood-opacity="0.08"/>
      </filter>
      <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="28"/>
      </filter>
      <style>
        text { font-family: "LXGW WenKai Screen", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Arial", sans-serif; letter-spacing: 0; }
      </style>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#EEF3F8"/>
    <rect x="34" y="34" width="832" height="1052" rx="56" fill="url(#bg)" filter="url(#shadow)"/>
    <rect x="35" y="35" width="830" height="1050" rx="55" fill="none" stroke="#FFFFFF" stroke-opacity="0.82" stroke-width="2"/>
    <rect x="58" y="58" width="784" height="330" rx="48" fill="url(#hero)" stroke="#FFFFFF" stroke-width="2"/>
    <circle cx="732" cy="142" r="76" fill="${p.accent}" opacity="0.18" filter="url(#soft)"/>
    <circle cx="668" cy="268" r="58" fill="${p.accent2}" opacity="0.2" filter="url(#soft)"/>
    <text x="86" y="124" font-size="26" font-weight="700" fill="#64748B">${xml(p.eyebrow)}</text>
    ${textBlock({ text: title, x: 86, y: 190, size: 54, weight: 820, fill: "#0F172A", maxChars: 10, maxLines: 1 })}
    ${textBlock({ text: subtitle, x: 86, y: 246, size: 28, weight: 520, fill: "#475569", maxChars: 16, maxLines: 2 })}
    <rect x="86" y="304" width="176" height="50" rx="25" fill="#0F172A"/>
    <text x="174" y="338" text-anchor="middle" font-size="24" font-weight="800" fill="#FFFFFF">${xml(fitLine(p.title, 6))}</text>
    ${renderKindHeroMark(kind, p)}
    ${metricCards}
    ${poll ? renderPollBars(poll, p) : bulletRows}
    <rect x="76" y="944" width="748" height="76" rx="38" fill="#0F172A"/>
    <text x="450" y="993" text-anchor="middle" font-size="29" font-weight="800" fill="#FFFFFF">${kind.startsWith("worldcup_poll") ? "点击下方按钮投票" : "点击下方信息来源看详情"}</text>
    <text x="76" y="1056" font-size="22" font-weight="500" fill="#64748B">Premium Feishu Card · Prismatic Widgets</text>
  </svg>`;
}

function renderKindHeroMark(kind, p) {
  if (kind === "price") {
    return `
      <path d="M624 300 C664 262 684 270 724 230 C756 198 782 184 816 154" fill="none" stroke="${p.accent}" stroke-width="10" stroke-linecap="round"/>
      <circle cx="816" cy="154" r="15" fill="${p.accent2}"/>
    `;
  }
  if (kind.startsWith("worldcup")) {
    return `
      <circle cx="725" cy="210" r="72" fill="#FFFFFF" opacity="0.72"/>
      <path d="M688 208 C702 170 749 170 764 208 C779 247 744 280 726 292 C707 280 673 247 688 208Z" fill="${p.accent}" opacity="0.9"/>
    `;
  }
  if (kind === "weather") {
    return `
      <circle cx="720" cy="190" r="62" fill="${p.warm}" opacity="0.72"/>
      <path d="M632 262 C647 228 699 229 713 262 C747 260 773 284 773 314 C773 345 748 366 716 366 H632 C599 366 575 344 575 314 C575 285 599 263 632 262Z" fill="#FFFFFF" opacity="0.78"/>
    `;
  }
  return `<circle cx="720" cy="210" r="72" fill="${p.accent}" opacity="0.22"/>`;
}

function renderPollBars(poll = {}, p) {
  const total = Math.max(0, pollTotal(poll));
  const options = poll.options || {};
  const counts = poll.counts || {};
  return ["home", "draw", "away"].map((key, index) => {
    const label = options[key] || (key === "draw" ? "平局 / 加时" : key);
    const count = Math.max(0, Number(counts[key] || 0));
    const pct = total ? Math.round((count / total) * 100) : 0;
    const y = 640 + index * 92;
    const fill = index === 0 ? p.accent : index === 1 ? "#94A3B8" : p.accent2;
    const width = total ? Math.max(18, Math.round(440 * count / total)) : 0;
    return `
      <text x="76" y="${y}" font-size="30" font-weight="700" fill="#172033">${xml(safeText(label, 18))}</text>
      <rect x="268" y="${y - 25}" width="440" height="25" rx="13" fill="#E8EDF4"/>
      <rect x="268" y="${y - 25}" width="${width}" height="25" rx="13" fill="${fill}"/>
      <text x="736" y="${y}" font-size="28" font-weight="760" fill="#172033">${count}票</text>
      <text x="76" y="${y + 34}" font-size="22" font-weight="560" fill="#64748B">${pct}%</text>
    `;
  }).join("");
}

function dataForKind({ query, results, summary, poll }) {
  const kind = classifyPremiumKind(query, results);
  const text = combineText({ query, results, summary });
  const bullets = summaryBullets(summary, 3);
  const numbers = extractNumbers(text);
  if (kind === "weather") {
    const multiRegion = /多个地区|多地|综合/.test(summary);
    const temperatures = extractTemperatures(text);
    const percentages = extractPercentages(text);
    return {
      kind,
      title: safeText(query.replace(/查下|查询|今天|今日/g, "").trim() || "天气速览", 32),
      subtitle: multiRegion ? "多地天气，仅供参考" : bullets[0] || "天气、降雨和体感已整理好。",
      metrics: [
        { label: "温度", value: temperatures[0] || "待确认" },
        { label: "降雨", value: percentages[0] || (/雨|降水|阵雨|暴雨|雷阵雨/.test(text) ? "看实况" : "待确认") },
        { label: "空气", value: /优/.test(text) ? "优" : /良/.test(text) ? "良" : "待确认" }
      ],
      bullets
    };
  }
  if (kind === "price") {
    const up = /上涨|涨|走高|上行|升/.test(text);
    const down = /下跌|跌|走低|回落|降/.test(text);
    const marketValues = extractMarketValues(text);
    return {
      kind,
      title: safeText(query, 32),
      subtitle: bullets[0] || "最新行情与主要变量已整理。",
      metrics: [
        { label: "最新", value: marketValues[0] || "待确认" },
        { label: "方向", value: up && down ? "震荡" : down ? "偏弱" : up ? "偏强" : "观察" },
        { label: "变量", value: "利率/美元" }
      ],
      bullets
    };
  }
  if (kind.startsWith("worldcup")) {
    const teams = extractTeams(query);
    return {
      kind,
      title: kind === "worldcup_poll" ? `${teams.home} vs ${teams.away}` : safeText(query, 32),
      subtitle: kind === "worldcup_poll" ? "每个人只保留最后一次选择。" : bullets[0] || "赛程、阵容和临场变量已整理。",
      metrics: kind === "worldcup_poll"
        ? [
            { label: "选项 A", value: teams.home },
            { label: "选项 B", value: "平局" },
            { label: "选项 C", value: teams.away }
          ]
        : [
            { label: "时间", value: numbers[0] || "待确认" },
            { label: "焦点", value: "对阵" },
            { label: "风险", value: "临场变动" }
          ],
      bullets,
      poll: poll || {
        title: query,
        options: { home: teams.home, draw: "平局 / 加时", away: teams.away },
        counts: {},
        voters: {}
      }
    };
  }
  return {
    kind,
    title: safeText(query, 32),
    subtitle: bullets[0] || "关键信息已整理成资料卡。",
    metrics: [
      { label: "资料", value: `${Math.max(1, results.length)}条` },
      { label: "范围", value: "公开来源" },
      { label: "状态", value: "已整理" }
    ],
    bullets
  };
}

export function renderPremiumSearchCardImage({ query, results = [], summary = "", poll = null }) {
  const data = dataForKind({ query, results, summary, poll });
  const svg = baseSvg(data);
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: { loadSystemFonts: true, fontFiles: premiumFontFiles() }
  });
  return {
    buffer: renderer.render().asPng(),
    mimeType: "image/png",
    kind: data.kind
  };
}

function hostnameFromUrl(value = "") {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, "");
    return hostname || "";
  } catch {
    return "";
  }
}

function sourceLabel(item = {}, index = 0) {
  const direct = safeText(item.siteName || item.source || item.provider || item.displayName || "", 16);
  if (direct) return direct;
  const displayUrl = safeText(item.displayUrl || item.url || "", 80);
  const hostname = hostnameFromUrl(displayUrl) || displayUrl.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  if (!hostname) return `信息来源 ${index + 1}`;
  const known = [
    [/163\.com$/i, "网易新闻"],
    [/(?:qq\.com|tencent\.com)$/i, "腾讯新闻"],
    [/weather\.com\.cn$/i, "中国天气网"],
    [/cma\.cn$/i, "中国气象局"],
    [/sina\.com\.cn$/i, "新浪新闻"],
    [/sohu\.com$/i, "搜狐新闻"],
    [/ifeng\.com$/i, "凤凰网"],
    [/people\.com\.cn$/i, "人民网"],
    [/xinhuanet\.com$/i, "新华网"],
    [/thepaper\.cn$/i, "澎湃新闻"]
  ].find(([pattern]) => pattern.test(hostname));
  if (known) return known[1];
  const compact = hostname
    .replace(/\.(com|cn|net|org|gov|edu)(\.[a-z]{2})?$/i, "")
    .replace(/\.(news|finance|weather)$/i, "");
  return safeText(compact || hostname, 16);
}

function sourceActions(results = [], limit = 3) {
  return results
    .filter((item) => /^https?:\/\//i.test(item.url))
    .slice(0, limit)
    .map((item, index) => ({
      tag: "button",
      text: { tag: "plain_text", content: sourceLabel(item, index) },
      type: index === 0 ? "primary" : "default",
      url: item.url
    }));
}

function voteActions(query = "", poll = null) {
  const teams = extractTeams(query);
  const pollId = poll?.pollId || poll?.poll_id || worldCupPollId(query);
  const optionLabels = {
    home: poll?.options?.home || teams.home,
    draw: poll?.options?.draw || "平局 / 加时",
    away: poll?.options?.away || teams.away
  };
  return [
    { key: "home", label: optionLabels.home, type: "primary" },
    { key: "draw", label: optionLabels.draw, type: "default" },
    { key: "away", label: optionLabels.away, type: "default" }
  ].map((option) => ({
    tag: "button",
    text: { tag: "plain_text", content: option.label },
    type: option.type,
    value: {
      action: "worldcup_vote",
      poll_id: pollId,
      option: option.key,
      label: option.label,
      options: optionLabels,
      title: safeText(query, 120)
    }
  }));
}

export function buildPremiumSearchCard({ imageKey, query, results = [], kind = "reference", poll = null }) {
  const elements = [
    {
      tag: "img",
      img_key: imageKey,
      alt: { tag: "plain_text", content: safeText(query || "资料卡", 80) }
    }
  ];
  const actions = kind === "worldcup_poll" ? voteActions(query, poll) : sourceActions(results, 3);
  if (actions.length) elements.push({ tag: "action", actions });
  if (kind !== "worldcup_poll" && results.length) {
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: `已整理 ${results.filter((item) => item.url).length} 条资料` }]
    });
  }
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    elements
  };
}

export function buildPremiumPollCard({ imageKey, poll }) {
  return buildPremiumSearchCard({
    imageKey,
    query: poll?.title || "世界杯投票",
    kind: "worldcup_poll",
    poll
  });
}
