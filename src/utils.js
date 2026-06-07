const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi
];

export function redactSensitive(text = "") {
  let output = String(text);
  for (const pattern of secretPatterns) {
    output = output.replace(pattern, "[REDACTED_SECRET]");
  }
  return output;
}

export function truncate(text = "", max = 4000) {
  const value = String(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 20)}\n...[truncated]`;
}

export function splitTelegramMessage(text, maxLength = 3900) {
  const value = String(text || "").trim() || "我刚才没有组织出合适的回复。";
  const chunks = [];
  let remaining = value;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf("."));
    const cut = breakAt > maxLength * 0.5 ? breakAt + 1 : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function parseJsonObject(text = "") {
  const raw = String(text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export function normalizeKey(text = "") {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._\-\u4e00-\u9fff]/g, "")
    .slice(0, 80);
}

export async function fetchAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const maxBytes = 20 * 1024 * 1024;

  if (buffer.length > maxBytes) {
    throw new Error("Telegram file is too large for image understanding.");
  }

  return `data:${contentType};base64,${buffer.toString("base64")}`;
}
