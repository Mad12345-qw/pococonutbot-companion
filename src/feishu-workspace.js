import { truncate } from "./utils.js";
import { logEvent } from "./runtime-log.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function columnName(index) {
  let value = Number(index) || 1;
  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output || "A";
}

function textBlock(blockType, content) {
  return {
    block_type: blockType,
    text: {
      elements: [
        {
          text_run: {
            content: String(content || "").slice(0, 4000)
          }
        }
      ]
    }
  };
}

function markdownLineToBlock(line = "") {
  const raw = String(line || "").trim();
  if (!raw) return null;
  if (raw.startsWith("### ")) return textBlock(5, raw.slice(4));
  if (raw.startsWith("## ")) return textBlock(4, raw.slice(3));
  if (raw.startsWith("# ")) return textBlock(3, raw.slice(2));
  if (/^[-*]\s+/.test(raw)) return textBlock(12, raw.replace(/^[-*]\s+/, ""));
  if (/^\d+[.)、]\s+/.test(raw)) return textBlock(13, raw.replace(/^\d+[.)、]\s+/, ""));
  return textBlock(2, raw);
}

function markdownToBlocks(markdown = "") {
  return String(markdown || "")
    .split(/\r?\n/)
    .map(markdownLineToBlock)
    .filter(Boolean)
    .slice(0, 300);
}

function normalizeRows(rows = []) {
  return rows.map((row) => row.map((cell) => String(cell ?? "").slice(0, 40000)));
}

export class FeishuWorkspaceClient {
  constructor({ config, getToken }) {
    this.config = config;
    this.getToken = getToken;
  }

  get enabled() {
    return Boolean(this.config.feishuAppId && this.config.feishuAppSecret);
  }

  docUrl(documentId) {
    if (!documentId) return "";
    return `${this.config.feishuDocBaseUrl || "https://www.feishu.cn"}/docx/${documentId}`;
  }

  async request(path, { method = "GET", body, headers = {} } = {}) {
    const token = await this.getToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Feishu workspace API returned non-JSON: ${truncate(text, 500)}`);
    }
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu workspace API failed ${response.status}: ${truncate(JSON.stringify(data), 800)}`);
    }
    return data.data || {};
  }

  async createDocument({ title, markdown }) {
    const body = { title: String(title || "AI 方案文档").slice(0, 800) };
    if (this.config.feishuProjectFolderToken) {
      body.folder_token = this.config.feishuProjectFolderToken;
    }

    const data = await this.request("/open-apis/docx/v1/documents", {
      method: "POST",
      body
    });
    const document = data.document || {};
    const documentId = document.document_id;
    if (!documentId) throw new Error(`Feishu document response missing document_id: ${truncate(JSON.stringify(data), 500)}`);

    const blocks = markdownToBlocks(markdown);
    for (let index = 0; index < blocks.length; index += 40) {
      const children = blocks.slice(index, index + 40);
      await this.request(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children?document_revision_id=-1`,
        {
          method: "POST",
          body: { children }
        }
      );
      if (index + 40 < blocks.length) await sleep(450);
    }

    logEvent("info", "Feishu document created", { title, documentId, blocks: blocks.length });
    return {
      token: documentId,
      url: this.docUrl(documentId),
      title: document.title || title
    };
  }

  async createSpreadsheet({ title, rows }) {
    const body = { title: String(title || "AI 方案表格").slice(0, 255) };
    if (this.config.feishuProjectFolderToken) {
      body.folder_token = this.config.feishuProjectFolderToken;
    }

    const data = await this.request("/open-apis/sheets/v3/spreadsheets", {
      method: "POST",
      body
    });
    const spreadsheet = data.spreadsheet || {};
    const token = spreadsheet.spreadsheet_token;
    if (!token) throw new Error(`Feishu spreadsheet response missing token: ${truncate(JSON.stringify(data), 500)}`);

    const sheetData = await this.request(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(token)}/sheets/query`);
    const sheetId = sheetData.sheets?.[0]?.sheet_id;
    if (!sheetId) throw new Error(`Feishu spreadsheet response missing sheet_id: ${truncate(JSON.stringify(sheetData), 500)}`);

    const values = normalizeRows(rows || []);
    if (values.length > 0) {
      const maxColumns = Math.max(...values.map((row) => row.length), 1);
      const range = `${sheetId}!A1:${columnName(maxColumns)}${values.length}`;
      await this.request(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`, {
        method: "PUT",
        body: {
          valueRange: {
            range,
            values
          }
        }
      });
    }

    logEvent("info", "Feishu spreadsheet created", { title, token, rows: values.length });
    return {
      token,
      url: spreadsheet.url || `${this.config.feishuDocBaseUrl || "https://www.feishu.cn"}/sheets/${token}`,
      title: spreadsheet.title || title
    };
  }
}
