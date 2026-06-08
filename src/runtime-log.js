const entries = [];
const MAX_ENTRIES = 300;

function sanitizeMeta(meta = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(meta || {})) {
    const name = String(key).toLowerCase();
    if (name.includes("key") || name.includes("secret") || name.includes("token") || name.includes("password")) {
      safe[key] = "[redacted]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function logEvent(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: String(message || ""),
    meta: sanitizeMeta(meta)
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  const line = `[${entry.level}] ${entry.message}`;
  if (entry.level === "error") {
    console.error(line, entry.meta);
  } else if (entry.level === "warn") {
    console.warn(line, entry.meta);
  } else {
    console.log(line, entry.meta);
  }
}

export function getRuntimeLogs(limit = 100) {
  return entries.slice(-limit).reverse();
}
