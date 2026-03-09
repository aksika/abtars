/**
 * Dashboard UI — inline HTML/CSS/JS for the Kiro Professor Web UI.
 *
 * Exports:
 *  - renderDashboardHtml(logoBase64): complete HTML string
 *  - getReconnectDelay(attempt): pure backoff calculation (testable)
 */

// ── Reconnect Backoff ───────────────────────────────────────────────────────

/**
 * Exponential backoff delay for WebSocket reconnection.
 * delay = min(1000 * 2^(attempt-1), 30000)
 *
 * @param attempt 1-based attempt number (first retry = 1)
 * @returns delay in milliseconds, capped at 30 000
 */
export function getReconnectDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt - 1), 30000);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Format byte count into human-readable string (KB, MB, GB).
 */
function formatBytesHelper(): string {
  return `
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  var k = 1024;
  var sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i >= sizes.length) i = sizes.length - 1;
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}`;
}

// ── Main Render Function ────────────────────────────────────────────────────

export function renderDashboardHtml(logoBase64: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kiro Professor Dashboard</title>
<style>
${getCss()}
</style>
</head>
<body>
${getHeaderHtml(logoBase64)}
<div id="connection-banner" class="connection-banner" style="display:none;">
  Connection lost. Reconnecting<span id="reconnect-dots">...</span>
</div>
<main class="grid">
  ${getBridgeHealthCard()}
  ${getPlatformsCard()}
  ${getTransportCard()}
  ${getMemoryCard()}
  ${getHeartbeatCard()}
</main>
<script>
${formatBytesHelper()}
${getScript()}
</script>
</body>
</html>`;
}

// ── CSS ─────────────────────────────────────────────────────────────────────

function getCss(): string {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
  min-height: 100vh;
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  background: #16213e;
  border-bottom: 1px solid #0f3460;
}

header img {
  width: 48px;
  height: 48px;
  border-radius: 8px;
}

header h1 {
  font-size: 1.4rem;
  font-weight: 600;
  color: #e0e0e0;
}

.connection-banner {
  background: #f44336;
  color: #fff;
  text-align: center;
  padding: 8px;
  font-size: 0.9rem;
  font-weight: 500;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 20px;
  padding: 24px;
}

.card {
  background: #16213e;
  border-radius: 12px;
  padding: 20px;
  border: 1px solid #0f3460;
}

.card h2 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 14px;
  color: #a0c4ff;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 0.85rem;
}

.stat-label { color: #9e9e9e; }
.stat-value { color: #e0e0e0; font-weight: 500; }

.indicator {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}

.indicator.green  { background: #4caf50; }
.indicator.yellow { background: #ff9800; }
.indicator.red    { background: #f44336; }

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}

.badge.running  { background: rgba(76,175,80,0.2); color: #4caf50; }
.badge.stopped  { background: rgba(255,152,0,0.2); color: #ff9800; }
.badge.error    { background: rgba(244,67,54,0.2); color: #f44336; }
.badge.disabled { background: rgba(100,100,100,0.2); color: #777; }
.badge.coming   { background: rgba(100,100,100,0.15); color: #666; font-style: italic; }

/* Platform group */
.platform-group { margin-bottom: 14px; }
.platform-group h3 {
  font-size: 0.8rem;
  color: #7e7e9e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.platform-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

.platform-item .name { font-size: 0.85rem; }

.platform-item button {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  font-size: 0.75rem;
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.2s;
}

.platform-item button:hover { opacity: 0.85; }

.btn-start { background: #4caf50; color: #fff; }
.btn-stop  { background: #f44336; color: #fff; }

.platform-item button:disabled {
  background: #333;
  color: #666;
  cursor: not-allowed;
}

.platform-item .coming-soon-tip {
  font-size: 0.7rem;
  color: #666;
  font-style: italic;
}

/* Transport */
.progress-bar-bg {
  background: #0f3460;
  border-radius: 6px;
  height: 14px;
  margin-top: 8px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 6px;
  background: #4caf50;
  transition: width 0.4s ease;
}

/* Memory */
.search-box {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.search-box input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid #0f3460;
  border-radius: 6px;
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 0.85rem;
  outline: none;
}

.search-box input:focus { border-color: #a0c4ff; }

.search-box button {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: #0f3460;
  color: #a0c4ff;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
}

.layer-toggles {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.layer-btn {
  padding: 3px 10px;
  border: 1px solid #0f3460;
  border-radius: 4px;
  background: transparent;
  color: #9e9e9e;
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.2s;
}

.layer-btn.active {
  background: #0f3460;
  color: #a0c4ff;
  border-color: #a0c4ff;
}

.layer-btn:disabled {
  color: #555;
  border-color: #333;
  cursor: not-allowed;
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
  font-size: 0.8rem;
}

.search-result-item {
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

.search-result-item .source {
  font-size: 0.7rem;
  color: #7e7e9e;
}

.search-result-item .score {
  font-size: 0.7rem;
  color: #ff9800;
  float: right;
}

/* Heartbeat task list */
.task-list {
  list-style: none;
  font-size: 0.8rem;
}

.task-list li {
  padding: 3px 0;
  color: #bbb;
}

.task-list li::before {
  content: '▸ ';
  color: #7e7e9e;
}

/* Responsive */
@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
    padding: 12px;
    gap: 12px;
  }
  header { padding: 14px 16px; }
}
`;
}

// ── HTML Fragments ──────────────────────────────────────────────────────────

function getHeaderHtml(logoBase64: string): string {
  return `
<header>
  <img src="data:image/jpeg;base64,${logoBase64}" alt="Kiro Professor Logo">
  <h1>Kiro Professor Dashboard</h1>
</header>`;
}

function getBridgeHealthCard(): string {
  return `
<div class="card" id="card-health">
  <h2>Bridge Health</h2>
  <div class="stat-row">
    <span class="stat-label">Uptime</span>
    <span class="stat-value" id="health-uptime">—</span>
  </div>
  <div class="stat-row">
    <span class="stat-label">Enabled Platforms</span>
    <span class="stat-value" id="health-platforms">—</span>
  </div>
  <div class="stat-row">
    <span class="stat-label">Heartbeat</span>
    <span class="stat-value" id="hb-status">
      <span class="indicator red"></span> stopped
    </span>
  </div>
  <div class="stat-row">
    <span class="stat-label">HB Interval</span>
    <span class="stat-value" id="hb-interval">—</span>
  </div>
  <div class="stat-row">
    <span class="stat-label">Last Update</span>
    <span class="stat-value" id="health-timestamp">—</span>
  </div>
</div>`;
}

function getPlatformsCard(): string {
  return `
<div class="card" id="card-platforms">
  <h2>Platforms</h2>

  <div class="platform-group">
    <h3>Access Interfaces</h3>
    <div class="platform-item" id="plat-telegram">
      <span class="name">Telegram</span>
      <span>
        <span class="badge disabled" id="plat-telegram-badge">—</span>
        <button class="btn-start" onclick="togglePlatform('telegram','start')" id="plat-telegram-start">Start</button>
        <button class="btn-stop" onclick="togglePlatform('telegram','stop')" id="plat-telegram-stop">Stop</button>
      </span>
    </div>
    <div class="platform-item" id="plat-discord">
      <span class="name">Discord</span>
      <span>
        <span class="badge disabled" id="plat-discord-badge">—</span>
        <button class="btn-start" onclick="togglePlatform('discord','start')" id="plat-discord-start">Start</button>
        <button class="btn-stop" onclick="togglePlatform('discord','stop')" id="plat-discord-stop">Stop</button>
      </span>
    </div>
  </div>

  <div class="platform-group">
    <h3>External Tooling</h3>
    <div class="platform-item">
      <span class="name">Projects</span>
      <span><span class="badge coming" title="coming soon">coming soon</span>
      <button disabled>Start</button></span>
    </div>
    <div class="platform-item" id="plat-nlm">
      <span class="name">LM Notebook</span>
      <span><span class="badge disabled" id="plat-nlm-badge">—</span></span>
    </div>
    <div class="platform-item">
      <span class="name">Keep</span>
      <span><span class="badge coming" title="coming soon">coming soon</span>
      <button disabled>Start</button></span>
    </div>
  </div>

  <div class="platform-group">
    <h3>Social Media</h3>
    <div class="platform-item">
      <span class="name">X</span>
      <span><span class="badge coming" title="coming soon">coming soon</span>
      <button disabled>Start</button></span>
    </div>
    <div class="platform-item">
      <span class="name">Facebook</span>
      <span><span class="badge coming" title="coming soon">coming soon</span>
      <button disabled>Start</button></span>
    </div>
  </div>
</div>`;
}

function getTransportCard(): string {
  return `
<div class="card" id="card-transport">
  <h2>Transport</h2>
  <div class="stat-row">
    <span class="stat-label">Type</span>
    <span class="stat-value" id="transport-type">—</span>
  </div>
  <div class="stat-row">
    <span class="stat-label">Connection</span>
    <span class="stat-value" id="transport-state">
      <span class="indicator red"></span> disconnected
    </span>
  </div>
  <div class="stat-row">
    <span class="stat-label">Switch Mode</span>
    <span class="stat-value">
      <button class="btn-start" style="font-size:0.75rem;padding:3px 10px;" onclick="switchTransport('tmux')" id="btn-switch-tmux">tmux</button>
      <button class="btn-stop" style="font-size:0.75rem;padding:3px 10px;" onclick="switchTransport('acp')" id="btn-switch-acp">acp</button>
    </span>
  </div>
  <div style="margin-top:10px;">
    <span class="stat-label">Context Window</span>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" id="transport-ctx-bar" style="width:0%"></div>
    </div>
    <div style="text-align:right;font-size:0.75rem;color:#9e9e9e;margin-top:2px;">
      <span id="transport-ctx-pct">—</span>
    </div>
  </div>
</div>`;
}

function getMemoryCard(): string {
  return `
<div class="card" id="card-memory">
  <h2>Memory</h2>
  <div id="memory-stats">
    <div class="stat-row">
      <span class="stat-label">Status</span>
      <span class="stat-value" id="mem-status">—</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Messages</span>
      <span class="stat-value" id="mem-messages">—</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Extracted</span>
      <span class="stat-value" id="mem-extracted">—</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Compactions (D/W/Q)</span>
      <span class="stat-value" id="mem-compactions">—</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Documents</span>
      <span class="stat-value" id="mem-documents">—</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">DB Size</span>
      <span class="stat-value" id="mem-dbsize">—</span>
    </div>
  </div>
  <hr style="border-color:#0f3460;margin:12px 0;">
  <div class="search-box" style="margin-bottom:6px;">
    <input type="text" id="mem-chatid-input" placeholder="0 = all chats" style="width:120px;text-align:center;flex:none;">
    <button onclick="listChatIds()">LIST</button>
  </div>
  <div class="search-box">
    <input type="text" id="mem-search-input" placeholder="Search memory keywords...">
  </div>
  <div class="layer-toggles" id="layer-toggles">
    <button class="layer-btn active" data-layer="L1" onclick="toggleLayer(this)">L1</button>
    <button class="layer-btn active" data-layer="L2" onclick="toggleLayer(this)">L2</button>
    <button class="layer-btn active" data-layer="L3" onclick="toggleLayer(this)">L3</button>
    <button class="layer-btn active" data-layer="L4" onclick="toggleLayer(this)">L4</button>
    <button class="layer-btn" data-layer="L5" disabled title="coming soon">L5</button>
  </div>
  <div class="search-results" id="mem-search-results"></div>
</div>`;
}

function getHeartbeatCard(): string {
  return '';
}

// ── Inline Script ───────────────────────────────────────────────────────────

function getScript(): string {
  return `
(function() {
  // ── Auth Token ──────────────────────────────────────────────────────
  var token = sessionStorage.getItem('dashboard_token');
  if (!token) {
    token = prompt('Enter dashboard auth token:');
    if (token) sessionStorage.setItem('dashboard_token', token);
  }
  if (!token) {
    document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#f44336;">Authentication token required. Reload to try again.</div>';
    return;
  }

  // ── Reconnect Backoff ──────────────────────────────────────────────
  function getReconnectDelay(attempt) {
    return Math.min(1000 * Math.pow(2, attempt - 1), 30000);
  }

  // ── Uptime Formatting ──────────────────────────────────────────────
  function formatUptime(ms) {
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    var parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0) parts.push(m + 'm');
    if (s > 0 || parts.length === 0) parts.push(s + 's');
    return parts.join(' ');
  }

  // ── WebSocket Connection ───────────────────────────────────────────
  var ws = null;
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var banner = document.getElementById('connection-banner');

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(token));

    ws.onopen = function() {
      reconnectAttempt = 0;
      banner.style.display = 'none';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onmessage = function(evt) {
      try {
        var snap = JSON.parse(evt.data);
        updateDashboard(snap);
      } catch(e) { /* ignore parse errors */ }
    };

    ws.onclose = function() {
      scheduleReconnect();
    };

    ws.onerror = function() {
      if (ws) ws.close();
    };
  }

  function scheduleReconnect() {
    banner.style.display = 'block';
    reconnectAttempt++;
    var delay = getReconnectDelay(reconnectAttempt);
    reconnectTimer = setTimeout(function() { connect(); }, delay);
  }

  // ── DOM Update ─────────────────────────────────────────────────────
  function updateDashboard(snap) {
    // Bridge Health
    var el;
    el = document.getElementById('health-uptime');
    if (el) el.textContent = formatUptime(snap.uptimeMs);

    el = document.getElementById('health-timestamp');
    if (el) el.textContent = new Date(snap.timestamp).toLocaleTimeString();

    // Enabled platforms count
    var enabledList = [];
    if (snap.platforms) {
      if (snap.platforms.telegram && snap.platforms.telegram.configured) enabledList.push('Telegram');
      if (snap.platforms.discord && snap.platforms.discord.configured) enabledList.push('Discord');
    }
    el = document.getElementById('health-platforms');
    if (el) el.textContent = enabledList.length > 0 ? enabledList.join(', ') : 'None';

    // Platforms
    updatePlatformRow('telegram', snap.platforms ? snap.platforms.telegram : null);
    updatePlatformRow('discord', snap.platforms ? snap.platforms.discord : null);

    // Transport
    if (snap.transport) {
      el = document.getElementById('transport-type');
      if (el) el.textContent = snap.transport.type || '—';

      el = document.getElementById('transport-state');
      if (el) {
        if (snap.transport.ready) {
          el.innerHTML = '<span class="indicator green"></span> connected';
        } else {
          el.innerHTML = '<span class="indicator red"></span> disconnected';
        }
      }

      var pct = snap.transport.contextPercent;
      el = document.getElementById('transport-ctx-bar');
      if (el) {
        if (pct >= 0) {
          el.style.width = Math.min(pct, 100) + '%';
          if (pct > 85) el.style.background = '#f44336';
          else if (pct > 60) el.style.background = '#ff9800';
          else el.style.background = '#4caf50';
        } else {
          el.style.width = '0%';
        }
      }
      el = document.getElementById('transport-ctx-pct');
      if (el) el.textContent = pct >= 0 ? pct + '%' : 'N/A';
    }

    // Memory
    if (snap.memory) {
      el = document.getElementById('mem-status');
      if (el) {
        if (!snap.memory.enabled) {
          el.innerHTML = '<span class="indicator yellow"></span> disabled';
        } else if (snap.memory.error) {
          el.innerHTML = '<span class="indicator red"></span> error';
        } else {
          el.innerHTML = '<span class="indicator green"></span> enabled';
        }
      }

      if (snap.memory.stats) {
        var s = snap.memory.stats;
        setText('mem-messages', s.totalMessages);
        setText('mem-extracted', s.extractedMemories);
        setText('mem-compactions', s.compactions.daily + ' / ' + s.compactions.weekly + ' / ' + s.compactions.quarterly);
        setText('mem-documents', s.ingestedDocuments);
        setText('mem-dbsize', formatBytes(s.dbSizeBytes));
      } else {
        setText('mem-messages', '—');
        setText('mem-extracted', '—');
        setText('mem-compactions', '—');
        setText('mem-documents', '—');
        setText('mem-dbsize', '—');
      }
    }

    // NotebookLM
    var nlmBadge = document.getElementById('plat-nlm-badge');
    if (nlmBadge) {
      if (snap.notebooklm && snap.notebooklm.enabled) {
        nlmBadge.textContent = 'active (cache: ' + snap.notebooklm.hits + 'h/' + snap.notebooklm.misses + 'm)';
        nlmBadge.className = 'badge running';
      } else {
        nlmBadge.textContent = 'disabled';
        nlmBadge.className = 'badge disabled';
      }
    }

    // Heartbeat
    if (snap.heartbeat) {
      el = document.getElementById('hb-status');
      if (el) {
        if (snap.heartbeat.running) {
          el.innerHTML = '<span class="indicator green"></span> running';
        } else {
          el.innerHTML = '<span class="indicator yellow"></span> stopped';
        }
      }

      el = document.getElementById('hb-interval');
      if (el) el.textContent = snap.heartbeat.intervalMs ? (snap.heartbeat.intervalMs / 1000) + 's' : '—';
    }
  }

  function updatePlatformRow(name, state) {
    var badge = document.getElementById('plat-' + name + '-badge');
    var btnStart = document.getElementById('plat-' + name + '-start');
    var btnStop = document.getElementById('plat-' + name + '-stop');
    if (!badge) return;

    if (!state || !state.configured) {
      badge.textContent = 'not configured';
      badge.className = 'badge disabled';
      if (btnStart) btnStart.disabled = true;
      if (btnStop) btnStop.disabled = true;
      return;
    }

    if (state.running) {
      badge.textContent = 'running';
      badge.className = 'badge running';
      if (btnStart) btnStart.disabled = true;
      if (btnStop) btnStop.disabled = false;
    } else {
      badge.textContent = 'stopped';
      badge.className = 'badge stopped';
      if (btnStart) btnStart.disabled = false;
      if (btnStop) btnStop.disabled = true;
    }
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val != null ? String(val) : '—';
  }

  function escHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Platform Toggle API ────────────────────────────────────────────
  window.togglePlatform = function(platform, action) {
    fetch('/api/platforms/' + platform + '/' + action, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) alert('Error: ' + data.error);
    }).catch(function(err) { alert('Request failed: ' + err.message); });
  };

  // ── Transport Switch API ───────────────────────────────────────────
  window.switchTransport = function(mode) {
    fetch('/api/transport/switch', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mode: mode })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) alert('Error: ' + data.error);
    }).catch(function(err) { alert('Request failed: ' + err.message); });
  };

  // ── Memory Search API ──────────────────────────────────────────────
  window.searchMemory = function() {
    var input = document.getElementById('mem-search-input');
    var keywords = input ? input.value.trim() : '';
    if (!keywords) return;

    var chatIdInput = document.getElementById('mem-chatid-input');
    var chatIdVal = chatIdInput ? chatIdInput.value.trim() : '0';
    var chatId = parseInt(chatIdVal, 10) || 0;

    var layers = getSelectedLayers();
    var url = '/api/memory/search?keywords=' + encodeURIComponent(keywords) + '&original=' + encodeURIComponent(keywords) + '&layers=' + encodeURIComponent(layers.join(','));
    if (chatId > 0) {
      url += '&chatId=' + chatId;
    }

    fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
      var container = document.getElementById('mem-search-results');
      if (!container) return;

      if (data.error) {
        container.innerHTML = '<div style="color:#f44336;padding:6px 0;">' + escHtml(data.error) + '</div>';
        return;
      }

      if (!data.results || data.results.length === 0) {
        container.innerHTML = '<div style="color:#666;padding:6px 0;">No results found</div>';
        return;
      }

      container.innerHTML = data.results.map(function(r) {
        return '<div class="search-result-item">' +
          '<span class="score">score: ' + (r.score != null ? r.score.toFixed(2) : '—') + '</span>' +
          '<div>' + escHtml(r.content.substring(0, 200)) + '</div>' +
          '<div class="source">' + escHtml(r.source) + ' · ' + escHtml(r.date) + '</div>' +
          '</div>';
      }).join('');
    }).catch(function(err) {
      var container = document.getElementById('mem-search-results');
      if (container) container.innerHTML = '<div style="color:#f44336;">Search failed: ' + escHtml(err.message) + '</div>';
    });
  };

  // ── List Chat IDs API ──────────────────────────────────────────────
  window.listChatIds = function() {
    fetch('/api/memory/chats', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
      var container = document.getElementById('mem-search-results');
      if (!container) return;

      if (data.error) {
        container.innerHTML = '<div style="color:#f44336;padding:6px 0;">' + escHtml(data.error) + '</div>';
        return;
      }

      if (!data.chatIds || data.chatIds.length === 0) {
        container.innerHTML = '<div style="color:#666;padding:6px 0;">No chats found</div>';
        return;
      }

      container.innerHTML = '<div style="padding:6px 0;color:#e0e0e0;">' +
        '<strong>Stored Chat IDs:</strong><br>' +
        data.chatIds.map(function(id) {
          return '<span style="cursor:pointer;color:#64b5f6;margin-right:12px;" onclick="document.getElementById(&quot;mem-chatid-input&quot;).value=&quot;' + id + '&quot;">' + id + '</span>';
        }).join('') +
        '</div>';
    }).catch(function(err) {
      var container = document.getElementById('mem-search-results');
      if (container) container.innerHTML = '<div style="color:#f44336;">Failed to list chats: ' + escHtml(err.message) + '</div>';
    });
  };

  // ── Layer Toggles ──────────────────────────────────────────────────
  window.toggleLayer = function(btn) {
    if (btn.disabled) return;
    btn.classList.toggle('active');
  };

  function getSelectedLayers() {
    var btns = document.querySelectorAll('#layer-toggles .layer-btn');
    var selected = [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('active') && !btns[i].disabled) {
        selected.push(btns[i].getAttribute('data-layer'));
      }
    }
    return selected;
  }

  // ── Enter key for search ───────────────────────────────────────────
  var searchInput = document.getElementById('mem-search-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') searchMemory();
    });
  }

  var chatIdInput = document.getElementById('mem-chatid-input');
  if (chatIdInput) {
    chatIdInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') searchMemory();
    });
  }

  // ── Start Connection ───────────────────────────────────────────────
  connect();
})();
`;
}
