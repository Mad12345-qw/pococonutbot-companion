# Feishu Grok CLI Bridge

这个项目是一个独立的 Render Web Service，用 Grok CLI 接收飞书机器人消息，并把回答用飞书 CardKit JSON 2.0 原生流式卡片返回。

核心链路：

- 飞书事件入口 `/feishu/events` 立即返回 200，后台继续执行 Grok CLI，避免飞书回调超时。
- Grok CLI 使用 `--output-format streaming-json`，服务端解析 `text` 增量事件并忽略 `thought`。
- 飞书回复使用 CardKit 卡片实体：先创建 `schema: "2.0"` 且 `streaming_mode: true` 的卡片，再发送 `card_id`，随后调用流式文本接口更新正文。
- 最终回答完成后关闭 `streaming_mode`，更新聊天列表摘要，并把 Grok 输出里的来源链接追加成飞书按钮。
- 不使用 xAI API；Render 上只复用 Grok CLI 授权。

## 为什么之前会卡在“正在检索”

之前的实现只是发送一张普通 interactive card，再反复 `PATCH /im/v1/messages/{message_id}`。这不是飞书官方的流式卡片协议，联网搜索时间一长，用户看到的就像停在“正在检索”。

现在的修复方式是：

- Grok CLI 默认不再带 `--max-turns 1`，也不再默认加 `--no-plan`。
- Grok CLI 固定带 `--always-approve`，让联网搜索等工具调用在 headless 机器人环境中自动批准。
- Grok CLI 固定带 `--permission-mode bypassPermissions`，避免 headless 工具执行停在权限交互层。
- Grok CLI 固定带 `--no-auto-update`，避免后台更新检查干扰脚本输出。
- Grok CLI 输出固定为 `streaming-json`，服务端只把 `text` 事件作为正文增量。
- Feishu 使用 CardKit 原生流式接口 `/cardkit/v1/cards/{card_id}/elements/{element_id}/content`，按递增 `sequence` 推送全量正文，飞书客户端负责打字机效果。
- 搜索或工具事件只显示成状态，不展示模型内部推理。

## Render 环境变量

必填：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=***
GROK_AUTH_JSON_B64=***
```

可选：

```env
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
GROK_DEPLOYMENT_KEY=
DEBUG_TOKEN=
GROK_CLI_TIMEOUT_MS=540000
MAX_CARD_CONTENT_CHARS=90000
```

`rnd_...` 是 Render API key，只能管理 Render，不能调用 Grok。Render 上的 Grok CLI 通过 `GROK_AUTH_JSON_B64` 还原 `$HOME/.grok/auth.json`。

## 飞书权限

机器人应用需要这些能力或权限：

- 机器人能力
- `im:message` 或 `im:message:send_as_bot`
- `cardkit:card:write`
- 事件订阅 `im.message.receive_v1`

飞书事件 URL：

```text
https://feishu-grok-bridge.onrender.com/feishu/events
```

## Cron Job 保温

如果使用 Render Free Web Service，可以用 `cron-job.org` 每 5 分钟请求：

```text
https://feishu-grok-bridge.onrender.com/health
```

Cron Job 只能保温，飞书事件 URL 仍然必须配置为 `/feishu/events`。

## Debug

不往飞书群发测试消息的服务端自检：

```powershell
$debugToken = (Get-Content -LiteralPath 'E:\POKEimessage\GROK\.debug-token.local' -Raw).Trim()
Invoke-RestMethod -Method Get -Uri 'https://feishu-grok-bridge.onrender.com/debug/cardkit-test' -Headers @{ 'x-debug-token' = $debugToken }
```

Grok CLI 联网测试：

```powershell
$debugToken = (Get-Content -LiteralPath 'E:\POKEimessage\GROK\.debug-token.local' -Raw).Trim()
$prompt = [uri]::EscapeDataString('请联网搜索并用中文回答：今天OpenAI有什么最新官方新闻？给出日期和来源链接。')
Invoke-RestMethod -Method Get -Uri "https://feishu-grok-bridge.onrender.com/debug/grok-test?prompt=$prompt" -Headers @{ 'x-debug-token' = $debugToken } -TimeoutSec 360
```

## 本地检查

```powershell
npm install
npm run check
```
