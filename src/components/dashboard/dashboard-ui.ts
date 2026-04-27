/**
 * Dashboard UI — HTML/CSS/JS for the Kiro Professor Web UI.
 *
 * CSS and JS are loaded from ./public/ (static files, colocated with this module).
 * HTML fragments are inline (they have dynamic parts).
 *
 * Exports:
 *  - renderDashboardHtml(logoBase64): complete HTML string
 *  - getReconnectDelay(attempt): pure backoff calculation (testable)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");

let _css: string | null = null;
let _js: string | null = null;

function loadCss(): string {
  if (!_css) _css = readFileSync(join(publicDir, "dashboard.css"), "utf-8");
  return _css;
}

function loadJs(): string {
  if (!_js) _js = readFileSync(join(publicDir, "dashboard.js"), "utf-8");
  return _js;
}

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

// ── Main Render Function ────────────────────────────────────────────────────

export function renderDashboardHtml(logoBase64: string, opts?: { agentApi?: { port: number; allowedIps: string[] } }): string {
  const agentHtml = opts?.agentApi
    ? `<div class="platform-item" id="plat-agent-api">
      <span class="name">Agent A2A</span>
      <span>
        <span class="badge disabled clickable" id="plat-agent-api-badge" data-port="${opts.agentApi.port}" onclick="toggleA2APanel()">—</span>
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
${loadCss()}
</style>
</head>
<body>
${getHeaderHtml(logoBase64)}
<div id="connection-banner" class="connection-banner" style="display:none;">
  Connection lost. Reconnecting<span id="reconnect-dots">...</span>
</div>
<main class="grid">
  ${getBridgeHealthCard()}
  ${getPlatformsCard(agentHtml)}
  ${getMemoryCard()}
  ${getCronCard()}
  ${getAuthCard()}
</main>
${getSearchOverlay()}
${getLogOverlay()}
${getA2APanel()}
<script>
${loadJs()}
</script>
</body>
</html>`;
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
      <span class="stat-value" id="hb-status">—</span>
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
      <span class="name">Gmail (gws)</span>
      <span><span class="badge disabled" id="auth-gws">—</span></span>
    </div>
    <div class="platform-item" id="plat-nlm">
      <span class="name">LM Notebook</span>
      <span><span class="badge disabled" id="auth-nlm">—</span></span>
    </div>
    <div class="platform-item" id="plat-keep">
      <span class="name">Keep</span>
      <span><span class="badge disabled" id="plat-keep-badge">—</span></span>
    </div>
    <div class="platform-item">
      <span class="name">Projects</span>
      <span><span class="badge coming" title="coming soon">coming soon</span></span>
    </div>
  </div>

  <div class="platform-group">
    <h3>Social Media</h3>
    <div class="platform-item">
      <span class="name">X.com</span>
      <span><span class="badge disabled" id="auth-x">—</span></span>
    </div>
    <div class="platform-item">
      <span class="name">Facebook</span>
      <span><span class="badge coming" title="coming soon">coming soon</span></span>
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
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn-search-toggle" onclick="loadMemoryUniverse()">🌌 Universe</button>
    <button class="btn-search-toggle" onclick="toggleOverlay('search-overlay')">🔍 Search</button>
  </div>
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

function getAuthCard(): string {
  return `
<div class="card" id="card-log">
  <h2>📋 Log</h2>
  <div style="display:flex;gap:6px;margin-bottom:8px;">
    <button class="log-level-btn lvl-info active" onclick="toggleLogLevel('info')">info</button>
    <button class="log-level-btn lvl-warn active" onclick="toggleLogLevel('warn')">warn</button>
    <button class="log-level-btn lvl-error active" onclick="toggleLogLevel('error')">error</button>
    <button class="log-level-btn lvl-debug" onclick="toggleLogLevel('debug')">debug</button>
  </div>
  <div id="log-entries" style="max-height:500px;overflow-y:auto;font-size:0.78rem;font-family:monospace;line-height:1.5;"></div>
</div>`;
}

function getLogOverlay(): string {
  return "";
}

function getSearchOverlay(): string {
  return `
<div id="search-overlay" class="overlay-panel" style="display:none;">
  <div class="overlay-header">
    <h2>🔍 Memory Search</h2>
    <button class="btn-close-overlay" onclick="toggleOverlay('search-overlay')">✕</button>
  </div>
  <div class="overlay-body">
    <div class="search-panel-row">
      <div class="search-box" style="margin:0;">
        <input type="text" id="mem-userid-input" placeholder="all users" style="width:100px;text-align:center;flex:none;">
        <button onclick="listChatIds()">LIST</button>
      </div>
      <div class="layer-toggles" id="layer-toggles" style="margin:0;">
        <button class="layer-btn active" data-layer="S1" onclick="toggleLayer(this)">S1:en-fts</button>
        <button class="layer-btn active" data-layer="S2" onclick="toggleLayer(this)">S2:orig-fts</button>
        <button class="layer-btn active" data-layer="S3" onclick="toggleLayer(this)">S3:like</button>
        <button class="layer-btn active" data-layer="S4" onclick="toggleLayer(this)">S4:msg-fts</button>
        <button class="layer-btn active" data-layer="S5" onclick="toggleLayer(this)">S5:msg-like</button>
        <button class="layer-btn active" data-layer="S6" onclick="toggleLayer(this)">S6:consol</button>
        <button class="layer-btn active" data-layer="S7" onclick="toggleLayer(this)">S7:fallback</button>
        <button class="layer-btn active" data-layer="Se" onclick="toggleLayer(this)">Se:embed</button>
        <button class="layer-btn" data-layer="NLM" onclick="toggleLayer(this)">NLM</button>
      </div>
    </div>
    <div class="search-panel-row" style="margin-top:8px;">
      <button class="layer-btn active" id="mode-toggle" onclick="toggleSearchMode()" style="min-width:42px;">OR</button>
      <input type="text" id="mem-keyword-input" class="keyword-input" placeholder="Type keyword + Enter to add filter...">
      <input type="text" id="mem-entity-input" placeholder="Entity filter" style="width:120px;flex:none;">
      <button class="btn-search" onclick="searchMemory()">Search</button>
    </div>
    <div id="keyword-filters" class="keyword-filters"></div>
    <div class="search-results" id="mem-search-results"></div>
  </div>
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
