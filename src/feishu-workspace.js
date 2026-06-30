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

function textBlock(content) {
  return {
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content: String(content || "").slice(0, 4000)
          }
        }
      ],
      style: {}
    }
  };
}

function markdownLineToTextBlock(line = "") {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "- ")
    .replace(/^\d+[.)\u3001]\s+/, "");
  return textBlock(normalized);
}

function markdownToBlocks(markdown = "") {
  return String(markdown || "")
    .split(/\r?\n/)
    .map(markdownLineToTextBlock)
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

  async readDocumentRawContent(documentId) {
    if (!documentId) return "";
    const data = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`);
    const content =
      data.content ||
      data.raw_content ||
      data.document?.content ||
      data.document?.raw_content ||
      "";
    return String(content || "");
  }

  async getWikiNode(token, objType = "wiki") {
    if (!token) return {};
    const params = new URLSearchParams({ token: String(token) });
    if (objType) params.set("obj_type", String(objType));
    const data = await this.request(`/open-apis/wiki/v2/spaces/get_node?${params.toString()}`);
    return data.node || {};
  }

  async readWikiNodeRawContent(wikiToken) {
    if (!wikiToken) return "";
    const node = await this.getWikiNode(wikiToken, "wiki");
    const objType = String(node.obj_type || "").toLowerCase();
    const objToken = node.obj_token || "";
    if (objType === "docx" && objToken) {
      return this.readDocumentRawContent(objToken);
    }
    if (node.title) {
      return `Wiki node title: ${node.title}\nUnsupported wiki object type: ${node.obj_type || "unknown"}`;
    }
    return "";
  }

  async wikiNodeDocumentId(wikiToken) {
    if (!wikiToken) return "";
    const node = await this.getWikiNode(wikiToken, "wiki");
    const objType = String(node.obj_type || "").toLowerCase();
    if (objType === "docx" && node.obj_token) return node.obj_token;
    return "";
  }

  async getChatInfo(chatId) {
    if (!chatId) return {};
    const data = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`);
    const chat = data.chat || data;
    return {
      chatId,
      name: chat.name || chat.chat_name || chat.title || "",
      description: chat.description || "",
      ownerId: chat.owner_id || chat.owner_open_id || "",
      avatar: chat.avatar || chat.avatar_url || "",
      raw: chat
    };
  }

  async listChats(limit = 1000) {
    const chats = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        user_id_type: "open_id",
        page_size: String(Math.min(Math.max(Number(limit) || 100, 1), 100))
      });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.request(`/open-apis/im/v1/chats?${params.toString()}`);
      chats.push(...(data.items || []));
      pageToken = data.page_token || "";
      if (!data.has_more || chats.length >= limit) break;
    } while (pageToken);

    return chats.slice(0, limit).map((chat) => ({
      chatId: chat.chat_id || chat.open_chat_id || "",
      name: chat.name || chat.chat_name || chat.title || "",
      chatType: chat.chat_type || "",
      raw: chat
    }));
  }

  async listChatMembers(chatId, limit = 500) {
    if (!chatId) return [];
    const members = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        member_id_type: "open_id",
        page_size: String(Math.min(Math.max(Number(limit) || 100, 1), 100))
      });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${params.toString()}`);
      members.push(...(data.items || []));
      pageToken = data.page_token || "";
      if (!data.has_more || members.length >= limit) break;
    } while (pageToken);

    return members.slice(0, limit).map((member) => ({
      memberId: member.member_id || member.open_id || member.user_id || "",
      name: member.name || member.member_name || member.user_name || member.nickname || "",
      tenantKey: member.tenant_key || "",
      raw: member
    }));
  }

  async getUserInfo(userId) {
    if (!userId) return {};
    const data = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=open_id`);
    const user = data.user || data;
    const name = user.name || user.nickname || user.en_name || user.enterprise_email || user.email || "";
    return {
      userId,
      name,
      enName: user.en_name || "",
      email: user.enterprise_email || user.email || "",
      avatar: user.avatar?.avatar_72 || user.avatar?.avatar_origin || "",
      raw: user
    };
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
    let writeError = "";
    try {
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
    } catch (error) {
      writeError = error.message;
      logEvent("warn", "Feishu document created but content write failed", {
        title,
        documentId,
        blockCount: blocks.length,
        blockTypes: [...new Set(blocks.map((block) => block.block_type))],
        firstBlockContentLength: blocks[0]?.text?.elements?.[0]?.text_run?.content?.length || 0,
        error: error.message
      });
    }

    logEvent("info", "Feishu document created", {
      title,
      documentId,
      blocks: blocks.length,
      contentWritten: !writeError,
      folderConfigured: Boolean(this.config.feishuProjectFolderToken)
    });
    return {
      token: documentId,
      url: this.docUrl(documentId),
      title: document.title || title,
      writeError
    };
  }

  async appendMarkdownToDocument({ documentId, markdown }) {
    if (!documentId) throw new Error("Missing Feishu document id.");
    const blocks = markdownToBlocks(markdown);
    if (!blocks.length) return { appended: true, blocks: 0 };

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

    logEvent("info", "Feishu document appended", {
      documentId,
      blocks: blocks.length
    });
    return { appended: true, blocks: blocks.length };
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

    logEvent("info", "Feishu spreadsheet created", {
      title,
      token,
      rows: values.length,
      folderConfigured: Boolean(this.config.feishuProjectFolderToken)
    });
    return {
      token,
      url: spreadsheet.url || `${this.config.feishuDocBaseUrl || "https://www.feishu.cn"}/sheets/${token}`,
      title: spreadsheet.title || title
    };
  }
}
