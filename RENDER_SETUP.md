# Render Setup

This project runs as one Render Web Service:

- Telegram bot polling
- Health endpoint at `/health`
- Memory/persona admin panel at `/admin`
- Render Postgres for persistent memory

Use a paid Render instance for 24/7 behavior. Free web services can spin down, which is not a good fit for a Telegram polling bot.

## 1. BotFather

For normal testing:

```text
Allow Groups: On
Group Privacy: On
```

For automatic group replies without @mention:

```text
Group Privacy: Off
```

Then set:

```env
TRIGGER_MODE=smart
```

`smart` mode records normal group messages as context and asks the AI service whether the bot should reply. It is safer than `all`, which replies to every message.

## 2. Local Test

Create `.env`:

```powershell
copy .env.example .env
```

Fill:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
AI_API_KEY=your_ai_api_key
AI_URL=https://api.minimaxi.com/v1/chat/completions
AI_MODEL=MiniMax-M3
AI_COMPATIBILITY=minimax
IMAGE_GENERATION_ENABLED=true
IMAGE_API_URL=http://your-image-api.example
IMAGE_API_KEY=your_image_api_key
IMAGE_MODEL=gpt-image-2
BOT_DISPLAY_NAME=小椰
COMPANION_MODE=girlfriend
TRIGGER_MODE=smart
ADMIN_USERNAME=admin
ADMIN_PASSWORD=local-test-password
```

Run:

```powershell
.\scripts\start-local.ps1
```

Open:

```text
http://127.0.0.1:3000/admin
```

Stop before cloud production:

```powershell
.\scripts\stop-local.ps1
```

Only run one copy at a time. If local and Render both poll Telegram, updates can conflict.

## 3. Deploy To Render

1. Push this folder to GitHub.
2. In Render, create a new Blueprint from the repo, or create a Web Service manually.
3. If using the included `render.yaml`, Render will create one Web Service.
4. Add secret environment variables in Render:

```env
TELEGRAM_BOT_TOKEN=your_new_telegram_bot_token
AI_API_KEY=your_new_ai_api_key
ADMIN_PASSWORD=a_strong_admin_password
IMAGE_API_URL=your_image_api_base_url
IMAGE_API_KEY=your_image_api_key
```

For a free persistent database, create a free Neon or Supabase Postgres database and paste its connection string into `DATABASE_URL`.

Use `DB_SSL=true` for SSL-required external Postgres URLs such as Neon. Use `DB_SSL=false` only when the provider's connection string already handles SSL or when SSL is not required.

## 4. Recommended Render Variables

```env
AI_URL=https://api.minimaxi.com/v1/chat/completions
AI_MODEL=MiniMax-M3
AI_COMPATIBILITY=minimax
IMAGE_GENERATION_ENABLED=true
IMAGE_MODEL=gpt-image-2
IMAGE_SIZE=1024x1024
BOT_DISPLAY_NAME=小椰
COMPANION_MODE=girlfriend
TRIGGER_MODE=smart
AUTO_MEMORY=true
RECENT_MESSAGE_LIMIT=24
MEMORY_LIMIT=24
ADMIN_USERNAME=admin
```

Use `TRIGGER_MODE=mention` if you want the bot to reply only when mentioned.

Image generation uses `IMAGE_API_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL`, and `IMAGE_SIZE`. The bot triggers it from commands like `/draw prompt`, `/image prompt`, `/imagine prompt`, or Chinese requests such as `画图 一只猫` and `生成图片 赛博朋克城市`.

## 5. Admin Panel

Open:

```text
https://your-render-service.onrender.com/admin
```

You can:

- view chats
- view recent messages
- view/edit/add/delete long-term memories
- filter memories by all users, shared chat memory, or a specific Telegram user
- edit the shared chat summary or a specific user's summary
- switch persona for a specific chat or a specific Telegram user

The persona switch writes `relationship.persona` into the selected memory scope. It takes effect immediately for future replies.

## 6. GitHub Memory Backup

To protect memory on Render Free, back it up to a private GitHub repo branch:

```env
GITHUB_BACKUP_TOKEN=github_token_with_repo_write_access
GITHUB_BACKUP_REPO=owner/private-memory-repo
GITHUB_BACKUP_BRANCH=memory-backups
GITHUB_BACKUP_PATH=backups/render-memory.json
GITHUB_BACKUP_INTERVAL_MINUTES=30
RESTORE_MEMORY_FROM_GITHUB=true
```

Do not use `master` as the backup branch. If the bot commits backups to the deployment branch, every backup can trigger a Render redeploy loop.
