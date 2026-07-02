# Pococonut Companion

Pococonut Companion 是一个面向 Telegram 与飞书的长期运行 Agent 助手。它不是单一聊天机器人，也不是一次性视频总结脚本，而是一套把对话、内容生成、飞书文档、YouTube 深度整理、跨来源研究知识库和长期产业链投研工作流放在同一条轨道上的个人智能助理系统。

当前主定义：

> 一个可部署到 Render 的多通道 Agent 助手，核心面向中文用户，支持日常对话、语音/图片/生图、飞书知识生产、YouTube 研究文档生成，以及基于证据图谱的长期产业链投研分析。

## 核心能力

### 多通道 Agent 助手

- Telegram 私聊与群聊：支持普通聊天、智能插话、群聊上下文记忆。
- 飞书机器人：支持消息回复、飞书云文档生成、飞书知识库/文档库写入。
- 网页后台：通过 `/admin` 管理记忆、摘要、人格和运行状态。
- 健康检查：通过 `/health` 查看当前能力开关、配置状态和架构版本。

### 多模态交互

- 文字对话：兼容 OpenAI-style Chat Completions API。
- 图片理解：Telegram 图片会转换为 `image_url` 输入给视觉模型。
- 语音理解：语音先经 STT/Whisper 转写，再进入主模型。
- 语音回复：支持 Telegram 与飞书不同声音配置。
- 生图：支持 `/draw`、`/image`、`/imagine`、`画图`、`生图`、`生成图片` 等触发方式。
- 角色化自拍：内置小椰形象与参考照，可生成角色化图片回复。

### 记忆与上下文

- 分用户长期记忆：公共记忆与个人记忆分层保存。
- 对话摘要：长对话会沉淀摘要，避免上下文无限膨胀。
- 存储后端：支持 Postgres，也支持本地 JSON 文件作为轻量开发模式。
- GitHub 备份：可将记忆定时备份到私有仓库分支。

### 飞书文档生产

- YouTube 链接自动提取字幕并生成中文深度文档。
- 文档采用“先证据抽取、再文章立意、再结构化内容、最后程序渲染”的流程。
- 支持关键术语、背景导读、核心结论、技术拆解、时间线、原文摘录、继续追问和出处索引。
- 生成前先约束证据边界、读者目标和结构化字段，质量闸门只作为最后保险，阻止过程话、占位符、重复元数据、`YouTube 技术笔记`、裸 HTML 等内容进入成品文档。

### 长期投研知识库

- 任意信息源都归一成 `source + evidence_cards + entities + time_context + questions + coverage_gaps`。
- 支持视频、访谈、播客、研报、财报、公告、论文、专利、网页、新闻、数据集、招聘信息、会议资料、人工笔记等开放 source type。
- 证据卡保留原文、位置、含义、时间敏感性、置信度和复核触发条件。
- 时间维度是一等数据：发布时间、拍摄/记录时间、事件期、分析时间、过期条件都会进入结构化层。

### 产业链投研报告

投研报告需要严格触发：

```text
投研报告：主题
```

示例：

```text
投研报告：AI 光模块 / CPO / 数据中心网络
投研报告：商业航天 / 星舰 / 中国供应链替代
投研报告：航天燃料
投研报告：液氧甲烷
```

系统不会因为普通聊天、单个 YouTube 链接或随口提到“投研报告”就自动生成正式报告。正式报告必须满足跨来源证据要求，避免把单一视频包装成投资结论。

投研报告固定结构：

1. 报告结论
2. 主题边界与产业链地图
3. 证据基础与时间校准
4. 产业链假设
5. 关键环节与跟踪指标
6. 反证、时间错位与风险
7. 迭代变化与下一轮调研任务
8. 资料来源与证据索引

## 架构概览

```text
Telegram / Feishu / Admin
        |
        v
Message Router
        |
        +--> Chat Agent
        +--> Image / Voice / Search Tools
        +--> YouTube Research Pipeline
        +--> Investment Report Pipeline
        |
        v
Storage Layer
        |
        +--> chat_messages / memories / summaries
        +--> research_sources
        +--> research_evidence_cards
        +--> research_entities
        +--> research_time_contexts
        +--> research_topics / research_topic_edges
        +--> research_report_versions / research_thesis_ledger
```

### YouTube 研究文档链路

```text
YouTube link
-> transcript extraction
-> evidence brief
-> article intent
-> structured slots
-> reader-grade Markdown
-> Feishu document
-> research source bundle
-> topic graph linking
```

### 投研报告链路

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

## 设计原则

- 文章优先：读者看到的是成品文档，不是模型过程日志。
- 证据优先：观点必须回到原文、来源、时间和位置。
- 正向引导：生成前就约束模型产出正确内容，不把系统设计成“先生成垃圾、再打回重试”。
- 程序渲染：标题、章节、加粗、缩进、出处和证据索引由代码控制。
- 开放信息源：后续接报告、财报、论文、专利、网页、数据集不需要重做底层架构。
- 图谱优先：知识库不是简单文件夹，而是类似 Obsidian 的主题节点、别名、边和证据链接。
- 时间优先：旧视频、旧报告和当前产业环境必须区分，否则投研结论会错位。
- 迭代优先：上一版报告只作为观点基线，不作为事实证据；新版报告要说明判断增强、削弱或变化。

## 技术栈

- Runtime：Node.js 20+
- Web Server：Express
- Database：Postgres 或本地 JSON
- Messaging：Telegram Bot API、飞书开放平台
- AI：OpenAI-compatible Chat Completions API
- Media：STT、TTS、图片理解、生图接口
- Deployment：Render
- Optional Sync：GitHub memory backup、Obsidian/GitHub sync

## 主要目录

```text
src/
  index.js                    # Express app, health check, route bootstrap
  feishu.js                   # Feishu bot, YouTube research, investment report flow
  telegram.js                 # Telegram bot integration
  storage.js                  # Postgres / JSON storage and research schema
  ai-client.js                # OpenAI-compatible model client
  transcript-api-client.js    # YouTube transcript adapter
  feishu-workspace.js         # Feishu document/wiki APIs
  admin.js                    # Admin UI routes

scripts/
  check-feishu-routing.mjs    # Message routing regression checks
  check-research-kb.mjs       # Research knowledge base regression checks

RESEARCH_KNOWLEDGE_ARCHITECTURE.md
  # Multi-source research and investment knowledge architecture
```

## 本地运行

```powershell
npm install
copy .env.example .env
npm run check
npm start
```

打开后台：

```text
http://127.0.0.1:3000/admin
```

健康检查：

```text
http://127.0.0.1:3000/health
```

## Render 部署

部署说明见：

```text
RENDER_SETUP.md
FEISHU_SETUP.md
FEISHU_CONTEXT_ROUTING.md
OBSIDIAN_YOUTUBE_SETUP.md
```

关键配置包括：

- `DATABASE_URL`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_INVESTMENT_REPORT_PARENT_WIKI_TOKEN`
- `TRANSCRIPT_API_KEY`
- `AI_API_KEY`
- `AI_URL`
- `AI_MODEL`

## 测试与质量闸门

```powershell
npm run check
node scripts\check-research-kb.mjs
git diff --check
```

检查覆盖：

- 飞书/Telegram 路由不会误触发。
- 严格 `投研报告：` 前缀才会进入投研报告流。
- YouTube 文档不会出现低质量过程文本、重复标题、模板废话或裸 HTML。
- 研究知识库可写入开放信息源、证据卡、实体、时间上下文和覆盖缺口。
- 主题图谱可按别名检索证据。
- 投研报告可记录 v1/v2 版本，并读取上一版作为观点基线。

## 投资研究边界

本项目面向长期产业链研究，不输出短线交易信号、目标价或直接买卖建议。它适合帮助个人研究者持续追踪：

- AI 基础设施、光模块、CPO、数据中心网络
- 商业航天、星舰、中国供应链替代、航天燃料路线
- 人形机器人、执行器、减速器、灵巧手
- AI 电力、液冷、储能、核电
- 其他由公开资料、专家访谈、论文、公告和数据集支撑的长期产业主题

当资料不足时，系统应生成 coverage gaps 和下一轮调研任务，而不是编造确定结论。

## 架构参考

本项目吸收了以下系统的设计思想，但不是它们的复制品：

- [Microsoft GraphRAG](https://github.com/microsoft/graphrag)：从非结构化文本中抽取实体、关系和社区摘要，用图谱增强私有语料推理。
- [OpenBB](https://github.com/OpenBB-finance/OpenBB)：多源金融数据接入和研究工作台思路。
- [FinRobot](https://github.com/ai4finance-foundation/finrobot)：金融分析 Agent 与研究报告工作流。
- [TradingAgents](https://github.com/tauricresearch/tradingagents)：多角色分析、辩论和风险审议框架。
- [Obsidian](https://obsidian.md/)：双链、主题网络和个人知识图谱的组织方式。

本仓库的取舍是：优先服务中文个人研究者的实际工作流，把公开资料、视频、报告、论文和后续调研任务沉淀成可追溯证据图谱，再生成读者友好的飞书文档和长期可迭代的产业链研究报告。
