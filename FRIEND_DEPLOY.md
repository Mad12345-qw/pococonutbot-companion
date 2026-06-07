# Friend Deploy Guide

This repo can be reused as a Telegram AI companion bot template.

## Recommended Sharing Method

Best option:

1. Share this repo with your friend as a private GitHub collaborator.
2. Ask them to fork or duplicate the repo into their own GitHub account.
3. They deploy their own copy on Render.
4. They must use their own environment variables and secrets.

Do not share your Render service, Telegram bot token, database URL, API keys, or GitHub backup token.

## What Your Friend Needs

- A Telegram bot token from BotFather.
- A Render account.
- A Postgres database URL, such as Neon or Supabase.
- A primary chat model endpoint and key.
- A fallback MiniMax key if they want fallback chat.
- A Groq key if they want Telegram voice transcription.
- An image generation endpoint and key if they want image generation.

## Render Environment Variables

Required:

```env
TELEGRAM_BOT_TOKEN=
AI_URL=
AI_API_KEY=
AI_MODEL=gpt-5.5
AI_COMPATIBILITY=openai
DATABASE_URL=
DB_SSL=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
```

Recommended:

```env
TRIGGER_MODE=smart
SMART_CLASSIFIER_ENABLED=false
AUTO_MEMORY=true
RECENT_MESSAGE_LIMIT=12
MEMORY_LIMIT=24
```

Fallback chat:

```env
FALLBACK_AI_URL=https://api.minimaxi.com/v1/chat/completions
FALLBACK_AI_API_KEY=
FALLBACK_AI_MODEL=MiniMax-M3
FALLBACK_AI_COMPATIBILITY=minimax
```

Voice transcription:

```env
STT_ENABLED=true
STT_API_URL=https://api.groq.com/openai/v1/audio/transcriptions
STT_API_KEY=
STT_MODEL=whisper-large-v3-turbo
STT_LANGUAGE=zh
VOICE_DIRECT_INPUT_ENABLED=false
```

Image generation:

```env
IMAGE_GENERATION_ENABLED=true
IMAGE_API_URL=
IMAGE_API_KEY=
IMAGE_MODEL=gpt-image-2
IMAGE_SIZE=1024x1024
```

## Customize The Bot

Basic persona:

```env
BOT_DISPLAY_NAME=小椰
COMPANION_MODE=girlfriend
BOT_LANGUAGE=zh-CN
```

Supported `COMPANION_MODE` values:

```text
girlfriend
boyfriend
friend
assistant
```

Custom appearance for generated selfies:

```env
SELF_REFERENCE_IMAGE_PATH=assets/persona/xiaoye-reference.jpg
SELF_APPEARANCE_DESCRIPTION=Describe the character's stable face, hair, clothes, and temperament.
SELF_SELFIE_STYLE=Realistic phone selfie, natural light, clean background, no text or watermark.
```

If they want their own character, replace:

```text
assets/persona/xiaoye-reference.jpg
```

Then update `SELF_APPEARANCE_DESCRIPTION`.

## Telegram Group Setup

In BotFather:

```text
Group Privacy: Off
Allow Groups: On
```

In Render:

```env
TRIGGER_MODE=smart
```

Private chats always reply. In groups, `smart` mode lets the bot see messages and decide when to reply.

## Admin Panel

After deployment:

```text
https://their-render-service.onrender.com/admin
```

The admin panel can edit memories, summaries, persona, and the GPT switch.

The `GPT` switch controls the main reply model:

- On: use the primary `AI_URL`.
- Off: use fallback MiniMax directly.

Image generation is separate and is not controlled by this switch.
