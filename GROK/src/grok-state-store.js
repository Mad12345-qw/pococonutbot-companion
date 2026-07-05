import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { sha256Hex } from "./grok-auth-store.js";

const DEFAULT_STATE_REDIS_KEY = "feishu-grok-bridge:grok-state";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function encryptionKey() {
  const raw = process.env.AUTH_ENCRYPTION_KEY || "";
  if (!raw.trim()) return null;
  const candidates = [];
  try {
    candidates.push(Buffer.from(raw, "base64"));
  } catch {
    // Try hex below.
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    candidates.push(Buffer.from(raw, "hex"));
  }
  const key = candidates.find((item) => item.length === 32);
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes.");
  return key;
}

function redisConfig() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const key = process.env.GROK_STATE_REDIS_KEY || DEFAULT_STATE_REDIS_KEY;
  return {
    url,
    token,
    key,
    enabled: Boolean(url && token && process.env.AUTH_ENCRYPTION_KEY)
  };
}

async function redisCommand(command) {
  const cfg = redisConfig();
  if (!cfg.enabled) throw new Error("Redis Grok state storage is not configured.");
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok || body?.error) {
    throw new Error(`Redis command failed: ${response.status} ${body?.error || text.slice(0, 200)}`);
  }
  return body.result;
}

function encryptPayload(payload) {
  const key = encryptionKey();
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY is required for Redis Grok state storage.");
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm+gzip-json",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    stateHash: sha256Hex(packed),
    updatedAt: new Date().toISOString(),
    fileCount: payload.files.length,
    skippedCount: payload.skipped.length,
    totalBytes: payload.totalBytes
  });
}

function decryptPayload(value) {
  const key = encryptionKey();
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY is required for Redis Grok state storage.");
  const parsed = JSON.parse(value);
  if (parsed.v !== 1 || parsed.alg !== "aes-256-gcm+gzip-json") {
    throw new Error("Unsupported Grok state Redis envelope.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const packed = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(zlib.gunzipSync(packed).toString("utf8"));
}

export function grokStateStoreConfigured() {
  return redisConfig().enabled;
}

export function grokStateRoots() {
  const home = os.homedir();
  return [
    { name: "sessions", root: path.join(home, ".grok", "sessions") },
    { name: "memory", root: path.join(home, ".grok", "memory") }
  ];
}

function shouldSkipFile(filePath, size) {
  if (size > MAX_FILE_BYTES) return `too_large:${size}`;
  if (MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return "media";
  return "";
}

function collectFiles() {
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  const visit = (rootName, root, current) => {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(rootName, root, fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(fullPath);
      const rel = path.relative(root, fullPath).split(path.sep).join("/");
      const reason = shouldSkipFile(fullPath, stat.size);
      if (reason) {
        skipped.push({ root: rootName, path: rel, reason });
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
        skipped.push({ root: rootName, path: rel, reason: "total_cap" });
        continue;
      }
      files.push({
        root: rootName,
        path: rel,
        mode: stat.mode,
        modifiedAt: stat.mtime.toISOString(),
        content: fs.readFileSync(fullPath).toString("base64")
      });
      totalBytes += stat.size;
    }
  };

  for (const item of grokStateRoots()) {
    visit(item.name, item.root, item.root);
  }
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    totalBytes,
    files,
    skipped
  };
}

export function currentGrokStateHash() {
  const payload = collectFiles();
  return sha256Hex(Buffer.from(JSON.stringify(payload.files.map((item) => [item.root, item.path, item.content])), "utf8"));
}

export async function saveGrokStateToStore() {
  if (!grokStateStoreConfigured()) return { saved: false, reason: "not_configured" };
  const payload = collectFiles();
  const envelope = encryptPayload(payload);
  await redisCommand(["SET", redisConfig().key, envelope]);
  return {
    saved: true,
    key: redisConfig().key,
    hashPrefix: JSON.parse(envelope).stateHash.slice(0, 12),
    fileCount: payload.files.length,
    skippedCount: payload.skipped.length,
    totalBytes: payload.totalBytes
  };
}

export async function restoreGrokStateFromStore() {
  if (!grokStateStoreConfigured()) return { restored: false, reason: "not_configured" };
  const value = await redisCommand(["GET", redisConfig().key]);
  if (!value) return { restored: false, reason: "empty_store" };
  const payload = decryptPayload(String(value));
  const roots = new Map(grokStateRoots().map((item) => [item.name, item.root]));
  let restoredFiles = 0;
  for (const item of payload.files || []) {
    const root = roots.get(item.root);
    if (!root) continue;
    const target = path.resolve(root, item.path);
    const rootResolved = path.resolve(root);
    if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(item.content, "base64"), { mode: item.mode || 0o600 });
    restoredFiles += 1;
  }
  return {
    restored: true,
    key: redisConfig().key,
    restoredFiles,
    savedAt: payload.savedAt || "",
    skippedCount: payload.skipped?.length || 0
  };
}

export async function grokStateStoreStatus() {
  const cfg = redisConfig();
  const roots = grokStateRoots().map((item) => ({
    name: item.name,
    root: item.root,
    exists: fs.existsSync(item.root)
  }));
  let storePresent = false;
  let storeError = "";
  let storeSummary = null;
  if (cfg.enabled) {
    try {
      const value = await redisCommand(["GET", cfg.key]);
      storePresent = Boolean(value);
      if (value) {
        const parsed = JSON.parse(String(value));
        storeSummary = {
          updatedAt: parsed.updatedAt || "",
          fileCount: parsed.fileCount || 0,
          skippedCount: parsed.skippedCount || 0,
          totalBytes: parsed.totalBytes || 0,
          stateHashPrefix: String(parsed.stateHash || "").slice(0, 12)
        };
      }
    } catch (error) {
      storeError = error.message;
    }
  }
  return {
    configured: cfg.enabled,
    key: cfg.key,
    roots,
    storePresent,
    storeSummary,
    storeError
  };
}
