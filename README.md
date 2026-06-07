# Telegram MiniMax Companion Bot

这是一个可以部署到 Render 的 Telegram AI 伴侣/群聊机器人。

核心能力：

- 文字聊天：MiniMax-M3
- 图片理解：Telegram 图片会转成 base64 `image_url`
- 群聊自动回复：`TRIGGER_MODE=smart`
- 长期记忆：Postgres 或本地 JSON
- 网页后台：`/admin` 查看和修改记忆、摘要、人格
- 健康检查：`/health`

部署和设置看：

```text
RENDER_SETUP.md
```

本地测试：

```powershell
npm install
copy .env.example .env
.\scripts\start-local.ps1
```

打开后台：

```text
http://127.0.0.1:3000/admin
```

上线 Render 前先停本地：

```powershell
.\scripts\stop-local.ps1
```

让机器人不用 @ 也能看群消息并自动回复：

1. 在 BotFather 里把 `Group Privacy` 关掉。
2. 在 Render 环境变量里设置 `TRIGGER_MODE=smart`。

`smart` 会记录普通群消息作为上下文，然后让 MiniMax 判断是否该插话。不要轻易用 `all`，它会每句话都回。
