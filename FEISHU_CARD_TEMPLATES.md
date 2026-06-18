# Feishu Card Templates

This bot now uses code-based Feishu interactive card templates. You do not need to create Feishu CardKit templates first; the bot builds and sends the cards directly.

## Built-In Templates

### Weather

Use cases:

```text
查下今天深圳天气
明天上海会不会下雨
北京周末穿什么
```

Bot behavior:

- Sends a weather card instead of voice.
- Shows body feel, rain signal, air quality, and short reminders.
- Adds source buttons as `资料 1`, `资料 2`.

### Price And Market

Use cases:

```text
今天黄金价格
查下 BTC 行情
美元人民币汇率现在多少
```

Bot behavior:

- Sends a price indicator card instead of voice.
- Extracts the main number, direction, and watch point.
- Uses green/yellow/red header color based on detected trend.

### News Brief

Use cases:

```text
今天 AI 新闻
最新新能源汽车政策
查下世界杯新闻
```

Bot behavior:

- Sends a daily brief card.
- Keeps the lead short, then lists key lines and source buttons.

### Reference Summary

Use cases:

```text
查一下某家公司资料
搜下某个政策是什么意思
联网查一下这个产品
```

Bot behavior:

- Sends a compact reference card.
- Keeps the search provider hidden from the Feishu-facing card.

### World Cup Schedule

Use cases:

```text
世界杯今天赛程
查下世界杯下一场比赛
世界杯积分榜
```

Bot behavior:

- Sends a World Cup schedule card.
- Prioritizes match time, score/status, and qualification/ranking signals.

### World Cup Prediction

Use cases:

```text
世界杯 阿根廷 vs 法国 预测
今晚这场谁会赢
查下世界杯胜率
```

Bot behavior:

- Sends a prediction card.
- Gives a cautious read based on current search results.

### World Cup Poll

Use cases:

```text
世界杯 阿根廷 vs 法国 投票
大家猜一下阿根廷对法国谁赢
世界杯这场开个投票
```

Bot behavior:

- Sends a poll card with three buttons.
- Button clicks are recorded server-side.
- Feishu shows a small toast after each vote.

## Minimal Setup Steps

Most templates only need the existing search setup:

```env
WEB_SEARCH_ENABLED=true
BOCHA_API_KEY=your_key_in_render_only
BOCHA_SEARCH_COUNT=6
BOCHA_SEARCH_FRESHNESS=noLimit
```

For World Cup poll buttons, add one Feishu card callback. This is not in the normal event list.

1. Open Feishu Open Platform.
2. Open this bot app.
3. Go to `事件与回调`.
4. Open the `回调配置` tab, not the `事件配置` tab.
5. Keep the existing request URL:

```text
https://pococonutbot-minimax-companion.onrender.com/feishu/events
```

6. Add the card callback named:

```text
卡片回传交互
```

The API callback type behind this item is `card.action.trigger`, but the console may only show the Chinese name.

7. Publish the app version again if Feishu asks for it.

## Recommended Test Messages

After deployment, test these in Feishu:

```text
查下今天深圳天气
今天黄金价格
今天 AI 新闻
世界杯今天赛程
世界杯 阿根廷 vs 法国 预测
世界杯 阿根廷 vs 法国 投票
```

Expected result: all six should reply with cards, not voice.
