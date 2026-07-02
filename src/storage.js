import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeKey } from "./utils.js";

const { Pool } = pg;

const summaryUserSeparator = "::user::";

function summaryKey(chatId, userId = "") {
  const normalizedUserId = String(userId || "");
  return normalizedUserId ? `${String(chatId)}${summaryUserSeparator}${normalizedUserId}` : String(chatId);
}

function parseSummaryKey(key) {
  const value = String(key);
  const separatorIndex = value.lastIndexOf(summaryUserSeparator);
  if (separatorIndex === -1) return { chatId: value, userId: "" };
  return {
    chatId: value.slice(0, separatorIndex),
    userId: value.slice(separatorIndex + summaryUserSeparator.length)
  };
}

function normalizeSummaries(summaries) {
  if (Array.isArray(summaries)) {
    return Object.fromEntries(
      summaries
        .filter((item) => item && item.chatId && item.summary)
        .map((item) => [summaryKey(item.chatId, item.userId), String(item.summary)])
    );
  }

  if (summaries && typeof summaries === "object") {
    return Object.fromEntries(
      Object.entries(summaries)
        .filter(([, value]) => value)
        .map(([key, value]) => [String(key), String(value)])
    );
  }

  return {};
}

function normalizeSettings(settings) {
  if (Array.isArray(settings)) {
    return Object.fromEntries(
      settings
        .filter((item) => item && item.key)
        .map((item) => [String(item.key), String(item.value ?? "")])
    );
  }

  if (settings && typeof settings === "object") {
    return Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [String(key), String(value ?? "")])
    );
  }

  return {};
}

function cleanResearchText(value = "", max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isLowValueResearchArtifactText(value = "") {
  const text = cleanResearchText(value, 500);
  if (!text) return false;
  return /YouTube\s*技术笔记|阅读导航|输出语言|内容形态|这部分没有生成到有效内容|<\/?details|<summary|我先按|接下来我会/i.test(text);
}

function cleanResearchTopicAlias(value = "", canonicalName = "") {
  const raw = cleanResearchText(value, 220);
  if (!raw || isLowValueResearchArtifactText(raw)) return "";
  if (/^https?:\/\//i.test(raw)) return "";
  if (/^(?:#{1,6}\s*)/.test(raw)) return "";
  const cleaned = raw
    .replace(/\s*YouTube\s*技术笔记\s*$/i, "")
    .replace(/\s*技术笔记\s*$/i, "")
    .trim();
  if (!cleaned || isLowValueResearchArtifactText(cleaned)) return "";
  if (cleaned === canonicalName) return "";
  if (cleaned.length > 80) return "";
  if (/^(?:为什么|如何|怎么|这篇|本文|视频|导读|总结|结论|证据|背景)[:：\s]/.test(cleaned)) return "";
  return cleaned;
}

function asResearchArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeResearchTopicKey(value = "") {
  const raw = cleanResearchText(value, 160).toLowerCase();
  const key = raw
    .replace(/[\s/|_，、,]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff+.#-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return key || normalizeKey(raw || "topic");
}

function inferResearchTopicType(name = "", fallback = "theme") {
  const value = String(name || "");
  if (/燃料|材料|液氧|甲烷|电池|芯片|光模块|减速器|执行器|液冷|储能|核电/.test(value)) return "material_or_component";
  if (/供应链|产业链|替代|产能|制造|工厂|发射|数据中心/.test(value)) return "supply_chain_node";
  if (/spacex|openai|tesla|nvidia|meta|google|microsoft|amazon|apple|starlink/i.test(value)) return "company";
  if (/starship|hls|cpo|gpu|asic|robot|rocket|engine|model|ai/i.test(value)) return "technology_or_product";
  return fallback || "theme";
}

function mergeResearchUnique(values = [], keyFn = (item) => JSON.stringify(item), limit = 100) {
  const seen = new Set();
  const result = [];
  for (const item of values || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function splitResearchTerms(query = "", extra = []) {
  return mergeResearchUnique(
    [
      ...String(query || "").split(/[\/,，、\s]+/),
      ...asResearchArray(extra)
    ]
      .map((item) => cleanResearchText(item, 80))
      .filter((item) => item.length >= 2),
    (item) => item.toLowerCase(),
    24
  );
}

function buildResearchTopicCandidates(bundle = {}) {
  const source = bundle.source || {};
  const metadata = source.metadata || {};
  const candidates = [];
  const push = (name, topicType = "theme", role = "related", aliases = []) => {
    const clean = cleanResearchText(name, 160);
    if (!clean || clean.length < 2 || isLowValueResearchArtifactText(clean)) return;
    const cleanAliases = mergeResearchUnique(
      asResearchArray(aliases)
        .map((item) => cleanResearchTopicAlias(item, clean))
        .filter(Boolean),
      (item) => item.toLowerCase(),
      10
    );
    candidates.push({
      topicKey: normalizeResearchTopicKey(clean),
      canonicalName: clean,
      topicType: inferResearchTopicType(clean, topicType),
      role,
      aliases: cleanAliases
    });
  };

  for (const topic of asResearchArray(bundle.topics)) {
    if (typeof topic === "string") {
      push(topic, "theme", "explicit_topic");
    } else if (topic && typeof topic === "object") {
      push(topic.name || topic.canonicalName || topic.topic || "", topic.topicType || topic.type || "theme", topic.role || "explicit_topic", topic.aliases || []);
    }
  }

  push(metadata.reportTopic || metadata.topic || metadata.requestTopic || "", "theme", "report_topic", [source.title]);
  push(source.organization || source.author || "", "organization", "publisher");

  for (const entity of asResearchArray(bundle.entities)) {
    const name = entity.name || "";
    const entityType = entity.entityType || entity.entity_type || "";
    const topicType = /company|organization/.test(entityType) ? entityType : inferResearchTopicType(name, entityType || "theme");
    push(name, topicType, entity.role || "mentioned_entity", entity.aliases || []);
  }

  if (!candidates.length) {
    push(source.title || source.url || source.sourceId || source.source_id || "", "theme", "source_title");
  }

  return mergeResearchUnique(candidates, (item) => item.topicKey, 80);
}

function buildResearchTopicEdges(candidates = []) {
  const primary = candidates.find((item) => item.role === "report_topic" || item.role === "explicit_topic") || candidates[0];
  if (!primary) return [];
  return candidates
    .filter((item) => item.topicKey !== primary.topicKey)
    .map((item) => ({
      fromTopicKey: primary.topicKey,
      toTopicKey: item.topicKey,
      edgeType: item.role === "publisher" ? "source_published_by" : "related_to",
      confidence: item.role === "mentioned_entity" ? 0.72 : 0.64,
      evidenceCount: 1,
      notes: `${primary.canonicalName} -> ${item.canonicalName}`
    }));
}

function textIncludesTopic(text = "", topic = {}) {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  const names = [topic.canonicalName, ...(topic.aliases || [])].map((item) => String(item || "").toLowerCase()).filter(Boolean);
  return names.some((name) => name.length >= 2 && value.includes(name));
}

export function createStorage(config) {
  if (config.databaseUrl) {
    return new PostgresStorage(config.databaseUrl, config.databaseSsl);
  }
  return new JsonFileStorage(path.resolve("data", "local-memory.json"));
}

class PostgresStorage {
  constructor(databaseUrl, databaseSsl = false) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseSsl ? { rejectUnauthorized: false } : undefined
    });
    this.pool.on("error", (error) => {
      console.error("Postgres pool idle client error:", error.message);
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        modality TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created
        ON chat_messages (chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memories (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (chat_id, user_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_chat_user
        ON memories (chat_id, user_id, importance DESC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        client_name TEXT NOT NULL DEFAULT '',
        product_name TEXT NOT NULL DEFAULT '',
        brief_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_projects_chat_updated
        ON projects (chat_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS project_tasks (
        id BIGSERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        input JSONB NOT NULL DEFAULT '{}'::jsonb,
        output JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_project_tasks_project
        ON project_tasks (project_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS project_artifacts (
        id BIGSERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '',
        content_summary TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_project_artifacts_project
        ON project_artifacts (project_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS project_sources (
        id BIGSERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        reliability TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS project_assets (
        id BIGSERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        asset_type TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        license_note TEXT NOT NULL DEFAULT '',
        usage_note TEXT NOT NULL DEFAULT '',
        thumbnail_url TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS research_jobs (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        stage TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        input JSONB NOT NULL DEFAULT '{}'::jsonb,
        output JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_jobs_status_updated
        ON research_jobs (status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS research_reference_sources (
        source_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        homepage_url TEXT NOT NULL DEFAULT '',
        institution_type TEXT NOT NULL DEFAULT '',
        source_perspective TEXT NOT NULL DEFAULT '',
        institution_role TEXT NOT NULL DEFAULT '',
        coverage_industries JSONB NOT NULL DEFAULT '[]'::jsonb,
        analysis_lenses JSONB NOT NULL DEFAULT '[]'::jsonb,
        access_level TEXT NOT NULL DEFAULT '',
        reliability_level TEXT NOT NULL DEFAULT '',
        conflict_profile TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_reference_sources_router
        ON research_reference_sources (institution_type, source_perspective, access_level);

      CREATE TABLE IF NOT EXISTS research_sources (
        source_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        organization TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL DEFAULT '',
        recorded_at TEXT NOT NULL DEFAULT '',
        event_period TEXT NOT NULL DEFAULT '',
        fetched_at TIMESTAMPTZ,
        analyzed_at TIMESTAMPTZ,
        language TEXT NOT NULL DEFAULT '',
        duration_text TEXT NOT NULL DEFAULT '',
        raw_text TEXT NOT NULL DEFAULT '',
        raw_text_hash TEXT NOT NULL DEFAULT '',
        doc_url TEXT NOT NULL DEFAULT '',
        obsidian_path TEXT NOT NULL DEFAULT '',
        reliability_level TEXT NOT NULL DEFAULT '',
        source_perspective TEXT NOT NULL DEFAULT '',
        institution_type TEXT NOT NULL DEFAULT '',
        institution_role TEXT NOT NULL DEFAULT '',
        analysis_lenses JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidence_strength TEXT NOT NULL DEFAULT '',
        access_level TEXT NOT NULL DEFAULT '',
        conflict_profile TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_sources_type_time
        ON research_sources (source_type, published_at, analyzed_at DESC);

      ALTER TABLE research_sources
        DROP CONSTRAINT IF EXISTS research_sources_url_key;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_url_nonempty
        ON research_sources (url)
        WHERE url <> '';

      CREATE TABLE IF NOT EXISTS research_evidence_cards (
        id BIGSERIAL PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES research_sources(source_id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL DEFAULT '',
        claim TEXT NOT NULL DEFAULT '',
        quote_original TEXT NOT NULL DEFAULT '',
        quote_zh TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        why_it_matters TEXT NOT NULL DEFAULT '',
        confidence NUMERIC NOT NULL DEFAULT 0.7,
        time_sensitivity TEXT NOT NULL DEFAULT '',
        stale_risk TEXT NOT NULL DEFAULT '',
        evidence_strength TEXT NOT NULL DEFAULT '',
        analysis_lens TEXT NOT NULL DEFAULT '',
        requires_recheck JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_evidence_source
        ON research_evidence_cards (source_id, id ASC);

      CREATE INDEX IF NOT EXISTS idx_research_evidence_type
        ON research_evidence_cards (evidence_type, time_sensitivity);

      CREATE TABLE IF NOT EXISTS research_entities (
        entity_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (name, entity_type)
      );

      CREATE TABLE IF NOT EXISTS research_source_entities (
        source_id TEXT NOT NULL REFERENCES research_sources(source_id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES research_entities(entity_id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, entity_id, role)
      );

      CREATE TABLE IF NOT EXISTS research_time_contexts (
        source_id TEXT PRIMARY KEY REFERENCES research_sources(source_id) ON DELETE CASCADE,
        video_published_at TEXT NOT NULL DEFAULT '',
        likely_recorded_at TEXT NOT NULL DEFAULT '',
        event_period TEXT NOT NULL DEFAULT '',
        industry_stage_at_that_time TEXT NOT NULL DEFAULT '',
        current_relevance TEXT NOT NULL DEFAULT '',
        time_sensitivity TEXT NOT NULL DEFAULT '',
        stale_if TEXT NOT NULL DEFAULT '',
        requires_recheck JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS research_questions (
        id BIGSERIAL PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES research_sources(source_id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        related_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
        priority INTEGER NOT NULL DEFAULT 3,
        research_direction TEXT NOT NULL DEFAULT '',
        suggested_source_types JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'open',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_questions_status_priority
        ON research_questions (status, priority ASC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS research_coverage_gaps (
        id BIGSERIAL PRIMARY KEY,
        source_id TEXT REFERENCES research_sources(source_id) ON DELETE CASCADE,
        gap TEXT NOT NULL,
        impact TEXT NOT NULL DEFAULT '',
        fallback_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
        confidence_impact TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_coverage_gaps_status
        ON research_coverage_gaps (status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS research_topics (
        id BIGSERIAL PRIMARY KEY,
        topic_key TEXT NOT NULL UNIQUE,
        canonical_name TEXT NOT NULL,
        topic_type TEXT NOT NULL DEFAULT 'theme',
        aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
        description TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_topics_key
        ON research_topics (topic_key);

      CREATE INDEX IF NOT EXISTS idx_research_topics_type
        ON research_topics (topic_type, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_research_topics_aliases
        ON research_topics USING GIN (aliases);

      CREATE TABLE IF NOT EXISTS research_topic_edges (
        id BIGSERIAL PRIMARY KEY,
        from_topic_id BIGINT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
        to_topic_id BIGINT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
        edge_type TEXT NOT NULL DEFAULT 'related_to',
        confidence NUMERIC NOT NULL DEFAULT 0.7,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (from_topic_id, to_topic_id, edge_type)
      );

      CREATE INDEX IF NOT EXISTS idx_research_topic_edges_from
        ON research_topic_edges (from_topic_id, edge_type);

      CREATE INDEX IF NOT EXISTS idx_research_topic_edges_to
        ON research_topic_edges (to_topic_id, edge_type);

      CREATE TABLE IF NOT EXISTS research_evidence_topics (
        evidence_card_id BIGINT NOT NULL REFERENCES research_evidence_cards(id) ON DELETE CASCADE,
        topic_id BIGINT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
        relevance NUMERIC NOT NULL DEFAULT 0.7,
        match_type TEXT NOT NULL DEFAULT 'generated',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (evidence_card_id, topic_id)
      );

      CREATE INDEX IF NOT EXISTS idx_research_evidence_topics_topic
        ON research_evidence_topics (topic_id, relevance DESC);

      CREATE INDEX IF NOT EXISTS idx_research_evidence_topics_evidence
        ON research_evidence_topics (evidence_card_id);

      CREATE TABLE IF NOT EXISTS research_report_versions (
        job_id TEXT PRIMARY KEY REFERENCES research_jobs(id) ON DELETE CASCADE,
        report_topic TEXT NOT NULL DEFAULT '',
        report_topic_key TEXT NOT NULL DEFAULT '',
        version_no INTEGER NOT NULL DEFAULT 1,
        prior_job_id TEXT REFERENCES research_jobs(id) ON DELETE SET NULL,
        evidence_cutoff_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source_count INTEGER NOT NULL DEFAULT 0,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        topic_count INTEGER NOT NULL DEFAULT 0,
        delta_summary TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_report_versions_topic
        ON research_report_versions (report_topic_key, version_no DESC);

      CREATE INDEX IF NOT EXISTS idx_research_report_versions_created
        ON research_report_versions (created_at DESC);

      CREATE TABLE IF NOT EXISTS research_thesis_ledger (
        id BIGSERIAL PRIMARY KEY,
        report_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        topic_key TEXT NOT NULL DEFAULT '',
        thesis TEXT NOT NULL DEFAULT '',
        thesis_type TEXT NOT NULL DEFAULT 'industry_chain',
        conviction TEXT NOT NULL DEFAULT 'medium',
        evidence_card_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        counter_evidence_card_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        time_horizon TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_research_thesis_topic_status
        ON research_thesis_ledger (topic_key, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_research_thesis_report
        ON research_thesis_ledger (report_job_id);

      ALTER TABLE research_sources
        ADD COLUMN IF NOT EXISTS source_perspective TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS institution_type TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS institution_role TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS analysis_lenses JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS evidence_strength TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS conflict_profile TEXT NOT NULL DEFAULT '';

      ALTER TABLE research_evidence_cards
        ADD COLUMN IF NOT EXISTS evidence_strength TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS analysis_lens TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS valid_from TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS valid_until TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_research_evidence_time_validity
        ON research_evidence_cards (time_sensitivity, valid_until);

      ALTER TABLE conversation_summaries
        ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';

      ALTER TABLE conversation_summaries
        DROP CONSTRAINT IF EXISTS conversation_summaries_pkey;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_summaries_chat_user
        ON conversation_summaries (chat_id, user_id);
    `);
  }

  async addMessage(message) {
    await this.pool.query(
      `INSERT INTO chat_messages (chat_id, user_id, role, modality, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(message.chatId),
        String(message.userId || ""),
        message.role,
        message.modality || "text",
        message.content,
        JSON.stringify(message.metadata || {})
      ]
    );
  }

  async getRecentMessages(chatId, limit, userId = null) {
    const hasUserFilter = userId !== null && userId !== undefined;
    const result = await this.pool.query(
      `SELECT role, content, modality, user_id, metadata, created_at
       FROM chat_messages
       WHERE chat_id = $1 ${hasUserFilter ? "AND user_id = $3" : ""}
       ORDER BY created_at DESC
       LIMIT $2`,
      hasUserFilter ? [String(chatId), limit, String(userId || "")] : [String(chatId), limit]
    );
    return result.rows.reverse();
  }

  async countMessages(chatId, userId = null) {
    const hasUserFilter = userId !== null && userId !== undefined;
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM chat_messages
       WHERE chat_id = $1 ${hasUserFilter ? "AND user_id = $2" : ""}`,
      hasUserFilter ? [String(chatId), String(userId || "")] : [String(chatId)]
    );
    return result.rows[0]?.count || 0;
  }

  async isEmpty() {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM chat_messages) AS message_count,
        (SELECT COUNT(*)::int FROM memories) AS memory_count,
        (SELECT COUNT(*)::int FROM conversation_summaries) AS summary_count
    `);
    const row = result.rows[0] || {};
    return (row.message_count || 0) + (row.memory_count || 0) + (row.summary_count || 0) === 0;
  }

  async exportState() {
    const [
      messages,
      memories,
      summaries,
      settings,
      projects,
      projectTasks,
      projectArtifacts,
      projectSources,
      projectAssets,
      researchJobs,
      researchReferenceSources,
      researchSources,
      researchEvidenceCards,
      researchEntities,
      researchSourceEntities,
      researchTimeContexts,
      researchQuestions,
      researchCoverageGaps,
      researchTopics,
      researchTopicEdges,
      researchEvidenceTopics,
      researchReportVersions,
      researchThesisLedger
    ] = await Promise.all([
      this.pool.query(
        `SELECT chat_id AS "chatId", user_id AS "userId", role, modality, content, metadata, created_at AS "createdAt"
         FROM chat_messages
         ORDER BY created_at ASC, id ASC`
      ),
      this.pool.query(
        `SELECT chat_id AS "chatId", user_id AS "userId", key, value, importance, metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM memories
         ORDER BY chat_id ASC, user_id ASC, key ASC`
      ),
      this.pool.query(
        `SELECT chat_id AS "chatId", user_id AS "userId", summary, updated_at AS "updatedAt"
         FROM conversation_summaries
         ORDER BY chat_id ASC, user_id ASC`
      ),
      this.pool.query(
        `SELECT key, value, updated_at AS "updatedAt"
         FROM system_settings
         ORDER BY key ASC`
      ),
      this.pool.query(
        `SELECT id, platform, chat_id AS "chatId", owner_user_id AS "ownerUserId", title,
                client_name AS "clientName", product_name AS "productName", brief_text AS "briefText",
                status, metadata, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM projects
         ORDER BY created_at ASC`
      ),
      this.pool.query(
        `SELECT id, project_id AS "projectId", agent_type AS "agentType", status, input, output, error,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM project_tasks
         ORDER BY created_at ASC, id ASC`
      ),
      this.pool.query(
        `SELECT id, project_id AS "projectId", artifact_type AS "artifactType", title, url, token,
                content_summary AS "contentSummary", metadata, created_at AS "createdAt"
         FROM project_artifacts
         ORDER BY created_at ASC, id ASC`
      ),
      this.pool.query(
        `SELECT id, project_id AS "projectId", source_type AS "sourceType", title, url, note,
                reliability, metadata, created_at AS "createdAt"
         FROM project_sources
         ORDER BY created_at ASC, id ASC`
      ),
      this.pool.query(
        `SELECT id, project_id AS "projectId", asset_type AS "assetType", title, url,
                license_note AS "licenseNote", usage_note AS "usageNote", thumbnail_url AS "thumbnailUrl",
                metadata, created_at AS "createdAt"
         FROM project_assets
         ORDER BY created_at ASC, id ASC`
      ),
      this.pool.query(
        `SELECT id, source_type AS "sourceType", source_url AS "sourceUrl", status, stage,
                attempts, input, output, error, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_jobs
         ORDER BY created_at ASC`
      ),
      this.pool.query(
        `SELECT source_key AS "sourceKey", name, homepage_url AS "homepageUrl",
                institution_type AS "institutionType", source_perspective AS "sourcePerspective",
                institution_role AS "institutionRole", coverage_industries AS "coverageIndustries",
                analysis_lenses AS "analysisLenses", access_level AS "accessLevel",
                reliability_level AS "reliabilityLevel", conflict_profile AS "conflictProfile",
                notes, metadata, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_reference_sources
         ORDER BY institution_type ASC, name ASC`
      ),
      this.pool.query(
        `SELECT source_id AS "sourceId", source_type AS "sourceType", platform, url, title,
                author, organization, published_at AS "publishedAt", recorded_at AS "recordedAt",
                event_period AS "eventPeriod", fetched_at AS "fetchedAt", analyzed_at AS "analyzedAt",
                language, duration_text AS "durationText", raw_text AS "rawText",
                raw_text_hash AS "rawTextHash", doc_url AS "docUrl", obsidian_path AS "obsidianPath",
                reliability_level AS "reliabilityLevel", source_perspective AS "sourcePerspective",
                institution_type AS "institutionType", institution_role AS "institutionRole",
                analysis_lenses AS "analysisLenses", evidence_strength AS "evidenceStrength",
                access_level AS "accessLevel", conflict_profile AS "conflictProfile", metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_sources
         ORDER BY created_at ASC`
      ),
      this.pool.query(
        `SELECT id, source_id AS "sourceId", evidence_type AS "evidenceType", claim,
                quote_original AS "quoteOriginal", quote_zh AS "quoteZh", location,
                why_it_matters AS "whyItMatters", confidence, time_sensitivity AS "timeSensitivity",
                stale_risk AS "staleRisk", evidence_strength AS "evidenceStrength",
                analysis_lens AS "analysisLens", requires_recheck AS "requiresRecheck", metadata,
                created_at AS "createdAt"
         FROM research_evidence_cards
         ORDER BY source_id ASC, id ASC`
      ),
      this.pool.query(
        `SELECT entity_id AS "entityId", name, entity_type AS "entityType", metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_entities
         ORDER BY name ASC`
      ),
      this.pool.query(
        `SELECT source_id AS "sourceId", entity_id AS "entityId", role, metadata,
                created_at AS "createdAt"
         FROM research_source_entities
         ORDER BY source_id ASC, entity_id ASC`
      ),
      this.pool.query(
        `SELECT source_id AS "sourceId", video_published_at AS "videoPublishedAt",
                likely_recorded_at AS "likelyRecordedAt", event_period AS "eventPeriod",
                industry_stage_at_that_time AS "industryStageAtThatTime",
                current_relevance AS "currentRelevance", time_sensitivity AS "timeSensitivity",
                stale_if AS "staleIf", requires_recheck AS "requiresRecheck", metadata,
                updated_at AS "updatedAt"
         FROM research_time_contexts
         ORDER BY source_id ASC`
      ),
      this.pool.query(
        `SELECT id, source_id AS "sourceId", question, related_entities AS "relatedEntities",
                priority, research_direction AS "researchDirection",
                suggested_source_types AS "suggestedSourceTypes", status, metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_questions
         ORDER BY source_id ASC, priority ASC, id ASC`
      ),
      this.pool.query(
        `SELECT id, source_id AS "sourceId", gap, impact, fallback_signals AS "fallbackSignals",
                confidence_impact AS "confidenceImpact", status, metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_coverage_gaps
         ORDER BY status ASC, updated_at DESC`
      ),
      this.pool.query(
        `SELECT id, topic_key AS "topicKey", canonical_name AS "canonicalName",
                topic_type AS "topicType", aliases, description, metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_topics
         ORDER BY topic_type ASC, canonical_name ASC`
      ),
      this.pool.query(
        `SELECT edge.id, from_topic.topic_key AS "fromTopicKey",
                to_topic.topic_key AS "toTopicKey", edge.edge_type AS "edgeType",
                edge.confidence, edge.evidence_count AS "evidenceCount",
                edge.notes, edge.metadata, edge.created_at AS "createdAt",
                edge.updated_at AS "updatedAt"
         FROM research_topic_edges edge
         JOIN research_topics from_topic ON from_topic.id = edge.from_topic_id
         JOIN research_topics to_topic ON to_topic.id = edge.to_topic_id
         ORDER BY edge.updated_at DESC, edge.id ASC`
      ),
      this.pool.query(
        `SELECT evidence_card_id AS "evidenceCardId", topic.topic_key AS "topicKey",
                relevance, match_type AS "matchType", research_evidence_topics.created_at AS "createdAt"
         FROM research_evidence_topics
         JOIN research_topics topic ON topic.id = research_evidence_topics.topic_id
         ORDER BY topic.topic_key ASC, evidence_card_id ASC`
      ),
      this.pool.query(
        `SELECT job_id AS "jobId", report_topic AS "reportTopic",
                report_topic_key AS "reportTopicKey", version_no AS "versionNo",
                prior_job_id AS "priorJobId", evidence_cutoff_at AS "evidenceCutoffAt",
                source_count AS "sourceCount", evidence_count AS "evidenceCount",
                topic_count AS "topicCount", delta_summary AS "deltaSummary",
                metadata, created_at AS "createdAt"
         FROM research_report_versions
         ORDER BY created_at ASC`
      ),
      this.pool.query(
        `SELECT id, report_job_id AS "reportJobId", topic_key AS "topicKey",
                thesis, thesis_type AS "thesisType", conviction,
                evidence_card_ids AS "evidenceCardIds",
                counter_evidence_card_ids AS "counterEvidenceCardIds",
                time_horizon AS "timeHorizon", status, metadata,
                created_at AS "createdAt"
         FROM research_thesis_ledger
         ORDER BY created_at ASC, id ASC`
      )
    ]);

    return {
      messages: messages.rows,
      memories: memories.rows,
      summaries: summaries.rows,
      settings: settings.rows,
      projects: projects.rows,
      projectTasks: projectTasks.rows,
      projectArtifacts: projectArtifacts.rows,
      projectSources: projectSources.rows,
      projectAssets: projectAssets.rows,
      researchJobs: researchJobs.rows,
      researchReferenceSources: researchReferenceSources.rows,
      researchSources: researchSources.rows,
      researchEvidenceCards: researchEvidenceCards.rows,
      researchEntities: researchEntities.rows,
      researchSourceEntities: researchSourceEntities.rows,
      researchTimeContexts: researchTimeContexts.rows,
      researchQuestions: researchQuestions.rows,
      researchCoverageGaps: researchCoverageGaps.rows,
      researchTopics: researchTopics.rows,
      researchTopicEdges: researchTopicEdges.rows,
      researchEvidenceTopics: researchEvidenceTopics.rows,
      researchReportVersions: researchReportVersions.rows,
      researchThesisLedger: researchThesisLedger.rows
    };
  }

  async importState(state) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chat_messages");
      await client.query("DELETE FROM memories");
      await client.query("DELETE FROM conversation_summaries");
      await client.query("DELETE FROM system_settings");
      await client.query("DELETE FROM project_assets");
      await client.query("DELETE FROM project_sources");
      await client.query("DELETE FROM project_artifacts");
      await client.query("DELETE FROM project_tasks");
      await client.query("DELETE FROM projects");
      await client.query("DELETE FROM research_thesis_ledger");
      await client.query("DELETE FROM research_report_versions");
      await client.query("DELETE FROM research_coverage_gaps");
      await client.query("DELETE FROM research_questions");
      await client.query("DELETE FROM research_time_contexts");
      await client.query("DELETE FROM research_source_entities");
      await client.query("DELETE FROM research_evidence_topics");
      await client.query("DELETE FROM research_evidence_cards");
      await client.query("DELETE FROM research_entities");
      await client.query("DELETE FROM research_sources");
      await client.query("DELETE FROM research_topic_edges");
      await client.query("DELETE FROM research_topics");
      await client.query("DELETE FROM research_reference_sources");
      await client.query("DELETE FROM research_jobs");

      for (const message of state.messages || []) {
        await client.query(
          `INSERT INTO chat_messages (chat_id, user_id, role, modality, content, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            String(message.chatId),
            String(message.userId || ""),
            message.role,
            message.modality || "text",
            message.content || "",
            JSON.stringify(message.metadata || {}),
            message.createdAt || new Date().toISOString()
          ]
        );
      }

      for (const memory of state.memories || []) {
        await client.query(
          `INSERT INTO memories (chat_id, user_id, key, value, importance, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (chat_id, user_id, key)
           DO UPDATE SET value = EXCLUDED.value, importance = EXCLUDED.importance, updated_at = EXCLUDED.updated_at`,
          [
            String(memory.chatId),
            String(memory.userId || ""),
            normalizeKey(memory.key),
            String(memory.value || "").slice(0, 1000),
            Math.max(1, Math.min(5, Number(memory.importance) || 3)),
            JSON.stringify(memory.metadata || {}),
            memory.createdAt || new Date().toISOString(),
            memory.updatedAt || new Date().toISOString()
          ]
        );
      }

      const summaries = Array.isArray(state.summaries)
        ? state.summaries
        : Object.entries(state.summaries || {}).map(([chatId, summary]) => ({ chatId, userId: "", summary }));

      for (const item of summaries) {
        await client.query(
          `INSERT INTO conversation_summaries (chat_id, user_id, summary)
           VALUES ($1, $2, $3)
           ON CONFLICT (chat_id, user_id)
           DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
          [String(item.chatId), String(item.userId || ""), String(item.summary || "").slice(0, 4000)]
        );
      }

      for (const [key, value] of Object.entries(normalizeSettings(state.settings))) {
        await client.query(
          `INSERT INTO system_settings (key, value)
           VALUES ($1, $2)
           ON CONFLICT (key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key.slice(0, 120), value.slice(0, 1000)]
        );
      }

      for (const project of state.projects || []) {
        await client.query(
          `INSERT INTO projects (id, platform, chat_id, owner_user_id, title, client_name, product_name, brief_text, status, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id)
           DO UPDATE SET
             title = EXCLUDED.title,
             client_name = EXCLUDED.client_name,
             product_name = EXCLUDED.product_name,
             brief_text = EXCLUDED.brief_text,
             status = EXCLUDED.status,
             metadata = EXCLUDED.metadata,
             updated_at = EXCLUDED.updated_at`,
          [
            String(project.id),
            String(project.platform || ""),
            String(project.chatId || project.chat_id || ""),
            String(project.ownerUserId || project.owner_user_id || ""),
            String(project.title || "").slice(0, 300),
            String(project.clientName || project.client_name || "").slice(0, 200),
            String(project.productName || project.product_name || "").slice(0, 200),
            String(project.briefText || project.brief_text || ""),
            String(project.status || "draft").slice(0, 40),
            JSON.stringify(project.metadata || {}),
            project.createdAt || project.created_at || new Date().toISOString(),
            project.updatedAt || project.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const task of state.projectTasks || []) {
        await client.query(
          `INSERT INTO project_tasks (project_id, agent_type, status, input, output, error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            String(task.projectId || task.project_id || ""),
            String(task.agentType || task.agent_type || ""),
            String(task.status || "pending"),
            JSON.stringify(task.input || {}),
            JSON.stringify(task.output || {}),
            String(task.error || ""),
            task.createdAt || task.created_at || new Date().toISOString(),
            task.updatedAt || task.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const artifact of state.projectArtifacts || []) {
        await client.query(
          `INSERT INTO project_artifacts (project_id, artifact_type, title, url, token, content_summary, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            String(artifact.projectId || artifact.project_id || ""),
            String(artifact.artifactType || artifact.artifact_type || ""),
            String(artifact.title || "").slice(0, 300),
            String(artifact.url || ""),
            String(artifact.token || ""),
            String(artifact.contentSummary || artifact.content_summary || ""),
            JSON.stringify(artifact.metadata || {}),
            artifact.createdAt || artifact.created_at || new Date().toISOString()
          ]
        );
      }

      for (const source of state.projectSources || []) {
        await client.query(
          `INSERT INTO project_sources (project_id, source_type, title, url, note, reliability, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            String(source.projectId || source.project_id || ""),
            String(source.sourceType || source.source_type || ""),
            String(source.title || "").slice(0, 300),
            String(source.url || ""),
            String(source.note || ""),
            String(source.reliability || ""),
            JSON.stringify(source.metadata || {}),
            source.createdAt || source.created_at || new Date().toISOString()
          ]
        );
      }

      for (const asset of state.projectAssets || []) {
        await client.query(
          `INSERT INTO project_assets (project_id, asset_type, title, url, license_note, usage_note, thumbnail_url, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            String(asset.projectId || asset.project_id || ""),
            String(asset.assetType || asset.asset_type || ""),
            String(asset.title || "").slice(0, 300),
            String(asset.url || ""),
            String(asset.licenseNote || asset.license_note || ""),
            String(asset.usageNote || asset.usage_note || ""),
            String(asset.thumbnailUrl || asset.thumbnail_url || ""),
            JSON.stringify(asset.metadata || {}),
            asset.createdAt || asset.created_at || new Date().toISOString()
          ]
        );
      }

      for (const job of state.researchJobs || []) {
        await client.query(
          `INSERT INTO research_jobs (id, source_type, source_url, status, stage, attempts, input, output, error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id)
           DO UPDATE SET status = EXCLUDED.status, stage = EXCLUDED.stage, attempts = EXCLUDED.attempts,
                         input = EXCLUDED.input, output = EXCLUDED.output, error = EXCLUDED.error,
                         updated_at = EXCLUDED.updated_at`,
          [
            String(job.id || ""),
            String(job.sourceType || job.source_type || ""),
            String(job.sourceUrl || job.source_url || ""),
            String(job.status || "pending"),
            String(job.stage || ""),
            Number(job.attempts || 0),
            JSON.stringify(job.input || {}),
            JSON.stringify(job.output || {}),
            String(job.error || ""),
            job.createdAt || job.created_at || new Date().toISOString(),
            job.updatedAt || job.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const reportVersion of state.researchReportVersions || []) {
        await client.query(
          `INSERT INTO research_report_versions (
             job_id, report_topic, report_topic_key, version_no, prior_job_id,
             evidence_cutoff_at, source_count, evidence_count, topic_count,
             delta_summary, metadata, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (job_id)
           DO UPDATE SET report_topic = EXCLUDED.report_topic,
                         report_topic_key = EXCLUDED.report_topic_key,
                         version_no = EXCLUDED.version_no,
                         prior_job_id = EXCLUDED.prior_job_id,
                         evidence_cutoff_at = EXCLUDED.evidence_cutoff_at,
                         source_count = EXCLUDED.source_count,
                         evidence_count = EXCLUDED.evidence_count,
                         topic_count = EXCLUDED.topic_count,
                         delta_summary = EXCLUDED.delta_summary,
                         metadata = EXCLUDED.metadata`,
          [
            String(reportVersion.jobId || reportVersion.job_id || ""),
            String(reportVersion.reportTopic || reportVersion.report_topic || ""),
            String(reportVersion.reportTopicKey || reportVersion.report_topic_key || ""),
            Number(reportVersion.versionNo || reportVersion.version_no || 1),
            reportVersion.priorJobId || reportVersion.prior_job_id || null,
            reportVersion.evidenceCutoffAt || reportVersion.evidence_cutoff_at || new Date().toISOString(),
            Number(reportVersion.sourceCount || reportVersion.source_count || 0),
            Number(reportVersion.evidenceCount || reportVersion.evidence_count || 0),
            Number(reportVersion.topicCount || reportVersion.topic_count || 0),
            String(reportVersion.deltaSummary || reportVersion.delta_summary || ""),
            JSON.stringify(reportVersion.metadata || {}),
            reportVersion.createdAt || reportVersion.created_at || new Date().toISOString()
          ]
        );
      }

      for (const reference of state.researchReferenceSources || []) {
        await client.query(
          `INSERT INTO research_reference_sources (
             source_key, name, homepage_url, institution_type, source_perspective,
             institution_role, coverage_industries, analysis_lenses, access_level,
             reliability_level, conflict_profile, notes, metadata, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (source_key)
           DO UPDATE SET name = EXCLUDED.name,
                         homepage_url = EXCLUDED.homepage_url,
                         institution_type = EXCLUDED.institution_type,
                         source_perspective = EXCLUDED.source_perspective,
                         institution_role = EXCLUDED.institution_role,
                         coverage_industries = EXCLUDED.coverage_industries,
                         analysis_lenses = EXCLUDED.analysis_lenses,
                         access_level = EXCLUDED.access_level,
                         reliability_level = EXCLUDED.reliability_level,
                         conflict_profile = EXCLUDED.conflict_profile,
                         notes = EXCLUDED.notes,
                         metadata = EXCLUDED.metadata,
                         updated_at = EXCLUDED.updated_at`,
          [
            String(reference.sourceKey || reference.source_key || ""),
            String(reference.name || ""),
            String(reference.homepageUrl || reference.homepage_url || ""),
            String(reference.institutionType || reference.institution_type || ""),
            String(reference.sourcePerspective || reference.source_perspective || ""),
            String(reference.institutionRole || reference.institution_role || ""),
            JSON.stringify(reference.coverageIndustries || reference.coverage_industries || []),
            JSON.stringify(reference.analysisLenses || reference.analysis_lenses || []),
            String(reference.accessLevel || reference.access_level || ""),
            String(reference.reliabilityLevel || reference.reliability_level || ""),
            String(reference.conflictProfile || reference.conflict_profile || ""),
            String(reference.notes || ""),
            JSON.stringify(reference.metadata || {}),
            reference.createdAt || reference.created_at || new Date().toISOString(),
            reference.updatedAt || reference.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const topic of state.researchTopics || []) {
        await client.query(
          `INSERT INTO research_topics (topic_key, canonical_name, topic_type, aliases, description, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (topic_key)
           DO UPDATE SET canonical_name = EXCLUDED.canonical_name,
                         topic_type = EXCLUDED.topic_type,
                         aliases = EXCLUDED.aliases,
                         description = EXCLUDED.description,
                         metadata = EXCLUDED.metadata,
                         updated_at = EXCLUDED.updated_at`,
          [
            String(topic.topicKey || topic.topic_key || ""),
            String(topic.canonicalName || topic.canonical_name || ""),
            String(topic.topicType || topic.topic_type || "theme"),
            JSON.stringify(topic.aliases || []),
            String(topic.description || ""),
            JSON.stringify(topic.metadata || {}),
            topic.createdAt || topic.created_at || new Date().toISOString(),
            topic.updatedAt || topic.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const edge of state.researchTopicEdges || []) {
        await client.query(
          `INSERT INTO research_topic_edges (
             from_topic_id, to_topic_id, edge_type, confidence, evidence_count,
             notes, metadata, created_at, updated_at
           )
           SELECT from_topic.id, to_topic.id, $3, $4, $5, $6, $7, $8, $9
           FROM research_topics from_topic, research_topics to_topic
           WHERE from_topic.topic_key = $1 AND to_topic.topic_key = $2
           ON CONFLICT (from_topic_id, to_topic_id, edge_type)
           DO UPDATE SET confidence = EXCLUDED.confidence,
                         evidence_count = EXCLUDED.evidence_count,
                         notes = EXCLUDED.notes,
                         metadata = EXCLUDED.metadata,
                         updated_at = EXCLUDED.updated_at`,
          [
            String(edge.fromTopicKey || edge.from_topic_key || ""),
            String(edge.toTopicKey || edge.to_topic_key || ""),
            String(edge.edgeType || edge.edge_type || "related_to"),
            Number(edge.confidence || 0.7),
            Number(edge.evidenceCount || edge.evidence_count || 0),
            String(edge.notes || ""),
            JSON.stringify(edge.metadata || {}),
            edge.createdAt || edge.created_at || new Date().toISOString(),
            edge.updatedAt || edge.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const source of state.researchSources || []) {
        await client.query(
          `INSERT INTO research_sources (
             source_id, source_type, platform, url, title, author, organization,
             published_at, recorded_at, event_period, fetched_at, analyzed_at,
             language, duration_text, raw_text, raw_text_hash, doc_url, obsidian_path,
             reliability_level, source_perspective, institution_type, institution_role,
             analysis_lenses, evidence_strength, access_level, conflict_profile,
             metadata, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
           ON CONFLICT (source_id)
           DO UPDATE SET source_type = EXCLUDED.source_type, platform = EXCLUDED.platform, url = EXCLUDED.url,
                         title = EXCLUDED.title, author = EXCLUDED.author, organization = EXCLUDED.organization,
                         published_at = EXCLUDED.published_at, recorded_at = EXCLUDED.recorded_at,
                         event_period = EXCLUDED.event_period, fetched_at = EXCLUDED.fetched_at,
                         analyzed_at = EXCLUDED.analyzed_at, language = EXCLUDED.language,
                         duration_text = EXCLUDED.duration_text, raw_text = EXCLUDED.raw_text,
                         raw_text_hash = EXCLUDED.raw_text_hash, doc_url = EXCLUDED.doc_url,
                         obsidian_path = EXCLUDED.obsidian_path,
                         reliability_level = EXCLUDED.reliability_level,
                         source_perspective = EXCLUDED.source_perspective,
                         institution_type = EXCLUDED.institution_type,
                         institution_role = EXCLUDED.institution_role,
                         analysis_lenses = EXCLUDED.analysis_lenses,
                         evidence_strength = EXCLUDED.evidence_strength,
                         access_level = EXCLUDED.access_level,
                         conflict_profile = EXCLUDED.conflict_profile,
                         metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at`,
          [
            String(source.sourceId || source.source_id || ""),
            String(source.sourceType || source.source_type || ""),
            String(source.platform || ""),
            String(source.url || ""),
            String(source.title || ""),
            String(source.author || ""),
            String(source.organization || ""),
            String(source.publishedAt || source.published_at || ""),
            String(source.recordedAt || source.recorded_at || ""),
            String(source.eventPeriod || source.event_period || ""),
            source.fetchedAt || source.fetched_at || null,
            source.analyzedAt || source.analyzed_at || null,
            String(source.language || ""),
            String(source.durationText || source.duration_text || ""),
            String(source.rawText || source.raw_text || ""),
            String(source.rawTextHash || source.raw_text_hash || ""),
            String(source.docUrl || source.doc_url || ""),
            String(source.obsidianPath || source.obsidian_path || ""),
            String(source.reliabilityLevel || source.reliability_level || ""),
            String(source.sourcePerspective || source.source_perspective || ""),
            String(source.institutionType || source.institution_type || ""),
            String(source.institutionRole || source.institution_role || ""),
            JSON.stringify(source.analysisLenses || source.analysis_lenses || []),
            String(source.evidenceStrength || source.evidence_strength || ""),
            String(source.accessLevel || source.access_level || ""),
            String(source.conflictProfile || source.conflict_profile || ""),
            JSON.stringify(source.metadata || {}),
            source.createdAt || source.created_at || new Date().toISOString(),
            source.updatedAt || source.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const entity of state.researchEntities || []) {
        await client.query(
          `INSERT INTO research_entities (entity_id, name, entity_type, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (entity_id)
           DO UPDATE SET name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
                         metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at`,
          [
            String(entity.entityId || entity.entity_id || ""),
            String(entity.name || ""),
            String(entity.entityType || entity.entity_type || ""),
            JSON.stringify(entity.metadata || {}),
            entity.createdAt || entity.created_at || new Date().toISOString(),
            entity.updatedAt || entity.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const card of state.researchEvidenceCards || []) {
        await client.query(
          `INSERT INTO research_evidence_cards (
             source_id, evidence_type, claim, quote_original, quote_zh, location,
             why_it_matters, confidence, time_sensitivity, stale_risk, evidence_strength,
             analysis_lens, requires_recheck, metadata, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            String(card.sourceId || card.source_id || ""),
            String(card.evidenceType || card.evidence_type || ""),
            String(card.claim || ""),
            String(card.quoteOriginal || card.quote_original || ""),
            String(card.quoteZh || card.quote_zh || ""),
            String(card.location || ""),
            String(card.whyItMatters || card.why_it_matters || ""),
            Number(card.confidence || 0.7),
            String(card.timeSensitivity || card.time_sensitivity || ""),
            String(card.staleRisk || card.stale_risk || ""),
            String(card.evidenceStrength || card.evidence_strength || ""),
            String(card.analysisLens || card.analysis_lens || ""),
            JSON.stringify(card.requiresRecheck || card.requires_recheck || []),
            JSON.stringify(card.metadata || {}),
            card.createdAt || card.created_at || new Date().toISOString()
          ]
        );
      }

      for (const link of state.researchSourceEntities || []) {
        await client.query(
          `INSERT INTO research_source_entities (source_id, entity_id, role, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (source_id, entity_id, role)
           DO UPDATE SET metadata = EXCLUDED.metadata`,
          [
            String(link.sourceId || link.source_id || ""),
            String(link.entityId || link.entity_id || ""),
            String(link.role || ""),
            JSON.stringify(link.metadata || {}),
            link.createdAt || link.created_at || new Date().toISOString()
          ]
        );
      }

      for (const context of state.researchTimeContexts || []) {
        await client.query(
          `INSERT INTO research_time_contexts (
             source_id, video_published_at, likely_recorded_at, event_period,
             industry_stage_at_that_time, current_relevance, time_sensitivity,
             stale_if, requires_recheck, metadata, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (source_id)
           DO UPDATE SET video_published_at = EXCLUDED.video_published_at,
                         likely_recorded_at = EXCLUDED.likely_recorded_at,
                         event_period = EXCLUDED.event_period,
                         industry_stage_at_that_time = EXCLUDED.industry_stage_at_that_time,
                         current_relevance = EXCLUDED.current_relevance,
                         time_sensitivity = EXCLUDED.time_sensitivity,
                         stale_if = EXCLUDED.stale_if,
                         requires_recheck = EXCLUDED.requires_recheck,
                         metadata = EXCLUDED.metadata,
                         updated_at = EXCLUDED.updated_at`,
          [
            String(context.sourceId || context.source_id || ""),
            String(context.videoPublishedAt || context.video_published_at || ""),
            String(context.likelyRecordedAt || context.likely_recorded_at || ""),
            String(context.eventPeriod || context.event_period || ""),
            String(context.industryStageAtThatTime || context.industry_stage_at_that_time || ""),
            String(context.currentRelevance || context.current_relevance || ""),
            String(context.timeSensitivity || context.time_sensitivity || ""),
            String(context.staleIf || context.stale_if || ""),
            JSON.stringify(context.requiresRecheck || context.requires_recheck || []),
            JSON.stringify(context.metadata || {}),
            context.updatedAt || context.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const question of state.researchQuestions || []) {
        await client.query(
          `INSERT INTO research_questions (
             source_id, question, related_entities, priority, research_direction,
             suggested_source_types, status, metadata, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            String(question.sourceId || question.source_id || ""),
            String(question.question || ""),
            JSON.stringify(question.relatedEntities || question.related_entities || []),
            Math.max(1, Math.min(5, Number(question.priority) || 3)),
            String(question.researchDirection || question.research_direction || ""),
            JSON.stringify(question.suggestedSourceTypes || question.suggested_source_types || []),
            String(question.status || "open"),
            JSON.stringify(question.metadata || {}),
            question.createdAt || question.created_at || new Date().toISOString(),
            question.updatedAt || question.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const gap of state.researchCoverageGaps || []) {
        await client.query(
          `INSERT INTO research_coverage_gaps (
             source_id, gap, impact, fallback_signals, confidence_impact, status,
             metadata, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            String(gap.sourceId || gap.source_id || ""),
            String(gap.gap || ""),
            String(gap.impact || ""),
            JSON.stringify(gap.fallbackSignals || gap.fallback_signals || []),
            String(gap.confidenceImpact || gap.confidence_impact || ""),
            String(gap.status || "open"),
            JSON.stringify(gap.metadata || {}),
            gap.createdAt || gap.created_at || new Date().toISOString(),
            gap.updatedAt || gap.updated_at || new Date().toISOString()
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listChats(limit = 100) {
    const result = await this.pool.query(
      `WITH chat_ids AS (
         SELECT chat_id FROM chat_messages
         UNION
         SELECT chat_id FROM memories
         UNION
         SELECT chat_id FROM conversation_summaries
       ),
       message_stats AS (
         SELECT chat_id, COUNT(*)::int AS message_count, MAX(created_at) AS last_message_at
         FROM chat_messages
         GROUP BY chat_id
       ),
       memory_stats AS (
         SELECT chat_id, COUNT(*)::int AS memory_count, MAX(updated_at) AS last_memory_at
         FROM memories
         GROUP BY chat_id
       ),
       summary_stats AS (
         SELECT chat_id, MAX(updated_at) AS summary_updated_at
         FROM conversation_summaries
         GROUP BY chat_id
       )
       SELECT
         c.chat_id,
         COALESCE(ms.message_count, 0)::int AS message_count,
         COALESCE(mem.memory_count, 0)::int AS memory_count,
         ms.last_message_at,
         mem.last_memory_at,
         ss.summary_updated_at
       FROM chat_ids c
       LEFT JOIN message_stats ms ON ms.chat_id = c.chat_id
       LEFT JOIN memory_stats mem ON mem.chat_id = c.chat_id
       LEFT JOIN summary_stats ss ON ss.chat_id = c.chat_id
       ORDER BY COALESCE(ms.last_message_at, mem.last_memory_at, ss.summary_updated_at) DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getMemories(chatId, userId, limit) {
    const result = await this.pool.query(
      `SELECT key, value, importance, user_id, updated_at
       FROM memories
       WHERE chat_id = $1 AND (user_id = '' OR user_id = $2)
       ORDER BY importance DESC, updated_at DESC
       LIMIT $3`,
      [String(chatId), String(userId || ""), limit]
    );
    return result.rows;
  }

  async listMemories(chatId, limit = 300) {
    const result = await this.pool.query(
      `SELECT key, value, importance, user_id, created_at, updated_at
       FROM memories
       WHERE chat_id = $1
       ORDER BY importance DESC, updated_at DESC
       LIMIT $2`,
      [String(chatId), limit]
    );
    return result.rows;
  }

  async listUsers(chatId, limit = 300) {
    const result = await this.pool.query(
      `WITH message_users AS (
         SELECT
           user_id,
           MAX(metadata->>'username') AS username,
           MAX(metadata->>'firstName') AS first_name,
           MAX(metadata->>'lastName') AS last_name,
           COUNT(*)::int AS message_count,
           MAX(created_at) AS last_message_at
         FROM chat_messages
         WHERE chat_id = $1 AND user_id <> ''
         GROUP BY user_id
       ),
       memory_users AS (
         SELECT user_id, COUNT(*)::int AS memory_count, MAX(updated_at) AS last_memory_at
         FROM memories
         WHERE chat_id = $1 AND user_id <> ''
         GROUP BY user_id
       ),
       user_ids AS (
         SELECT user_id FROM message_users
         UNION
         SELECT user_id FROM memory_users
       )
       SELECT
         u.user_id,
         COALESCE(mu.username, '') AS username,
         COALESCE(mu.first_name, '') AS first_name,
         COALESCE(mu.last_name, '') AS last_name,
         COALESCE(mu.message_count, 0)::int AS message_count,
         COALESCE(mem.memory_count, 0)::int AS memory_count,
         mu.last_message_at,
         mem.last_memory_at
       FROM user_ids u
       LEFT JOIN message_users mu ON mu.user_id = u.user_id
       LEFT JOIN memory_users mem ON mem.user_id = u.user_id
       ORDER BY COALESCE(mu.last_message_at, mem.last_memory_at) DESC NULLS LAST
       LIMIT $2`,
      [String(chatId), limit]
    );
    return result.rows;
  }

  async setMemory(chatId, userId, memory) {
    const key = normalizeKey(memory.key);
    if (!key || !memory.value) return;

    await this.pool.query(
      `INSERT INTO memories (chat_id, user_id, key, value, importance)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chat_id, user_id, key)
       DO UPDATE SET
         value = EXCLUDED.value,
         importance = EXCLUDED.importance,
         updated_at = now()`,
      [
        String(chatId),
        String(userId || ""),
        key,
        String(memory.value).slice(0, 1000),
        Math.max(1, Math.min(5, Number(memory.importance) || 3))
      ]
    );
  }

  async upsertMemories(chatId, userId, memories) {
    for (const memory of memories) {
      const key = normalizeKey(memory.key);
      if (!key || !memory.value) continue;
      await this.pool.query(
        `INSERT INTO memories (chat_id, user_id, key, value, importance)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (chat_id, user_id, key)
         DO UPDATE SET
           value = EXCLUDED.value,
           importance = GREATEST(memories.importance, EXCLUDED.importance),
           updated_at = now()`,
        [
          String(chatId),
          String(userId || ""),
          key,
          String(memory.value).slice(0, 1000),
          Math.max(1, Math.min(5, Number(memory.importance) || 3))
        ]
      );
    }
  }

  async deleteMemory(chatId, userId, key) {
    await this.pool.query(
      `DELETE FROM memories WHERE chat_id = $1 AND user_id = $2 AND key = $3`,
      [String(chatId), String(userId || ""), normalizeKey(key)]
    );
  }

  async getSummary(chatId, userId = "") {
    const result = await this.pool.query(
      `SELECT summary FROM conversation_summaries WHERE chat_id = $1 AND user_id = $2`,
      [String(chatId), String(userId || "")]
    );
    return result.rows[0]?.summary || "";
  }

  async setSummary(chatId, summary, userId = "") {
    await this.pool.query(
      `INSERT INTO conversation_summaries (chat_id, user_id, summary)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id)
       DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
      [String(chatId), String(userId || ""), String(summary).slice(0, 4000)]
    );
  }

  async clearChat(chatId) {
    await this.pool.query(`DELETE FROM chat_messages WHERE chat_id = $1`, [String(chatId)]);
    await this.pool.query(`DELETE FROM memories WHERE chat_id = $1`, [String(chatId)]);
    await this.pool.query(`DELETE FROM conversation_summaries WHERE chat_id = $1`, [String(chatId)]);
  }

  async createProject(project) {
    await this.pool.query(
      `INSERT INTO projects (id, platform, chat_id, owner_user_id, title, client_name, product_name, brief_text, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id)
       DO UPDATE SET
         title = EXCLUDED.title,
         client_name = EXCLUDED.client_name,
         product_name = EXCLUDED.product_name,
         brief_text = EXCLUDED.brief_text,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        String(project.id),
        String(project.platform || ""),
        String(project.chatId || ""),
        String(project.ownerUserId || ""),
        String(project.title || "").slice(0, 300),
        String(project.clientName || "").slice(0, 200),
        String(project.productName || "").slice(0, 200),
        String(project.briefText || ""),
        String(project.status || "draft").slice(0, 40),
        JSON.stringify(project.metadata || {})
      ]
    );
  }

  async updateProject(projectId, updates = {}) {
    const existing = await this.getProject(projectId);
    if (!existing) return;
    await this.createProject({
      id: existing.id,
      platform: existing.platform,
      chatId: existing.chat_id,
      ownerUserId: existing.owner_user_id,
      title: updates.title ?? existing.title,
      clientName: updates.clientName ?? existing.client_name,
      productName: updates.productName ?? existing.product_name,
      briefText: updates.briefText ?? existing.brief_text,
      status: updates.status ?? existing.status,
      metadata: updates.metadata ?? existing.metadata ?? {}
    });
  }

  async getProject(projectId) {
    const result = await this.pool.query(
      `SELECT id, platform, chat_id, owner_user_id, title, client_name, product_name, brief_text, status, metadata, created_at, updated_at
       FROM projects
       WHERE id = $1`,
      [String(projectId)]
    );
    return result.rows[0] || null;
  }

  async listProjects(chatId = "", limit = 50) {
    const hasChat = Boolean(chatId);
    const result = await this.pool.query(
      `SELECT id, platform, chat_id, owner_user_id, title, client_name, product_name, status, created_at, updated_at
       FROM projects
       ${hasChat ? "WHERE chat_id = $2" : ""}
       ORDER BY updated_at DESC
       LIMIT $1`,
      hasChat ? [limit, String(chatId)] : [limit]
    );
    return result.rows;
  }

  async addProjectTask(task) {
    const result = await this.pool.query(
      `INSERT INTO project_tasks (project_id, agent_type, status, input, output, error)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        String(task.projectId || ""),
        String(task.agentType || ""),
        String(task.status || "pending"),
        JSON.stringify(task.input || {}),
        JSON.stringify(task.output || {}),
        String(task.error || "")
      ]
    );
    return result.rows[0]?.id;
  }

  async addProjectArtifact(artifact) {
    const result = await this.pool.query(
      `INSERT INTO project_artifacts (project_id, artifact_type, title, url, token, content_summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        String(artifact.projectId || ""),
        String(artifact.artifactType || ""),
        String(artifact.title || "").slice(0, 300),
        String(artifact.url || ""),
        String(artifact.token || ""),
        String(artifact.contentSummary || ""),
        JSON.stringify(artifact.metadata || {})
      ]
    );
    return result.rows[0]?.id;
  }

  async listProjectArtifacts(projectId) {
    const result = await this.pool.query(
      `SELECT id, project_id, artifact_type, title, url, token, content_summary, metadata, created_at
       FROM project_artifacts
       WHERE project_id = $1
       ORDER BY created_at ASC, id ASC`,
      [String(projectId)]
    );
    return result.rows;
  }

  async getSetting(key, fallback = "") {
    const result = await this.pool.query(`SELECT value FROM system_settings WHERE key = $1`, [String(key)]);
    return result.rows[0]?.value ?? fallback;
  }

  async setSetting(key, value) {
    await this.pool.query(
      `INSERT INTO system_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [String(key).slice(0, 120), String(value ?? "").slice(0, 1000)]
    );
  }

  async upsertResearchJob(job = {}) {
    const result = await this.pool.query(
      `INSERT INTO research_jobs (id, source_type, source_url, status, stage, attempts, input, output, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id)
       DO UPDATE SET source_type = EXCLUDED.source_type,
                     source_url = EXCLUDED.source_url,
                     status = EXCLUDED.status,
                     stage = EXCLUDED.stage,
                     attempts = EXCLUDED.attempts,
                     input = EXCLUDED.input,
                     output = EXCLUDED.output,
                     error = EXCLUDED.error,
                     updated_at = now()
       RETURNING id`,
      [
        String(job.id || ""),
        String(job.sourceType || job.source_type || ""),
        String(job.sourceUrl || job.source_url || ""),
        String(job.status || "pending"),
        String(job.stage || ""),
        Number(job.attempts || 0),
        JSON.stringify(job.input || {}),
        JSON.stringify(job.output || {}),
        String(job.error || "")
      ]
    );
    return result.rows[0]?.id || "";
  }

  async updateResearchJob(jobId, updates = {}) {
    const assignments = [];
    const values = [];
    const push = (column, value) => {
      assignments.push(`${column} = $${values.length + 1}`);
      values.push(value);
    };
    if (updates.status !== undefined) push("status", String(updates.status || ""));
    if (updates.stage !== undefined) push("stage", String(updates.stage || ""));
    if (updates.attempts !== undefined) push("attempts", Number(updates.attempts || 0));
    if (updates.output !== undefined) push("output", JSON.stringify(updates.output || {}));
    if (updates.error !== undefined) push("error", String(updates.error || ""));
    if (!assignments.length) return;
    values.push(String(jobId || ""));
    await this.pool.query(
      `UPDATE research_jobs
       SET ${assignments.join(", ")}, updated_at = now()
       WHERE id = $${values.length}`,
      values
    );
  }

  async hasResearchSource(sourceId = "") {
    if (!sourceId) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM research_sources WHERE source_id = $1 LIMIT 1`,
      [String(sourceId)]
    );
    return Boolean(result.rows[0]);
  }

  async upsertResearchTopicGraph(client, { bundle = {}, evidenceCards = [] } = {}) {
    const candidates = buildResearchTopicCandidates(bundle);
    if (!candidates.length) return { topics: 0, edges: 0, evidenceTopicLinks: 0 };

    const topicRows = new Map();
    for (const topic of candidates) {
      const result = await client.query(
        `INSERT INTO research_topics (topic_key, canonical_name, topic_type, aliases, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (topic_key)
         DO UPDATE SET canonical_name = CASE
                           WHEN research_topics.canonical_name = '' THEN EXCLUDED.canonical_name
                           ELSE research_topics.canonical_name
                         END,
                       topic_type = CASE
                         WHEN research_topics.topic_type = 'theme' THEN EXCLUDED.topic_type
                         ELSE research_topics.topic_type
                       END,
                       aliases = (
                         SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                         FROM jsonb_array_elements_text(research_topics.aliases || EXCLUDED.aliases) AS merged(value)
                       ),
                       metadata = research_topics.metadata || EXCLUDED.metadata,
                       updated_at = now()
         RETURNING id, topic_key AS "topicKey"`,
        [
          topic.topicKey,
          topic.canonicalName,
          topic.topicType || "theme",
          JSON.stringify(topic.aliases || []),
          JSON.stringify({ lastRole: topic.role || "", source: "research_ingestion" })
        ]
      );
      topicRows.set(topic.topicKey, result.rows[0]);
    }

    let edges = 0;
    for (const edge of buildResearchTopicEdges(candidates)) {
      const from = topicRows.get(edge.fromTopicKey);
      const to = topicRows.get(edge.toTopicKey);
      if (!from?.id || !to?.id || from.id === to.id) continue;
      await client.query(
        `INSERT INTO research_topic_edges (
           from_topic_id, to_topic_id, edge_type, confidence, evidence_count, notes, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (from_topic_id, to_topic_id, edge_type)
         DO UPDATE SET confidence = GREATEST(research_topic_edges.confidence, EXCLUDED.confidence),
                       evidence_count = research_topic_edges.evidence_count + EXCLUDED.evidence_count,
                       notes = EXCLUDED.notes,
                       metadata = research_topic_edges.metadata || EXCLUDED.metadata,
                       updated_at = now()`,
        [
          from.id,
          to.id,
          edge.edgeType,
          Number(edge.confidence || 0.7),
          Number(edge.evidenceCount || 1),
          edge.notes || "",
          JSON.stringify({ source: "research_ingestion" })
        ]
      );
      edges += 1;
    }

    const primary = candidates.find((item) => item.role === "report_topic" || item.role === "explicit_topic") || candidates[0];
    let evidenceTopicLinks = 0;
    for (const item of evidenceCards || []) {
      if (!item.id) continue;
      const card = item.card || {};
      const text = [
        card.claim,
        card.quoteOriginal || card.quote_original,
        card.quoteZh || card.quote_zh,
        card.whyItMatters || card.why_it_matters,
        card.analysisLens || card.analysis_lens,
        JSON.stringify(card.metadata || {})
      ].join("\n");
      const matched = candidates.filter((topic) => topic.topicKey === primary.topicKey || textIncludesTopic(text, topic)).slice(0, 10);
      for (const topic of matched) {
        const row = topicRows.get(topic.topicKey);
        if (!row?.id) continue;
        await client.query(
          `INSERT INTO research_evidence_topics (evidence_card_id, topic_id, relevance, match_type)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (evidence_card_id, topic_id)
           DO UPDATE SET relevance = GREATEST(research_evidence_topics.relevance, EXCLUDED.relevance),
                         match_type = EXCLUDED.match_type`,
          [
            item.id,
            row.id,
            topic.topicKey === primary.topicKey ? 0.95 : 0.72,
            topic.topicKey === primary.topicKey ? "primary_topic" : "text_match"
          ]
        );
        evidenceTopicLinks += 1;
      }
    }

    return { topics: candidates.length, edges, evidenceTopicLinks };
  }

  async upsertResearchSourceBundle(bundle = {}) {
    const source = bundle.source || {};
    const sourceId = String(source.sourceId || source.source_id || "");
    if (!sourceId) throw new Error("research source bundle requires sourceId.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO research_sources (
           source_id, source_type, platform, url, title, author, organization,
           published_at, recorded_at, event_period, fetched_at, analyzed_at,
           language, duration_text, raw_text, raw_text_hash, doc_url, obsidian_path,
           reliability_level, source_perspective, institution_type, institution_role,
           analysis_lenses, evidence_strength, access_level, conflict_profile, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
         ON CONFLICT (source_id)
         DO UPDATE SET source_type = EXCLUDED.source_type,
                       platform = EXCLUDED.platform,
                       url = EXCLUDED.url,
                       title = EXCLUDED.title,
                       author = EXCLUDED.author,
                       organization = EXCLUDED.organization,
                       published_at = EXCLUDED.published_at,
                       recorded_at = EXCLUDED.recorded_at,
                       event_period = EXCLUDED.event_period,
                       fetched_at = EXCLUDED.fetched_at,
                       analyzed_at = EXCLUDED.analyzed_at,
                       language = EXCLUDED.language,
                       duration_text = EXCLUDED.duration_text,
                       raw_text = EXCLUDED.raw_text,
                       raw_text_hash = EXCLUDED.raw_text_hash,
                       doc_url = EXCLUDED.doc_url,
                       obsidian_path = EXCLUDED.obsidian_path,
                       reliability_level = EXCLUDED.reliability_level,
                       source_perspective = EXCLUDED.source_perspective,
                       institution_type = EXCLUDED.institution_type,
                       institution_role = EXCLUDED.institution_role,
                       analysis_lenses = EXCLUDED.analysis_lenses,
                       evidence_strength = EXCLUDED.evidence_strength,
                       access_level = EXCLUDED.access_level,
                       conflict_profile = EXCLUDED.conflict_profile,
                       metadata = EXCLUDED.metadata,
                       updated_at = now()`,
        [
          sourceId,
          String(source.sourceType || source.source_type || ""),
          String(source.platform || ""),
          String(source.url || ""),
          String(source.title || "").slice(0, 500),
          String(source.author || ""),
          String(source.organization || ""),
          String(source.publishedAt || source.published_at || ""),
          String(source.recordedAt || source.recorded_at || ""),
          String(source.eventPeriod || source.event_period || ""),
          source.fetchedAt || source.fetched_at || new Date().toISOString(),
          source.analyzedAt || source.analyzed_at || new Date().toISOString(),
          String(source.language || ""),
          String(source.durationText || source.duration_text || ""),
          String(source.rawText || source.raw_text || ""),
          String(source.rawTextHash || source.raw_text_hash || ""),
          String(source.docUrl || source.doc_url || ""),
          String(source.obsidianPath || source.obsidian_path || ""),
          String(source.reliabilityLevel || source.reliability_level || ""),
          String(source.sourcePerspective || source.source_perspective || ""),
          String(source.institutionType || source.institution_type || ""),
          String(source.institutionRole || source.institution_role || ""),
          JSON.stringify(source.analysisLenses || source.analysis_lenses || []),
          String(source.evidenceStrength || source.evidence_strength || ""),
          String(source.accessLevel || source.access_level || ""),
          String(source.conflictProfile || source.conflict_profile || ""),
          JSON.stringify(source.metadata || {})
        ]
      );

      await client.query(`DELETE FROM research_evidence_cards WHERE source_id = $1`, [sourceId]);
      await client.query(`DELETE FROM research_questions WHERE source_id = $1`, [sourceId]);
      await client.query(`DELETE FROM research_time_contexts WHERE source_id = $1`, [sourceId]);
      await client.query(`DELETE FROM research_source_entities WHERE source_id = $1`, [sourceId]);
      await client.query(`DELETE FROM research_coverage_gaps WHERE source_id = $1`, [sourceId]);

      const insertedEvidenceCards = [];
      for (const card of bundle.evidenceCards || []) {
        const result = await client.query(
          `INSERT INTO research_evidence_cards (
             source_id, evidence_type, claim, quote_original, quote_zh, location,
             why_it_matters, confidence, time_sensitivity, stale_risk, evidence_strength,
             analysis_lens, requires_recheck, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [
            sourceId,
            String(card.evidenceType || card.evidence_type || ""),
            String(card.claim || "").slice(0, 1200),
            String(card.quoteOriginal || card.quote_original || "").slice(0, 2400),
            String(card.quoteZh || card.quote_zh || "").slice(0, 2400),
            String(card.location || "").slice(0, 120),
            String(card.whyItMatters || card.why_it_matters || "").slice(0, 1200),
            Number(card.confidence || 0.7),
            String(card.timeSensitivity || card.time_sensitivity || ""),
            String(card.staleRisk || card.stale_risk || ""),
            String(card.evidenceStrength || card.evidence_strength || ""),
            String(card.analysisLens || card.analysis_lens || ""),
            JSON.stringify(card.requiresRecheck || card.requires_recheck || []),
            JSON.stringify(card.metadata || {})
          ]
        );
        insertedEvidenceCards.push({ id: result.rows[0]?.id, card });
      }

      for (const entity of bundle.entities || []) {
        const entityId = String(entity.entityId || entity.entity_id || "");
        if (!entityId || !entity.name) continue;
        await client.query(
          `INSERT INTO research_entities (entity_id, name, entity_type, metadata)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (entity_id)
           DO UPDATE SET name = EXCLUDED.name,
                         entity_type = EXCLUDED.entity_type,
                         metadata = EXCLUDED.metadata,
                         updated_at = now()`,
          [
            entityId,
            String(entity.name || "").slice(0, 240),
            String(entity.entityType || entity.entity_type || ""),
            JSON.stringify(entity.metadata || {})
          ]
        );
        await client.query(
          `INSERT INTO research_source_entities (source_id, entity_id, role, metadata)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_id, entity_id, role)
           DO UPDATE SET metadata = EXCLUDED.metadata`,
          [
            sourceId,
            entityId,
            String(entity.role || "mentioned"),
            JSON.stringify(entity.linkMetadata || {})
          ]
        );
      }

      const context = bundle.timeContext || {};
      if (Object.keys(context).length) {
        await client.query(
          `INSERT INTO research_time_contexts (
             source_id, video_published_at, likely_recorded_at, event_period,
             industry_stage_at_that_time, current_relevance, time_sensitivity,
             stale_if, requires_recheck, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (source_id)
           DO UPDATE SET video_published_at = EXCLUDED.video_published_at,
                         likely_recorded_at = EXCLUDED.likely_recorded_at,
                         event_period = EXCLUDED.event_period,
                         industry_stage_at_that_time = EXCLUDED.industry_stage_at_that_time,
                         current_relevance = EXCLUDED.current_relevance,
                         time_sensitivity = EXCLUDED.time_sensitivity,
                         stale_if = EXCLUDED.stale_if,
                         requires_recheck = EXCLUDED.requires_recheck,
                         metadata = EXCLUDED.metadata,
                         updated_at = now()`,
          [
            sourceId,
            String(context.videoPublishedAt || context.video_published_at || ""),
            String(context.likelyRecordedAt || context.likely_recorded_at || ""),
            String(context.eventPeriod || context.event_period || ""),
            String(context.industryStageAtThatTime || context.industry_stage_at_that_time || ""),
            String(context.currentRelevance || context.current_relevance || ""),
            String(context.timeSensitivity || context.time_sensitivity || ""),
            String(context.staleIf || context.stale_if || ""),
            JSON.stringify(context.requiresRecheck || context.requires_recheck || []),
            JSON.stringify(context.metadata || {})
          ]
        );
      }

      for (const question of bundle.questions || []) {
        await client.query(
          `INSERT INTO research_questions (
             source_id, question, related_entities, priority, research_direction,
             suggested_source_types, status, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            sourceId,
            String(question.question || question || "").slice(0, 600),
            JSON.stringify(question.relatedEntities || question.related_entities || []),
            Math.max(1, Math.min(5, Number(question.priority) || 3)),
            String(question.researchDirection || question.research_direction || ""),
            JSON.stringify(question.suggestedSourceTypes || question.suggested_source_types || []),
            String(question.status || "open"),
            JSON.stringify(question.metadata || {})
          ]
        );
      }

      for (const gap of bundle.coverageGaps || []) {
        await client.query(
          `INSERT INTO research_coverage_gaps (
             source_id, gap, impact, fallback_signals, confidence_impact, status, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sourceId,
            String(gap.gap || gap || "").slice(0, 600),
            String(gap.impact || "").slice(0, 1000),
            JSON.stringify(gap.fallbackSignals || gap.fallback_signals || []),
            String(gap.confidenceImpact || gap.confidence_impact || ""),
            String(gap.status || "open"),
            JSON.stringify(gap.metadata || {})
          ]
        );
      }

      await this.upsertResearchTopicGraph(client, { bundle, sourceId, evidenceCards: insertedEvidenceCards });

      await client.query("COMMIT");
      return {
        sourceId,
        evidenceCards: (bundle.evidenceCards || []).length,
        entities: (bundle.entities || []).length,
        questions: (bundle.questions || []).length,
        coverageGaps: (bundle.coverageGaps || []).length
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getResearchTopicMap({ query = "", limit = 80 } = {}) {
    const terms = splitResearchTerms(query);
    const topicKeys = terms.map((term) => normalizeResearchTopicKey(term));
    const values = [];
    const clauses = [];
    if (topicKeys.length) {
      values.push(topicKeys);
      clauses.push(`topic_key = ANY($${values.length}::text[])`);
    }
    for (const term of terms.slice(0, 12)) {
      values.push(`%${term}%`);
      const slot = `$${values.length}`;
      clauses.push(`canonical_name ILIKE ${slot} OR aliases::text ILIKE ${slot} OR description ILIKE ${slot}`);
    }
    values.push(Math.max(1, Math.min(120, Number(limit) || 80)));
    const topicResult = await this.pool.query(
      `SELECT id, topic_key AS "topicKey", canonical_name AS "canonicalName",
              topic_type AS "topicType", aliases, description, metadata,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM research_topics
       ${clauses.length ? `WHERE ${clauses.map((clause) => `(${clause})`).join(" OR ")}` : ""}
       ORDER BY updated_at DESC
       LIMIT $${values.length}`,
      values
    );
    const ids = topicResult.rows.map((row) => row.id).filter(Boolean);
    let edgeRows = [];
    let neighborRows = [];
    if (ids.length) {
      const edgeResult = await this.pool.query(
        `SELECT edge.id, from_topic.topic_key AS "fromTopicKey",
                from_topic.canonical_name AS "fromName",
                to_topic.topic_key AS "toTopicKey",
                to_topic.canonical_name AS "toName",
                to_topic.topic_type AS "toType",
                edge.edge_type AS "edgeType", edge.confidence,
                edge.evidence_count AS "evidenceCount", edge.notes
         FROM research_topic_edges edge
         JOIN research_topics from_topic ON from_topic.id = edge.from_topic_id
         JOIN research_topics to_topic ON to_topic.id = edge.to_topic_id
         WHERE edge.from_topic_id = ANY($1::bigint[]) OR edge.to_topic_id = ANY($1::bigint[])
         ORDER BY edge.confidence DESC, edge.evidence_count DESC, edge.updated_at DESC
         LIMIT 120`,
        [ids]
      );
      edgeRows = edgeResult.rows;
      const neighborKeys = mergeResearchUnique(
        edgeRows.flatMap((edge) => [edge.fromTopicKey, edge.toTopicKey]).filter(Boolean),
        (item) => item,
        120
      );
      if (neighborKeys.length) {
        const neighborResult = await this.pool.query(
          `SELECT topic_key AS "topicKey", canonical_name AS "canonicalName",
                  topic_type AS "topicType", aliases, description, metadata,
                  updated_at AS "updatedAt"
           FROM research_topics
           WHERE topic_key = ANY($1::text[])
           ORDER BY updated_at DESC`,
          [neighborKeys]
        );
        neighborRows = neighborResult.rows;
      }
    }
    return {
      query,
      topics: mergeResearchUnique([...topicResult.rows, ...neighborRows], (item) => item.topicKey, 120),
      edges: edgeRows
    };
  }

  async listResearchEvidenceForReport({ query = "", limit = 10, evidenceLimit = 80, topicMap = null } = {}) {
    const effectiveTopicMap = topicMap || await this.getResearchTopicMap({ query });
    const graphTerms = (effectiveTopicMap?.topics || []).flatMap((topic) => [
      topic.canonicalName,
      ...(topic.aliases || [])
    ]);
    const terms = splitResearchTerms(query, graphTerms).slice(0, 24);
    const topicKeys = mergeResearchUnique((effectiveTopicMap?.topics || []).map((topic) => topic.topicKey).filter(Boolean), (item) => item, 120);
    const safeLimit = Math.max(1, Math.min(30, Number(limit) || 10));
    const sourceValues = [];
    const clauses = terms.map((term) => {
      sourceValues.push(`%${term}%`);
      const slot = `$${sourceValues.length}`;
      return [
        `s.title ILIKE ${slot}`,
        `s.author ILIKE ${slot}`,
        `s.organization ILIKE ${slot}`,
        `s.source_type ILIKE ${slot}`,
        `s.platform ILIKE ${slot}`,
        `s.raw_text ILIKE ${slot}`,
        `s.metadata::text ILIKE ${slot}`,
        `e.claim ILIKE ${slot}`,
        `e.quote_original ILIKE ${slot}`,
        `e.why_it_matters ILIKE ${slot}`
      ].join(" OR ");
    });
    if (topicKeys.length) {
      sourceValues.push(topicKeys);
      clauses.push(`t.topic_key = ANY($${sourceValues.length}::text[])`);
    }
    sourceValues.push(safeLimit);
    const sourceResult = await this.pool.query(
      `SELECT DISTINCT s.source_id AS "sourceId", s.source_type AS "sourceType", s.platform,
              s.url, s.title, s.author, s.organization, s.published_at AS "publishedAt",
              s.recorded_at AS "recordedAt", s.event_period AS "eventPeriod",
              s.fetched_at AS "fetchedAt", s.analyzed_at AS "analyzedAt", s.language,
              s.duration_text AS "durationText", s.doc_url AS "docUrl",
              s.obsidian_path AS "obsidianPath", s.reliability_level AS "reliabilityLevel",
              s.source_perspective AS "sourcePerspective", s.institution_type AS "institutionType",
              s.institution_role AS "institutionRole", s.analysis_lenses AS "analysisLenses",
              s.evidence_strength AS "evidenceStrength", s.access_level AS "accessLevel",
              s.conflict_profile AS "conflictProfile", s.metadata,
              s.created_at AS "createdAt", s.updated_at AS "updatedAt"
       FROM research_sources s
       LEFT JOIN research_evidence_cards e ON e.source_id = s.source_id
       LEFT JOIN research_evidence_topics et ON et.evidence_card_id = e.id
       LEFT JOIN research_topics t ON t.id = et.topic_id
       ${clauses.length ? `WHERE ${clauses.map((clause) => `(${clause})`).join(" OR ")}` : ""}
       ORDER BY s.analyzed_at DESC NULLS LAST, s.created_at DESC
       LIMIT $${sourceValues.length}`,
      sourceValues
    );
    const sourceIds = sourceResult.rows.map((row) => row.sourceId).filter(Boolean);
    if (!sourceIds.length) {
      return { sources: [], evidenceCards: [], entities: [], timeContexts: [], questions: [], coverageGaps: [], topicMap: effectiveTopicMap };
    }
    const safeEvidenceLimit = Math.max(1, Math.min(300, Number(evidenceLimit) || 80));
    const [evidenceCards, entities, timeContexts, questions, coverageGaps] = await Promise.all([
      this.pool.query(
        `SELECT id, source_id AS "sourceId", evidence_type AS "evidenceType", claim,
                quote_original AS "quoteOriginal", quote_zh AS "quoteZh", location,
                why_it_matters AS "whyItMatters", confidence, time_sensitivity AS "timeSensitivity",
                stale_risk AS "staleRisk", evidence_strength AS "evidenceStrength",
                analysis_lens AS "analysisLens", requires_recheck AS "requiresRecheck", metadata,
                created_at AS "createdAt"
         FROM research_evidence_cards
         WHERE source_id = ANY($1::text[])
         ORDER BY confidence DESC, id ASC
         LIMIT $2`,
        [sourceIds, safeEvidenceLimit]
      ),
      this.pool.query(
        `SELECT se.source_id AS "sourceId", e.entity_id AS "entityId", e.name,
                e.entity_type AS "entityType", se.role, e.metadata
         FROM research_source_entities se
         JOIN research_entities e ON e.entity_id = se.entity_id
         WHERE se.source_id = ANY($1::text[])
         ORDER BY se.source_id ASC, se.role ASC, e.name ASC`,
        [sourceIds]
      ),
      this.pool.query(
        `SELECT source_id AS "sourceId", video_published_at AS "videoPublishedAt",
                likely_recorded_at AS "likelyRecordedAt", event_period AS "eventPeriod",
                industry_stage_at_that_time AS "industryStageAtThatTime",
                current_relevance AS "currentRelevance", time_sensitivity AS "timeSensitivity",
                stale_if AS "staleIf", requires_recheck AS "requiresRecheck", metadata,
                updated_at AS "updatedAt"
         FROM research_time_contexts
         WHERE source_id = ANY($1::text[])
         ORDER BY source_id ASC`,
        [sourceIds]
      ),
      this.pool.query(
        `SELECT id, source_id AS "sourceId", question, related_entities AS "relatedEntities",
                priority, research_direction AS "researchDirection",
                suggested_source_types AS "suggestedSourceTypes", status, metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_questions
         WHERE source_id = ANY($1::text[])
         ORDER BY priority ASC, updated_at DESC`,
        [sourceIds]
      ),
      this.pool.query(
        `SELECT id, source_id AS "sourceId", gap, impact, fallback_signals AS "fallbackSignals",
                confidence_impact AS "confidenceImpact", status, metadata,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM research_coverage_gaps
         WHERE source_id = ANY($1::text[])
         ORDER BY updated_at DESC`,
        [sourceIds]
      )
    ]);
    return {
      sources: sourceResult.rows,
      evidenceCards: evidenceCards.rows,
      entities: entities.rows,
      timeContexts: timeContexts.rows,
      questions: questions.rows,
      coverageGaps: coverageGaps.rows,
      topicMap: effectiveTopicMap
    };
  }

  async getPriorInvestmentReport({ query = "", topicMap = null } = {}) {
    const topicKey = normalizeResearchTopicKey(
      topicMap?.topics?.[0]?.canonicalName || query
    );
    const result = await this.pool.query(
      `SELECT job.id, job.output, job.updated_at AS "updatedAt",
              version.report_topic AS "reportTopic",
              version.report_topic_key AS "reportTopicKey",
              version.version_no AS "versionNo",
              version.evidence_cutoff_at AS "evidenceCutoffAt",
              version.source_count AS "sourceCount",
              version.evidence_count AS "evidenceCount",
              version.topic_count AS "topicCount",
              version.delta_summary AS "deltaSummary",
              version.metadata
       FROM research_report_versions version
       JOIN research_jobs job ON job.id = version.job_id
       WHERE version.report_topic_key = $1
          OR version.report_topic ILIKE $2
       ORDER BY version.version_no DESC, version.created_at DESC
       LIMIT 1`,
      [topicKey, `%${String(query || "").trim()}%`]
    );
    return result.rows[0] || null;
  }

  async getReusableInvestmentReport({ query = "", topicMap = null, maxAgeMinutes = 720 } = {}) {
    const maxAge = Math.max(1, Math.min(10080, Number(maxAgeMinutes) || 720));
    const prior = await this.getPriorInvestmentReport({ query, topicMap });
    const output = prior?.output || {};
    const feishuDocUrl = output.feishuDocUrl || output.feishu_doc_url || "";
    if (!prior || !feishuDocUrl) return null;

    const evidenceCutoff = prior.evidenceCutoffAt || prior.evidence_cutoff_at || prior.updatedAt || prior.updated_at || "";
    const createdAt = new Date(evidenceCutoff);
    if (!Number.isFinite(createdAt.getTime())) return null;
    if (Date.now() - createdAt.getTime() > maxAge * 60 * 1000) return null;

    const graphTerms = (topicMap?.topics || []).flatMap((topic) => [
      topic.canonicalName,
      ...(topic.aliases || [])
    ]);
    const terms = splitResearchTerms(query, graphTerms).slice(0, 24);
    const values = [evidenceCutoff];
    const clauses = terms.map((term) => {
      values.push(`%${term}%`);
      const slot = `$${values.length}`;
      return [
        `title ILIKE ${slot}`,
        `author ILIKE ${slot}`,
        `organization ILIKE ${slot}`,
        `source_type ILIKE ${slot}`,
        `platform ILIKE ${slot}`,
        `raw_text ILIKE ${slot}`,
        `metadata::text ILIKE ${slot}`
      ].join(" OR ");
    });
    const newerResult = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM research_sources
       WHERE COALESCE(analyzed_at, created_at) > $1::timestamptz
       ${clauses.length ? `AND (${clauses.map((clause) => `(${clause})`).join(" OR ")})` : ""}`,
      values
    );
    const newerSources = Number(newerResult.rows[0]?.count || 0);
    if (newerSources > 0) return null;
    return {
      ...prior,
      feishuDocUrl,
      reusable: true,
      reason: "no_new_relevant_sources_since_prior_report"
    };
  }

  async recordInvestmentReportVersion({
    jobId = "",
    query = "",
    topicMap = null,
    structured = {},
    pack = {},
    priorReport = null
  } = {}) {
    const topicName = cleanResearchText(topicMap?.topics?.[0]?.canonicalName || query, 180);
    const topicKey = normalizeResearchTopicKey(topicName || query);
    const maxResult = await this.pool.query(
      `SELECT COALESCE(MAX(version_no), 0)::int AS max_version
       FROM research_report_versions
       WHERE report_topic_key = $1`,
      [topicKey]
    );
    const versionNo = Number(maxResult.rows[0]?.max_version || 0) + 1;
    await this.pool.query(
      `INSERT INTO research_report_versions (
         job_id, report_topic, report_topic_key, version_no, prior_job_id,
         source_count, evidence_count, topic_count, delta_summary, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_id)
       DO UPDATE SET report_topic = EXCLUDED.report_topic,
                     report_topic_key = EXCLUDED.report_topic_key,
                     version_no = EXCLUDED.version_no,
                     prior_job_id = EXCLUDED.prior_job_id,
                     source_count = EXCLUDED.source_count,
                     evidence_count = EXCLUDED.evidence_count,
                     topic_count = EXCLUDED.topic_count,
                     delta_summary = EXCLUDED.delta_summary,
                     metadata = EXCLUDED.metadata`,
      [
        String(jobId || ""),
        topicName || String(query || ""),
        topicKey,
        versionNo,
        priorReport?.id || priorReport?.jobId || null,
        Number(pack.sources?.length || 0),
        Number(pack.evidenceCards?.length || 0),
        Number(topicMap?.topics?.length || 0),
        String(structured.deltaSincePrior || structured.oneSentence || "").slice(0, 1000),
        JSON.stringify({
          title: structured.title || "",
          oneSentence: structured.oneSentence || "",
          thesis: structured.thesis || "",
          priorVersionNo: priorReport?.versionNo || null,
          topicKeys: (topicMap?.topics || []).map((topic) => topic.topicKey).slice(0, 60)
        })
      ]
    );

    const hypotheses = asResearchArray(structured.hypotheses).slice(0, 8);
    for (const hypothesis of hypotheses) {
      const thesis = cleanResearchText(hypothesis.title || hypothesis.logic || hypothesis.hypothesis || "", 900);
      if (!thesis) continue;
      await this.pool.query(
        `INSERT INTO research_thesis_ledger (
           report_job_id, topic_key, thesis, thesis_type, conviction,
           evidence_card_ids, counter_evidence_card_ids, time_horizon, status, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          String(jobId || ""),
          topicKey,
          thesis,
          "industry_chain_hypothesis",
          String(hypothesis.confidence || "medium").slice(0, 120),
          JSON.stringify(hypothesis.evidenceIds || []),
          JSON.stringify(hypothesis.counterEvidenceIds || []),
          String(hypothesis.timeRisk || "").slice(0, 300),
          "active",
          JSON.stringify({ versionNo })
        ]
      );
    }

    return { topicKey, versionNo };
  }

  async listYoutubeResearchHistoryForBackfill({ query = "", limit = 12 } = {}) {
    const terms = String(query || "")
      .split(/[\/,，、\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 10);
    const values = [];
    const clauses = terms.map((term) => {
      values.push(`%${term}%`);
      const slot = `$${values.length}`;
      return `(content ILIKE ${slot} OR metadata::text ILIKE ${slot})`;
    });
    values.push(Math.max(1, Math.min(30, Number(limit) || 12)));
    const result = await this.pool.query(
      `SELECT content, metadata, created_at AS "createdAt"
       FROM chat_messages
       WHERE metadata->>'youtubeResearch' = 'true'
         AND (metadata->>'feishuDocUrl') IS NOT NULL
         ${clauses.length ? `AND (${clauses.join(" OR ")})` : ""}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values
    );
    return result.rows;
  }
}

class JsonFileStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      messages: [],
      memories: [],
      summaries: {},
      settings: {},
      projects: [],
      projectTasks: [],
      projectArtifacts: [],
      projectSources: [],
      projectAssets: [],
      researchJobs: [],
      researchReferenceSources: [],
      researchSources: [],
      researchEvidenceCards: [],
      researchEntities: [],
      researchSourceEntities: [],
      researchTimeContexts: [],
      researchQuestions: [],
      researchCoverageGaps: [],
      researchTopics: [],
      researchTopicEdges: [],
      researchEvidenceTopics: [],
      researchReportVersions: [],
      researchThesisLedger: []
    };
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.state.summaries = normalizeSummaries(this.state.summaries);
      this.state.settings = normalizeSettings(this.state.settings);
      this.state.projects = Array.isArray(this.state.projects) ? this.state.projects : [];
      this.state.projectTasks = Array.isArray(this.state.projectTasks) ? this.state.projectTasks : [];
      this.state.projectArtifacts = Array.isArray(this.state.projectArtifacts) ? this.state.projectArtifacts : [];
      this.state.projectSources = Array.isArray(this.state.projectSources) ? this.state.projectSources : [];
      this.state.projectAssets = Array.isArray(this.state.projectAssets) ? this.state.projectAssets : [];
      this.state.researchJobs = Array.isArray(this.state.researchJobs) ? this.state.researchJobs : [];
      this.state.researchReferenceSources = Array.isArray(this.state.researchReferenceSources) ? this.state.researchReferenceSources : [];
      this.state.researchSources = Array.isArray(this.state.researchSources) ? this.state.researchSources : [];
      this.state.researchEvidenceCards = Array.isArray(this.state.researchEvidenceCards) ? this.state.researchEvidenceCards : [];
      this.state.researchEntities = Array.isArray(this.state.researchEntities) ? this.state.researchEntities : [];
      this.state.researchSourceEntities = Array.isArray(this.state.researchSourceEntities) ? this.state.researchSourceEntities : [];
      this.state.researchTimeContexts = Array.isArray(this.state.researchTimeContexts) ? this.state.researchTimeContexts : [];
      this.state.researchQuestions = Array.isArray(this.state.researchQuestions) ? this.state.researchQuestions : [];
      this.state.researchCoverageGaps = Array.isArray(this.state.researchCoverageGaps) ? this.state.researchCoverageGaps : [];
      this.state.researchTopics = Array.isArray(this.state.researchTopics) ? this.state.researchTopics : [];
      this.state.researchTopicEdges = Array.isArray(this.state.researchTopicEdges) ? this.state.researchTopicEdges : [];
      this.state.researchEvidenceTopics = Array.isArray(this.state.researchEvidenceTopics) ? this.state.researchEvidenceTopics : [];
      this.state.researchReportVersions = Array.isArray(this.state.researchReportVersions) ? this.state.researchReportVersions : [];
      this.state.researchThesisLedger = Array.isArray(this.state.researchThesisLedger) ? this.state.researchThesisLedger : [];
    } catch {
      await this.flush();
    }
  }

  async flush() {
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  async addMessage(message) {
    this.state.messages.push({
      ...message,
      chatId: String(message.chatId),
      userId: String(message.userId || ""),
      createdAt: new Date().toISOString()
    });
    if (this.state.messages.length > 5000) {
      this.state.messages = this.state.messages.slice(-4000);
    }
    await this.flush();
  }

  async getRecentMessages(chatId, limit, userId = null) {
    const hasUserFilter = userId !== null && userId !== undefined;
    return this.state.messages
      .filter((message) => {
        return String(message.chatId) === String(chatId) &&
          (!hasUserFilter || String(message.userId || "") === String(userId || ""));
      })
      .slice(-limit)
      .map((message) => ({
        role: message.role,
        content: message.content,
        modality: message.modality || "text",
        user_id: message.userId || "",
        metadata: message.metadata || {},
        created_at: message.createdAt
      }));
  }

  async countMessages(chatId, userId = null) {
    const hasUserFilter = userId !== null && userId !== undefined;
    return this.state.messages.filter((message) => {
      return String(message.chatId) === String(chatId) &&
        (!hasUserFilter || String(message.userId || "") === String(userId || ""));
    }).length;
  }

  async isEmpty() {
    return (
      this.state.messages.length === 0 &&
      this.state.memories.length === 0 &&
      Object.keys(this.state.summaries || {}).length === 0 &&
      this.state.projects.length === 0
    );
  }

  async exportState() {
    return {
      messages: this.state.messages,
      memories: this.state.memories,
      summaries: Object.entries(this.state.summaries || {}).map(([key, summary]) => ({
        ...parseSummaryKey(key),
        summary
      })),
      settings: Object.entries(this.state.settings || {}).map(([key, value]) => ({ key, value })),
      projects: this.state.projects,
      projectTasks: this.state.projectTasks,
      projectArtifacts: this.state.projectArtifacts,
      projectSources: this.state.projectSources,
      projectAssets: this.state.projectAssets,
      researchJobs: this.state.researchJobs,
      researchReferenceSources: this.state.researchReferenceSources,
      researchSources: this.state.researchSources,
      researchEvidenceCards: this.state.researchEvidenceCards,
      researchEntities: this.state.researchEntities,
      researchSourceEntities: this.state.researchSourceEntities,
      researchTimeContexts: this.state.researchTimeContexts,
      researchQuestions: this.state.researchQuestions,
      researchCoverageGaps: this.state.researchCoverageGaps,
      researchTopics: this.state.researchTopics,
      researchTopicEdges: this.state.researchTopicEdges,
      researchEvidenceTopics: this.state.researchEvidenceTopics,
      researchReportVersions: this.state.researchReportVersions,
      researchThesisLedger: this.state.researchThesisLedger
    };
  }

  async importState(state) {
    this.state = {
      messages: Array.isArray(state.messages) ? state.messages : [],
      memories: Array.isArray(state.memories) ? state.memories : [],
      summaries: normalizeSummaries(state.summaries),
      settings: normalizeSettings(state.settings),
      projects: Array.isArray(state.projects) ? state.projects : [],
      projectTasks: Array.isArray(state.projectTasks) ? state.projectTasks : [],
      projectArtifacts: Array.isArray(state.projectArtifacts) ? state.projectArtifacts : [],
      projectSources: Array.isArray(state.projectSources) ? state.projectSources : [],
      projectAssets: Array.isArray(state.projectAssets) ? state.projectAssets : [],
      researchJobs: Array.isArray(state.researchJobs) ? state.researchJobs : [],
      researchReferenceSources: Array.isArray(state.researchReferenceSources) ? state.researchReferenceSources : [],
      researchSources: Array.isArray(state.researchSources) ? state.researchSources : [],
      researchEvidenceCards: Array.isArray(state.researchEvidenceCards) ? state.researchEvidenceCards : [],
      researchEntities: Array.isArray(state.researchEntities) ? state.researchEntities : [],
      researchSourceEntities: Array.isArray(state.researchSourceEntities) ? state.researchSourceEntities : [],
      researchTimeContexts: Array.isArray(state.researchTimeContexts) ? state.researchTimeContexts : [],
      researchQuestions: Array.isArray(state.researchQuestions) ? state.researchQuestions : [],
      researchCoverageGaps: Array.isArray(state.researchCoverageGaps) ? state.researchCoverageGaps : [],
      researchTopics: Array.isArray(state.researchTopics) ? state.researchTopics : [],
      researchTopicEdges: Array.isArray(state.researchTopicEdges) ? state.researchTopicEdges : [],
      researchEvidenceTopics: Array.isArray(state.researchEvidenceTopics) ? state.researchEvidenceTopics : [],
      researchReportVersions: Array.isArray(state.researchReportVersions) ? state.researchReportVersions : [],
      researchThesisLedger: Array.isArray(state.researchThesisLedger) ? state.researchThesisLedger : []
    };
    await this.flush();
  }

  async listChats(limit = 100) {
    const ids = new Set();
    for (const message of this.state.messages) ids.add(String(message.chatId));
    for (const memory of this.state.memories) ids.add(String(memory.chatId));
    for (const key of Object.keys(this.state.summaries || {})) {
      ids.add(String(parseSummaryKey(key).chatId));
    }

    const rows = [...ids].map((chatId) => {
      const messages = this.state.messages.filter((message) => String(message.chatId) === chatId);
      const memories = this.state.memories.filter((memory) => String(memory.chatId) === chatId);
      const lastMessage = messages[messages.length - 1];
      const lastMemory = memories
        .slice()
        .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];

      return {
        chat_id: chatId,
        message_count: messages.length,
        memory_count: memories.length,
        last_message_at: lastMessage?.createdAt || null,
        last_memory_at: lastMemory?.updatedAt || lastMemory?.createdAt || null,
        summary_updated_at: this.state.summaries[summaryKey(chatId)] ? null : null
      };
    });

    return rows
      .sort((a, b) => String(b.last_message_at || b.last_memory_at || "").localeCompare(String(a.last_message_at || a.last_memory_at || "")))
      .slice(0, limit);
  }

  async getMemories(chatId, userId, limit) {
    return this.state.memories
      .filter((memory) => {
        return String(memory.chatId) === String(chatId) && (!memory.userId || String(memory.userId) === String(userId || ""));
      })
      .sort((a, b) => (b.importance || 3) - (a.importance || 3))
      .slice(0, limit)
      .map((memory) => ({
        key: memory.key,
        value: memory.value,
        importance: memory.importance || 3,
        user_id: memory.userId || "",
        updated_at: memory.updatedAt
      }));
  }

  async listMemories(chatId, limit = 300) {
    return this.state.memories
      .filter((memory) => String(memory.chatId) === String(chatId))
      .sort((a, b) => {
        const importanceDelta = (b.importance || 3) - (a.importance || 3);
        if (importanceDelta !== 0) return importanceDelta;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      })
      .slice(0, limit)
      .map((memory) => ({
        key: memory.key,
        value: memory.value,
        importance: memory.importance || 3,
        user_id: memory.userId || "",
        created_at: memory.createdAt || null,
        updated_at: memory.updatedAt || null
      }));
  }

  async listUsers(chatId, limit = 300) {
    const byId = new Map();
    for (const message of this.state.messages) {
      if (String(message.chatId) !== String(chatId) || !message.userId) continue;
      const row = byId.get(String(message.userId)) || {
        user_id: String(message.userId),
        username: "",
        first_name: "",
        last_name: "",
        message_count: 0,
        memory_count: 0,
        last_message_at: null,
        last_memory_at: null
      };
      row.username = message.metadata?.username || row.username;
      row.first_name = message.metadata?.firstName || row.first_name;
      row.last_name = message.metadata?.lastName || row.last_name;
      row.message_count += 1;
      row.last_message_at = message.createdAt || row.last_message_at;
      byId.set(row.user_id, row);
    }

    for (const memory of this.state.memories) {
      if (String(memory.chatId) !== String(chatId) || !memory.userId) continue;
      const row = byId.get(String(memory.userId)) || {
        user_id: String(memory.userId),
        username: "",
        first_name: "",
        last_name: "",
        message_count: 0,
        memory_count: 0,
        last_message_at: null,
        last_memory_at: null
      };
      row.memory_count += 1;
      row.last_memory_at = memory.updatedAt || memory.createdAt || row.last_memory_at;
      byId.set(row.user_id, row);
    }

    return [...byId.values()]
      .sort((a, b) => String(b.last_message_at || b.last_memory_at || "").localeCompare(String(a.last_message_at || a.last_memory_at || "")))
      .slice(0, limit);
  }

  async setMemory(chatId, userId, memory) {
    const key = normalizeKey(memory.key);
    if (!key || !memory.value) return;

    const existing = this.state.memories.find((item) => {
      return String(item.chatId) === String(chatId) && String(item.userId || "") === String(userId || "") && item.key === key;
    });

    if (existing) {
      existing.value = String(memory.value).slice(0, 1000);
      existing.importance = Math.max(1, Math.min(5, Number(memory.importance) || 3));
      existing.updatedAt = new Date().toISOString();
    } else {
      this.state.memories.push({
        chatId: String(chatId),
        userId: String(userId || ""),
        key,
        value: String(memory.value).slice(0, 1000),
        importance: Math.max(1, Math.min(5, Number(memory.importance) || 3)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    await this.flush();
  }

  async upsertMemories(chatId, userId, memories) {
    for (const memory of memories) {
      const key = normalizeKey(memory.key);
      if (!key || !memory.value) continue;

      const existing = this.state.memories.find((item) => {
        return String(item.chatId) === String(chatId) && String(item.userId || "") === String(userId || "") && item.key === key;
      });

      if (existing) {
        existing.value = String(memory.value).slice(0, 1000);
        existing.importance = Math.max(existing.importance || 3, Number(memory.importance) || 3);
        existing.updatedAt = new Date().toISOString();
      } else {
        this.state.memories.push({
          chatId: String(chatId),
          userId: String(userId || ""),
          key,
          value: String(memory.value).slice(0, 1000),
          importance: Math.max(1, Math.min(5, Number(memory.importance) || 3)),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
    await this.flush();
  }

  async deleteMemory(chatId, userId, key) {
    const normalized = normalizeKey(key);
    this.state.memories = this.state.memories.filter((memory) => {
      return !(
        String(memory.chatId) === String(chatId) &&
        String(memory.userId || "") === String(userId || "") &&
        memory.key === normalized
      );
    });
    await this.flush();
  }

  async getSummary(chatId, userId = "") {
    return this.state.summaries[summaryKey(chatId, userId)] || "";
  }

  async setSummary(chatId, summary, userId = "") {
    this.state.summaries[summaryKey(chatId, userId)] = String(summary).slice(0, 4000);
    await this.flush();
  }

  async clearChat(chatId) {
    this.state.messages = this.state.messages.filter((message) => String(message.chatId) !== String(chatId));
    this.state.memories = this.state.memories.filter((memory) => String(memory.chatId) !== String(chatId));
    for (const key of Object.keys(this.state.summaries || {})) {
      if (String(parseSummaryKey(key).chatId) === String(chatId)) {
        delete this.state.summaries[key];
      }
    }
    await this.flush();
  }

  async createProject(project) {
    const now = new Date().toISOString();
    const existing = this.state.projects.find((item) => String(item.id) === String(project.id));
    const row = {
      id: String(project.id),
      platform: String(project.platform || ""),
      chat_id: String(project.chatId || project.chat_id || ""),
      owner_user_id: String(project.ownerUserId || project.owner_user_id || ""),
      title: String(project.title || "").slice(0, 300),
      client_name: String(project.clientName || project.client_name || "").slice(0, 200),
      product_name: String(project.productName || project.product_name || "").slice(0, 200),
      brief_text: String(project.briefText || project.brief_text || ""),
      status: String(project.status || "draft").slice(0, 40),
      metadata: project.metadata || {},
      created_at: existing?.created_at || now,
      updated_at: now
    };
    if (existing) {
      Object.assign(existing, row);
    } else {
      this.state.projects.push(row);
    }
    await this.flush();
  }

  async updateProject(projectId, updates = {}) {
    const existing = await this.getProject(projectId);
    if (!existing) return;
    await this.createProject({
      id: existing.id,
      platform: existing.platform,
      chatId: existing.chat_id,
      ownerUserId: existing.owner_user_id,
      title: updates.title ?? existing.title,
      clientName: updates.clientName ?? existing.client_name,
      productName: updates.productName ?? existing.product_name,
      briefText: updates.briefText ?? existing.brief_text,
      status: updates.status ?? existing.status,
      metadata: updates.metadata ?? existing.metadata ?? {}
    });
  }

  async getProject(projectId) {
    return this.state.projects.find((item) => String(item.id) === String(projectId)) || null;
  }

  async listProjects(chatId = "", limit = 50) {
    return this.state.projects
      .filter((item) => !chatId || String(item.chat_id) === String(chatId))
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
      .slice(0, limit);
  }

  async addProjectTask(task) {
    const id = this.state.projectTasks.length + 1;
    const now = new Date().toISOString();
    this.state.projectTasks.push({
      id,
      project_id: String(task.projectId || ""),
      agent_type: String(task.agentType || ""),
      status: String(task.status || "pending"),
      input: task.input || {},
      output: task.output || {},
      error: String(task.error || ""),
      created_at: now,
      updated_at: now
    });
    await this.flush();
    return id;
  }

  async addProjectArtifact(artifact) {
    const id = this.state.projectArtifacts.length + 1;
    this.state.projectArtifacts.push({
      id,
      project_id: String(artifact.projectId || ""),
      artifact_type: String(artifact.artifactType || ""),
      title: String(artifact.title || "").slice(0, 300),
      url: String(artifact.url || ""),
      token: String(artifact.token || ""),
      content_summary: String(artifact.contentSummary || ""),
      metadata: artifact.metadata || {},
      created_at: new Date().toISOString()
    });
    await this.flush();
    return id;
  }

  async listProjectArtifacts(projectId) {
    return this.state.projectArtifacts
      .filter((item) => String(item.project_id) === String(projectId))
      .sort((a, b) => (a.id || 0) - (b.id || 0));
  }

  async getSetting(key, fallback = "") {
    return this.state.settings?.[String(key)] ?? fallback;
  }

  async setSetting(key, value) {
    this.state.settings = this.state.settings || {};
    this.state.settings[String(key)] = String(value ?? "").slice(0, 1000);
    await this.flush();
  }

  async upsertResearchJob(job = {}) {
    const now = new Date().toISOString();
    const id = String(job.id || "");
    const row = {
      id,
      source_type: String(job.sourceType || job.source_type || ""),
      source_url: String(job.sourceUrl || job.source_url || ""),
      status: String(job.status || "pending"),
      stage: String(job.stage || ""),
      attempts: Number(job.attempts || 0),
      input: job.input || {},
      output: job.output || {},
      error: String(job.error || ""),
      created_at: now,
      updated_at: now
    };
    const index = this.state.researchJobs.findIndex((item) => String(item.id) === id);
    if (index >= 0) {
      row.created_at = this.state.researchJobs[index].created_at || now;
      this.state.researchJobs[index] = row;
    } else {
      this.state.researchJobs.push(row);
    }
    await this.flush();
    return id;
  }

  async updateResearchJob(jobId, updates = {}) {
    const row = this.state.researchJobs.find((item) => String(item.id) === String(jobId));
    if (!row) return;
    if (updates.status !== undefined) row.status = String(updates.status || "");
    if (updates.stage !== undefined) row.stage = String(updates.stage || "");
    if (updates.attempts !== undefined) row.attempts = Number(updates.attempts || 0);
    if (updates.output !== undefined) row.output = updates.output || {};
    if (updates.error !== undefined) row.error = String(updates.error || "");
    row.updated_at = new Date().toISOString();
    await this.flush();
  }

  async hasResearchSource(sourceId = "") {
    return this.state.researchSources.some((source) => String(source.source_id) === String(sourceId || ""));
  }

  upsertResearchTopicGraph({ bundle = {}, evidenceCards = [] } = {}) {
    const now = new Date().toISOString();
    const candidates = buildResearchTopicCandidates(bundle);
    if (!candidates.length) return { topics: 0, edges: 0, evidenceTopicLinks: 0 };

    const topicByKey = new Map(this.state.researchTopics.map((topic) => [String(topic.topic_key), topic]));
    const nextTopicId = () => (this.state.researchTopics.reduce((max, topic) => Math.max(max, Number(topic.id || 0)), 0) + 1);
    for (const topic of candidates) {
      const existing = topicByKey.get(topic.topicKey);
      if (existing) {
        existing.aliases = mergeResearchUnique([...(existing.aliases || []), ...(topic.aliases || [])], (item) => String(item).toLowerCase(), 24);
        if (!existing.canonical_name) existing.canonical_name = topic.canonicalName;
        if (existing.topic_type === "theme" && topic.topicType) existing.topic_type = topic.topicType;
        existing.metadata = { ...(existing.metadata || {}), lastRole: topic.role || "" };
        existing.updated_at = now;
      } else {
        const row = {
          id: nextTopicId(),
          topic_key: topic.topicKey,
          canonical_name: topic.canonicalName,
          topic_type: topic.topicType || "theme",
          aliases: topic.aliases || [],
          description: "",
          metadata: { lastRole: topic.role || "", source: "research_ingestion" },
          created_at: now,
          updated_at: now
        };
        this.state.researchTopics.push(row);
        topicByKey.set(topic.topicKey, row);
      }
    }

    let edges = 0;
    for (const edge of buildResearchTopicEdges(candidates)) {
      const from = topicByKey.get(edge.fromTopicKey);
      const to = topicByKey.get(edge.toTopicKey);
      if (!from?.id || !to?.id || from.id === to.id) continue;
      const existing = this.state.researchTopicEdges.find((item) =>
        String(item.from_topic_key) === edge.fromTopicKey &&
        String(item.to_topic_key) === edge.toTopicKey &&
        String(item.edge_type) === String(edge.edgeType)
      );
      if (existing) {
        existing.confidence = Math.max(Number(existing.confidence || 0), Number(edge.confidence || 0.7));
        existing.evidence_count = Number(existing.evidence_count || 0) + Number(edge.evidenceCount || 1);
        existing.notes = edge.notes || existing.notes || "";
        existing.updated_at = now;
      } else {
        this.state.researchTopicEdges.push({
          id: this.state.researchTopicEdges.length + 1,
          from_topic_key: edge.fromTopicKey,
          to_topic_key: edge.toTopicKey,
          edge_type: edge.edgeType,
          confidence: Number(edge.confidence || 0.7),
          evidence_count: Number(edge.evidenceCount || 1),
          notes: edge.notes || "",
          metadata: { source: "research_ingestion" },
          created_at: now,
          updated_at: now
        });
      }
      edges += 1;
    }

    const primary = candidates.find((item) => item.role === "report_topic" || item.role === "explicit_topic") || candidates[0];
    let evidenceTopicLinks = 0;
    for (const item of evidenceCards || []) {
      if (!item.id) continue;
      const card = item.card || {};
      const text = [
        card.claim,
        card.quoteOriginal || card.quote_original,
        card.quoteZh || card.quote_zh,
        card.whyItMatters || card.why_it_matters,
        card.analysisLens || card.analysis_lens,
        JSON.stringify(card.metadata || {})
      ].join("\n");
      const matched = candidates.filter((topic) => topic.topicKey === primary.topicKey || textIncludesTopic(text, topic)).slice(0, 10);
      for (const topic of matched) {
        if (this.state.researchEvidenceTopics.some((link) =>
          Number(link.evidence_card_id) === Number(item.id) && String(link.topic_key) === topic.topicKey
        )) continue;
        this.state.researchEvidenceTopics.push({
          evidence_card_id: item.id,
          topic_key: topic.topicKey,
          relevance: topic.topicKey === primary.topicKey ? 0.95 : 0.72,
          match_type: topic.topicKey === primary.topicKey ? "primary_topic" : "text_match",
          created_at: now
        });
        evidenceTopicLinks += 1;
      }
    }

    return { topics: candidates.length, edges, evidenceTopicLinks };
  }

  async upsertResearchSourceBundle(bundle = {}) {
    const source = bundle.source || {};
    const sourceId = String(source.sourceId || source.source_id || "");
    if (!sourceId) throw new Error("research source bundle requires sourceId.");
    const now = new Date().toISOString();
    const sourceRow = {
      source_id: sourceId,
      source_type: String(source.sourceType || source.source_type || ""),
      platform: String(source.platform || ""),
      url: String(source.url || ""),
      title: String(source.title || "").slice(0, 500),
      author: String(source.author || ""),
      organization: String(source.organization || ""),
      published_at: String(source.publishedAt || source.published_at || ""),
      recorded_at: String(source.recordedAt || source.recorded_at || ""),
      event_period: String(source.eventPeriod || source.event_period || ""),
      fetched_at: source.fetchedAt || source.fetched_at || now,
      analyzed_at: source.analyzedAt || source.analyzed_at || now,
      language: String(source.language || ""),
      duration_text: String(source.durationText || source.duration_text || ""),
      raw_text: String(source.rawText || source.raw_text || ""),
      raw_text_hash: String(source.rawTextHash || source.raw_text_hash || ""),
      doc_url: String(source.docUrl || source.doc_url || ""),
      obsidian_path: String(source.obsidianPath || source.obsidian_path || ""),
      reliability_level: String(source.reliabilityLevel || source.reliability_level || ""),
      source_perspective: String(source.sourcePerspective || source.source_perspective || ""),
      institution_type: String(source.institutionType || source.institution_type || ""),
      institution_role: String(source.institutionRole || source.institution_role || ""),
      analysis_lenses: source.analysisLenses || source.analysis_lenses || [],
      evidence_strength: String(source.evidenceStrength || source.evidence_strength || ""),
      access_level: String(source.accessLevel || source.access_level || ""),
      conflict_profile: String(source.conflictProfile || source.conflict_profile || ""),
      metadata: source.metadata || {},
      created_at: now,
      updated_at: now
    };
    const existing = this.state.researchSources.findIndex((item) => String(item.source_id) === sourceId);
    if (existing >= 0) {
      sourceRow.created_at = this.state.researchSources[existing].created_at || now;
      this.state.researchSources[existing] = sourceRow;
    } else {
      this.state.researchSources.push(sourceRow);
    }

    const removedEvidenceIds = new Set(
      this.state.researchEvidenceCards
        .filter((item) => String(item.source_id) === sourceId)
        .map((item) => Number(item.id))
    );
    this.state.researchEvidenceTopics = this.state.researchEvidenceTopics.filter((item) => !removedEvidenceIds.has(Number(item.evidence_card_id)));
    this.state.researchEvidenceCards = this.state.researchEvidenceCards.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchQuestions = this.state.researchQuestions.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchTimeContexts = this.state.researchTimeContexts.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchSourceEntities = this.state.researchSourceEntities.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchCoverageGaps = this.state.researchCoverageGaps.filter((item) => String(item.source_id) !== sourceId);

    const insertedEvidenceCards = [];
    const nextEvidenceId = () => (
      this.state.researchEvidenceCards.reduce((max, card) => Math.max(max, Number(card.id || 0)), 0) + 1
    );
    for (const card of bundle.evidenceCards || []) {
      const row = {
        id: nextEvidenceId(),
        source_id: sourceId,
        evidence_type: String(card.evidenceType || card.evidence_type || ""),
        claim: String(card.claim || "").slice(0, 1200),
        quote_original: String(card.quoteOriginal || card.quote_original || "").slice(0, 2400),
        quote_zh: String(card.quoteZh || card.quote_zh || "").slice(0, 2400),
        location: String(card.location || "").slice(0, 120),
        why_it_matters: String(card.whyItMatters || card.why_it_matters || "").slice(0, 1200),
        confidence: Number(card.confidence || 0.7),
        time_sensitivity: String(card.timeSensitivity || card.time_sensitivity || ""),
        stale_risk: String(card.staleRisk || card.stale_risk || ""),
        evidence_strength: String(card.evidenceStrength || card.evidence_strength || ""),
        analysis_lens: String(card.analysisLens || card.analysis_lens || ""),
        requires_recheck: card.requiresRecheck || card.requires_recheck || [],
        metadata: card.metadata || {},
        created_at: now
      };
      this.state.researchEvidenceCards.push(row);
      insertedEvidenceCards.push({ id: row.id, card });
    }

    for (const entity of bundle.entities || []) {
      const entityId = String(entity.entityId || entity.entity_id || "");
      if (!entityId || !entity.name) continue;
      if (!this.state.researchEntities.some((item) => String(item.entity_id) === entityId)) {
        this.state.researchEntities.push({
          entity_id: entityId,
          name: String(entity.name || "").slice(0, 240),
          entity_type: String(entity.entityType || entity.entity_type || ""),
          metadata: entity.metadata || {},
          created_at: now,
          updated_at: now
        });
      }
      this.state.researchSourceEntities.push({
        source_id: sourceId,
        entity_id: entityId,
        role: String(entity.role || "mentioned"),
        metadata: entity.linkMetadata || {},
        created_at: now
      });
    }

    const context = bundle.timeContext || {};
    if (Object.keys(context).length) {
      this.state.researchTimeContexts.push({
        source_id: sourceId,
        video_published_at: String(context.videoPublishedAt || context.video_published_at || ""),
        likely_recorded_at: String(context.likelyRecordedAt || context.likely_recorded_at || ""),
        event_period: String(context.eventPeriod || context.event_period || ""),
        industry_stage_at_that_time: String(context.industryStageAtThatTime || context.industry_stage_at_that_time || ""),
        current_relevance: String(context.currentRelevance || context.current_relevance || ""),
        time_sensitivity: String(context.timeSensitivity || context.time_sensitivity || ""),
        stale_if: String(context.staleIf || context.stale_if || ""),
        requires_recheck: context.requiresRecheck || context.requires_recheck || [],
        metadata: context.metadata || {},
        updated_at: now
      });
    }

    for (const question of bundle.questions || []) {
      this.state.researchQuestions.push({
        id: this.state.researchQuestions.length + 1,
        source_id: sourceId,
        question: String(question.question || question || "").slice(0, 600),
        related_entities: question.relatedEntities || question.related_entities || [],
        priority: Math.max(1, Math.min(5, Number(question.priority) || 3)),
        research_direction: String(question.researchDirection || question.research_direction || ""),
        suggested_source_types: question.suggestedSourceTypes || question.suggested_source_types || [],
        status: String(question.status || "open"),
        metadata: question.metadata || {},
        created_at: now,
        updated_at: now
      });
    }

    for (const gap of bundle.coverageGaps || []) {
      this.state.researchCoverageGaps.push({
        id: this.state.researchCoverageGaps.length + 1,
        source_id: sourceId,
        gap: String(gap.gap || gap || "").slice(0, 600),
        impact: String(gap.impact || "").slice(0, 1000),
        fallback_signals: gap.fallbackSignals || gap.fallback_signals || [],
        confidence_impact: String(gap.confidenceImpact || gap.confidence_impact || ""),
        status: String(gap.status || "open"),
        metadata: gap.metadata || {},
        created_at: now,
        updated_at: now
      });
    }

    this.upsertResearchTopicGraph({ bundle, evidenceCards: insertedEvidenceCards });

    await this.flush();
    return {
      sourceId,
      evidenceCards: (bundle.evidenceCards || []).length,
      entities: (bundle.entities || []).length,
      questions: (bundle.questions || []).length,
      coverageGaps: (bundle.coverageGaps || []).length
    };
  }

  async getResearchTopicMap({ query = "", limit = 80 } = {}) {
    const terms = splitResearchTerms(query);
    const topicKeys = new Set(terms.map((term) => normalizeResearchTopicKey(term)));
    const matches = (topic) => {
      if (!terms.length) return true;
      const text = [
        topic.topic_key,
        topic.canonical_name,
        topic.topic_type,
        ...(topic.aliases || []),
        topic.description
      ].join("\n").toLowerCase();
      return terms.some((term) => text.includes(term.toLowerCase())) || topicKeys.has(String(topic.topic_key));
    };
    const topics = this.state.researchTopics
      .filter(matches)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
      .slice(0, Math.max(1, Math.min(120, Number(limit) || 80)));
    const matchedKeys = new Set(topics.map((topic) => String(topic.topic_key)));
    const edges = this.state.researchTopicEdges
      .filter((edge) => matchedKeys.has(String(edge.from_topic_key)) || matchedKeys.has(String(edge.to_topic_key)))
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, 120);
    const neighborKeys = new Set(edges.flatMap((edge) => [String(edge.from_topic_key), String(edge.to_topic_key)]));
    const neighbors = this.state.researchTopics.filter((topic) => neighborKeys.has(String(topic.topic_key)));
    return {
      query,
      topics: mergeResearchUnique([...topics, ...neighbors].map((topic) => ({
        id: topic.id,
        topicKey: topic.topic_key,
        canonicalName: topic.canonical_name,
        topicType: topic.topic_type,
        aliases: topic.aliases || [],
        description: topic.description || "",
        metadata: topic.metadata || {},
        updatedAt: topic.updated_at
      })), (item) => item.topicKey, 120),
      edges: edges.map((edge) => ({
        fromTopicKey: edge.from_topic_key,
        toTopicKey: edge.to_topic_key,
        edgeType: edge.edge_type,
        confidence: edge.confidence,
        evidenceCount: edge.evidence_count,
        notes: edge.notes
      }))
    };
  }

  async listResearchEvidenceForReport({ query = "", limit = 10, evidenceLimit = 80, topicMap = null } = {}) {
    const effectiveTopicMap = topicMap || await this.getResearchTopicMap({ query });
    const graphTerms = (effectiveTopicMap?.topics || []).flatMap((topic) => [
      topic.canonicalName,
      ...(topic.aliases || [])
    ]);
    const terms = splitResearchTerms(query, graphTerms).map((item) => item.toLowerCase()).slice(0, 24);
    const topicKeys = new Set((effectiveTopicMap?.topics || []).map((topic) => String(topic.topicKey)).filter(Boolean));
    const evidenceIdsByTopic = new Set(
      this.state.researchEvidenceTopics
        .filter((link) => topicKeys.has(String(link.topic_key)))
        .map((link) => Number(link.evidence_card_id))
    );
    const matches = (value) => {
      if (!terms.length) return true;
      const text = String(value || "").toLowerCase();
      return terms.some((term) => text.includes(term));
    };
    const sourceMatches = (source) => {
      const sourceEvidence = this.state.researchEvidenceCards.filter((card) => String(card.source_id) === String(source.source_id));
      if (sourceEvidence.some((card) => evidenceIdsByTopic.has(Number(card.id)))) return true;
      const text = [
        source.source_type,
        source.platform,
        source.url,
        source.title,
        source.author,
        source.organization,
        source.raw_text,
        JSON.stringify(source.metadata || {}),
        ...sourceEvidence.flatMap((card) => [card.claim, card.quote_original, card.why_it_matters])
      ].join("\n");
      return matches(text);
    };
    const sources = this.state.researchSources
      .filter(sourceMatches)
      .sort((a, b) => String(b.analyzed_at || b.created_at || "").localeCompare(String(a.analyzed_at || a.created_at || "")))
      .slice(0, Math.max(1, Math.min(30, Number(limit) || 10)));
    const sourceIds = new Set(sources.map((source) => String(source.source_id)).filter(Boolean));
    const evidenceCards = this.state.researchEvidenceCards
      .filter((card) => sourceIds.has(String(card.source_id)))
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, Math.max(1, Math.min(300, Number(evidenceLimit) || 80)));
    const entityIds = new Set(
      this.state.researchSourceEntities
        .filter((link) => sourceIds.has(String(link.source_id)))
        .map((link) => String(link.entity_id))
    );
    const entityById = new Map(this.state.researchEntities.map((entity) => [String(entity.entity_id), entity]));
    const entities = this.state.researchSourceEntities
      .filter((link) => sourceIds.has(String(link.source_id)) && entityIds.has(String(link.entity_id)))
      .map((link) => ({
        source_id: link.source_id,
        entity_id: link.entity_id,
        role: link.role,
        ...(entityById.get(String(link.entity_id)) || {})
      }));
    return {
      sources,
      evidenceCards,
      entities,
      timeContexts: this.state.researchTimeContexts.filter((item) => sourceIds.has(String(item.source_id))),
      questions: this.state.researchQuestions.filter((item) => sourceIds.has(String(item.source_id))),
      coverageGaps: this.state.researchCoverageGaps.filter((item) => sourceIds.has(String(item.source_id))),
      topicMap: effectiveTopicMap
    };
  }

  async getPriorInvestmentReport({ query = "", topicMap = null } = {}) {
    const topicKey = normalizeResearchTopicKey(topicMap?.topics?.[0]?.canonicalName || query);
    const queryText = String(query || "").toLowerCase();
    return this.state.researchReportVersions
      .filter((item) =>
        String(item.report_topic_key) === topicKey ||
        String(item.report_topic || "").toLowerCase().includes(queryText)
      )
      .sort((a, b) => Number(b.version_no || 0) - Number(a.version_no || 0))
      .map((version) => ({
        id: version.job_id,
        output: this.state.researchJobs.find((job) => String(job.id) === String(version.job_id))?.output || {},
        reportTopic: version.report_topic,
        reportTopicKey: version.report_topic_key,
        versionNo: version.version_no,
        evidenceCutoffAt: version.evidence_cutoff_at,
        sourceCount: version.source_count,
        evidenceCount: version.evidence_count,
        topicCount: version.topic_count,
        deltaSummary: version.delta_summary,
        metadata: version.metadata || {}
      }))[0] || null;
  }

  async getReusableInvestmentReport({ query = "", topicMap = null, maxAgeMinutes = 720 } = {}) {
    const maxAge = Math.max(1, Math.min(10080, Number(maxAgeMinutes) || 720));
    const prior = await this.getPriorInvestmentReport({ query, topicMap });
    const output = prior?.output || {};
    const feishuDocUrl = output.feishuDocUrl || output.feishu_doc_url || "";
    if (!prior || !feishuDocUrl) return null;
    const evidenceCutoff = prior.evidenceCutoffAt || prior.evidence_cutoff_at || "";
    const createdAt = new Date(evidenceCutoff);
    if (!Number.isFinite(createdAt.getTime())) return null;
    if (Date.now() - createdAt.getTime() > maxAge * 60 * 1000) return null;

    const graphTerms = (topicMap?.topics || []).flatMap((topic) => [
      topic.canonicalName,
      ...(topic.aliases || [])
    ]);
    const terms = splitResearchTerms(query, graphTerms).map((term) => term.toLowerCase()).slice(0, 24);
    const matches = (source) => {
      const text = [
        source.source_type,
        source.platform,
        source.title,
        source.author,
        source.organization,
        source.raw_text,
        JSON.stringify(source.metadata || {})
      ].join("\n").toLowerCase();
      return terms.length ? terms.some((term) => text.includes(term)) : true;
    };
    const newerSources = this.state.researchSources.filter((source) => {
      const analyzed = new Date(source.analyzed_at || source.created_at || 0);
      return Number.isFinite(analyzed.getTime()) && analyzed > createdAt && matches(source);
    }).length;
    if (newerSources > 0) return null;
    return {
      ...prior,
      feishuDocUrl,
      reusable: true,
      reason: "no_new_relevant_sources_since_prior_report"
    };
  }

  async recordInvestmentReportVersion({
    jobId = "",
    query = "",
    topicMap = null,
    structured = {},
    pack = {},
    priorReport = null
  } = {}) {
    const now = new Date().toISOString();
    const topicName = cleanResearchText(topicMap?.topics?.[0]?.canonicalName || query, 180);
    const topicKey = normalizeResearchTopicKey(topicName || query);
    const maxVersion = this.state.researchReportVersions
      .filter((item) => String(item.report_topic_key) === topicKey)
      .reduce((max, item) => Math.max(max, Number(item.version_no || 0)), 0);
    const versionNo = maxVersion + 1;
    const row = {
      job_id: String(jobId || ""),
      report_topic: topicName || String(query || ""),
      report_topic_key: topicKey,
      version_no: versionNo,
      prior_job_id: priorReport?.id || priorReport?.jobId || "",
      evidence_cutoff_at: now,
      source_count: Number(pack.sources?.length || 0),
      evidence_count: Number(pack.evidenceCards?.length || 0),
      topic_count: Number(topicMap?.topics?.length || 0),
      delta_summary: String(structured.deltaSincePrior || structured.oneSentence || "").slice(0, 1000),
      metadata: {
        title: structured.title || "",
        oneSentence: structured.oneSentence || "",
        thesis: structured.thesis || "",
        priorVersionNo: priorReport?.versionNo || null,
        topicKeys: (topicMap?.topics || []).map((topic) => topic.topicKey).slice(0, 60)
      },
      created_at: now
    };
    const existing = this.state.researchReportVersions.findIndex((item) => String(item.job_id) === String(jobId));
    if (existing >= 0) this.state.researchReportVersions[existing] = row;
    else this.state.researchReportVersions.push(row);

    for (const hypothesis of asResearchArray(structured.hypotheses).slice(0, 8)) {
      const thesis = cleanResearchText(hypothesis.title || hypothesis.logic || hypothesis.hypothesis || "", 900);
      if (!thesis) continue;
      this.state.researchThesisLedger.push({
        id: this.state.researchThesisLedger.length + 1,
        report_job_id: String(jobId || ""),
        topic_key: topicKey,
        thesis,
        thesis_type: "industry_chain_hypothesis",
        conviction: String(hypothesis.confidence || "medium").slice(0, 120),
        evidence_card_ids: hypothesis.evidenceIds || [],
        counter_evidence_card_ids: hypothesis.counterEvidenceIds || [],
        time_horizon: String(hypothesis.timeRisk || "").slice(0, 300),
        status: "active",
        metadata: { versionNo },
        created_at: now
      });
    }
    await this.flush();
    return { topicKey, versionNo };
  }

  async listYoutubeResearchHistoryForBackfill({ query = "", limit = 12 } = {}) {
    const terms = String(query || "")
      .toLowerCase()
      .split(/[\/,，、\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 10);
    const matches = (message) => {
      if (!terms.length) return true;
      const text = [message.content, JSON.stringify(message.metadata || {})].join("\n").toLowerCase();
      return terms.some((term) => text.includes(term));
    };
    return this.state.messages
      .filter((message) => message.metadata?.youtubeResearch && message.metadata?.feishuDocUrl && matches(message))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, Math.max(1, Math.min(30, Number(limit) || 12)));
  }
}
