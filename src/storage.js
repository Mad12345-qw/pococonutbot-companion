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
    const [messages, memories, summaries, settings] = await Promise.all([
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
      )
    ]);

    return {
      messages: messages.rows,
      memories: memories.rows,
      summaries: summaries.rows,
      settings: settings.rows
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
}

class JsonFileStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      messages: [],
      memories: [],
      summaries: {},
      settings: {}
    };
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.state.summaries = normalizeSummaries(this.state.summaries);
      this.state.settings = normalizeSettings(this.state.settings);
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
      Object.keys(this.state.summaries || {}).length === 0
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
      settings: Object.entries(this.state.settings || {}).map(([key, value]) => ({ key, value }))
    };
  }

  async importState(state) {
    this.state = {
      messages: Array.isArray(state.messages) ? state.messages : [],
      memories: Array.isArray(state.memories) ? state.memories : [],
      summaries: normalizeSummaries(state.summaries),
      settings: normalizeSettings(state.settings)
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

  async getSetting(key, fallback = "") {
    return this.state.settings?.[String(key)] ?? fallback;
  }

  async setSetting(key, value) {
    this.state.settings = this.state.settings || {};
    this.state.settings[String(key)] = String(value ?? "").slice(0, 1000);
    await this.flush();
  }
}
