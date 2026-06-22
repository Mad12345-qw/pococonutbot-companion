import { getRuntimeLogs } from "./runtime-log.js";
import { truncate } from "./utils.js";

const CHAT_DISPLAY_NAME_KEY = "chat.display_name";
const CHAT_FEISHU_NAME_KEY = "chat.feishu_name";
const PERSONA_PROMPT_KEY = "relationship.persona_prompt";
const USER_DISPLAY_NAME_KEY = "user.display_name";
const FEISHU_ALWAYS_REPLY_USERS_SETTING = "feishu.always_reply_user_ids";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isSpecificUserFilter(value) {
  return value && value !== "__all" && value !== "__shared";
}

function memoryTargetUserId(value) {
  return isSpecificUserFilter(value) ? String(value) : "";
}

function filterMemories(memories, selectedUserId) {
  if (selectedUserId === "__shared") {
    return memories.filter((memory) => !memory.user_id);
  }
  if (isSpecificUserFilter(selectedUserId)) {
    return memories.filter((memory) => String(memory.user_id || "") === String(selectedUserId));
  }
  return memories;
}

function findScopedMemoryValue(memories, key, userId = "") {
  const targetUserId = String(userId || "");
  if (targetUserId) {
    const userValue = memories.find((memory) => {
      return memory.key === key && String(memory.user_id || "") === targetUserId;
    })?.value;
    if (userValue) return userValue;
  }
  return memories.find((memory) => memory.key === key && !memory.user_id)?.value || "";
}

async function attachChatDisplayNames(storage, chats) {
  return Promise.all(
    chats.map(async (chat) => {
      const memories = await storage.listMemories(chat.chat_id, 80);
      return {
        ...chat,
        display_name: findScopedMemoryValue(memories, CHAT_DISPLAY_NAME_KEY) || findScopedMemoryValue(memories, CHAT_FEISHU_NAME_KEY),
        feishu_name: findScopedMemoryValue(memories, CHAT_FEISHU_NAME_KEY)
      };
    })
  );
}

function attachUserDisplayNames(users, memories) {
  return users.map((user) => ({
    ...user,
    display_name: findScopedMemoryValue(memories, USER_DISPLAY_NAME_KEY, user.user_id)
  }));
}

function rawFeishuId(platformScopedId = "") {
  return String(platformScopedId || "").replace(/^feishu:/, "");
}

function isFeishuChatId(rawId = "") {
  return /^oc_|^chat_/i.test(String(rawId || ""));
}

function isFeishuUserId(rawId = "") {
  return /^(ou_|on_|union_|[a-z0-9_-]{8,})/i.test(String(rawId || "")) && !isFeishuChatId(rawId);
}

function readableUserName(info = {}, fallback = "") {
  return info.name || info.enName || info.email || fallback || "";
}

async function inferPrivateUserId(storage, chatId) {
  const users = await storage.listUsers(chatId, 10);
  const singleUser = users.length === 1 ? users.find((user) => rawFeishuId(user.user_id)) : null;
  if (singleUser) return rawFeishuId(singleUser.user_id);

  const messages = await storage.getRecentMessages(chatId, 30);
  for (const message of messages.slice().reverse()) {
    if (message.metadata?.chatType && message.metadata.chatType !== "p2p") continue;
    const rawUserId = message.metadata?.rawUserId || rawFeishuId(message.user_id);
    if (rawUserId && isFeishuUserId(rawUserId)) return rawUserId;
  }
  return "";
}

async function syncFeishuNames({ storage, feishuWorkspace, chatIds, includeUsers = true, useChatList = false }) {
  if (!feishuWorkspace?.enabled) {
    throw new Error("Feishu app credentials are not configured.");
  }

  const results = {
    chatsUpdated: 0,
    usersUpdated: 0,
    visibleChats: 0,
    synced: [],
    skipped: [],
    errors: []
  };
  const visibleChatNames = new Map();
  if (useChatList) {
    try {
      const visibleChats = await feishuWorkspace.listChats(1000);
      results.visibleChats = visibleChats.length;
      for (const chat of visibleChats) {
        const rawChatId = rawFeishuId(chat.chatId);
        if (rawChatId && chat.name) visibleChatNames.set(rawChatId, chat.name);
      }
    } catch (error) {
      results.errors.push({ chatId: "all", error: truncate(`List visible chats failed: ${error.message}`, 260) });
    }
  }
  for (const chatId of chatIds) {
    const rawChatId = rawFeishuId(chatId);
    const chatMemberNames = new Map();
    try {
      let chatName = "";
      if (isFeishuChatId(rawChatId)) {
        chatName = visibleChatNames.get(rawChatId) || "";
        if (!chatName && !useChatList) {
          const chatInfo = await feishuWorkspace.getChatInfo(rawChatId);
          chatName = chatInfo.name;
        }
        if (includeUsers) {
          try {
            const members = await feishuWorkspace.listChatMembers(rawChatId, 500);
            for (const member of members) {
              const memberId = rawFeishuId(member.memberId);
              const memberName = readableUserName(member, "");
              if (memberId && memberName) chatMemberNames.set(memberId, memberName);
            }
          } catch (error) {
            results.errors.push({ chatId, error: truncate(`List chat members failed: ${error.message}`, 260) });
          }
        }
      } else if (isFeishuUserId(rawChatId)) {
        const userInfo = await feishuWorkspace.getUserInfo(rawChatId);
        const userName = readableUserName(userInfo, rawChatId);
        chatName = userName ? `私聊：${userName}` : "";
      }
      if (!chatName && isFeishuChatId(rawChatId)) {
        const privateUserId = await inferPrivateUserId(storage, chatId);
        if (privateUserId) {
          try {
            const userInfo = await feishuWorkspace.getUserInfo(privateUserId);
            const userName = readableUserName(userInfo, privateUserId);
            chatName = userName ? `私聊：${userName}` : "";
          } catch (error) {
            results.errors.push({ chatId, error: truncate(`Private chat user lookup failed: ${error.message}`, 260) });
          }
        }
      }
      if (chatName) {
        await storage.setMemory(chatId, "", {
          key: CHAT_FEISHU_NAME_KEY,
          value: chatName,
          importance: 5
        });
        results.chatsUpdated += 1;
        results.synced.push({ chatId, name: chatName });
      } else {
        results.skipped.push({
          chatId,
          reason: isFeishuChatId(rawChatId) && useChatList
            ? "这个历史聊天不在当前机器人可见群列表里，通常是机器人不在该群或应用不可访问"
            : isFeishuChatId(rawChatId)
              ? "飞书返回了群信息，但没有群名称字段"
              : "不是可识别的飞书群聊或用户 ID"
        });
      }
    } catch (error) {
      results.errors.push({ chatId, error: truncate(error.message, 260) });
    }

    if (!includeUsers) continue;
    let users = [];
    try {
      users = await storage.listUsers(chatId, 300);
    } catch (error) {
      results.errors.push({ chatId, error: truncate(`List users failed: ${error.message}`, 260) });
      continue;
    }
    for (const user of users) {
      const userId = String(user.user_id || "");
      const rawUserId = rawFeishuId(userId);
      if (!rawUserId || !isFeishuUserId(rawUserId)) continue;
      try {
        let name = chatMemberNames.get(rawUserId) || "";
        if (!name && !isFeishuChatId(rawChatId)) {
          const userInfo = await feishuWorkspace.getUserInfo(rawUserId);
          name = readableUserName(userInfo, "");
        }
        if (!name) continue;
        await storage.setMemory(chatId, userId, {
          key: USER_DISPLAY_NAME_KEY,
          value: name,
          importance: 5
        });
        results.usersUpdated += 1;
      } catch (error) {
        results.errors.push({ chatId, userId, error: truncate(error.message, 260) });
      }
    }
  }
  return results;
}

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function adminAuth(config) {
  return (req, res, next) => {
    if (!config.adminPassword) {
      if (isLocalRequest(req)) return next();
      res.status(403).send("Set ADMIN_PASSWORD before exposing /admin on a public service.");
      return;
    }

    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="Bot Admin"');
      res.status(401).send("Authentication required.");
      return;
    }

    let username = "";
    let password = "";
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    } catch {
      res.status(401).send("Invalid credentials.");
      return;
    }

    if (username === config.adminUsername && password === config.adminPassword) {
      return next();
    }

    res.set("WWW-Authenticate", 'Basic realm="Bot Admin"');
    res.status(401).send("Invalid credentials.");
  };
}

function adminPage(config) {
  const title = `${escapeHtml(config.displayName)} Admin`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --surface: #ffffff;
      --surface-2: #eef2ee;
      --text: #18201c;
      --muted: #68736d;
      --line: #dce3dd;
      --accent: #2f7d64;
      --accent-2: #172b24;
      --danger: #b54747;
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    button, input, select, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 11px;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
    }
    button:hover { border-color: #b9c8bf; }
    button.primary { background: var(--accent-2); color: white; border-color: var(--accent-2); }
    button.danger { color: var(--danger); }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 9px 10px;
      background: #fff;
      color: var(--text);
    }
    textarea { min-height: 90px; resize: vertical; }
    .shell {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: #fbfcfa;
      padding: 18px;
    }
    .brand { margin-bottom: 18px; }
    .brand h1 { font-size: 18px; margin: 0 0 3px; }
    .brand p { margin: 0; color: var(--muted); }
    .side-label { margin: 18px 0 8px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .chat-list { display: grid; gap: 8px; }
    .chat-row {
      text-align: left;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .chat-row.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(47,125,100,.12); }
    .chat-row strong { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-row span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    main { padding: 22px; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 18px;
    }
    .topbar h2 { margin: 0; font-size: 22px; }
    .topbar p { margin: 3px 0 0; color: var(--muted); }
    .page-guide {
      background: #10251f;
      color: #f5fbf7;
      border: 0;
      padding: 18px;
    }
    .guide-title {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .guide-title h3 { margin: 0 0 4px; font-size: 18px; }
    .guide-title p { margin: 0; color: #b9cbc3; }
    .quick-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .info-card {
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: var(--radius);
      padding: 12px;
      min-height: 116px;
    }
    .info-card b { display: block; font-size: 13px; margin-bottom: 6px; }
    .info-card strong { display: block; font-size: 18px; margin-bottom: 6px; }
    .info-card span { display: block; color: #c9d7d1; font-size: 12px; line-height: 1.5; }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 16px;
      align-items: start;
    }
    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 16px;
      margin-bottom: 16px;
    }
    section h3 { margin: 0; font-size: 15px; }
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }
    .section-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--muted);
      background: #f8faf8;
      font-size: 12px;
      white-space: nowrap;
    }
    .explain {
      background: #f4f8f6;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px 11px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 12px;
    }
    .explain strong { color: var(--text); }
    .identity-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 120px;
      gap: 10px;
      align-items: end;
    }
    .identity-panel label,
    .persona-editor label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .scope-warning {
      margin: 10px 0;
      border: 1px solid #ead8a6;
      background: #fff8e6;
      color: #7b5a12;
      border-radius: 7px;
      padding: 9px 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    .template-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 8px 0;
    }
    .split-two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 120px 90px;
      gap: 8px;
      margin-bottom: 10px;
    }
    .memory-item {
      border-top: 1px solid var(--line);
      padding: 12px 0;
      display: grid;
      gap: 8px;
    }
    .memory-item.persona {
      border: 1px solid rgba(47,125,100,.35);
      border-radius: var(--radius);
      padding: 12px;
      background: #f3faf7;
      margin-bottom: 10px;
    }
    .memory-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .memory-title strong { color: var(--text); font-size: 13px; }
    .memory-meta {
      display: grid;
      grid-template-columns: 1fr 100px 110px;
      gap: 8px;
      align-items: center;
    }
    .memory-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .messages {
      display: grid;
      gap: 8px;
      max-height: 520px;
      overflow: auto;
      padding-right: 4px;
    }
    .message {
      background: var(--surface-2);
      border-radius: 7px;
      padding: 9px 10px;
    }
    .message.assistant { background: #e7f0eb; }
    .message b { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
    .config-list, .logs { display: grid; gap: 8px; }
    .config-row, .log-row {
      background: var(--surface-2);
      border-radius: 7px;
      padding: 9px 10px;
    }
    .config-row b, .log-row b { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
    .log-row.error { background: #f8eaea; }
    .log-row.warn { background: #fff4da; }
    .muted { color: var(--muted); }
    .mini-note { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .status { min-height: 20px; color: var(--muted); }
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .setting-row strong { display: block; }
    .setting-row span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .switch { position: relative; width: 46px; height: 26px; flex: 0 0 auto; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      inset: 0;
      cursor: pointer;
      background: #c8d1cc;
      border-radius: 999px;
      transition: .16s ease;
    }
    .slider:before {
      content: "";
      position: absolute;
      width: 20px;
      height: 20px;
      left: 3px;
      top: 3px;
      background: white;
      border-radius: 50%;
      box-shadow: 0 1px 2px rgba(0,0,0,.18);
      transition: .16s ease;
    }
    .switch input:checked + .slider { background: var(--accent); }
    .switch input:checked + .slider:before { transform: translateX(20px); }
    @media (max-width: 920px) {
      .shell, .grid, .quick-grid, .split-two, .identity-panel, .template-grid { grid-template-columns: 1fr; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
      .form-grid, .memory-meta { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <h1>${title}</h1>
        <p>记忆和人格后台</p>
      </div>
      <div id="chatList" class="chat-list"></div>
      <div class="side-label">用户</div>
      <div id="userList" class="chat-list"></div>
    </aside>
    <main>
      <div class="topbar">
        <div>
          <h2 id="chatTitle">选择一个聊天</h2>
          <p id="meta">加载中...</p>
        </div>
        <button id="refreshBtn">刷新</button>
      </div>
      <section>
        <div class="section-head">
          <div>
            <h3>当前聊天名称</h3>
            <p>这里改的是后台里给你看的名字，不影响飞书真实群名，也不影响机器人回复。</p>
          </div>
          <span class="pill" id="chatRawIdPill">未选择</span>
        </div>
        <div class="identity-panel">
          <div>
            <label for="chatDisplayName">显示成你看得懂的名称</label>
            <input id="chatDisplayName" placeholder="例如：Demo Day 群 / 童哥私聊 / 小椰测试群" />
          </div>
          <button id="saveChatNameBtn" class="primary">保存名称</button>
        </div>
        <div class="memory-actions" style="margin-top:8px">
          <button id="syncCurrentFeishuNamesBtn">从飞书同步当前聊天和成员名</button>
          <button id="syncAllFeishuNamesBtn">同步左侧全部聊天名</button>
        </div>
        <div id="syncReport" class="explain" style="display:none;margin-top:10px"></div>
        <p class="mini-note" id="chatIdentityMeta"></p>
      </section>
      <section class="page-guide">
        <div class="guide-title">
          <div>
            <h3>小椰现在怎么想，主要看这四块</h3>
            <p>先看人格和摘要，再看长期记忆。最近消息只是短期上下文。</p>
          </div>
          <span class="pill" id="scopePill">当前范围</span>
        </div>
        <div class="quick-grid">
          <div class="info-card">
            <b>人格模式</b>
            <strong id="personaOverview">-</strong>
            <span>决定小椰像女友、朋友还是助手。实际写入 relationship.persona。</span>
          </div>
          <div class="info-card">
            <b>对话摘要</b>
            <strong id="summaryOverview">-</strong>
            <span>压缩这段聊天的长期背景。适合写“这个群主要在聊什么”。</span>
          </div>
          <div class="info-card">
            <b>长期记忆</b>
            <strong id="memoryOverview">-</strong>
            <span>小椰明确记住的事实、偏好、关系设定。会长期影响回复。</span>
          </div>
          <div class="info-card">
            <b>最近消息</b>
            <strong id="messageOverview">-</strong>
            <span>最近几十条原始聊天，只用于当前上下文，不等于长期记忆。</span>
          </div>
        </div>
      </section>
      <div class="grid">
        <div>
          <section>
            <div class="section-head">
              <div>
                <h3>新增一条长期记忆</h3>
                <p>只有你确定要小椰长期记住时才加。临时聊天不用写这里。</p>
              </div>
              <span class="pill">长期生效</span>
            </div>
            <div class="explain">
              常用 key：<strong>relationship.persona</strong> 控制人格，<strong>user.nickname</strong> 记录称呼，<strong>user.preference</strong> 记录偏好，<strong>style.reply</strong> 记录回复风格。
            </div>
            <div class="form-grid">
              <input id="newKey" placeholder="key，例如 user.nickname" />
              <input id="newImportance" type="number" min="1" max="5" value="3" />
              <button id="addMemoryBtn" class="primary">添加</button>
            </div>
            <textarea id="newValue" placeholder="记忆内容，例如 用户喜欢被叫老板。"></textarea>
          </section>
          <section>
            <div class="section-head">
              <div>
                <h3>长期记忆</h3>
                <p>这里才是小椰真正“记住”的内容。importance 越高越重要。</p>
              </div>
              <span class="pill" id="memoryCountPill">0 条</span>
            </div>
            <div id="memoryList" class="muted">暂无记忆</div>
          </section>
          <section>
            <div class="section-head">
              <div>
                <h3>项目记录</h3>
                <p>机器人创建过的项目、文档和交付物。一般不影响人格。</p>
              </div>
            </div>
            <div id="projectList" class="config-list"></div>
          </section>
        </div>
        <div>
          <section>
            <div class="section-head">
              <div>
                <h3>人格和回复开关</h3>
                <p>这里改的是当前聊天的小椰状态。</p>
              </div>
            </div>
            <div class="setting-row">
              <div>
                <strong>GPT</strong>
                <span id="gptSwitchMeta">主回复接口</span>
              </div>
              <label class="switch" title="关闭后主聊天直接使用备用 MiniMax">
                <input id="gptSwitch" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
            <div class="setting-row">
              <div>
                <strong>智能插话</strong>
                <span id="smartRepliesSwitchMeta">群聊自动判断是否回复</span>
              </div>
              <label class="switch" title="关闭后群聊里不主动插话，只响应 @、指令、私聊和明确任务">
                <input id="smartRepliesSwitch" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
            <div class="persona-editor">
              <label for="alwaysReplyUsers">指定用户优先回复</label>
              <textarea id="alwaysReplyUsers" placeholder="例如：410351, 用户410351, feishu:ou_xxx。命中的用户在群里发普通消息也会触发回复。"></textarea>
              <div class="memory-actions" style="margin-top:8px">
                <button id="addSelectedAlwaysReplyUserBtn" type="button">加入左侧选中的用户</button>
                <button id="saveAlwaysReplyUsersBtn" class="primary" type="button">保存白名单</button>
              </div>
              <p class="mini-note">这里保存后立即生效，不用去 Render 改环境变量。多个用户用逗号或换行分隔。</p>
            </div>
            <hr style="border:0;border-top:1px solid var(--line);margin:14px 0" />
            <select id="persona">
              <option value="girlfriend">AI 女友</option>
              <option value="boyfriend">AI 男友</option>
              <option value="friend">亲密朋友</option>
              <option value="assistant">个人助理</option>
            </select>
            <p class="mini-note">这里会写入当前聊天的 <strong>relationship.persona</strong> 记忆，保存后立即影响后续回复。</p>
            <div class="persona-editor">
              <div class="scope-warning" id="personaScopeWarning"></div>
              <label for="personaPrompt">人格提示词</label>
              <textarea id="personaPrompt" placeholder="例如：你是张三的 AI 女友，只对张三使用亲密陪伴口吻；在群里对其他成员保持普通朋友边界。"></textarea>
              <div class="template-grid">
                <button type="button" data-persona-template="girlfriend">套用 AI 女友边界模板</button>
                <button type="button" data-persona-template="assistant">套用 AI 助理边界模板</button>
              </div>
              <div class="memory-actions">
                <button id="savePersonaPromptBtn" class="primary">保存人格提示词</button>
              </div>
              <p class="mini-note">这会写入 <strong>relationship.persona_prompt</strong>。如果左侧选中具体用户，就只绑定给这个人；如果选“群公共”，会影响整个聊天。</p>
            </div>
          </section>
          <section>
            <div class="section-head">
              <div>
                <h3>对话摘要</h3>
                <p>给模型看的背景提要。写短一点、准一点，比堆历史消息更稳定。</p>
              </div>
              <span class="pill" id="summaryScopePill">公共摘要</span>
            </div>
            <textarea id="summary" placeholder="例如：这个群主要讨论 AI 机器人、飞书自动化和产品 Demo。小椰回复要自然、直接，优先解决当前问题。"></textarea>
            <div class="memory-actions" style="margin-top:8px">
              <button id="saveSummaryBtn" class="primary">保存摘要</button>
            </div>
          </section>
          <section>
            <div class="section-head">
              <div>
                <h3>最近消息</h3>
                <p>短期上下文。看到“语音/图片/卡片”可以判断刚刚发生了什么。</p>
              </div>
              <span class="pill" id="messageCountPill">0 条</span>
            </div>
            <div id="messages" class="messages"></div>
          </section>
          <section>
            <div class="section-head">
              <div>
                <h3>模型与接口</h3>
                <p>只看状态，不在这里改密钥。</p>
              </div>
            </div>
            <div id="runtimeConfig" class="config-list"></div>
          </section>
          <section>
            <div class="section-head">
              <div>
                <h3>运行日志</h3>
                <p>排查“不回复、语音失败、图片失败”时先看这里。</p>
              </div>
            </div>
            <div id="runtimeLogs" class="logs"></div>
          </section>
          <p id="status" class="status"></p>
        </div>
      </div>
    </main>
  </div>
  <script>
    let state = null;
    let selectedChatId = new URLSearchParams(location.search).get("chatId") || "";
    let selectedUserId = new URLSearchParams(location.search).get("userId") || "__all";
    const apiOrigin = location.origin.replace(/^(https?:\\/\\/)[^@]+@/, "$1");

    async function api(path, options = {}) {
      const response = await fetch(apiOrigin + path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function setStatus(text) {
      document.getElementById("status").textContent = text || "";
    }

    function renderSyncReport(result) {
      const el = document.getElementById("syncReport");
      if (!result) {
        el.style.display = "none";
        el.innerHTML = "";
        return;
      }
      const synced = result.synced || [];
      const skipped = result.skipped || [];
      const errors = result.errors || [];
      const lines = [];
      if (result.visibleChats) {
        lines.push("<strong>飞书可见群</strong><br />本次从飞书群列表拿到 " + escapeHtml(result.visibleChats) + " 个群。没有出现在这个列表里的历史聊天，通常无法自动同步群名。");
      }
      if (synced.length) {
        lines.push("<strong>已同步</strong><br />" + synced.slice(0, 8).map((item) => escapeHtml(item.name) + " · " + escapeHtml(shortChatId(item.chatId))).join("<br />"));
      }
      if (skipped.length) {
        lines.push("<strong>未拿到名称</strong><br />" + skipped.slice(0, 8).map((item) => escapeHtml(shortChatId(item.chatId)) + " · " + escapeHtml(item.reason || "")).join("<br />"));
      }
      if (errors.length) {
        lines.push("<strong>失败原因</strong><br />" + errors.slice(0, 8).map((item) => escapeHtml(shortChatId(item.chatId || item.userId || "")) + " · " + escapeHtml(item.error || "")).join("<br />"));
      }
      el.innerHTML = lines.join("<br /><br />") || "飞书没有返回可同步的名称。";
      el.style.display = "block";
    }

    function renderChats() {
      const el = document.getElementById("chatList");
      if (!state.chats.length) {
        el.innerHTML = '<p class="muted">还没有聊天记录。</p>';
        return;
      }
      el.innerHTML = state.chats.map(chat => {
        const active = String(chat.chat_id) === String(selectedChatId) ? " active" : "";
        const label = displayChatName(chat);
        const rawId = shortChatId(chat.chat_id);
        return '<button class="chat-row' + active + '" data-chat="' + escapeHtml(chat.chat_id) + '">' +
          '<strong>' + escapeHtml(label) + '</strong>' +
          '<span>' + escapeHtml(rawId) + ' · ' + chat.message_count + ' messages · ' + chat.memory_count + ' memories</span>' +
          '</button>';
      }).join("");
      for (const row of el.querySelectorAll(".chat-row")) {
        row.addEventListener("click", () => {
          selectedChatId = row.dataset.chat;
          selectedUserId = "__all";
          history.replaceState(null, "", "/admin?chatId=" + encodeURIComponent(selectedChatId));
          load();
        });
      }
    }

    function shortChatId(chatId = "") {
      const cleaned = String(chatId || "").replace(/^feishu:/, "");
      if (!cleaned) return "未选择";
      return cleaned.length > 18 ? cleaned.slice(0, 18) + "..." : cleaned;
    }

    function displayChatName(chat) {
      if (!chat) return selectedChatId ? "聊天 " + shortChatId(selectedChatId) : "选择一个聊天";
      return chat.display_name || "聊天 " + shortChatId(chat.chat_id);
    }

    function selectedChat() {
      return (state.chats || []).find((chat) => String(chat.chat_id) === String(selectedChatId)) || null;
    }

    function userLabel(user) {
      if (user.display_name) return user.display_name;
      const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
      const username = user.username ? "@" + user.username : "";
      return [name, username].filter(Boolean).join(" ") || "User " + user.user_id;
    }

    function selectedUserLabel() {
      if (selectedUserId === "__shared") return "群公共";
      if (!selectedUserId || selectedUserId === "__all") return "这个聊天";
      const user = (state.users || []).find((item) => String(item.user_id) === String(selectedUserId));
      return user ? userLabel(user) : "用户 " + selectedUserId;
    }

    function personaScopeText() {
      if (selectedUserId && selectedUserId !== "__all" && selectedUserId !== "__shared") {
        return "当前会只绑定给「" + selectedUserLabel() + "」。适合写：小椰是谁的 AI 女友/AI 助理，以及在群里对其他人的边界。";
      }
      return "当前会写到群公共，会影响这个聊天里的所有人。要设置“是谁的 AI 女友/助理”，请先在左侧用户列表点具体的人。";
    }

    function personaTemplate(type) {
      const user = selectedUserLabel();
      if (type === "assistant") {
        return "你是 " + user + " 的 AI 助理，优先帮他整理信息、提醒事项、搜索资料和推进任务；在群聊里对其他成员保持普通协作口吻，不把自己设定成所有人的私人助理。";
      }
      return "你是 " + user + " 的 AI 女友，只对这个用户使用亲密、陪伴、撒娇但有边界的口吻；在群聊里对其他成员保持自然朋友口吻，不把自己设定成所有人的女友。";
    }

    function personaLabel(value) {
      const labels = {
        girlfriend: "AI 女友",
        boyfriend: "AI 男友",
        friend: "亲密朋友",
        assistant: "个人助理"
      };
      return labels[value] || value || "未设置";
    }

    function selectedScopeLabel() {
      if (selectedUserId === "__shared") return "正在看：群公共记忆";
      if (selectedUserId && selectedUserId !== "__all") return "正在看：单个用户记忆";
      return "正在看：全部记忆";
    }

    function memoryMeaning(key = "") {
      if (key === "relationship.persona") return "人格模式：最影响小椰说话关系感";
      if (key === "relationship.persona_prompt") return "人格提示词：定义关系归属和群聊边界";
      if (key === "chat.display_name") return "聊天显示名：只用于后台识别";
      if (key === "chat.feishu_name") return "飞书同步名称：自动读取的群聊/私聊名称";
      if (key === "user.display_name") return "飞书用户名称：自动读取的成员昵称";
      if (key.startsWith("profile.")) return "用户档案：平台、身份或基础资料";
      if (key.startsWith("user.")) return "用户偏好：称呼、习惯、喜好";
      if (key.startsWith("style.")) return "回复风格：语气、长度、表达方式";
      if (key.startsWith("bot.")) return "机器人设定：小椰自己的行为规则";
      return "普通长期记忆";
    }

    function renderUsers() {
      const el = document.getElementById("userList");
      if (!selectedChatId) {
        el.innerHTML = '<p class="muted">先选择聊天。</p>';
        return;
      }
      const rows = [
        { id: "__all", label: "全部记忆", meta: "公共 + 所有人" },
        { id: "__shared", label: "群公共", meta: "user id 为空" },
        ...(state.users || []).map(user => ({
          id: String(user.user_id),
          label: userLabel(user),
          meta: user.message_count + " messages · " + user.memory_count + " memories"
        }))
      ];
      el.innerHTML = rows.map(row => {
        const active = String(row.id) === String(selectedUserId) ? " active" : "";
        return '<button class="chat-row' + active + '" data-user="' + escapeHtml(row.id) + '">' +
          '<strong>' + escapeHtml(row.label) + '</strong>' +
          '<span>' + escapeHtml(row.meta) + '</span>' +
          '</button>';
      }).join("");
      for (const row of el.querySelectorAll(".chat-row")) {
        row.addEventListener("click", () => {
          selectedUserId = row.dataset.user;
          const query = "?chatId=" + encodeURIComponent(selectedChatId) + "&userId=" + encodeURIComponent(selectedUserId);
          history.replaceState(null, "", "/admin" + query);
          load();
        });
      }
    }

    function renderState() {
      renderChats();
      renderUsers();
      const chat = selectedChat();
      const chatName = displayChatName(chat);
      document.getElementById("chatTitle").textContent = selectedChatId ? "当前聊天：" + chatName : "选择一个聊天";
      document.getElementById("meta").textContent =
        selectedScopeLabel() + " · 触发模式 " + state.config.triggerMode + " · 存储 " + state.config.storage;
      document.getElementById("chatDisplayName").value = state.chatDisplayName || "";
      document.getElementById("chatRawIdPill").textContent = selectedChatId ? shortChatId(selectedChatId) : "未选择";
      document.getElementById("chatIdentityMeta").textContent = selectedChatId
        ? "原始 ID：" + selectedChatId + (chat?.feishu_name ? " · 飞书同步名：" + chat.feishu_name : "")
        : "先从左侧选择一个聊天。";

      const gptEnabled = state.settings?.gptEnabled !== false;
      document.getElementById("gptSwitch").checked = gptEnabled;
      document.getElementById("gptSwitchMeta").textContent = gptEnabled
        ? "开启：使用 GPT 主回复接口"
        : "关闭：直接使用备用 MiniMax";
      const smartRepliesEnabled = state.settings?.smartRepliesEnabled !== false;
      document.getElementById("smartRepliesSwitch").checked = smartRepliesEnabled;
      document.getElementById("smartRepliesSwitchMeta").textContent = smartRepliesEnabled
        ? "开启：普通群聊先由 AI 判断是否适合回复"
        : "关闭：群聊只响应 @、指令、私聊和明确任务";
      document.getElementById("alwaysReplyUsers").value = state.settings?.alwaysReplyUserIds || "";

      const persona = state.persona || state.config.companionMode || "girlfriend";
      document.getElementById("persona").value = persona;
      document.getElementById("personaPrompt").value = state.personaPrompt || "";
      document.getElementById("personaScopeWarning").textContent = personaScopeText();
      document.getElementById("summary").value = state.summary || "";
      document.getElementById("scopePill").textContent = selectedScopeLabel();
      document.getElementById("personaOverview").textContent = personaLabel(persona);
      document.getElementById("summaryOverview").textContent = state.summary ? "已填写" : "暂无";
      document.getElementById("memoryOverview").textContent = (state.memories?.length || 0) + " 条";
      document.getElementById("messageOverview").textContent = (state.messages?.length || 0) + " 条";
      document.getElementById("memoryCountPill").textContent = (state.memories?.length || 0) + " 条记忆";
      document.getElementById("messageCountPill").textContent = (state.messages?.length || 0) + " 条消息";
      document.getElementById("summaryScopePill").textContent = selectedUserId && selectedUserId !== "__all" && selectedUserId !== "__shared"
        ? "当前用户摘要"
        : "群公共摘要";

      const memoryEl = document.getElementById("memoryList");
      if (!state.memories.length) {
        memoryEl.innerHTML = '<p class="muted">暂无长期记忆。小椰会主要依赖系统人格、对话摘要和最近消息来回复。</p>';
      } else {
        memoryEl.innerHTML = state.memories.map((memory, index) => {
          const importantMemory = ["relationship.persona", "relationship.persona_prompt", "chat.display_name"].includes(memory.key);
          return (
          '<div class="memory-item ' + (importantMemory ? "persona" : "") + '" data-index="' + index + '">' +
            '<div class="memory-title">' +
              '<strong>' + escapeHtml(memoryMeaning(memory.key)) + '</strong>' +
              '<span>' + (memory.user_id ? "绑定用户" : "群公共") + '</span>' +
            '</div>' +
            '<div class="memory-meta">' +
              '<input class="memory-key" value="' + escapeHtml(memory.key) + '" />' +
              '<input class="memory-importance" type="number" min="1" max="5" value="' + escapeHtml(memory.importance) + '" />' +
              '<input class="memory-user" value="' + escapeHtml(memory.user_id || "") + '" placeholder="user id" />' +
            '</div>' +
            '<textarea class="memory-value">' + escapeHtml(memory.value) + '</textarea>' +
            '<div class="memory-actions">' +
              '<button class="save-memory primary">保存</button>' +
              '<button class="delete-memory danger">删除</button>' +
            '</div>' +
          '</div>'
          );
        }).join("");
        bindMemoryActions();
      }

      const projectList = document.getElementById("projectList");
      const projects = state.projects || [];
      projectList.innerHTML = projects.length ? projects.map(project => (
        '<div class="config-row">' +
          '<b>' + escapeHtml(project.id || "") + ' · ' + escapeHtml(project.status || "") + '</b>' +
          '<div>' + escapeHtml(project.title || "") + '</div>' +
          '<div class="muted">' + escapeHtml([project.client_name, project.product_name].filter(Boolean).join(" / ")) + '</div>' +
          (project.artifacts?.length ? '<div style="margin-top:6px">' + project.artifacts.map(item => (
            item.url
              ? '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.title || item.artifact_type || "artifact") + '</a>'
              : '<span class="muted">' + escapeHtml(item.title || item.artifact_type || "artifact") + '</span>'
          )).join("<br />") + '</div>' : '') +
        '</div>'
      )).join("") : '<p class="muted">暂无项目。</p>';

      const messages = document.getElementById("messages");
      messages.innerHTML = state.messages.length ? state.messages.map(msg => (
        '<div class="message ' + escapeHtml(msg.role) + '">' +
          '<b>' + escapeHtml(msg.role) + ' · ' + escapeHtml(msg.modality || "text") + ' · user ' + escapeHtml(msg.user_id || "") + '</b>' +
          '<div>' + escapeHtml(msg.content || "") + '</div>' +
        '</div>'
      )).join("") : '<p class="muted">暂无消息。</p>';

      const runtimeConfig = document.getElementById("runtimeConfig");
      const cfg = state.config || {};
      runtimeConfig.innerHTML = [
        ["主回复模型", cfg.primaryModel || "未显示"],
        ["主接口类型", cfg.primaryCompatibility || "未显示"],
        ["备用模型", cfg.fallbackModel || "未配置"],
        ["生图模型", cfg.imageModel || "未配置"],
        ["生图尺寸", cfg.imageSize || "未配置"],
        ["生图超时", cfg.imageTimeoutMs ? cfg.imageTimeoutMs + " ms" : "未配置"],
        ["识图提取超时", cfg.imageUnderstandingTimeoutMs ? cfg.imageUnderstandingTimeoutMs + " ms" : "未配置"],
        ["生图状态", cfg.imageGeneration ? "已开启" : "未开启"],
        ["语音识别", cfg.voiceRecognition ? "已开启" : "未开启"],
        ["指定用户优先回复", cfg.feishuAlwaysReplyUserIds || "未配置"],
        ["飞书项目文件夹", cfg.feishuProjectFolder ? "已配置" : "未配置"]
      ].map(row => (
        '<div class="config-row"><b>' + escapeHtml(row[0]) + '</b><div>' + escapeHtml(row[1]) + '</div></div>'
      )).join("");

      const runtimeLogs = document.getElementById("runtimeLogs");
      runtimeLogs.innerHTML = state.logs?.length ? state.logs.map(log => {
        const meta = log.meta && Object.keys(log.meta).length ? " · " + JSON.stringify(log.meta) : "";
        return '<div class="log-row ' + escapeHtml(log.level) + '">' +
          '<b>' + escapeHtml(log.ts) + ' · ' + escapeHtml(log.level) + '</b>' +
          '<div>' + escapeHtml(log.message + meta) + '</div>' +
          '</div>';
      }).join("") : '<p class="muted">暂无运行日志。</p>';
    }

    function bindMemoryActions() {
      document.querySelectorAll(".memory-item").forEach(item => {
        item.querySelector(".save-memory").addEventListener("click", async () => {
          const original = state.memories[Number(item.dataset.index)];
          await api("/api/admin/memory", {
            method: "POST",
            body: JSON.stringify({
              chatId: selectedChatId,
              oldKey: original.key,
              oldUserId: original.user_id || "",
              key: item.querySelector(".memory-key").value,
              value: item.querySelector(".memory-value").value,
              importance: item.querySelector(".memory-importance").value,
              userId: item.querySelector(".memory-user").value
            })
          });
          setStatus("已保存记忆。");
          await load();
        });
        item.querySelector(".delete-memory").addEventListener("click", async () => {
          const original = state.memories[Number(item.dataset.index)];
          if (!confirm("删除这条记忆？")) return;
          await api("/api/admin/memory", {
            method: "DELETE",
            body: JSON.stringify({ chatId: selectedChatId, key: original.key, userId: original.user_id || "" })
          });
          setStatus("已删除记忆。");
          await load();
        });
      });
    }

    async function load() {
      const query = selectedChatId
        ? "?chatId=" + encodeURIComponent(selectedChatId) + "&userId=" + encodeURIComponent(selectedUserId)
        : "";
      state = await api("/api/admin/state" + query);
      selectedChatId = state.selectedChatId || selectedChatId;
      selectedUserId = state.selectedUserId || selectedUserId;
      renderState();
    }

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function selectedMemoryUserId() {
      return selectedUserId && selectedUserId !== "__all" && selectedUserId !== "__shared" ? selectedUserId : "";
    }

    function splitAlwaysReplyUsers(value = "") {
      return String(value || "")
        .split(/[,\n，]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    document.getElementById("refreshBtn").addEventListener("click", load);
    document.getElementById("saveChatNameBtn").addEventListener("click", async () => {
      if (!selectedChatId) return setStatus("先选择一个聊天。");
      await api("/api/admin/chat-name", {
        method: "POST",
        body: JSON.stringify({ chatId: selectedChatId, displayName: document.getElementById("chatDisplayName").value })
      });
      setStatus("已保存聊天显示名。");
      await load();
    });
    document.getElementById("syncCurrentFeishuNamesBtn").addEventListener("click", async () => {
      if (!selectedChatId) return setStatus("先选择一个聊天。");
      setStatus("正在从飞书同步当前聊天和成员名...");
      const result = await api("/api/admin/sync-feishu-names", {
        method: "POST",
        body: JSON.stringify({ chatId: selectedChatId, includeUsers: true })
      });
      renderSyncReport(result);
      setStatus("同步完成：聊天名 " + result.chatsUpdated + " 个，成员名 " + result.usersUpdated + " 个，失败 " + result.errors.length + " 个。");
      await load();
    });
    document.getElementById("syncAllFeishuNamesBtn").addEventListener("click", async () => {
      setStatus("正在从飞书同步左侧全部聊天名...");
      const result = await api("/api/admin/sync-feishu-names", {
        method: "POST",
        body: JSON.stringify({ all: true, includeUsers: false })
      });
      renderSyncReport(result);
      setStatus("同步完成：聊天名 " + result.chatsUpdated + " 个，失败 " + result.errors.length + " 个。");
      await load();
    });
    document.getElementById("gptSwitch").addEventListener("change", async (event) => {
      const enabled = Boolean(event.target.checked);
      await api("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ gptEnabled: enabled })
      });
      setStatus(enabled ? "GPT 已开启，主聊天使用 GPT 接口。" : "GPT 已关闭，主聊天直接使用备用 MiniMax。");
      await load();
    });
    document.getElementById("smartRepliesSwitch").addEventListener("change", async (event) => {
      const enabled = Boolean(event.target.checked);
      await api("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ smartRepliesEnabled: enabled })
      });
      setStatus(enabled ? "智能插话已开启。" : "智能插话已关闭。");
      await load();
    });
    document.getElementById("addSelectedAlwaysReplyUserBtn").addEventListener("click", () => {
      const userId = selectedMemoryUserId();
      if (!userId) return setStatus("先在左侧用户列表选择一个具体用户。");
      const input = document.getElementById("alwaysReplyUsers");
      const values = splitAlwaysReplyUsers(input.value);
      if (!values.includes(userId)) values.push(userId);
      input.value = values.join(", ");
      setStatus("已加入左侧选中的用户，记得点保存白名单。");
    });
    document.getElementById("saveAlwaysReplyUsersBtn").addEventListener("click", async () => {
      const value = splitAlwaysReplyUsers(document.getElementById("alwaysReplyUsers").value).join(", ");
      await api("/api/admin/always-reply-users", {
        method: "POST",
        body: JSON.stringify({ value })
      });
      setStatus("已保存指定用户优先回复白名单。");
      await load();
    });
    document.getElementById("addMemoryBtn").addEventListener("click", async () => {
      if (!selectedChatId) return setStatus("先选择一个聊天。");
      await api("/api/admin/memory", {
        method: "POST",
        body: JSON.stringify({
          chatId: selectedChatId,
          key: document.getElementById("newKey").value,
          value: document.getElementById("newValue").value,
          importance: document.getElementById("newImportance").value,
          userId: selectedMemoryUserId()
        })
      });
      document.getElementById("newKey").value = "";
      document.getElementById("newValue").value = "";
      setStatus("已添加记忆。");
      await load();
    });
    document.getElementById("saveSummaryBtn").addEventListener("click", async () => {
      if (!selectedChatId) return setStatus("先选择一个聊天。");
      await api("/api/admin/summary", {
        method: "POST",
        body: JSON.stringify({ chatId: selectedChatId, userId: selectedMemoryUserId(), summary: document.getElementById("summary").value })
      });
      setStatus("已保存摘要。");
      await load();
    });
    document.getElementById("persona").addEventListener("change", async (event) => {
      if (!selectedChatId) return setStatus("先选择一个聊天。");
      await api("/api/admin/persona", {
        method: "POST",
        body: JSON.stringify({ chatId: selectedChatId, userId: selectedMemoryUserId(), persona: event.target.value })
      });
      setStatus("已切换人格。");
      await load();
    });

    for (const button of document.querySelectorAll("[data-persona-template]")) {
      button.addEventListener("click", () => {
        document.getElementById("personaPrompt").value = personaTemplate(button.dataset.personaTemplate);
      });
    }
    document.getElementById("savePersonaPromptBtn").addEventListener("click", async () => {
      if (!selectedChatId) return setStatus("先选择一个聊天。");
      await api("/api/admin/persona-prompt", {
        method: "POST",
        body: JSON.stringify({
          chatId: selectedChatId,
          userId: selectedMemoryUserId(),
          prompt: document.getElementById("personaPrompt").value
        })
      });
      setStatus(selectedMemoryUserId() ? "已保存这个用户的人格提示词。" : "已保存群公共人格提示词。");
      await load();
    });

    load().catch(error => setStatus(error.message));
  </script>
</body>
</html>`;
}

export function setupAdminRoutes(app, { config, storage, feishuBitable, feishuWorkspace }) {
  const auth = adminAuth(config);

  app.get("/admin", auth, (_req, res) => {
    res.type("html").send(adminPage(config));
  });

  app.get("/api/admin/state", auth, async (req, res) => {
    const rawChats = await storage.listChats(100);
    const chats = await attachChatDisplayNames(storage, rawChats);
    const selectedChatId = String(req.query.chatId || chats[0]?.chat_id || "");
    const selectedUserId = String(req.query.userId || "__all");
    const rawUsers = selectedChatId ? await storage.listUsers(selectedChatId, 300) : [];
    const allMemories = selectedChatId ? await storage.listMemories(selectedChatId, 500) : [];
    const users = attachUserDisplayNames(rawUsers, allMemories);
    const memories = filterMemories(allMemories, selectedUserId).slice(0, 300);
    const targetUserId = memoryTargetUserId(selectedUserId);
    const summary = selectedChatId ? await storage.getSummary(selectedChatId, targetUserId) : "";
    const messages = selectedChatId ? await storage.getRecentMessages(selectedChatId, 80) : [];
    const projects = selectedChatId ? await storage.listProjects(selectedChatId, 20) : [];
    for (const project of projects) {
      project.artifacts = await storage.listProjectArtifacts(project.id);
    }
    const gptEnabled = String(await storage.getSetting("gpt.enabled", "true")).toLowerCase() !== "false";
    const smartRepliesEnabled =
      String(await storage.getSetting("smart_replies.enabled", config.smartClassifierEnabled ? "true" : "false")).toLowerCase() !== "false";
    const alwaysReplyUserIds = await storage.getSetting(
      FEISHU_ALWAYS_REPLY_USERS_SETTING,
      (config.feishuAlwaysReplyUserIds || []).join(", ")
    );
    const persona =
      (targetUserId
        ? allMemories.find((memory) => memory.key === "relationship.persona" && String(memory.user_id || "") === targetUserId)?.value
        : "") ||
      allMemories.find((memory) => memory.key === "relationship.persona" && !memory.user_id)?.value ||
      config.companionMode;
    const chatDisplayName = findScopedMemoryValue(allMemories, CHAT_DISPLAY_NAME_KEY);
    const personaPrompt = findScopedMemoryValue(allMemories, PERSONA_PROMPT_KEY, targetUserId);

    res.json({
      selectedChatId,
      selectedUserId,
      chats,
      users,
      memories,
      summary,
      messages,
      projects,
      persona,
      personaPrompt,
      chatDisplayName,
      settings: {
        gptEnabled,
        smartRepliesEnabled,
        alwaysReplyUserIds
      },
      logs: getRuntimeLogs(80),
      config: {
        displayName: config.displayName,
        companionMode: config.companionMode,
        triggerMode: config.triggerMode,
        smartReplyConfidenceThreshold: config.smartReplyConfidenceThreshold,
        feishuAlwaysReplyUserIds: alwaysReplyUserIds,
        storage: config.databaseUrl ? "postgres" : "json-file",
        primaryModel: config.aiModel,
        primaryCompatibility: config.aiCompatibility,
        fallbackModel: config.fallbackAiModel,
        fallbackCompatibility: config.fallbackAiCompatibility,
        feishuProjectFolder: Boolean(config.feishuProjectFolderToken),
        imageGeneration: Boolean(config.imageGenerationEnabled && config.imageApiKey && config.imageApiUrl),
        imageModel: config.imageModel,
        imageSize: config.imageSize,
        imageTimeoutMs: config.imageTimeoutMs,
        imageUnderstandingTimeoutMs: config.imageUnderstandingTimeoutMs,
        webSearch: Boolean(config.webSearchEnabled && config.bochaApiKey),
        webSearchResultCount: config.bochaSearchCount,
        voiceRecognition: Boolean(config.sttEnabled && config.sttApiKey && config.sttApiUrl)
      }
    });
  });

  app.get("/api/admin/bitable/snapshot", auth, async (req, res) => {
    if (!feishuBitable?.enabled) {
      res.status(400).json({ error: "Feishu app credentials are not configured." });
      return;
    }

    const appToken = String(req.query.appToken || "P1g7bR1bkaBhIDs2QHQcoGbEnLg");
    const sampleSize = Math.min(Math.max(Number(req.query.sampleSize || 5), 0), 20);
    try {
      const snapshot = await feishuBitable.snapshot({ appToken, sampleSize });
      res.json({ ok: true, snapshot });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/memory", auth, async (req, res) => {
    const { chatId, userId = "", oldKey, oldUserId = "", key, value, importance } = req.body || {};
    if (!chatId || !key || !value) {
      res.status(400).json({ error: "chatId, key, and value are required." });
      return;
    }

    if (oldKey && (oldKey !== key || String(oldUserId || "") !== String(userId || ""))) {
      await storage.deleteMemory(chatId, oldUserId, oldKey);
    }
    await storage.setMemory(chatId, userId, { key, value, importance });
    res.json({ ok: true });
  });

  app.delete("/api/admin/memory", auth, async (req, res) => {
    const { chatId, userId = "", key } = req.body || {};
    if (!chatId || !key) {
      res.status(400).json({ error: "chatId and key are required." });
      return;
    }

    await storage.deleteMemory(chatId, userId, key);
    res.json({ ok: true });
  });

  app.post("/api/admin/chat-name", auth, async (req, res) => {
    const { chatId, displayName = "" } = req.body || {};
    if (!chatId) {
      res.status(400).json({ error: "chatId is required." });
      return;
    }

    const value = String(displayName || "").trim();
    if (!value) {
      await storage.deleteMemory(chatId, "", CHAT_DISPLAY_NAME_KEY);
    } else {
      await storage.setMemory(chatId, "", {
        key: CHAT_DISPLAY_NAME_KEY,
        value,
        importance: 5
      });
    }
    res.json({ ok: true });
  });

  app.post("/api/admin/sync-feishu-names", auth, async (req, res) => {
    const { chatId = "", all = false, includeUsers = true } = req.body || {};
    let chatIds = [];
    if (all) {
      const chats = await storage.listChats(100);
      chatIds = chats.map((chat) => chat.chat_id).filter(Boolean);
    } else if (chatId) {
      chatIds = [String(chatId)];
    }
    if (!chatIds.length) {
      res.status(400).json({ error: "chatId or all is required." });
      return;
    }

    try {
      const result = await syncFeishuNames({
        storage,
        feishuWorkspace,
        chatIds,
        includeUsers: Boolean(includeUsers) && !all,
        useChatList: Boolean(all)
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/persona-prompt", auth, async (req, res) => {
    const { chatId, userId = "", prompt = "" } = req.body || {};
    if (!chatId) {
      res.status(400).json({ error: "chatId is required." });
      return;
    }

    const value = String(prompt || "").trim();
    if (!value) {
      await storage.deleteMemory(chatId, userId, PERSONA_PROMPT_KEY);
    } else {
      await storage.setMemory(chatId, userId, {
        key: PERSONA_PROMPT_KEY,
        value,
        importance: 5
      });
    }
    res.json({ ok: true });
  });

  app.post("/api/admin/summary", auth, async (req, res) => {
    const { chatId, userId = "", summary = "" } = req.body || {};
    if (!chatId) {
      res.status(400).json({ error: "chatId is required." });
      return;
    }

    await storage.setSummary(chatId, summary, userId);
    res.json({ ok: true });
  });

  app.post("/api/admin/persona", auth, async (req, res) => {
    const { chatId, userId = "", persona } = req.body || {};
    if (!chatId || !persona) {
      res.status(400).json({ error: "chatId and persona are required." });
      return;
    }

    await storage.setMemory(chatId, userId, {
      key: "relationship.persona",
      value: persona,
      importance: 5
    });
    res.json({ ok: true });
  });

  app.post("/api/admin/settings", auth, async (req, res) => {
    const { gptEnabled, smartRepliesEnabled } = req.body || {};
    if (typeof gptEnabled !== "boolean" && typeof smartRepliesEnabled !== "boolean") {
      res.status(400).json({ error: "At least one boolean setting is required." });
      return;
    }

    const response = { ok: true };
    if (typeof gptEnabled === "boolean") {
      await storage.setSetting("gpt.enabled", gptEnabled ? "true" : "false");
      response.gptEnabled = gptEnabled;
    }
    if (typeof smartRepliesEnabled === "boolean") {
      await storage.setSetting("smart_replies.enabled", smartRepliesEnabled ? "true" : "false");
      response.smartRepliesEnabled = smartRepliesEnabled;
    }
    res.json(response);
  });

  app.post("/api/admin/always-reply-users", auth, async (req, res) => {
    const { value = "" } = req.body || {};
    const normalized = String(value || "")
      .split(/[,\n，]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(", ");
    await storage.setSetting(FEISHU_ALWAYS_REPLY_USERS_SETTING, normalized);
    res.json({ ok: true, value: normalized });
  });
}
