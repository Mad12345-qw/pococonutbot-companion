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

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripLeadingSelfName(text = "", names = []) {
  let output = String(text || "").trim();
  const cleanNames = [...new Set(names.filter(Boolean).map((name) => String(name).trim()).filter(Boolean))];
  if (!output || cleanNames.length === 0) return output;

  const namePattern = cleanNames.map(escapeRegExp).join("|");
  const leadingPattern = new RegExp(
    `^(?:我是\\s*)?(?:${namePattern})(?:\\s*(?:呀|啊|哦|啦|呢))?\\s*[,，:：、。.!！?？\\-—\\s]+`,
    "i"
  );

  for (let i = 0; i < 3; i += 1) {
    const next = output.replace(leadingPattern, "").trim();
    if (next === output) break;
    output = next;
  }

  return output || String(text || "").trim();
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

export function splitChatBubbles(text, maxLength = 3900) {
  const chunks = splitTelegramMessage(text, maxLength);
  if (chunks.length !== 1) return chunks;

  const value = chunks[0];
  if (value.length > 900) return chunks;

  const parts = value
    .split(/\n{1,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2 || parts.length > 4) return chunks;
  if (parts.some((part) => part.length > 320)) return chunks;
  if (parts.some((part) => /^[-*•]|\d+[.)、]/.test(part))) return chunks;

  return parts;
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

function normalizeMimeType(contentType = "") {
  return String(contentType).split(";")[0].trim().toLowerCase();
}

export function detectImageMimeType(buffer, fallback = "") {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  const normalized = normalizeMimeType(fallback);
  if (normalized === "image/jpg") return "image/jpeg";
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(normalized)) {
    return normalized;
  }

  return "";
}

export async function fetchAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const maxBytes = 20 * 1024 * 1024;

  if (buffer.length > maxBytes) {
    throw new Error("Telegram file is too large for image understanding.");
  }

  const imageMimeType = detectImageMimeType(buffer, contentType);
  if (!imageMimeType) {
    throw new Error("Telegram file is not a supported image format.");
  }

  return `data:${imageMimeType};base64,${buffer.toString("base64")}`;
}

export async function fetchAsBuffer(url, maxBytes = 20 * 1024 * 1024) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > maxBytes) {
    throw new Error("Telegram file is too large.");
  }

  return { buffer, contentType };
}
