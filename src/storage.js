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
        ADD COLUMN IF NOT EXISTS analysis_lens TEXT NOT NULL DEFAULT '';

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
      researchCoverageGaps
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
      researchCoverageGaps: researchCoverageGaps.rows
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
      await client.query("DELETE FROM research_coverage_gaps");
      await client.query("DELETE FROM research_questions");
      await client.query("DELETE FROM research_time_contexts");
      await client.query("DELETE FROM research_source_entities");
      await client.query("DELETE FROM research_evidence_cards");
      await client.query("DELETE FROM research_entities");
      await client.query("DELETE FROM research_sources");
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

      for (const card of bundle.evidenceCards || []) {
        await client.query(
          `INSERT INTO research_evidence_cards (
             source_id, evidence_type, claim, quote_original, quote_zh, location,
             why_it_matters, confidence, time_sensitivity, stale_risk, evidence_strength,
             analysis_lens, requires_recheck, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
      researchCoverageGaps: []
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
      researchCoverageGaps: this.state.researchCoverageGaps
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
      researchCoverageGaps: Array.isArray(state.researchCoverageGaps) ? state.researchCoverageGaps : []
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

    this.state.researchEvidenceCards = this.state.researchEvidenceCards.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchQuestions = this.state.researchQuestions.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchTimeContexts = this.state.researchTimeContexts.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchSourceEntities = this.state.researchSourceEntities.filter((item) => String(item.source_id) !== sourceId);
    this.state.researchCoverageGaps = this.state.researchCoverageGaps.filter((item) => String(item.source_id) !== sourceId);

    for (const card of bundle.evidenceCards || []) {
      this.state.researchEvidenceCards.push({
        id: this.state.researchEvidenceCards.length + 1,
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
      });
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

    await this.flush();
    return {
      sourceId,
      evidenceCards: (bundle.evidenceCards || []).length,
      entities: (bundle.entities || []).length,
      questions: (bundle.questions || []).length,
      coverageGaps: (bundle.coverageGaps || []).length
    };
  }
}
