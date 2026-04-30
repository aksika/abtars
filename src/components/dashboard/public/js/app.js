/**
 * app.js — Dashboard entry point (ES module).
 * Sets up auth, WebSocket, event delegation, and card updates.
 */

// ── Auth ─────────────────────────────────────────────────────────────────────
let token = sessionStorage.getItem("dashboard_token");
if (!token) {
  token = new URLSearchParams(location.search).get("token") || prompt("Enter dashboard auth token:");
  if (token) sessionStorage.setItem("dashboard_token", token);
}
if (!token) {
  document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#f44336;">Authentication token required. Reload to try again.</div>';
  throw new Error("no token");
}

// ── Capability flags ─────────────────────────────────────────────────────────
const body = document.body;
if (body.dataset.hasAgentApi === "true") {
  const el = document.getElementById("plat-agent-api");
  if (el) el.style.display = "";
  const badge = document.getElementById("plat-agent-api-badge");
  if (badge) badge.dataset.port = body.dataset.agentApiPort || "";
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (h > 0) parts.push(h + "h");
  if (m > 0) parts.push(m + "m");
  if (sec > 0 || parts.length === 0) parts.push(sec + "s");
  return parts.join(" ");
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val != null ? String(val) : "—";
}

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function authHeaders() {
  return { "Authorization": "Bearer " + token };
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws = null, reconnectAttempt = 0, reconnectTimer = null;
const banner = document.getElementById("connection-banner");

function getReconnectDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt - 1), 30000);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws?token=" + encodeURIComponent(token));
  ws.onopen = () => { reconnectAttempt = 0; banner.style.display = "none"; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
  ws.onmessage = (evt) => { try { updateDashboard(JSON.parse(evt.data)); } catch {} };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { if (ws) ws.close(); };
}

function scheduleReconnect() {
  banner.style.display = "block";
  reconnectAttempt++;
  reconnectTimer = setTimeout(connect, getReconnectDelay(reconnectAttempt));
}

// ── Dashboard Update ─────────────────────────────────────────────────────────
function updateDashboard(snap) {
  // Bridge Health
  setText("health-uptime", formatUptime(snap.uptimeMs));
  setText("health-timestamp", new Date(snap.timestamp).toLocaleTimeString());

  // Platforms
  if (snap.services) {
    updateServiceRow("telegram", snap.services.telegram);
    updateServiceRow("discord", snap.services.discord);
    updateServiceRow("agent-api", snap.services["agent-api"]);
    const enabled = [];
    if (snap.services.telegram?.running) enabled.push("Telegram");
    if (snap.services.discord?.running) enabled.push("Discord");
    setText("health-platforms", enabled.length > 0 ? enabled.join(", ") : "None");
  }

  // Transport
  if (snap.transport) {
    setText("transport-type", snap.transport.type || "—");
    const stateEl = document.getElementById("transport-state");
    if (stateEl) stateEl.innerHTML = snap.transport.ready
      ? '<span class="indicator green"></span> connected'
      : '<span class="indicator red"></span> disconnected';
    const pct = snap.transport.contextPercent;
    const bar = document.getElementById("transport-ctx-bar");
    if (bar) {
      bar.style.width = pct >= 0 ? Math.min(pct, 100) + "%" : "0%";
      bar.style.background = pct > 85 ? "#f44336" : pct > 60 ? "#ff9800" : "#4caf50";
    }
    setText("transport-ctx-pct", pct >= 0 ? pct + "%" : "N/A");
  }

  // Memory
  if (snap.memory) {
    const memStatus = document.getElementById("mem-status");
    if (memStatus) {
      memStatus.innerHTML = !snap.memory.enabled
        ? '<span class="indicator yellow"></span> disabled'
        : snap.memory.error ? '<span class="indicator red"></span> error'
        : '<span class="indicator green"></span> enabled';
    }
    if (snap.memory.stats) {
      const s = snap.memory.stats;
      setText("mem-messages", s.totalMessages);
      setText("mem-extracted", s.extractedMemories);
      setText("mem-consolidations", s.consolidationFiles.daily + " / " + s.consolidationFiles.weekly + " / " + s.consolidationFiles.quarterly);
      setText("mem-documents", s.ingestedDocuments);
      setText("mem-dbsize", formatBytes(s.dbSizeBytes));
    }
  }

  // Auth indicators
  const authGws = document.getElementById("auth-gws");
  if (authGws) authGws.innerHTML = '<span class="auth-dot ' + (snap.gwsAuth ? "ok" : "no") + '"></span>' + (snap.gwsAuth ? "Authenticated" : "Not configured");
  const authNlm = document.getElementById("auth-nlm");
  if (authNlm) authNlm.innerHTML = '<span class="auth-dot ' + (snap.notebooklm?.enabled ? "ok" : "no") + '"></span>' + (snap.notebooklm?.enabled ? "Active" : "Disabled");
  const authX = document.getElementById("auth-x");
  if (authX) authX.innerHTML = '<span class="auth-dot ' + (snap.xAuth ? "ok" : "no") + '"></span>' + (snap.xAuth ? "Authenticated" : "No cookies");

  // Heartbeat
  if (snap.heartbeat) {
    const hbEl = document.getElementById("hb-status");
    if (hbEl) {
      hbEl.innerHTML = snap.heartbeat.running
        ? '<span class="indicator green"></span> ' + (snap.heartbeat.intervalMs ? (snap.heartbeat.intervalMs / 1000) + "s" : "")
        : '<span class="indicator red"></span> FAILED';
    }
    const hbTasks = document.getElementById("hb-tasks");
    if (hbTasks && snap.heartbeat.taskNames) {
      hbTasks.innerHTML = snap.heartbeat.taskNames.length === 0
        ? '<div style="color:#666;font-size:0.82rem;">No tasks registered</div>'
        : snap.heartbeat.taskNames.map(name =>
          '<div class="stat-row"><span class="stat-label">' + escHtml(name) + '</span><span class="stat-value"><span class="indicator ' + (snap.heartbeat.running ? "green" : "yellow") + '"></span></span></div>'
        ).join("");
    }
  }

  // Cron
  if (snap.cron) updateCronPanel(snap.cron);

  // A2A
  updateA2ATraffic(snap.agentApi);
}

function updateServiceRow(name, state) {
  const badge = document.getElementById("plat-" + name + "-badge");
  const btnStart = document.getElementById("plat-" + name + "-start");
  const btnStop = document.getElementById("plat-" + name + "-stop");
  if (!badge) return;
  if (!state || !state.configured) {
    badge.textContent = "not configured"; badge.className = "badge disabled";
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;
    return;
  }
  if (state.running) {
    badge.textContent = name === "agent-api" ? "⚠️ " + (badge.dataset.port || "?") : "running";
    badge.className = name === "agent-api" ? "badge running clickable" : "badge running";
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
  } else {
    badge.textContent = "stopped"; badge.className = "badge stopped";
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
  }
}

// ── Cron Panel ───────────────────────────────────────────────────────────────
function updateCronPanel(entries) {
  const container = document.getElementById("cron-entries");
  if (!container) return;
  if (!entries || entries.length === 0) {
    container.innerHTML = '<div style="color:#666;font-size:0.82rem;">No scheduled tasks</div>';
    return;
  }
  container.innerHTML = entries.map(e => {
    const statusBadge = e.paused ? '<span class="badge paused">paused</span>' : '<span class="badge running">active</span>';
    const priorityBadge = e.priority === "high" ? ' <span class="badge high">HIGH</span>' : e.priority === "low" ? ' <span class="badge low">LOW</span>' : "";
    const nextFire = e.paused ? "—" : new Date(e.fireAt).toLocaleString();
    const lastRan = e.lastRanAt ? new Date(e.lastRanAt).toLocaleString() : "never";
    const pauseBtn = e.paused
      ? `<button class="btn-start" data-action="cron-action" data-id="${e.id}" data-op="resume">Resume</button>`
      : `<button class="btn-stop" data-action="cron-action" data-id="${e.id}" data-op="pause">Pause</button>`;
    return `<div class="cron-entry"><div class="cron-info"><div class="cron-label">${statusBadge}${priorityBadge} ${escHtml(e.label)}</div><div class="cron-meta">${escHtml(e.schedule)} · ${e.executor} · next: ${nextFire} · last: ${lastRan}</div></div><div class="cron-actions">${pauseBtn}<button class="btn-start" style="background:#0f3460;color:#a0c4ff;" data-action="cron-action" data-id="${e.id}" data-op="trigger">▶ Run</button></div></div>`;
  }).join("");
}

// ── A2A Traffic ──────────────────────────────────────────────────────────────
let lastTrafficCount = 0;

function updateA2ATraffic(agentApi) {
  if (!agentApi?.traffic) return;
  const entries = agentApi.traffic;
  if (entries.length === lastTrafficCount) return;
  lastTrafficCount = entries.length;
  setText("a2a-count", entries.length + " entries");
  const container = document.getElementById("a2a-entries");
  if (!container) return;
  if (entries.length === 0) {
    container.innerHTML = '<div class="a2a-empty">No traffic yet. Waiting for agent requests...</div>';
    return;
  }
  container.innerHTML = entries.slice().reverse().map(e => {
    const time = new Date(e.ts).toLocaleTimeString();
    const epClass = e.endpoint === "prompt" ? "prompt" : e.endpoint === "reset" ? "reset" : "status";
    let body = "";
    if (e.endpoint === "prompt") {
      body = '<div class="a2a-prompt">→ ' + escHtml(e.prompt) + "</div>";
      if (e.response) body += '<div class="a2a-response">← ' + escHtml(e.response) + "</div>";
    } else {
      body = '<div class="a2a-response">' + escHtml(e.response || e.endpoint) + "</div>";
    }
    body += '<div class="a2a-meta">' + (e.ip || "—") + " · " + e.durationMs + "ms · " + e.status + "</div>";
    return `<div class="a2a-entry"><span class="a2a-time">${time}</span><span class="a2a-endpoint ${epClass}">${e.endpoint}</span><div class="a2a-body">${body}</div></div>`;
  }).join("");
}

// ── Log Panel ────────────────────────────────────────────────────────────────
const logLevels = { info: true, warn: true, error: true, debug: false };

function fetchLogs() {
  const active = Object.keys(logLevels).filter(k => logLevels[k]);
  const container = document.getElementById("log-entries");
  if (active.length === 0) { if (container) container.innerHTML = '<div style="color:#666;padding:12px;">No levels selected</div>'; return; }
  fetch("/api/logs?level=" + active.join(",") + "&limit=500", { headers: authHeaders() })
    .then(r => r.json())
    .then(data => {
      if (!container || !data.lines) return;
      const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
      container.innerHTML = data.lines.map(line => {
        let lvl = "info";
        if (line.includes(" WARN ")) lvl = "warn";
        else if (line.includes(" ERROR")) lvl = "error";
        else if (line.includes(" DEBUG")) lvl = "debug";
        return '<div class="log-line ' + lvl + '">' + escHtml(line.slice(0, 19).replace("T", " ") + line.slice(24)) + "</div>";
      }).join("");
      if (wasAtBottom) container.scrollTop = container.scrollHeight;
    }).catch(() => {});
}

// ── Memory Search ────────────────────────────────────────────────────────────
let keywordFilters = [];
let searchMode = "or";

function getSelectedStages() {
  return [...document.querySelectorAll("#layer-toggles .layer-btn.active")].map(b => b.dataset.layer);
}

function renderFilters() {
  const container = document.getElementById("keyword-filters");
  if (!container) return;
  container.innerHTML = keywordFilters.map((kw, i) =>
    `<span class="keyword-chip" data-action="remove-filter" data-index="${i}">${escHtml(kw)} ✕</span>`
  ).join("");
}

function searchMemory() {
  const container = document.getElementById("mem-search-results");
  if (keywordFilters.length === 0) { if (container) container.innerHTML = ""; return; }
  const stages = getSelectedStages();
  if (stages.length === 0) { if (container) container.innerHTML = '<div style="color:#666;padding:6px 0;">No stages selected</div>'; return; }
  const userId = document.getElementById("mem-userid-input")?.value.trim() || "";
  const entity = document.getElementById("mem-entity-input")?.value || "";
  const keywords = keywordFilters.join(",");
  let url = "/api/memory/search?keywords=" + encodeURIComponent(keywords) + "&original=" + encodeURIComponent(keywords) + "&stages=" + encodeURIComponent(stages.join(",")) + "&mode=" + searchMode;
  if (entity) url += "&entity=" + encodeURIComponent(entity);
  if (userId) url += "&userId=" + encodeURIComponent(userId);
  fetch(url, { headers: authHeaders() }).then(r => r.json()).then(data => {
    if (!container) return;
    if (data.error) { container.innerHTML = '<div style="color:#f44336;padding:6px 0;">' + escHtml(data.error) + "</div>"; return; }
    if (!data.results?.length) { container.innerHTML = '<div style="color:#666;padding:6px 0;">No results found</div>'; return; }
    let stageInfo = "";
    if (data.layers) {
      stageInfo = '<div style="color:#888;font-size:11px;margin-bottom:6px;">' + Object.keys(data.layers).map(k => k + ":" + (data.layers[k].hits || 0) + " (" + (data.layers[k].ms || 0) + "ms)").join(" | ") + "</div>";
    }
    container.innerHTML = stageInfo + data.results.map(r => {
      let meta = '<span class="score">' + (r.score != null ? r.score.toFixed(2) : "—") + '</span> <span class="source">' + escHtml(r.source) + '</span> <span class="source">' + escHtml(r.date) + "</span>";
      if (r.memoryType) meta += ' <span class="source">' + r.memoryType + "</span>";
      let content = escHtml(r.content.substring(0, 300));
      if (r.contentOriginal && r.contentOriginal !== r.content) content += '<div style="color:#888;font-size:11px;margin-top:2px;">' + escHtml(r.contentOriginal.substring(0, 200)) + "</div>";
      return '<div class="search-result-item"><div class="result-meta">' + meta + '</div><div class="result-content">' + content + "</div></div>";
    }).join("");
  }).catch(err => { if (container) container.innerHTML = '<div style="color:#f44336;">Search failed: ' + escHtml(err.message) + "</div>"; });
}

function listChatIds() {
  fetch("/api/memory/chats", { headers: authHeaders() }).then(r => r.json()).then(data => {
    const container = document.getElementById("mem-search-results");
    if (!container) return;
    if (data.error) { container.innerHTML = '<div style="color:#f44336;">' + escHtml(data.error) + "</div>"; return; }
    if (!data.userIds?.length) { container.innerHTML = '<div style="color:#666;">No chats found</div>'; return; }
    container.innerHTML = '<div style="padding:6px 0;color:#e0e0e0;"><strong>Stored Chat IDs:</strong><br>' +
      data.userIds.map(id => `<span style="cursor:pointer;color:#64b5f6;margin-right:12px;" data-action="select-chat-id" data-id="${id}">${id}</span>`).join("") + "</div>";
  }).catch(() => {});
}

// ── Event Delegation ─────────────────────────────────────────────────────────
document.body.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case "toggle-platform": {
      const name = target.dataset.name, op = target.dataset.op;
      fetch("/api/services/" + name + "/" + op, { method: "POST", headers: authHeaders() })
        .then(r => r.json()).then(d => { if (d.error) alert("Error: " + d.error); })
        .catch(err => alert("Request failed: " + err.message));
      break;
    }
    case "toggle-overlay": {
      const el = document.getElementById(target.dataset.target);
      if (el) el.style.display = el.style.display === "none" ? "flex" : "none";
      break;
    }
    case "toggle-a2a-panel": {
      const panel = document.getElementById("a2a-panel");
      if (panel) panel.style.display = panel.style.display === "none" ? "flex" : "none";
      break;
    }
    case "load-universe": {
      if (window.initMemoryUniverse) window.initMemoryUniverse(token);
      break;
    }
    case "toggle-log-level": {
      const level = target.dataset.level;
      logLevels[level] = !logLevels[level];
      target.classList.toggle("active", logLevels[level]);
      fetchLogs();
      break;
    }
    case "toggle-layer": {
      target.classList.toggle("active");
      searchMemory();
      break;
    }
    case "toggle-search-mode": {
      searchMode = searchMode === "or" ? "and" : "or";
      target.textContent = searchMode.toUpperCase();
      target.classList.toggle("active", searchMode === "or");
      searchMemory();
      break;
    }
    case "search-memory": {
      searchMemory();
      break;
    }
    case "list-chat-ids": {
      listChatIds();
      break;
    }
    case "remove-filter": {
      keywordFilters.splice(Number(target.dataset.index), 1);
      renderFilters();
      searchMemory();
      break;
    }
    case "cron-action": {
      fetch("/api/cron/" + target.dataset.id + "/" + target.dataset.op, { method: "POST", headers: authHeaders() })
        .then(r => r.json()).then(d => { if (d.error) alert("Error: " + d.error); })
        .catch(err => alert("Request failed: " + err.message));
      break;
    }
    case "select-chat-id": {
      const input = document.getElementById("mem-userid-input");
      if (input) input.value = target.dataset.id;
      break;
    }
  }
});

// Keyword input Enter handler
const kwInput = document.getElementById("mem-keyword-input");
if (kwInput) {
  kwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = kwInput.value.trim();
      if (val && !keywordFilters.includes(val)) {
        keywordFilters.push(val);
        renderFilters();
        searchMemory();
      }
      kwInput.value = "";
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
connect();
fetchLogs();
setInterval(fetchLogs, 10000);
