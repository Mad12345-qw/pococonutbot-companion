# Pococonut Companion

> A Feishu-first personal research agent for turning videos, documents, conversations, and public sources into reader-grade knowledge documents and long-term industry-chain research assets.

Pococonut Companion is a long-running multi-channel Agent system for Chinese knowledge work. It connects Telegram, Feishu, YouTube transcript research, WeChat Official Account draft publishing, memory management, and a multi-source investment-research knowledge base into one workflow.

It is not a simple chat bot and not a one-off YouTube summarizer. The core goal is to help an individual researcher continuously turn messy public information into:

- polished Feishu documents that are readable by humans
- structured evidence cards that are reusable by machines
- topic/entity/time-context graphs for later retrieval
- versioned industry-chain research reports with traceable evidence

## Current Status

- Deployed as a Render Web Service.
- Uses Node.js 20+, Express, Postgres or local JSON storage.
- Supports OpenAI-compatible chat APIs, image generation APIs, STT/TTS, Feishu Open Platform, Telegram Bot API, TranscriptAPI-compatible YouTube transcript extraction, and WeChat Official Account draft creation.
- Formal YouTube research documents and investment reports are generated through structured JSON slots and program rendering, not freeform Markdown.
- Formal document paths can be configured to use the primary model only. If the primary model fails, the system should fail clearly instead of publishing degraded fallback content.

## What It Does

### 1. Multi-Channel Agent

- Telegram private chat and group chat.
- Feishu bot message handling.
- Admin panel at `/admin`.
- Health endpoint at `/health`.
- Long-term memory, recent context, summaries, and optional GitHub backup.

### 2. Feishu Knowledge Document Generation

For YouTube links, the system can:

1. fetch transcript and metadata
2. extract evidence and article intent
3. generate bounded structured content fields
4. render a polished Feishu document
5. add source metadata, timeline navigation, transcript excerpts, and group entry cards
6. write reusable research assets into the knowledge base

The document structure is reader-first:

- key terms before dense technical discussion
- background interpretation before conclusions
- concrete article thesis instead of raw video titles
- core judgments, evidence, technical breakdown, timeline, follow-up questions, and source index
- no process prefaces, internal metadata dumps, placeholders, raw HTML, or low-value labels such as `YouTube 技术笔记`

### 3. Investment Research Knowledge Base

The research layer normalizes every useful source into a shared structure:

```text
source
-> evidence_cards
-> entities
-> time_context
-> research_questions
-> coverage_gaps
-> topic graph links
```

Supported source types are intentionally open-ended:

- videos, interviews, podcasts
- sell-side reports, consulting reports, filings, earnings calls
- papers, patents, official docs, datasets
- webpages, news, conference materials, job postings
- manual notes and future source adapters

Time context is treated as first-class data. A stale video, a newly published paper, and an old company filing should not be mixed into one conclusion without calibration.

### 4. Investment Report Workflow

Investment reports require a strict trigger:

```text
投研报告：主题
```

Examples:

```text
投研报告：AI 光模块 / CPO / 数据中心网络
投研报告：商业航天 / 星舰 / 中国供应链替代
投研报告：航天燃料
投研报告：液氧甲烷
```

The system should not turn one video into a formal investment conclusion. A report is generated only after retrieving and calibrating a broader evidence pack.

The report structure is controlled by code:

1. 报告结论
2. 主题边界与产业链地图
3. 证据基础与时间校准
4. 产业链假设
5. 关键环节与跟踪指标
6. 反证、时间错位与风险
7. 迭代变化与下一轮调研任务
8. 资料来源与证据索引

Previous reports are treated as prior thesis baselines, not as new evidence. New reports should compare against the prior baseline and explain which judgments strengthened, weakened, or changed.

### 5. WeChat Official Account Drafts

The WeChat publisher adapts finished Feishu articles into WeChat-compatible HTML drafts instead of regenerating the article from scratch.

It supports:

- official draft API payloads
- cover image handling through `thumb_media_id`
- article-specific visual styling
- public-account friendly section layout
- source-link reduction to lower public-platform risk

Draft creation is not the same as mass sending. Final publication should still be reviewed in WeChat.

## Architecture

```text
Telegram / Feishu / Admin
        |
        v
Message Router
        |
        +--> Chat Agent
        +--> Image / Voice / Search Tools
        +--> YouTube Research Pipeline
        +--> WeChat Draft Publisher
        +--> Investment Report Pipeline
        |
        v
Storage Layer
        |
        +--> chat_messages / memories / summaries
        +--> research_jobs
        +--> research_sources
        +--> research_evidence_cards
        +--> research_entities
        +--> research_time_contexts
        +--> research_topics / research_topic_edges
        +--> research_report_versions / research_thesis_ledger
```

### YouTube Research Pipeline

```text
YouTube link
-> transcript extraction
-> deterministic evidence anchors
-> primary-model evidence planning
-> structured article slots
-> program-rendered Feishu document
-> research source bundle
-> topic graph linking
```

Recent stability principle:

- Time-index extraction is deterministic and program-driven.
- The model handles thesis, interpretation, evidence meaning, and prose.
- Long videos are split into bounded JSON tasks instead of one giant freeform prompt.
- Per-part timing is logged so timeout planning can be based on real p95/p99 data, not guessing.

### Investment Report Pipeline

```text
投研报告：主题
-> strict trigger check
-> topic graph expansion
-> evidence retrieval
-> prior report baseline
-> time-context calibration
-> industry-chain hypothesis
-> counter-evidence and gap analysis
-> next research tasks
-> Feishu report folder
-> report version + thesis ledger
```

## Design Principles

- **Reader-first output**: the user sees a finished article or report, not model logs.
- **Evidence before opinion**: claims need source, quote/location, and time context.
- **Direction before generation**: prompts constrain the correct output shape before prose is produced.
- **Program rendering**: code owns headings, order, metadata placement, source sections, indentation, and evidence anchors.
- **No degraded formal output**: for formal documents, a clear failure is better than publishing a low-quality fallback.
- **Open source types**: new sources should be adapter work, not database redesign.
- **Graph-first knowledge**: topics, aliases, edges, entities, and evidence links matter more than folders.
- **Time-aware research**: old context, current context, and event time must be separated.
- **Iterative research**: prior reports are judgment baselines, not factual evidence.

## Tech Stack

- Runtime: Node.js 20+
- Server: Express
- Storage: Postgres or local JSON
- Messaging: Telegram Bot API, Feishu Open Platform
- Documents: Feishu wiki/doc APIs
- AI: OpenAI-compatible Chat Completions API
- Transcripts: TranscriptAPI-compatible YouTube transcript adapter
- Media: STT, TTS, image understanding, image generation
- Publishing: WeChat Official Account draft API
- Deployment: Render
- Optional sync: GitHub memory backup, Obsidian/GitHub note sync

## Repository Map

```text
src/
  index.js                    Express app, health check, bootstrap
  feishu.js                   Feishu bot, YouTube research, investment reports
  telegram.js                 Telegram bot integration
  storage.js                  Postgres / JSON storage and research schema
  ai-client.js                OpenAI-compatible model client
  transcript-api-client.js    YouTube transcript adapter
  feishu-workspace.js         Feishu document/wiki APIs
  wechat-publisher.js         WeChat Official Account draft generation
  admin.js                    Admin UI routes

scripts/
  check-feishu-routing.mjs    Routing and document-generation regression tests
  check-research-kb.mjs       Research knowledge base checks
  sanitize-research-kb-artifacts.mjs

docs / root docs
  RESEARCH_KNOWLEDGE_ARCHITECTURE.md
  RENDER_SETUP.md
  FEISHU_SETUP.md
  FEISHU_CONTEXT_ROUTING.md
  OBSIDIAN_YOUTUBE_SETUP.md
```

## Quick Start

```powershell
npm install
copy .env.example .env
npm run check
npm start
```

Admin:

```text
http://127.0.0.1:3000/admin
```

Health check:

```text
http://127.0.0.1:3000/health
```

## Core Configuration

Minimum local configuration depends on which capability you want to run.

### Chat

```env
AI_API_KEY=
AI_URL=
AI_MODEL=gpt-5.5
AI_COMPATIBILITY=openai
```

### Feishu

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
```

### YouTube Research

```env
TRANSCRIPT_API_ENABLED=true
TRANSCRIPT_API_KEY=
YOUTUBE_RESEARCH_AI_TIMEOUT_MS=180000
```

### Investment Reports

```env
FEISHU_INVESTMENT_REPORT_PARENT_WIKI_TOKEN=
INVESTMENT_REPORT_AI_TIMEOUT_MS=90000
```

### WeChat Drafts

```env
WECHAT_MP_ENABLED=true
WECHAT_MP_APP_ID=
WECHAT_MP_APP_SECRET=
WECHAT_MP_DEFAULT_THUMB_MEDIA_ID=
```

### Storage

```env
DATABASE_URL=
DB_SSL=false
```

Do not commit real secrets. `.env` and `.env.*` are ignored; `.env.example` should contain placeholders only.

## Testing

```powershell
npm run check
node scripts\check-research-kb.mjs
git diff --check
```

The regression suite checks:

- Feishu and Telegram routing behavior
- strict `投研报告：` trigger handling
- YouTube article structure and low-value artifact prevention
- primary-model-only formal generation paths
- research source, evidence card, entity, topic graph, and report-version behavior
- Feishu evidence anchors
- WeChat draft formatting and source adaptation

## Deployment

Render deployment notes are in [RENDER_SETUP.md](RENDER_SETUP.md).

Recommended production setup:

- one Render Web Service
- Postgres database
- Feishu app credentials
- Transcript API credentials
- primary AI provider credentials
- optional image/STT/TTS/WeChat credentials
- GitHub backup for memory if running on ephemeral infrastructure

## Research Boundary

This project is designed for long-term industry-chain research, not short-term trading signals.

It can help track topics such as:

- AI infrastructure, optical modules, CPO, data-center networking
- commercial space, Starship, launch systems, supply-chain localization, propellant routes
- humanoid robots, actuators, reducers, dexterous hands
- AI power, liquid cooling, storage, nuclear power
- other evidence-backed public research themes

It should not output target prices, direct buy/sell instructions, or conclusions unsupported by evidence. Missing data should become coverage gaps and next research tasks.

## Reference Inspiration

This project borrows design ideas from, but does not copy:

- [Microsoft GraphRAG](https://github.com/microsoft/graphrag): entity and relationship extraction over private corpora
- [OpenBB](https://github.com/OpenBB-finance/OpenBB): multi-source financial research workbench
- [FinRobot](https://github.com/ai4finance-foundation/finrobot): financial analysis agents and report workflows
- [TradingAgents](https://github.com/tauricresearch/tradingagents): multi-role analysis and risk debate
- [Obsidian](https://obsidian.md/): linked personal knowledge graphs

The practical tradeoff here is to serve a Chinese individual researcher first: ingest public materials, preserve traceable evidence, generate readable Feishu documents, and compound long-term research judgment through topic graphs and report versions.

## License

No open-source license has been declared yet. If you plan to share this repository publicly, add a license before encouraging third-party reuse.
