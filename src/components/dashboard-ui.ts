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

export function renderDashboardHtml(logoBase64: string, opts?: { agentApi?: { port: number; allowedIps: string[] } }): string {
  const agentHtml = opts?.agentApi
    ? `<div class="platform-item" id="plat-agent-api">
      <span class="name">Agent API</span>
      <span>
        <span class="badge disabled" id="plat-agent-api-badge">—</span>
        <button class="btn-start" onclick="togglePlatform('agent-api','start')" id="plat-agent-api-start">Start</button>
        <button class="btn-stop" onclick="togglePlatform('agent-api','stop')" id="plat-agent-api-stop">Stop</button>
      </span>
    </div>`
    : "";
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
<div class="dashboard-layout">
<div class="main-area">
<main class="grid">
  ${getBridgeHealthCard()}
  ${getPlatformsCard(agentHtml)}
  ${getMemoryCard()}
  ${getCronCard()}
</main>
${getSearchPanel()}
${getA2APanel()}
</div>
${getLogPanel()}
</div>
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
  overflow: hidden;
}

.dashboard-layout {
  display: flex;
  flex-direction: row;
  height: calc(100vh - 69px);
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
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
  flex-shrink: 0;
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
.badge.clickable { cursor: pointer; transition: background 0.2s; }
.badge.clickable:hover { background: rgba(76,175,80,0.35); }
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

.search-result-item .result-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 2px;
}

.search-result-item .result-content {
  font-size: 0.8rem;
  color: #ccc;
}

.search-result-item .source {
  font-size: 0.7rem;
  color: #7e7e9e;
}

.search-result-item .score {
  font-size: 0.7rem;
  color: #ff9800;
  font-weight: 600;
}

/* Split card */
.card-split { display: flex; flex-direction: column; }
.split-divider { border: none; border-top: 1px solid #0f3460; margin: 14px 0; }
.split-bottom h2 { margin-bottom: 10px; }

/* Search toggle button */
.btn-search-toggle {
  width: 100%;
  padding: 8px;
  border: 1px solid #0f3460;
  border-radius: 6px;
  background: transparent;
  color: #a0c4ff;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  transition: background 0.2s;
}
.btn-search-toggle:hover { background: rgba(15,52,96,0.5); }

/* Search panel */
.search-panel {
  background: #16213e;
  border-top: 1px solid #0f3460;
  padding: 16px 24px;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.search-panel-header { margin-bottom: 12px; flex-shrink: 0; }
.search-panel-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.keyword-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid #0f3460;
  border-radius: 6px;
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 0.85rem;
  outline: none;
}
.keyword-input:focus { border-color: #a0c4ff; }
.btn-search {
  padding: 6px 18px;
  border: none;
  border-radius: 6px;
  background: #0f3460;
  color: #a0c4ff;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
}
.keyword-filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.keyword-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: #0f3460;
  color: #a0c4ff;
  border-radius: 12px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.2s;
}
.keyword-chip:hover { background: #f44336; color: #fff; }
.search-panel .search-results {
  max-height: none;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  font-size: 0.8rem;
}

/* A2A Traffic Panel */
.a2a-panel {
  background: #16213e;
  border-top: 1px solid #0f3460;
  padding: 16px 24px;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.a2a-panel .a2a-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.a2a-panel .a2a-header h3 { margin: 0; font-size: 0.95rem; color: #a0c4ff; }
.a2a-panel .a2a-count { font-size: 0.75rem; color: #888; }
.a2a-entries {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  font-size: 0.8rem;
}
.a2a-entry {
  padding: 8px 10px;
  border-bottom: 1px solid #0f3460;
  display: grid;
  grid-template-columns: 70px 60px 1fr;
  gap: 8px;
  align-items: start;
}
.a2a-entry:hover { background: rgba(160,196,255,0.05); }
.a2a-time { color: #888; font-family: monospace; font-size: 0.75rem; }
.a2a-endpoint { font-weight: 500; }
.a2a-endpoint.prompt { color: #4caf50; }
.a2a-endpoint.reset { color: #ff9800; }
.a2a-endpoint.status { color: #888; }
.a2a-body { color: #ccc; }
.a2a-body .a2a-prompt { color: #a0c4ff; white-space: pre-wrap; word-break: break-word; }
.a2a-body .a2a-response { color: #888; margin-top: 2px; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
.a2a-body .a2a-meta { color: #555; font-size: 0.7rem; }
.a2a-empty { color: #555; text-align: center; padding: 40px; }

/* Log Panel */
.log-panel {
  width: 400px;
  flex-shrink: 0;
  background: #16213e;
  border-left: 1px solid #0f3460;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.log-panel-header {
  padding: 14px 16px 10px;
  border-bottom: 1px solid #0f3460;
  flex-shrink: 0;
}
.log-panel-header h2 {
  font-size: 1rem;
  color: #a0c4ff;
  margin-bottom: 8px;
}
.log-level-filters {
  display: flex;
  gap: 6px;
}
.log-level-btn {
  padding: 3px 10px;
  border: 1px solid #0f3460;
  border-radius: 4px;
  background: transparent;
  color: #9e9e9e;
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.2s;
}
.log-level-btn.active { background: #0f3460; color: #a0c4ff; border-color: #a0c4ff; }
.log-level-btn.lvl-error.active { background: rgba(244,67,54,0.2); color: #f44336; border-color: #f44336; }
.log-level-btn.lvl-warn.active { background: rgba(255,152,0,0.2); color: #ff9800; border-color: #ff9800; }
.log-entries {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.72rem;
  line-height: 1.5;
}
.log-line { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
.log-line.info { color: #9e9e9e; }
.log-line.warn { color: #ff9800; }
.log-line.error { color: #f44336; }
.log-line.debug { color: #666; }

/* Cron Card */
.cron-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 0.82rem;
}
.cron-entry .cron-info { flex: 1; min-width: 0; }
.cron-entry .cron-label { color: #e0e0e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cron-entry .cron-meta { font-size: 0.7rem; color: #7e7e9e; margin-top: 2px; }
.cron-entry .cron-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 8px; }
.cron-entry .cron-actions button {
  padding: 3px 8px;
  border: none;
  border-radius: 4px;
  font-size: 0.7rem;
  cursor: pointer;
  font-weight: 500;
}
.badge.paused { background: rgba(255,152,0,0.2); color: #ff9800; }
.badge.high { background: rgba(244,67,54,0.15); color: #ff6b6b; font-size: 0.65rem; }

/* Responsive */
@media (max-width: 768px) {
  .dashboard-layout { flex-direction: column; }
  .log-panel { width: 100%; height: 300px; border-left: none; border-top: 1px solid #0f3460; }
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
<div class="card card-split" id="card-health">
  <div class="split-top">
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
    <div id="hb-tasks" style="margin-top:6px;"></div>
    <div class="stat-row">
      <span class="stat-label">Last Update</span>
      <span class="stat-value" id="health-timestamp">—</span>
    </div>
  </div>
  <hr class="split-divider">
  <div class="split-bottom">
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
    <div style="margin-top:10px;">
      <span class="stat-label">Context Window</span>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="transport-ctx-bar" style="width:0%"></div>
      </div>
      <div style="text-align:right;font-size:0.75rem;color:#9e9e9e;margin-top:2px;">
        <span id="transport-ctx-pct">—</span>
      </div>
    </div>
  </div>
</div>`;
}

function getPlatformsCard(agentHtml: string): string {
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
    </div>${agentHtml}
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
    <div class="platform-item" id="plat-keep">
      <span class="name">Keep</span>
      <span><span class="badge disabled" id="plat-keep-badge">—</span></span>
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
      <span class="stat-label">Consolidations (D/W/Q)</span>
      <span class="stat-value" id="mem-consolidations">—</span>
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
  <button class="btn-search-toggle" onclick="toggleSearchPanel()">🔍 Search Memory</button>
</div>`;
}

function getCronCard(): string {
  return `
<div class="card" id="card-cron">
  <h2>Scheduled Tasks</h2>
  <div id="cron-entries">
    <div style="color:#666;font-size:0.82rem;">Loading...</div>
  </div>
</div>`;
}

function getLogPanel(): string {
  return `
<div class="log-panel">
  <div class="log-panel-header">
    <h2>📋 Log (24h)</h2>
    <div class="log-level-filters">
      <button class="log-level-btn lvl-info active" onclick="toggleLogLevel('info')">info</button>
      <button class="log-level-btn lvl-warn active" onclick="toggleLogLevel('warn')">warn</button>
      <button class="log-level-btn lvl-error active" onclick="toggleLogLevel('error')">error</button>
      <button class="log-level-btn lvl-debug" onclick="toggleLogLevel('debug')">debug</button>
    </div>
  </div>
  <div class="log-entries" id="log-entries"></div>
</div>`;
}

function getSearchPanel(): string {
  return `
<div id="search-panel" class="search-panel" style="display:none;">
  <div class="search-panel-header">
    <div class="search-panel-row">
      <div class="search-box" style="margin:0;">
        <input type="text" id="mem-chatid-input" placeholder="0 = all chats" style="width:100px;text-align:center;flex:none;">
        <button onclick="listChatIds()">LIST</button>
      </div>
      <div class="layer-toggles" id="layer-toggles" style="margin:0;">
        <button class="layer-btn active" data-layer="L1" onclick="toggleLayer(this)">L1:messages</button>
        <button class="layer-btn active" data-layer="L2" onclick="toggleLayer(this)">L2:extracted</button>
        <button class="layer-btn active" data-layer="L3" onclick="toggleLayer(this)">L3:consolidations</button>
        <button class="layer-btn active" data-layer="L4" onclick="toggleLayer(this)">L4:original</button>
        <button class="layer-btn" data-layer="NLM" onclick="toggleLayer(this)">NLM</button>
      </div>
    </div>
    <div class="search-panel-row" style="margin-top:8px;">
      <button class="layer-btn active" id="mode-toggle" onclick="toggleSearchMode()" style="min-width:42px;">OR</button>
      <input type="text" id="mem-keyword-input" class="keyword-input" placeholder="Type keyword + Enter to add filter...">
      <button class="btn-search" onclick="searchMemory()">Search</button>
    </div>
    <div id="keyword-filters" class="keyword-filters"></div>
  </div>
  <div class="search-results" id="mem-search-results"></div>
</div>`;
}

function getA2APanel(): string {
  return `
<div id="a2a-panel" class="a2a-panel" style="display:none;">
  <div class="a2a-header">
    <h3>🔗 A2A Traffic — Kiro Professor ↔ Agents</h3>
    <span class="a2a-count" id="a2a-count"></span>
  </div>
  <div class="a2a-entries" id="a2a-entries">
    <div class="a2a-empty">No traffic yet. Waiting for agent requests...</div>
  </div>
</div>`;
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

    // Platforms (from services)
    if (snap.services) {
      updateServiceRow('telegram', snap.services.telegram);
      updateServiceRow('discord', snap.services.discord);
      updateServiceRow('agent-api', snap.services['agent-api']);
    }

    // Enabled platforms count
    var enabledList = [];
    if (snap.services) {
      if (snap.services.telegram && snap.services.telegram.running) enabledList.push('Telegram');
      if (snap.services.discord && snap.services.discord.running) enabledList.push('Discord');
    }
    el = document.getElementById('health-platforms');
    if (el) el.textContent = enabledList.length > 0 ? enabledList.join(', ') : 'None';

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
        setText('mem-consolidations', s.consolidationFiles.daily + ' / ' + s.consolidationFiles.weekly + ' / ' + s.consolidationFiles.quarterly);
        setText('mem-documents', s.ingestedDocuments);
        setText('mem-dbsize', formatBytes(s.dbSizeBytes));
      } else {
        setText('mem-messages', '—');
        setText('mem-extracted', '—');
        setText('mem-consolidations', '—');
        setText('mem-documents', '—');
        setText('mem-dbsize', '—');
      }
    }

    // NotebookLM
    var nlmBadge = document.getElementById('plat-nlm-badge');
    if (nlmBadge) {
      if (snap.notebooklm && snap.notebooklm.enabled) {
        nlmBadge.textContent = 'active';
        nlmBadge.className = 'badge running';
      } else {
        nlmBadge.textContent = 'no auth';
        nlmBadge.className = 'badge disabled';
      }
    }

    // Keep (gws auth)
    var keepBadge = document.getElementById('plat-keep-badge');
    if (keepBadge) {
      if (snap.gwsAuth) {
        keepBadge.textContent = 'authenticated';
        keepBadge.className = 'badge running';
      } else {
        keepBadge.textContent = 'no auth';
        keepBadge.className = 'badge disabled';
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

      // Heartbeat task list
      var hbTasks = document.getElementById('hb-tasks');
      if (hbTasks && snap.heartbeat.taskNames) {
        if (snap.heartbeat.taskNames.length === 0) {
          hbTasks.innerHTML = '<div style="color:#666;font-size:0.82rem;">No tasks registered</div>';
        } else {
          hbTasks.innerHTML = snap.heartbeat.taskNames.map(function(name) {
            return '<div class="stat-row"><span class="stat-label">' + escHtml(name) + '</span><span class="stat-value"><span class="indicator ' + (snap.heartbeat.running ? 'green' : 'yellow') + '"></span></span></div>';
          }).join('');
        }
      }
    }

    // Cron entries
    if (snap.cron) {
      updateCronPanel(snap.cron);
    }

    // A2A Traffic
    updateA2ATraffic(snap.agentApi);
  }

  function updateServiceRow(name, state) {
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
  window.togglePlatform = function(service, action) {
    fetch('/api/services/' + service + '/' + action, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) alert('Error: ' + data.error);
    }).catch(function(err) { alert('Request failed: ' + err.message); });
  };

  // ── Search Panel Toggle ─────────────────────────────────────────────
  window.toggleSearchPanel = function() {
    var panel = document.getElementById('search-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    // Hide A2A when search opens
    var a2a = document.getElementById('a2a-panel');
    if (a2a && panel && panel.style.display === 'flex') a2a.style.display = 'none';
  };

  // ── A2A Traffic Panel ──────────────────────────────────────────────
  var lastTrafficCount = 0;

  window.toggleA2APanel = function() {
    var panel = document.getElementById('a2a-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    // Hide search when A2A opens
    var search = document.getElementById('search-panel');
    if (search && panel && panel.style.display === 'flex') search.style.display = 'none';
  };

  function updateA2ATraffic(agentApi) {
    if (!agentApi || !agentApi.traffic) return;
    var entries = agentApi.traffic;
    if (entries.length === lastTrafficCount) return;
    lastTrafficCount = entries.length;

    var countEl = document.getElementById('a2a-count');
    if (countEl) countEl.textContent = entries.length + ' entries';

    var container = document.getElementById('a2a-entries');
    if (!container) return;

    if (entries.length === 0) {
      container.innerHTML = '<div class="a2a-empty">No traffic yet. Waiting for agent requests...</div>';
      return;
    }

    // Show newest first
    var html = '';
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      var time = new Date(e.ts).toLocaleTimeString();
      var epClass = e.endpoint === 'prompt' ? 'prompt' : e.endpoint === 'reset' ? 'reset' : 'status';
      var body = '';
      if (e.endpoint === 'prompt') {
        body = '<div class="a2a-prompt">→ ' + escHtml(e.prompt) + '</div>';
        if (e.response) body += '<div class="a2a-response">← ' + escHtml(e.response) + '</div>';
      } else {
        body = '<div class="a2a-response">' + escHtml(e.response || e.endpoint) + '</div>';
      }
      body += '<div class="a2a-meta">' + (e.ip || '—') + ' · ' + e.durationMs + 'ms · ' + e.status + '</div>';
      html += '<div class="a2a-entry"><span class="a2a-time">' + time + '</span><span class="a2a-endpoint ' + epClass + '">' + e.endpoint + '</span><div class="a2a-body">' + body + '</div></div>';
    }
    container.innerHTML = html;
  }

  // ── Keyword Filters ────────────────────────────────────────────────
  var keywordFilters = [];
  var searchMode = 'or';

  window.toggleSearchMode = function() {
    searchMode = searchMode === 'or' ? 'and' : 'or';
    var btn = document.getElementById('mode-toggle');
    if (btn) {
      btn.textContent = searchMode.toUpperCase();
      btn.classList.toggle('active', searchMode === 'or');
    }
    searchMemory();
  };

  function renderFilters() {
    var container = document.getElementById('keyword-filters');
    if (!container) return;
    container.innerHTML = keywordFilters.map(function(kw, i) {
      return '<span class="keyword-chip" onclick="removeFilter(' + i + ')">' + escHtml(kw) + ' ✕</span>';
    }).join('');
  }

  window.removeFilter = function(index) {
    keywordFilters.splice(index, 1);
    renderFilters();
    searchMemory();
  };

  var kwInput = document.getElementById('mem-keyword-input');
  if (kwInput) {
    kwInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var val = kwInput.value.trim();
        if (val && keywordFilters.indexOf(val) === -1) {
          keywordFilters.push(val);
          renderFilters();
          searchMemory();
        }
        kwInput.value = '';
      }
    });
  }

  // ── Memory Search API ──────────────────────────────────────────────
  window.searchMemory = function() {
    var container = document.getElementById('mem-search-results');
    if (keywordFilters.length === 0) {
      if (container) container.innerHTML = '';
      return;
    }

    var chatIdInput = document.getElementById('mem-chatid-input');
    var chatIdVal = chatIdInput ? chatIdInput.value.trim() : '0';
    var chatId = parseInt(chatIdVal, 10) || 0;

    var layers = getSelectedLayers();
    if (layers.length === 0) {
      if (container) container.innerHTML = '<div style="color:#666;padding:6px 0;">No layers selected</div>';
      return;
    }
    var keywords = keywordFilters.join(',');
    var url = '/api/memory/search?keywords=' + encodeURIComponent(keywords) + '&original=' + encodeURIComponent(keywords) + '&layers=' + encodeURIComponent(layers.join(',')) + '&mode=' + searchMode;
    if (chatId > 0) {
      url += '&chatId=' + chatId;
    }

    fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
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
          '<div class="result-meta"><span class="score">' + (r.score != null ? r.score.toFixed(2) : '—') + '</span> <span class="source">' + escHtml(r.source) + '</span> <span class="source">' + escHtml(r.date) + '</span></div>' +
          '<div class="result-content">' + escHtml(r.content.substring(0, 200)) + '</div>' +
          '</div>';
      }).join('');
    }).catch(function(err) {
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
    searchMemory();
  };

  function getSelectedLayers() {
    var btns = document.querySelectorAll('#layer-toggles .layer-btn');
    var selected = [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('active') && !btns[i].disabled) {
        var layer = btns[i].getAttribute('data-layer');
        if (layer !== 'NLM') selected.push(layer);
      }
    }
    return selected;
  }

  // ── Cron Panel ──────────────────────────────────────────────────────
  function updateCronPanel(entries) {
    var container = document.getElementById('cron-entries');
    if (!container) return;
    if (!entries || entries.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:0.82rem;">No scheduled tasks</div>';
      return;
    }
    container.innerHTML = entries.map(function(e) {
      var statusBadge = e.paused
        ? '<span class="badge paused">paused</span>'
        : '<span class="badge running">active</span>';
      var priorityBadge = e.priority === 'high' ? ' <span class="badge high">HIGH</span>' : '';
      var nextFire = e.paused ? '—' : new Date(e.fireAt).toLocaleString();
      var lastRan = e.lastRanAt ? new Date(e.lastRanAt).toLocaleString() : 'never';
      var pauseBtn = e.paused
        ? '<button class="btn-start" onclick="cronAction(\\'' + e.id + '\\',\\'resume\\')">Resume</button>'
        : '<button class="btn-stop" onclick="cronAction(\\'' + e.id + '\\',\\'pause\\')">Pause</button>';
      return '<div class="cron-entry">' +
        '<div class="cron-info">' +
          '<div class="cron-label">' + statusBadge + priorityBadge + ' ' + escHtml(e.label) + '</div>' +
          '<div class="cron-meta">' + escHtml(e.schedule) + ' · ' + e.executor + ' · next: ' + nextFire + ' · last: ' + lastRan + '</div>' +
        '</div>' +
        '<div class="cron-actions">' +
          pauseBtn +
          '<button class="btn-start" style="background:#0f3460;color:#a0c4ff;" onclick="cronAction(\\'' + e.id + '\\',\\'trigger\\')">▶ Run</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  window.cronAction = function(id, action) {
    fetch('/api/cron/' + id + '/' + action, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) alert('Error: ' + data.error);
    }).catch(function(err) { alert('Request failed: ' + err.message); });
  };

  // ── Log Panel ──────────────────────────────────────────────────────
  var logLevels = { info: true, warn: true, error: true, debug: false };
  var logRefreshTimer = null;

  window.toggleLogLevel = function(level) {
    logLevels[level] = !logLevels[level];
    var btns = document.querySelectorAll('.log-level-btn.lvl-' + level);
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', logLevels[level]);
    }
    fetchLogs();
  };

  function fetchLogs() {
    var activeLevels = Object.keys(logLevels).filter(function(k) { return logLevels[k]; });
    if (activeLevels.length === 0) {
      var c = document.getElementById('log-entries');
      if (c) c.innerHTML = '<div style="color:#666;padding:12px;">No levels selected</div>';
      return;
    }
    fetch('/api/logs?level=' + activeLevels.join(',') + '&limit=500', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(data) {
      var container = document.getElementById('log-entries');
      if (!container || !data.lines) return;
      var wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
      container.innerHTML = data.lines.map(function(line) {
        var lvl = 'info';
        if (line.indexOf(' WARN ') !== -1) lvl = 'warn';
        else if (line.indexOf(' ERROR') !== -1) lvl = 'error';
        else if (line.indexOf(' DEBUG') !== -1) lvl = 'debug';
        var display = line.slice(0, 19).replace('T', ' ') + line.slice(24);
        return '<div class="log-line ' + lvl + '">' + escHtml(display) + '</div>';
      }).join('');
      if (wasAtBottom) container.scrollTop = container.scrollHeight;
    }).catch(function() { /* silent */ });
  }

  // Fetch logs on load and every 10s
  fetchLogs();
  logRefreshTimer = setInterval(fetchLogs, 10000);

  // ── Start Connection ───────────────────────────────────────────────
  connect();
})();
`;
}
