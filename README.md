# Telegram AI Companion Bot

这是一个可以部署到 Render 的 Telegram AI 伴侣/群聊机器人。

核心能力：

- 文字聊天：支持 OpenAI-compatible Chat Completions 接口
- 图片理解：Telegram 图片会转成 base64 `image_url`
- 语音理解：Telegram 语音会先用独立 STT/Whisper 转文字，再交给主模型回复
- 生图：`/draw`、`/image`、`/imagine`、`画图`、`生图`、`生成图片`
- 小椰自拍：内置一张固定参考照和外貌设定，可直接说“小椰发张自拍”
- 群聊自动回复：`TRIGGER_MODE=smart`
- 分用户长期记忆：公共记忆 + 每个 Telegram 用户的个人记忆
- 长期记忆：Postgres 或本地 JSON
- GitHub 记忆备份：可定时提交到私有仓库的 `memory-backups` 分支
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

`smart` 会记录普通群消息作为上下文，然后让 AI 服务判断是否该插话。不要轻易用 `all`，它会每句话都回。
