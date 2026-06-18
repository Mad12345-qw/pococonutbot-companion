# Feishu Context Routing

This file is the routing contract for the Feishu bot. Before adding a new
feature trigger, check this matrix first so one feature does not steal another
feature's context.

## Mental Model

Every incoming Feishu message goes through five stages:

1. Normalize the message: parse text/post/audio/image, strip bot name, detect
   mentions, and record passive links.
2. Decide whether the bot should reply: p2p, bot mention, reply-to-bot, slash
   command, explicit feature request, or smart group candidate.
3. Enrich the current message: read direct/referenced links and understand
   images when available.
4. Route to exactly one primary action.
5. Deliver the response: card/image/audio/post mention/text/voice.

The safest rule is: commands and concrete feature nouns win; vague pronouns
like "this/that/above" should use the referenced context, not web search.

## Primary Route Priority

| Priority | Route | User intent | Output | Notes |
| --- | --- | --- | --- | --- |
| 1 | Project workflow | `/project`, `新建项目`, `创建项目`, `开始项目`, `项目brief`, `brief` | Text progress + Feishu docs | High blast radius, keep explicit only. |
| 2 | Selfie image | `拍一张你自拍`, `给我看看你的照片`, asks for Xiaoye/self photo | Image | Runs before generic image generation because it has a fixed character identity. |
| 3 | Song playback | `/song`, `/music`, `唱一首`, `点歌`, `放歌`, `听一首` | Audio message | If no song is named, use the default/random G.E.M. query path. |
| 4 | Generic image generation | `/draw`, `/image`, `/imagine`, `生图`, `画图`, `生成图片`, `设计海报` | Image | Explicit creation wins over inferred search, so `生成世界杯赛程海报` does not become a World Cup card. Meta questions about image APIs/models should remain normal chat. |
| 5 | Web search card | `/search`, `/web`, `/news`, `/weather`, explicit `搜/查/联网`, weather, price, World Cup, GitHub trending | Feishu card | Must not trigger from "看看这个/总结一下" when referenced content exists, and must not steal explicit creation requests. |
| 6 | Smart group reply gate | Non-mentioned group messages in smart mode | Maybe normal reply | Uses fast heuristics, then AI classifier if enabled. |
| 7 | Normal AI reply | Chat, link summary, image understanding, style changes, explanation | Voice by default, text if requested | Link/image context is injected into the AI prompt. |

## Cross-Cutting Delivery Priority

Delivery is separate from intent routing:

| Delivery case | Output |
| --- | --- |
| Outgoing @ mention target is resolvable | Rich text post with mention nodes; no TTS. |
| User explicitly asks for text or "不要语音/省点 TTS" | Text bubbles. |
| Link/document/reference summary with readable context | Text bubbles by default, because dense summaries are easier to read than voice. |
| User explicitly asks for voice | Voice/audio if TTS works. |
| Default normal AI reply | Voice reply first, fallback to text. |
| Card/song/image/project routes | Their route-specific output; do not TTS the card/song/image result. |

## Conflict Rules

### Referenced content vs web search

Use link reading when the user points at context:

- `看看这个，总结一下`
- `看下这篇文档`
- `把上面这条整理一下`
- `这份资料提炼重点`

Use web search when the user asks for outside/current info:

- `搜一下 今天黄金价格`
- `查下明天天气`
- `今天 GitHub 热榜前三`
- `/search 世界杯赛程`

Do not treat bare `看看` as web search. It is only web search when paired with a
hard outside-info noun such as price, weather, GitHub trending, World Cup, or
an explicit search verb.

When a message is quoted/replied to, include the visible referenced message text
before fetched URL/document content. The quoted text is usually what the user
means by "this"; links inside that quoted message are supporting material, not a
replacement for the visible text.

### Image creation vs web search cards

If the user explicitly asks to create a visual, image generation wins:

- `帮我生成一张世界杯赛程海报`
- `做一张今天黄金价格走势图`
- `画一个天气预报信息图`

If the user asks to find current facts, web search wins:

- `查一下世界杯赛程`
- `今天黄金价格多少`
- `上海明天天气`

### Song vs normal chat

`唱一首` and `唱首歌` are song requests. Questions about lyrics, singers, or
music recommendations are normal chat unless they also say play/sing/listen.

### Selfie vs image generation

Selfie requests about "你/小椰/你的照片" route to the Xiaoye selfie prompt.
Generic `生成一张图片/做个海报` routes to generic image generation.

### @ mention vs voice

If the bot needs to @ someone, it must send a rich-text post. Feishu cannot put
an actual mention inside a voice bubble, so mention delivery overrides TTS.

### Image message vs image generation

An incoming image with `看看/总结/识别` is image understanding. It is not image
generation unless the user explicitly asks to create/draw/generate a new image.

## Regression Coverage

Run:

```powershell
npm run check:routes
```

The route checks cover the known fragile boundaries:

- reference summary stays normal AI/link reading
- price/weather/GitHub/World Cup still become web cards
- song, selfie, project, and generic image routes remain distinct
- text/voice delivery preference remains independent from primary routing
