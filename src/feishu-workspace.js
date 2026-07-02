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

export const DEFAULT_FEISHU_ARTICLE_GROUP_CHAT_ID = "oc_bd5099233ce701edc7879f798aa9925c";
export const DEFAULT_FEISHU_ARTICLE_GROUP_INVITE_TEXT = "加入我们，持续追踪SpaceX、AI、Robot！";

export function feishuOpenChatUrl(chatId = "") {
  const clean = String(chatId || "").trim();
  if (!clean) return "";
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(clean)}`;
}

export function buildFeishuArticleGroupPrelude(config = {}) {
  const chatId = String(config.feishuArticleGroupChatId || DEFAULT_FEISHU_ARTICLE_GROUP_CHAT_ID).trim();
  const inviteText = String(config.feishuArticleGroupInviteText || DEFAULT_FEISHU_ARTICLE_GROUP_INVITE_TEXT).trim();
  if (!chatId || !inviteText) return "";
  return inviteText;
}

export function withFeishuArticleGroupPrelude(markdown = "", config = {}) {
  const body = String(markdown || "").trimStart();
  const prelude = buildFeishuArticleGroupPrelude(config);
  if (!prelude || body.includes(prelude)) {
    return body;
  }
  const lines = body.split(/\r?\n/);
  if (/^#\s+/.test(lines[0] || "")) {
    return [lines[0], "", prelude, "", ...lines.slice(1)]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return [prelude, "", body]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function feishuArticleGroupChatCardIndex(markdown = "") {
  const lines = String(markdown || "").trimStart().split(/\r?\n/);
  return /^#\s+/.test(lines[0] || "") ? 2 : 1;
}

function linkedTextBlock(content = "", url = "") {
  const encodedUrl = encodeURIComponent(String(url || ""));
  const block = textBlock(content);
  if (encodedUrl) {
    block.text.elements[0].text_run.text_element_style = {
      link: { url: encodedUrl }
    };
  }
  return block;
}

function cleanConvertedBlock(block = {}) {
  if (!block || typeof block !== "object") return block;
  const cleaned = JSON.parse(JSON.stringify(block));
  if (cleaned.block_type === 31 && cleaned.table?.property?.merge_info) {
    delete cleaned.table.property.merge_info;
  }
  return cleaned;
}

function normalizeConvertedDocument(data = {}) {
  const blocks = data.blocks || data.descendants || data.document?.blocks || [];
  const firstLevelBlockIds =
    data.first_level_block_ids ||
    data.firstLevelBlockIds ||
    data.children_id ||
    data.childrenId ||
    [];
  return {
    blocks: Array.isArray(blocks) ? blocks.map(cleanConvertedBlock) : [],
    firstLevelBlockIds: Array.isArray(firstLevelBlockIds) ? firstLevelBlockIds : []
  };
}

function collectTextRunContents(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectTextRunContents(item, output);
    return output;
  }
  if (value.text_run?.content) output.push(String(value.text_run.content));
  for (const item of Object.values(value)) collectTextRunContents(item, output);
  return output;
}

function collectEvidenceBlockIds(blocks = []) {
  const output = new Map();
  for (const block of blocks) {
    const blockId = String(block?.block_id || "").trim();
    if (!blockId) continue;
    const text = collectTextRunContents(block).join("").trim();
    const match = text.match(/^证据\s+(E\d+)$/i);
    if (match) output.set(match[1].toUpperCase(), blockId);
  }
  return output;
}

function normalizeLinkUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function rewriteEvidenceLinksInValue(value, evidenceBlockIds, documentUrl = "") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rewriteEvidenceLinksInValue(item, evidenceBlockIds, documentUrl);
    return;
  }
  const link = value.text_run?.text_element_style?.link;
  if (link?.url) {
    const normalized = normalizeLinkUrl(link.url);
    const match = normalized.match(/^#证据-(e\d+)$/i);
    const evidenceId = match?.[1]?.toUpperCase() || "";
    const blockId = evidenceId ? evidenceBlockIds.get(evidenceId) : "";
    if (blockId) link.url = encodeURIComponent(`${documentUrl}#${blockId}`);
  }
  for (const item of Object.values(value)) rewriteEvidenceLinksInValue(item, evidenceBlockIds, documentUrl);
}

function rewriteEvidenceLinksToBlockAnchors({ blocks = [], documentUrl = "" } = {}) {
  if (!documentUrl) return { rewritten: 0, evidenceAnchors: 0 };
  const evidenceBlockIds = collectEvidenceBlockIds(blocks);
  if (!evidenceBlockIds.size) return { rewritten: 0, evidenceAnchors: 0 };
  let before = 0;
  let after = 0;
  const countPlaceholderLinks = () => {
    let count = 0;
    const walk = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      const url = value.text_run?.text_element_style?.link?.url;
      if (url && /^#证据-e\d+$/i.test(normalizeLinkUrl(url))) count += 1;
      for (const item of Object.values(value)) walk(item);
    };
    walk(blocks);
    return count;
  };
  before = countPlaceholderLinks();
  rewriteEvidenceLinksInValue(blocks, evidenceBlockIds, documentUrl);
  after = countPlaceholderLinks();
  return {
    rewritten: Math.max(0, before - after),
    evidenceAnchors: evidenceBlockIds.size
  };
}

function normalizeRows(rows = []) {
  return rows.map((row) => row.map((cell) => String(cell ?? "").slice(0, 40000)));
}

function isFolderPermissionError(error) {
  const message = String(error?.message || "");
  return /1770040|folder/i.test(message) && /permission|no\s+fo|no\s+folder|folder/i.test(message);
}

export class FeishuWorkspaceClient {
  constructor({ config, getToken, onDocumentCreated = null }) {
    this.config = config;
    this.getToken = getToken;
    this.onDocumentCreated = typeof onDocumentCreated === "function" ? onDocumentCreated : null;
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

  async notifyDocumentCreated(document = {}, meta = {}) {
    if (!this.onDocumentCreated || !document.url) return null;
    try {
      return await this.onDocumentCreated(document, meta);
    } catch (error) {
      logEvent("warn", "Feishu document created callback failed", {
        title: document.title || meta.title || "",
        url: document.url || "",
        error: error.message
      });
      return { sent: false, error: error.message };
    }
  }

  async insertArticleGroupChatCard({ documentId, parentBlockId = documentId, index = 1 } = {}) {
    const chatId = String(this.config.feishuArticleGroupChatId || DEFAULT_FEISHU_ARTICLE_GROUP_CHAT_ID).trim();
    if (!documentId || !chatId) return { inserted: false, reason: "not_configured" };
    try {
      await this.request(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children?document_revision_id=-1`,
        {
          method: "POST",
          body: {
            index,
            children: [
              {
                block_type: 20,
                chat_card: {
                  chat_id: chatId,
                  align: 1
                }
              }
            ]
          }
        }
      );
      logEvent("info", "Feishu article group chat card inserted", {
        documentId,
        chatId,
        index
      });
      return { inserted: true, native: true, blocks: 1 };
    } catch (error) {
      logEvent("warn", "Feishu native chat card insert failed, falling back to linked text", {
        documentId,
        chatId,
        index,
        error: error.message
      });
      const url = feishuOpenChatUrl(chatId);
      await this.request(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children?document_revision_id=-1`,
        {
          method: "POST",
          body: {
            index,
            children: [linkedTextBlock("加入群聊", url)]
          }
        }
      );
      return { inserted: true, native: false, blocks: 1, fallback: "linked_text", error: error.message };
    }
  }

  async createWikiDocument({ parentWikiToken, title, markdown, requireRichMarkdown = false, articleGroupSourceType = "" }) {
    if (!parentWikiToken) throw new Error("Missing Feishu parent wiki token.");
    const parentNode = await this.getWikiNode(parentWikiToken, "wiki");
    const spaceId = parentNode.space_id || parentNode.spaceId || "";
    const parentNodeToken = parentNode.node_token || parentNode.wiki_token || parentWikiToken;
    if (!spaceId || !parentNodeToken) {
      throw new Error(`Feishu parent wiki node missing space_id/node_token: ${truncate(JSON.stringify(parentNode), 500)}`);
    }

    const data = await this.request(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: "POST",
      body: {
        obj_type: "docx",
        node_type: "origin",
        parent_node_token: parentNodeToken,
        title: String(title || "YouTube 技术笔记").slice(0, 800)
      }
    });
    const node = data.node || {};
    const documentId = node.obj_token || node.objToken || "";
    const wikiToken = node.node_token || node.wiki_token || "";
    if (!documentId) {
      throw new Error(`Feishu wiki node response missing obj_token: ${truncate(JSON.stringify(data), 500)}`);
    }

    let writeError = "";
    let writeMode = "rich";
    let blockCount = 0;
    let writeDiagnostics = {};
    const documentMarkdown = withFeishuArticleGroupPrelude(markdown, this.config);
    const articleGroupCardIndex = feishuArticleGroupChatCardIndex(documentMarkdown);
    try {
      const result = await this.insertRichMarkdown({ documentId, parentBlockId: documentId, markdown: documentMarkdown, index: 0 });
      blockCount = result.blocks || 0;
      writeDiagnostics = {
        evidenceLinksRewritten: result.evidenceLinksRewritten || 0,
        evidenceAnchors: result.evidenceAnchors || 0,
        firstLevelBlocks: result.firstLevelBlocks || 0
      };
    } catch (error) {
      if (requireRichMarkdown) throw error;
      logEvent("warn", "Feishu rich wiki document write failed, falling back to text blocks", {
        title,
        documentId,
        wikiToken,
        error: error.message
      });
      writeMode = "text_fallback";
      try {
        const result = await this.insertPlainTextMarkdown({ documentId, parentBlockId: documentId, markdown: documentMarkdown });
        blockCount = result.blocks || 0;
      } catch (fallbackError) {
        writeError = fallbackError.message;
      }
    }
    if (!writeError) {
      const cardResult = await this.insertArticleGroupChatCard({
        documentId,
        parentBlockId: documentId,
        index: articleGroupCardIndex
      });
      blockCount += cardResult.blocks || 0;
      writeDiagnostics.articleGroupChatCard = cardResult;
    }

    logEvent("info", "Feishu wiki document created", {
      title,
      spaceId,
      parentNodeToken,
      documentId,
      wikiToken,
      blocks: blockCount,
      writeDiagnostics,
      writeMode,
      contentWritten: !writeError
    });
    const created = {
      token: documentId,
      wikiToken,
      url: node.url || (wikiToken ? `${this.config.feishuDocBaseUrl || "https://www.feishu.cn"}/wiki/${wikiToken}` : this.docUrl(documentId)),
      title: node.title || title,
      writeError,
      writeMode,
      writeDiagnostics,
      blocks: blockCount,
      inWiki: true
    };
    created.articleGroupNotification = await this.notifyDocumentCreated(created, {
      title,
      sourceType: articleGroupSourceType
    });
    return created;
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
    const timeoutMs = this.config.feishuWorkspaceTimeoutMs || 30000;
    let response;
    try {
      response = await fetch(`https://open.feishu.cn${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new Error(`Feishu workspace API timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw error;
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Feishu workspace API returned non-JSON: ${truncate(text, 500)}`);
    }
    if (!response.ok || data.code !== 0) {
      const error = new Error(`Feishu workspace API failed ${response.status}: ${truncate(JSON.stringify(data), 800)}`);
      error.status = response.status;
      error.code = data.code;
      error.responseData = data;
      throw error;
    }
    return data.data || {};
  }

  async createDocumentRecord({ title, useFolder = true }) {
    const body = { title: String(title || "AI 方案文档").slice(0, 800) };
    if (useFolder && this.config.feishuProjectFolderToken) {
      body.folder_token = this.config.feishuProjectFolderToken;
    }

    const data = await this.request("/open-apis/docx/v1/documents", {
      method: "POST",
      body
    });
    const document = data.document || {};
    const documentId = document.document_id;
    if (!documentId) throw new Error(`Feishu document response missing document_id: ${truncate(JSON.stringify(data), 500)}`);
    return { document, documentId, usedFolder: Boolean(body.folder_token) };
  }

  async createDocument({ title, markdown, articleGroupSourceType = "" }) {
    let record;
    let folderFallback = false;
    try {
      record = await this.createDocumentRecord({ title, useFolder: true });
    } catch (error) {
      if (!this.config.feishuProjectFolderToken || !isFolderPermissionError(error)) {
        throw error;
      }
      folderFallback = true;
      logEvent("warn", "Feishu document folder create failed, retrying without folder", {
        title,
        error: error.message
      });
      record = await this.createDocumentRecord({ title, useFolder: false });
    }
    const { document, documentId } = record;

    let writeError = "";
    let writeMode = "rich";
    let blockCount = 0;
    const documentMarkdown = withFeishuArticleGroupPrelude(markdown, this.config);
    const articleGroupCardIndex = feishuArticleGroupChatCardIndex(documentMarkdown);
    const writeDiagnostics = {};
    try {
      const result = await this.insertRichMarkdown({ documentId, parentBlockId: documentId, markdown: documentMarkdown, index: 0 });
      blockCount = result.blocks || 0;
    } catch (error) {
      logEvent("warn", "Feishu rich document write failed, falling back to text blocks", {
        title,
        documentId,
        error: error.message
      });
      writeMode = "text_fallback";
      try {
        const result = await this.insertPlainTextMarkdown({ documentId, parentBlockId: documentId, markdown: documentMarkdown });
        blockCount = result.blocks || 0;
      } catch (fallbackError) {
        writeError = fallbackError.message;
        const blocks = markdownToBlocks(documentMarkdown);
        logEvent("warn", "Feishu document created but content write failed", {
          title,
          documentId,
          blockCount: blocks.length,
          blockTypes: [...new Set(blocks.map((block) => block.block_type))],
          firstBlockContentLength: blocks[0]?.text?.elements?.[0]?.text_run?.content?.length || 0,
          error: fallbackError.message
        });
      }
    }
    if (!writeError) {
      const cardResult = await this.insertArticleGroupChatCard({
        documentId,
        parentBlockId: documentId,
        index: articleGroupCardIndex
      });
      blockCount += cardResult.blocks || 0;
      writeDiagnostics.articleGroupChatCard = cardResult;
    }

    logEvent("info", "Feishu document created", {
      title,
      documentId,
      blocks: blockCount,
      writeMode,
      writeDiagnostics,
      contentWritten: !writeError,
      folderConfigured: Boolean(this.config.feishuProjectFolderToken),
      folderUsed: Boolean(record.usedFolder),
      folderFallback
    });
    const created = {
      token: documentId,
      url: this.docUrl(documentId),
      title: document.title || title,
      writeError,
      writeMode,
      blocks: blockCount,
      folderFallback
    };
    created.articleGroupNotification = await this.notifyDocumentCreated(created, {
      title,
      sourceType: articleGroupSourceType
    });
    return created;
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

  async convertMarkdownToBlocks(markdown = "") {
    const data = await this.request("/open-apis/docx/v1/documents/blocks/convert", {
      method: "POST",
      body: {
        content_type: "markdown",
        content: String(markdown || "").slice(0, 90000)
      }
    });
    const converted = normalizeConvertedDocument(data);
    if (!converted.blocks.length || !converted.firstLevelBlockIds.length) {
      throw new Error(`Feishu markdown conversion returned no usable blocks: ${truncate(JSON.stringify(data), 500)}`);
    }
    return converted;
  }

  async insertRichMarkdown({ documentId, parentBlockId = documentId, markdown, index = -1 }) {
    if (!documentId) throw new Error("Missing Feishu document id.");
    const converted = await this.convertMarkdownToBlocks(markdown);
    const linkRewrite = rewriteEvidenceLinksToBlockAnchors({
      blocks: converted.blocks,
      documentUrl: this.docUrl(documentId)
    });
    if (converted.blocks.length > 1000) {
      throw new Error(`Feishu rich document is too large for one descendant write: ${converted.blocks.length} blocks`);
    }
    await this.request(
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/descendant?document_revision_id=-1`,
      {
        method: "POST",
        body: {
          children_id: converted.firstLevelBlockIds,
          descendants: converted.blocks,
          index
        }
      }
    );
    logEvent("info", "Feishu rich markdown inserted", {
      documentId,
      blocks: converted.blocks.length,
      firstLevelBlocks: converted.firstLevelBlockIds.length,
      evidenceLinksRewritten: linkRewrite.rewritten,
      evidenceAnchors: linkRewrite.evidenceAnchors
    });
    return {
      appended: true,
      rich: true,
      blocks: converted.blocks.length,
      firstLevelBlocks: converted.firstLevelBlockIds.length,
      evidenceLinksRewritten: linkRewrite.rewritten,
      evidenceAnchors: linkRewrite.evidenceAnchors
    };
  }

  async insertPlainTextMarkdown({ documentId, parentBlockId = documentId, markdown }) {
    if (!documentId) throw new Error("Missing Feishu document id.");
    const blocks = markdownToBlocks(markdown);
    if (!blocks.length) return { appended: true, blocks: 0 };

    for (let index = 0; index < blocks.length; index += 40) {
      const children = blocks.slice(index, index + 40);
      await this.request(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children?document_revision_id=-1`,
        {
          method: "POST",
          body: { children }
        }
      );
      if (index + 40 < blocks.length) await sleep(450);
    }
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
