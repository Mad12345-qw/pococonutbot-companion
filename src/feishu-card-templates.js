import crypto from "node:crypto";
import { truncate } from "./utils.js";

function cardText(value = "", max = 600) {
  return truncate(String(value || "").replace(/[<>{}]/g, "").replace(/\s+/g, " ").trim(), max);
}

function compactLines(lines = []) {
  return lines.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
}

function uniqueItems(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function sourceLabel(item = {}) {
  return cardText([item.siteName, item.publishedAt].filter(Boolean).join(" | "), 140);
}

function summaryBullets(text = "", limit = 4) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines.slice(0, limit).map((line) => cardText(line, 180));
  return raw
    .split(/[。！？?]\s*/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => cardText(line, 180));
}

function cardActionButtons(results = [], limit = 3) {
  return results
    .filter((item) => /^https?:\/\//i.test(item.url))
    .slice(0, limit)
    .map((item, index) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content: `资料 ${item.index || index + 1}`
      },
      type: index === 0 ? "primary" : "default",
      url: item.url
    }));
}

function cardNote(results = []) {
  const sourceCount = results.filter((item) => item.url).length;
  return {
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `已整理 ${sourceCount} 条公开资料`
      }
    ]
  };
}

function md(content = "", max = 1200) {
  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content: cardText(content, max)
    }
  };
}

function metricColumn(label, value) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [
      md(compactLines([
        `**${cardText(label, 20)}**`,
        cardText(value || "待确认", 80)
      ]), 140)
    ]
  };
}

function metricStrip(metrics = []) {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "grey",
    columns: metrics.map((item) => metricColumn(item.label, item.value))
  };
}

function baseCard({ title, template = "blue", elements = [] }) {
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      }
    },
    elements
  };
}

function textForKind(query = "", results = []) {
  return [
    query,
    ...results.slice(0, 4).flatMap((item) => [item.title, item.summary, item.snippet, item.siteName])
  ].join("\n");
}

export function classifySearchCard(query = "", results = []) {
  const text = textForKind(query, results);
  if (/(?:世界杯|FIFA|World Cup|足球|比赛|赛程|对阵|比分|小组赛|淘汰赛|积分榜|预测|胜率|投票|支持哪队)/i.test(text)) {
    if (/(?:投票|支持|押|猜|选哪|站哪边|谁赢)/i.test(text)) return "worldcup_poll";
    if (/(?:预测|胜率|谁会赢|分析|看好|赔率)/i.test(text)) return "worldcup_prediction";
    return "worldcup_schedule";
  }
  if (/(?:天气|气温|温度|下雨|降雨|降水|空气质量|AQI|穿什么|台风|暴雨|预报|晴|多云|雷阵雨)/i.test(text)) {
    return "weather";
  }
  if (/(?:价格|行情|报价|金价|黄金|白银|汇率|股价|股票|指数|油价|利率|CPI|PPI|BTC|USDT|比特币|人民币|美元|上涨|下跌|涨|跌)/i.test(text)) {
    return "price";
  }
  if (/(?:新闻|要闻|日报|今天|今日|最新|近期|最近|动态|进展|发布|更新|热搜|突发|事件)/i.test(text)) {
    return "news";
  }
  return "reference";
}

export function searchKindFromText(text = "") {
  return classifySearchCard(text, []);
}

export function inferSearchFreshness(text = "", fallback = "noLimit") {
  const value = String(text || "");
  if (/(?:今天|今日|现在|刚刚|实时|天气|赛程|比分|投票|预测)/.test(value)) return "oneDay";
  if (/(?:本周|这周|一周|世界杯|比赛)/.test(value)) return "oneWeek";
  if (/(?:最新|最近|近期|近一个月)/.test(value)) return "oneMonth";
  if (/(?:今年|近一年)/.test(value)) return "oneYear";
  return fallback || "noLimit";
}

export function buildSearchCard({ query, search, summary }) {
  const results = (search?.results || []).slice(0, 5);
  const kind = classifySearchCard(query, results);
  if (kind === "weather") return buildWeatherCard({ query, results, summary });
  if (kind === "price") return buildPriceCard({ query, results, summary });
  if (kind === "news") return buildNewsCard({ query, results, summary });
  if (kind === "worldcup_schedule") return buildWorldCupCard({ query, results, summary, mode: "schedule" });
  if (kind === "worldcup_prediction") return buildWorldCupCard({ query, results, summary, mode: "prediction" });
  if (kind === "worldcup_poll") return buildWorldCupCard({ query, results, summary, mode: "poll" });
  return buildReferenceCard({ query, results, summary });
}

function buildWeatherCard({ query, results, summary }) {
  const signals = extractWeatherSignals({ query, results, summary });
  const bullets = summaryBullets(summary, 4);
  const elements = [
    md(compactLines([
      `**${cardText(query, 120)}**`,
      bullets[0] || cardText(summary, 220)
    ]), 360),
    metricStrip([
      { label: "体感", value: signals.temperature },
      { label: "降雨", value: signals.rain },
      { label: "空气", value: signals.air }
    ]),
    md(compactLines([
      "**今日提醒**",
      ...bullets.slice(1, 4).map((item) => `- ${item}`)
    ]), 700)
  ];
  const actions = cardActionButtons(results, 2);
  if (actions.length) elements.push({ tag: "action", actions });
  elements.push(cardNote(results));
  return baseCard({ title: "天气速览", template: "wathet", elements });
}

function extractWeatherSignals({ query = "", results = [], summary = "" }) {
  const text = [query, summary, ...results.flatMap((item) => [item.title, item.summary, item.snippet])].join("\n");
  const temperatures = uniqueItems(text.match(/-?\d+(?:\.\d+)?\s*(?:℃|度)/g) || []);
  const rain =
    cardText((text.match(/(?:降雨|降水|下雨|阵雨|暴雨|雷雨|雨量|湿度|伞)[^。！？\n]{0,36}/g) || [])[0] || "", 60) ||
    (/雨|降水|降雨/.test(text) ? "有降雨信号" : "未见明显降雨");
  const air =
    cardText((text.match(/(?:AQI|空气质量|PM2\.5|污染|优|良)[^。！？\n]{0,36}/i) || [])[0] || "", 60) ||
    "待看当地实况";
  return {
    temperature: temperatures.slice(0, 2).join(" / ") || "未检出温度",
    rain,
    air
  };
}

function buildPriceCard({ query, results, summary }) {
  const signals = extractPriceSignals({ query, results, summary });
  const bullets = summaryBullets(summary, 4);
  const elements = [
    md(compactLines([
      `**${cardText(query, 120)}**`,
      bullets[0] || cardText(summary, 220)
    ]), 360),
    metricStrip([
      { label: "最新信号", value: signals.primaryNumber },
      { label: "方向", value: signals.trend },
      { label: "观察点", value: signals.watch }
    ]),
    md(compactLines([
      "**驱动因素**",
      ...bullets.slice(1, 4).map((item) => `- ${item}`)
    ]), 760)
  ];
  const actions = cardActionButtons(results, 3);
  if (actions.length) elements.push({ tag: "action", actions });
  elements.push(cardNote(results));
  return baseCard({
    title: "价格指标卡",
    template: signals.trendType === "down" ? "red" : signals.trendType === "mixed" ? "yellow" : "green",
    elements
  });
}

function extractPriceSignals({ query = "", results = [], summary = "" }) {
  const text = [query, summary, ...results.flatMap((item) => [item.title, item.summary, item.snippet])].join("\n");
  const numbers = uniqueItems(
    (text.match(/[+-]?\d+(?:\.\d+)?\s*(?:元\/克|元\/斤|美元\/盎司|美元|元|港元|点|%|％|万元|亿元|万|亿|克|吨|桶|BTC|USDT)/gi) || [])
      .map((item) => cardText(item, 40))
  );
  const up = /(?:上涨|涨|飙升|走高|上行|创新高|升破|站上|涨幅)/.test(text);
  const down = /(?:下跌|跌|回落|走低|下行|降|跌幅)/.test(text);
  const trendType = up && down ? "mixed" : down ? "down" : up ? "up" : "flat";
  const trend =
    trendType === "mixed" ? "波动加大" :
    trendType === "down" ? "回落或走低" :
    trendType === "up" ? "上行或偏强" :
    "等待明确信号";
  const watch = cardText(results[0]?.siteName || results[0]?.displayUrl || "多源交叉确认", 60);
  return {
    primaryNumber: numbers[0] || "未检出明确数字",
    trend,
    trendType,
    watch
  };
}

function buildNewsCard({ query, results, summary }) {
  const bullets = summaryBullets(summary, 4);
  const lead = bullets.shift() || cardText(summary, 200);
  const elements = [
    md(compactLines([
      `**${cardText(query, 120)}**`,
      lead
    ]), 360),
    md(compactLines([
      "**今日主线**",
      ...bullets.map((item) => `- ${item}`)
    ]), 720),
    { tag: "hr" },
    md("**重点新闻**", 60)
  ];
  for (const item of results.slice(0, 4)) {
    elements.push(md(compactLines([
      `**${String(item.index).padStart(2, "0")}  ${cardText(item.title, 120)}**`,
      sourceLabel(item),
      cardText(item.summary || item.snippet, 210)
    ]), 460));
  }
  const actions = cardActionButtons(results, 3);
  if (actions.length) elements.push({ tag: "action", actions });
  elements.push(cardNote(results));
  return baseCard({ title: "今日简报", template: "orange", elements });
}

function buildWorldCupCard({ query, results, summary, mode }) {
  const bullets = summaryBullets(summary, mode === "poll" ? 3 : 4);
  const title =
    mode === "poll" ? "世界杯投票" :
    mode === "prediction" ? "世界杯预测" :
    "世界杯赛程";
  const elements = [
    md(compactLines([
      `**${cardText(query, 120)}**`,
      bullets[0] || cardText(summary, 220)
    ]), 360),
    metricStrip(worldCupMetrics({ query, results, summary, mode })),
    md(compactLines([
      mode === "poll" ? "**先投一票**" : mode === "prediction" ? "**判断依据**" : "**赛程重点**",
      ...bullets.slice(1, 4).map((item) => `- ${item}`)
    ]), 760)
  ];

  if (mode === "poll") {
    elements.push({
      tag: "action",
      actions: buildWorldCupVoteButtons(query)
    });
  }

  const actions = cardActionButtons(results, mode === "poll" ? 2 : 3);
  if (actions.length) elements.push({ tag: "action", actions });
  elements.push(cardNote(results));
  return baseCard({ title, template: mode === "prediction" ? "purple" : "indigo", elements });
}

function worldCupMetrics({ query = "", results = [], summary = "", mode = "schedule" }) {
  const text = [query, summary, ...results.flatMap((item) => [item.title, item.summary, item.snippet])].join("\n");
  const time = cardText((text.match(/\d{1,2}[月/-]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2})?|\d{1,2}:\d{2}/) || [])[0] || "", 50);
  const score = cardText((text.match(/\b\d+\s*[-:：]\s*\d+\b/) || [])[0] || "", 50);
  if (mode === "prediction") {
    return [
      { label: "倾向", value: inferWinner(query, summary) },
      { label: "变量", value: "阵容 / 状态 / 赛程" },
      { label: "风险", value: "临场信息会变" }
    ];
  }
  if (mode === "poll") {
    const options = extractTeams(query);
    return [
      { label: "选项 A", value: options.home },
      { label: "选项 B", value: "平局 / 加时" },
      { label: "选项 C", value: options.away }
    ];
  }
  return [
    { label: "时间", value: time || "看最近赛程" },
    { label: "比分", value: score || "赛前待定" },
    { label: "关注", value: "对阵 / 出线 / 排名" }
  ];
}

function inferWinner(query = "", summary = "") {
  const text = `${query}\n${summary}`;
  const match = text.match(/(?:看好|倾向|预测|胜率较高|优势)[^。！？\n]{0,32}/);
  return cardText(match?.[0] || "谨慎看临场", 60);
}

function extractTeams(query = "") {
  const text = String(query || "")
    .replace(/(?:世界杯|FIFA|World Cup|worldcup|wc|投票|预测|赛程|比赛|猜一下|开个投票|谁赢)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = text.match(/([\u4e00-\u9fa5A-Za-z0-9·.\-\s]{2,24})\s*(?:vs|VS|对阵|对|打|和)\s*([\u4e00-\u9fa5A-Za-z0-9·.\-\s]{2,24})/);
  const home = cardText(match?.[1] || "A 队", 24);
  const away = cardText(match?.[2] || "B 队", 24);
  return { home, away };
}

function buildWorldCupVoteButtons(query = "") {
  const pollId = crypto.createHash("sha1").update(String(query || "worldcup")).digest("hex").slice(0, 16);
  const teams = extractTeams(query);
  const options = [
    { key: "home", label: teams.home },
    { key: "draw", label: "平局 / 加时" },
    { key: "away", label: teams.away }
  ];
  return options.map((option, index) => ({
    tag: "button",
    text: {
      tag: "plain_text",
      content: option.label
    },
    type: index === 0 ? "primary" : "default",
    value: {
      action: "worldcup_vote",
      poll_id: pollId,
      option: option.key,
      label: option.label,
      title: cardText(query, 120)
    }
  }));
}

function buildReferenceCard({ query, results, summary }) {
  const bullets = summaryBullets(summary, 4);
  const elements = [
    md(compactLines([
      `**${cardText(query, 120)}**`,
      ...bullets.map((item) => `- ${item}`)
    ]), 760),
    { tag: "hr" },
    md("**可参考资料**", 60)
  ];
  for (const item of results.slice(0, 5)) {
    elements.push(md(compactLines([
      `**${item.index}. ${cardText(item.title, 120)}**`,
      sourceLabel(item),
      cardText(item.summary || item.snippet, 220)
    ]), 480));
  }
  const actions = cardActionButtons(results, 3);
  if (actions.length) elements.push({ tag: "action", actions });
  elements.push(cardNote(results));
  return baseCard({ title: "资料卡", template: "blue", elements });
}
