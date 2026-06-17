# Feishu Setup

This project can run Telegram and Feishu in the same Render service.

## Render Variables

Set these in Render:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your_app_secret
FEISHU_BOT_NAME=小椰
```

Optional:

```env
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
FEISHU_MENTION_TARGETS_JSON={"珠珠":"ou_xxx"}
FEISHU_PROJECT_FOLDER_TOKEN=
FEISHU_DOC_BASE_URL=https://www.feishu.cn
LINK_READING_ENABLED=true
LINK_READING_MAX_CHARS=12000
```

Leave `FEISHU_ENCRYPT_KEY` empty unless you enable encrypted event pushes in Feishu.

## Feishu Event URL

In Feishu Open Platform, set the event subscription request URL to:

```text
https://your-render-service.onrender.com/feishu/events
```

For the current Render service:

```text
https://pococonutbot-minimax-companion.onrender.com/feishu/events
```

## Event Permissions

Enable message receive events, especially:

```text
im.message.receive_v1
```

The bot currently supports:

- Private text messages
- Group messages that mention the bot or start with a clear command
- Text replies
- Rich-text mention replies for requests such as "艾特一下珠珠"
- Link/document reading for public web pages and Feishu `/docx/` links
- Image generation replies for prompts such as "生成一张海报"
- Shared AI/persona/memory stack with Telegram, isolated by `feishu:` id prefixes

## Link And Document Reading

When a user sends a URL, or replies to a message that contains a URL and asks the bot to read it, the bot tries to add the linked content to the AI context. Feishu `/docx/` links are read through the Feishu document API; normal public web pages are fetched as text.

Recommended Feishu Open Platform permissions:

```text
im:message
docx:document
```

The app must also have permission to the target document. For private docs, share the document with the bot app or put it in a folder the app can access.

## Mention Targets

Feishu @ mentions need an actual user or bot id. If the incoming user already @ mentioned the target, the bot reuses that id. If the user only types a name, configure a name-to-id map in Render:

```env
FEISHU_MENTION_TARGETS_JSON={"珠珠":"ou_xxx","珠珠-SPM":{"open_id":"ou_xxx","name":"珠珠-SPM"}}
```

Bot accounts can be configured the same way if Feishu exposes their open_id in the group. Whether the mentioned bot replies depends on that bot's own event and anti-loop settings.

## Project Workflow Permissions

Phase 1 creates Feishu docs and spreadsheets. In Feishu Open Platform, add and publish these permissions:

```text
docx:document:create
docx:document
sheets:spreadsheet:create
sheets:spreadsheet
drive:drive
```

Project workflow triggers when a Feishu message starts with `新建项目`, `创建项目`, `brief`, or `/project`.

If you want artifacts to land in a fixed folder, create a Feishu Drive folder such as `AI方案工厂`, copy its folder token from the URL, and set:

```env
FEISHU_PROJECT_FOLDER_TOKEN=fld_xxx
```

When using `tenant_access_token`, Feishu may also require you to add the app to the target folder or document permissions from the Feishu document UI.

## Data Isolation

Feishu chats and users are stored with prefixed ids:

```text
chat_id = feishu:<feishu_chat_id>
user_id = feishu:<feishu_open_id>
```

This keeps Feishu memory separate from Telegram memory while using the same Postgres database.
