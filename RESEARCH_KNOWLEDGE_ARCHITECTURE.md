# Multi-Source Research Knowledge Architecture

## Goal

This system is not a single-video investment report generator. Its long-term role is:

1. Turn every useful source into traceable research evidence.
2. Produce a polished reader-facing document when appropriate.
3. Store machine-readable evidence, entities, time context, questions, and coverage gaps.
4. Let a separate research synthesis layer aggregate many sources before forming investment conclusions.

## Non-Negotiable Principles

- Plan before generation.
- Evidence before opinion.
- Time context is first-class data.
- Markdown is for readers; evidence cards are for machines.
- A single source can create research signals, not final investment conclusions.
- Missing data must create coverage gaps and reduce confidence.
- Do not generate garbage and then reject it; guide extraction and writing correctly from the start.
- Source types are open-ended. New adapters should not require database redesign.
- The reader document is the product surface; Obsidian, Feishu, tables, and vectors are infrastructure.
- Every reusable conclusion must keep a path back to source text, location, and time context.

## Open Source Model

`research_sources.source_type` is an open string, not a fixed enum. Current and future adapters may include:

- video
- interview
- podcast
- report
- filing
- earnings_call
- paper
- patent
- news
- webpage
- company_disclosure
- regulatory_record
- dataset
- job_posting
- conference
- expert_note
- manual_note
- future_unknown_source

Source-specific details belong in `metadata`; shared research fields belong in first-class columns.

## Source Adapter Contract

Every future adapter should normalize source material into the same minimum contract before any article or investment synthesis is written:

- `source`: source type, platform, URL or stable local reference, title, author, organization, publication time, likely recording or event period, language, raw text, raw text hash, reliability, access level, and conflict profile.
- `evidence_cards`: claims grounded in quote, location, why-it-matters, evidence strength, analysis lens, confidence, time sensitivity, and recheck triggers.
- `entities`: companies, products, technologies, policies, people, markets, metrics, and supply-chain nodes.
- `time_context`: what time the source belongs to, which conclusions may be stale, and what should be rechecked before synthesis.
- `research_questions`: next questions that route to other source types.
- `coverage_gaps`: missing data that prevents overclaiming.

This keeps YouTube, reports, filings, papers, patents, datasets, job postings, webpages, expert notes, and future unknown sources on the same research rail without forcing them into the same article template.

## Core Tables

- `research_jobs`: durable job state for long-running ingestion and generation.
- `research_reference_sources`: registry of institutions and source classes used for routing.
- `research_sources`: one normalized source material.
- `research_evidence_cards`: source-grounded claims with quote, location, lens, strength, and time sensitivity.
- `research_entities`: companies, products, people, technologies, markets, policies, metrics, and other reusable objects.
- `research_source_entities`: source-to-entity roles.
- `research_time_contexts`: publication, recording, event period, staleness, and recheck rules.
- `research_questions`: follow-up research tasks produced by each source.
- `research_coverage_gaps`: missing data, why it matters, and substitute signals.
- `research_topics`: Obsidian-like graph nodes for companies, technologies, products, materials, fuels, policies, countries, markets, missions, value-chain nodes, and open-ended themes.
- `research_topic_edges`: graph relationships such as related_to, source_published_by, supplies_to, competes_with, substitutes, depends_on, or future edge types.
- `research_evidence_topics`: many-to-many links from evidence cards to graph topics.
- `research_report_versions`: versioned investment reports by topic key, with prior report baseline, evidence cutoff, source count, evidence count, and topic count.
- `research_thesis_ledger`: reusable thesis records extracted from each report, with evidence IDs, counter-evidence IDs, time horizon, conviction, and status.

## Topic Graph And Iteration

The research system is graph-first, not folder-first.

- A report topic may be a company (`SpaceX`), a technology (`Starship HLS`), a material or route (`liquid oxygen methane`), a supply-chain node (`commercial-space fuel supply`), a country comparison, a policy, or a broad theme.
- The graph stores aliases and adjacent topics, so `投研报告：航天燃料`, `投研报告：液氧甲烷`, and `投研报告：中国商业航天供应链` can retrieve overlapping but not identical evidence packs.
- Previous reports are treated as prior thesis baselines, not as evidence. A new report must compare against the prior baseline, then rely on fresh evidence cards and source time context.
- Time is part of the graph contract: publication time, likely recording time, event period, analysis time, stale risk, and recheck triggers must travel with the evidence.
- The graph is allowed to be incomplete. Missing nodes or weak edges should create coverage gaps and next research tasks rather than invented certainty.

## Reference Source Routing

The system should not use every reference for every question. It should first classify the research question, then select a small relevant source pack.

Reference classes:

- Primary materials: company disclosures, filings, transcripts, official docs, product releases, demos.
- Sell-side research: banks and brokers for valuation, catalysts, market expectations, and risks.
- Consulting research: adoption curves, value pools, commercialization pathways, operating models.
- Industry data: market sizing, installation data, launch data, benchmark data, regulatory records.
- VC and growth investors: early technology routes, startup ecosystems, product-market inflection.
- Academic and technical sources: papers, patents, benchmarks, engineering constraints.
- Public expert media: videos, interviews, podcasts, conference talks.

The system should use a compact source pack for each question, not blindly include every famous institution. For example, a commercial-space supply-chain question may need primary company material, regulatory launch records, capital-market context, technical papers, and competing-country policy signals; an AI infrastructure question may need hyperscaler capex, optical-network suppliers, standards activity, job postings, and customer deployment evidence.

Each reference source should carry:

- `institution_type`
- `source_perspective`
- `institution_role`
- `coverage_industries`
- `analysis_lenses`
- `access_level`
- `reliability_level`
- `conflict_profile`

## Research Flow

```text
Source adapter
-> source normalization
-> deterministic evidence extraction
-> model-assisted evidence refinement
-> reader document rendering
-> research source bundle write
-> topic graph linking
-> retrieval and cross-source synthesis
-> prior thesis baseline comparison
-> contrarian check
-> investment thesis / industry-chain hypothesis
-> next research tasks
```

## Investment Report Trigger And Routing

Investment reports are not generated from ordinary chat or ordinary source ingestion. They require the exact message prefix:

```text
投研报告：
```

Examples:

```text
投研报告：AI 光模块 / CPO / 数据中心网络
投研报告：商业航天 / 星舰 / 中国供应链替代
```

This strict trigger prevents single YouTube links, casual questions, or ordinary summaries from accidentally producing a formal-looking investment report. If the evidence base has fewer than two sources or fewer than six evidence cards, the system should stop before writing and return an evidence-gap message instead of creating a weak report.

Published investment reports must go to the dedicated Feishu wiki folder configured by `FEISHU_INVESTMENT_REPORT_PARENT_WIKI_TOKEN` or `FEISHU_RESEARCH_REPORT_PARENT_WIKI_TOKEN`, not the YouTube article folder.

The rendered investment report structure is fixed by code:

1. 报告结论
2. 主题边界与产业链地图
3. 证据基础与时间校准
4. 产业链假设
5. 关键环节与跟踪指标
6. 反证、时间错位与风险
7. 迭代变化与下一轮调研任务
8. 资料来源与证据索引

The model fills bounded content fields; it must not invent new sections, process notes, database labels, or internal generation explanations.

## Reader Document Contract

Reader-facing documents must be generated from evidence and article intent first, then rendered by code:

- glossary before dense technical discussion
- background interpretation before core conclusion
- concrete article thesis instead of raw video titles or `YouTube technical notes`
- bold reader labels and indentation where they create hierarchy
- source links only in the final source section
- no generation prefaces, metadata fields, placeholders, raw HTML, or internal process text
- timeline as navigation plus evidence, not a transcript dump

The quality gate is a last line of defense, not the main writing strategy. Prompts and slot schemas must positively instruct the model to produce reader-grade content from the start.

## Investment Use Boundary

The system should support long-term industry-chain research, such as optical modules, AI infrastructure, robotics supply chains, or commercial space. It should output:

- industry-chain hypothesis
- evidence and counter-evidence
- affected value-chain nodes
- leading indicators
- trigger conditions
- invalidation conditions
- coverage gaps
- next research tasks

It should not present one source as a complete investment recommendation.

## Individual-Investor Reality Check

The system must assume some premium data, bank research, expert calls, or private company details may be unavailable. When that happens, it should:

- use public substitutes such as filings, official releases, standards bodies, regulatory records, conference talks, patents, hiring signals, datasets, reputable industry media, and technical communities
- mark access limitations as coverage gaps
- lower confidence instead of filling missing facts with model guesses
- generate next research tasks that a motivated individual can actually pursue

The goal is not short-term trading signals. The goal is to compound a traceable view of long-term supply-chain inflection points before they become obvious in mainstream summaries.
