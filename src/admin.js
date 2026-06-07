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
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
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
    section h3 { margin: 0 0 12px; font-size: 15px; }
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
    .muted { color: var(--muted); }
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
      .shell, .grid { grid-template-columns: 1fr; }
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
      <div class="grid">
        <div>
          <section>
            <h3>新增记忆</h3>
            <div class="form-grid">
              <input id="newKey" placeholder="key，例如 user.nickname" />
              <input id="newImportance" type="number" min="1" max="5" value="3" />
              <button id="addMemoryBtn" class="primary">添加</button>
            </div>
            <textarea id="newValue" placeholder="记忆内容，例如 用户喜欢被叫老板。"></textarea>
          </section>
          <section>
            <h3>长期记忆</h3>
            <div id="memoryList" class="muted">暂无记忆</div>
          </section>
        </div>
        <div>
          <section>
            <h3>人格</h3>
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
            <hr style="border:0;border-top:1px solid var(--line);margin:14px 0" />
            <select id="persona">
              <option value="girlfriend">AI 女友</option>
              <option value="boyfriend">AI 男友</option>
              <option value="friend">亲密朋友</option>
              <option value="assistant">个人助理</option>
            </select>
            <p class="muted">这里会写入当前聊天的 relationship.persona 记忆，立即影响后续回复。</p>
          </section>
          <section>
            <h3>对话摘要</h3>
            <textarea id="summary"></textarea>
            <div class="memory-actions" style="margin-top:8px">
              <button id="saveSummaryBtn" class="primary">保存摘要</button>
            </div>
          </section>
          <section>
            <h3>最近消息</h3>
            <div id="messages" class="messages"></div>
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

    function renderChats() {
      const el = document.getElementById("chatList");
      if (!state.chats.length) {
        el.innerHTML = '<p class="muted">还没有聊天记录。</p>';
        return;
      }
      el.innerHTML = state.chats.map(chat => {
        const active = String(chat.chat_id) === String(selectedChatId) ? " active" : "";
        return '<button class="chat-row' + active + '" data-chat="' + escapeHtml(chat.chat_id) + '">' +
          '<strong>' + escapeHtml(chat.chat_id) + '</strong>' +
          '<span>' + chat.message_count + ' messages · ' + chat.memory_count + ' memories</span>' +
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

    function userLabel(user) {
      const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
      const username = user.username ? "@" + user.username : "";
      return [name, username].filter(Boolean).join(" ") || "User " + user.user_id;
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
      document.getElementById("chatTitle").textContent = selectedChatId ? "Chat " + selectedChatId : "选择一个聊天";
      document.getElementById("meta").textContent =
        "filter " + selectedUserId + " · trigger " + state.config.triggerMode + " · storage " + state.config.storage;

      const gptEnabled = state.settings?.gptEnabled !== false;
      document.getElementById("gptSwitch").checked = gptEnabled;
      document.getElementById("gptSwitchMeta").textContent = gptEnabled
        ? "开启：使用 GPT 主回复接口"
        : "关闭：直接使用备用 MiniMax";

      const persona = state.persona || state.config.companionMode || "girlfriend";
      document.getElementById("persona").value = persona;
      document.getElementById("summary").value = state.summary || "";

      const memoryEl = document.getElementById("memoryList");
      if (!state.memories.length) {
        memoryEl.innerHTML = '<p class="muted">暂无长期记忆。</p>';
      } else {
        memoryEl.innerHTML = state.memories.map((memory, index) => (
          '<div class="memory-item" data-index="' + index + '">' +
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
        )).join("");
        bindMemoryActions();
      }

      const messages = document.getElementById("messages");
      messages.innerHTML = state.messages.length ? state.messages.map(msg => (
        '<div class="message ' + escapeHtml(msg.role) + '">' +
          '<b>' + escapeHtml(msg.role) + ' · ' + escapeHtml(msg.modality || "text") + ' · user ' + escapeHtml(msg.user_id || "") + '</b>' +
          '<div>' + escapeHtml(msg.content || "") + '</div>' +
        '</div>'
      )).join("") : '<p class="muted">暂无消息。</p>';
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

    document.getElementById("refreshBtn").addEventListener("click", load);
    document.getElementById("gptSwitch").addEventListener("change", async (event) => {
      const enabled = Boolean(event.target.checked);
      await api("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ gptEnabled: enabled })
      });
      setStatus(enabled ? "GPT 已开启，主聊天使用 GPT 接口。" : "GPT 已关闭，主聊天直接使用备用 MiniMax。");
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

    load().catch(error => setStatus(error.message));
  </script>
</body>
</html>`;
}

export function setupAdminRoutes(app, { config, storage }) {
  const auth = adminAuth(config);

  app.get("/admin", auth, (_req, res) => {
    res.type("html").send(adminPage(config));
  });

  app.get("/api/admin/state", auth, async (req, res) => {
    const chats = await storage.listChats(100);
    const selectedChatId = String(req.query.chatId || chats[0]?.chat_id || "");
    const selectedUserId = String(req.query.userId || "__all");
    const users = selectedChatId ? await storage.listUsers(selectedChatId, 300) : [];
    const allMemories = selectedChatId ? await storage.listMemories(selectedChatId, 500) : [];
    const memories = filterMemories(allMemories, selectedUserId).slice(0, 300);
    const targetUserId = memoryTargetUserId(selectedUserId);
    const summary = selectedChatId ? await storage.getSummary(selectedChatId, targetUserId) : "";
    const messages = selectedChatId ? await storage.getRecentMessages(selectedChatId, 80) : [];
    const gptEnabled = String(await storage.getSetting("gpt.enabled", "true")).toLowerCase() !== "false";
    const persona =
      (targetUserId
        ? allMemories.find((memory) => memory.key === "relationship.persona" && String(memory.user_id || "") === targetUserId)?.value
        : "") ||
      allMemories.find((memory) => memory.key === "relationship.persona" && !memory.user_id)?.value ||
      config.companionMode;

    res.json({
      selectedChatId,
      selectedUserId,
      chats,
      users,
      memories,
      summary,
      messages,
      persona,
      settings: {
        gptEnabled
      },
      config: {
        displayName: config.displayName,
        companionMode: config.companionMode,
        triggerMode: config.triggerMode,
        storage: config.databaseUrl ? "postgres" : "json-file"
      }
    });
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
    const { gptEnabled } = req.body || {};
    if (typeof gptEnabled !== "boolean") {
      res.status(400).json({ error: "gptEnabled boolean is required." });
      return;
    }

    await storage.setSetting("gpt.enabled", gptEnabled ? "true" : "false");
    res.json({ ok: true, gptEnabled });
  });
}
