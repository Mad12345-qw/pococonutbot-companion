import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { normalizeKey } from "./utils.js";

const { Pool } = pg;

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
        chat_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
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

  async getRecentMessages(chatId, limit) {
    const result = await this.pool.query(
      `SELECT role, content, modality, user_id, created_at
       FROM chat_messages
       WHERE chat_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [String(chatId), limit]
    );
    return result.rows.reverse();
  }

  async countMessages(chatId) {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM chat_messages WHERE chat_id = $1`,
      [String(chatId)]
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
    const [messages, memories, summaries] = await Promise.all([
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
        `SELECT chat_id AS "chatId", summary, updated_at AS "updatedAt"
         FROM conversation_summaries
         ORDER BY chat_id ASC`
      )
    ]);

    return {
      messages: messages.rows,
      memories: memories.rows,
      summaries: Object.fromEntries(summaries.rows.map((row) => [row.chatId, row.summary]))
    };
  }

  async importState(state) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chat_messages");
      await client.query("DELETE FROM memories");
      await client.query("DELETE FROM conversation_summaries");

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

      for (const [chatId, summary] of Object.entries(state.summaries || {})) {
        await client.query(
          `INSERT INTO conversation_summaries (chat_id, summary)
           VALUES ($1, $2)
           ON CONFLICT (chat_id)
           DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
          [String(chatId), String(summary).slice(0, 4000)]
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
       )
       SELECT
         c.chat_id,
         COALESCE(ms.message_count, 0)::int AS message_count,
         COALESCE(mem.memory_count, 0)::int AS memory_count,
         ms.last_message_at,
         mem.last_memory_at,
         s.updated_at AS summary_updated_at
       FROM chat_ids c
       LEFT JOIN message_stats ms ON ms.chat_id = c.chat_id
       LEFT JOIN memory_stats mem ON mem.chat_id = c.chat_id
       LEFT JOIN conversation_summaries s ON s.chat_id = c.chat_id
       ORDER BY COALESCE(ms.last_message_at, mem.last_memory_at, s.updated_at) DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getMemories(chatId, userId, limit) {
    const result = await this.pool.query(
      `SELECT key, value, importance, updated_at
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

  async getSummary(chatId) {
    const result = await this.pool.query(
      `SELECT summary FROM conversation_summaries WHERE chat_id = $1`,
      [String(chatId)]
    );
    return result.rows[0]?.summary || "";
  }

  async setSummary(chatId, summary) {
    await this.pool.query(
      `INSERT INTO conversation_summaries (chat_id, summary)
       VALUES ($1, $2)
       ON CONFLICT (chat_id)
       DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
      [String(chatId), String(summary).slice(0, 4000)]
    );
  }

  async clearChat(chatId) {
    await this.pool.query(`DELETE FROM chat_messages WHERE chat_id = $1`, [String(chatId)]);
    await this.pool.query(`DELETE FROM memories WHERE chat_id = $1`, [String(chatId)]);
    await this.pool.query(`DELETE FROM conversation_summaries WHERE chat_id = $1`, [String(chatId)]);
  }
}

class JsonFileStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      messages: [],
      memories: [],
      summaries: {}
    };
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await fs.readFile(this.filePath, "utf8"));
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

  async getRecentMessages(chatId, limit) {
    return this.state.messages
      .filter((message) => String(message.chatId) === String(chatId))
      .slice(-limit)
      .map((message) => ({
        role: message.role,
        content: message.content,
        modality: message.modality || "text",
        user_id: message.userId || "",
        created_at: message.createdAt
      }));
  }

  async countMessages(chatId) {
    return this.state.messages.filter((message) => String(message.chatId) === String(chatId)).length;
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
      summaries: this.state.summaries || {}
    };
  }

  async importState(state) {
    this.state = {
      messages: Array.isArray(state.messages) ? state.messages : [],
      memories: Array.isArray(state.memories) ? state.memories : [],
      summaries: state.summaries && typeof state.summaries === "object" ? state.summaries : {}
    };
    await this.flush();
  }

  async listChats(limit = 100) {
    const ids = new Set();
    for (const message of this.state.messages) ids.add(String(message.chatId));
    for (const memory of this.state.memories) ids.add(String(memory.chatId));
    for (const chatId of Object.keys(this.state.summaries || {})) ids.add(String(chatId));

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
        summary_updated_at: this.state.summaries[chatId] ? null : null
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

  async getSummary(chatId) {
    return this.state.summaries[String(chatId)] || "";
  }

  async setSummary(chatId, summary) {
    this.state.summaries[String(chatId)] = String(summary).slice(0, 4000);
    await this.flush();
  }

  async clearChat(chatId) {
    this.state.messages = this.state.messages.filter((message) => String(message.chatId) !== String(chatId));
    this.state.memories = this.state.memories.filter((memory) => String(memory.chatId) !== String(chatId));
    delete this.state.summaries[String(chatId)];
    await this.flush();
  }
}
