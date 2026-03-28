function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  var k = 1024;
  var sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i >= sizes.length) i = sizes.length - 1;
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

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
          var secs = snap.heartbeat.intervalMs ? (snap.heartbeat.intervalMs / 1000) + 's' : '';
          el.innerHTML = '<span class="indicator green"></span> ' + secs;
        } else {
          el.innerHTML = '<span class="indicator red"></span> FAILED';
        }
      }

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
      badge.textContent = name === 'agent-api' ? '\u26A0\uFE0F ' + (badge.dataset.port || '?') : 'running';
      badge.className = name === 'agent-api' ? 'badge running clickable' : 'badge running';
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

    var stages = getSelectedStages();
    if (stages.length === 0) {
      if (container) container.innerHTML = '<div style="color:#666;padding:6px 0;">No stages selected</div>';
      return;
    }
    var keywords = keywordFilters.join(',');
    var entity = (document.getElementById('mem-entity-input') || {}).value || '';
    var url = '/api/memory/search?keywords=' + encodeURIComponent(keywords) + '&original=' + encodeURIComponent(keywords) + '&stages=' + encodeURIComponent(stages.join(',')) + '&mode=' + searchMode;
    if (entity) url += '&entity=' + encodeURIComponent(entity);
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

      var stageInfo = '';
      if (data.layers) {
        stageInfo = '<div style="color:#888;font-size:11px;margin-bottom:6px;">' +
          Object.keys(data.layers).map(function(k) {
            var s = data.layers[k];
            return k + ':' + (s.hits || 0) + ' (' + (s.ms || 0) + 'ms)';
          }).join(' | ') + '</div>';
      }

      container.innerHTML = stageInfo + data.results.map(function(r) {
        var meta = '<span class="score">' + (r.score != null ? r.score.toFixed(2) : '—') + '</span> ' +
          '<span class="source">' + escHtml(r.source) + '</span> ' +
          '<span class="source">' + escHtml(r.date) + '</span>';
        if (r.memoryType) meta += ' <span class="source">' + r.memoryType + '</span>';
        if (r.classification != null && r.classification > 0) {
          var cls = ['U','R','C','S'][r.classification] || '?';
          meta += ' <span class="source" style="color:' + (r.classification >= 2 ? '#f44336' : '#aaa') + ';">' + cls + '</span>';
        }
        if (r.trust != null) meta += ' T:' + r.trust;
        if (r.credibility != null) meta += ' C:' + r.credibility;
        if (r.integrity != null) meta += ' I:' + r.integrity;
        var content = escHtml(r.content.substring(0, 300));
        if (r.contentOriginal && r.contentOriginal !== r.content) {
          content += '<div style="color:#888;font-size:11px;margin-top:2px;">' + escHtml(r.contentOriginal.substring(0, 200)) + '</div>';
        }
        return '<div class="search-result-item">' +
          '<div class="result-meta">' + meta + '</div>' +
          '<div class="result-content">' + content + '</div>' +
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

  // ── Stage Toggles ──────────────────────────────────────────────────
  window.toggleLayer = function(btn) {
    if (btn.disabled) return;
    btn.classList.toggle('active');
    searchMemory();
  };

  function getSelectedStages() {
    var btns = document.querySelectorAll('#layer-toggles .layer-btn');
    var selected = [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('active') && !btns[i].disabled) {
        selected.push(btns[i].getAttribute('data-layer'));
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
      var priorityBadge = e.priority === 'high' ? ' <span class="badge high">HIGH</span>' : e.priority === 'low' ? ' <span class="badge low">LOW</span>' : '';
      var nextFire = e.paused ? '—' : new Date(e.fireAt).toLocaleString();
      var lastRan = e.lastRanAt ? new Date(e.lastRanAt).toLocaleString() : 'never';
      var pauseBtn = e.paused
        ? '<button class="btn-start" onclick="cronAction(\'' + e.id + '\',\'resume\')">Resume</button>'
        : '<button class="btn-stop" onclick="cronAction(\'' + e.id + '\',\'pause\')">Pause</button>';
      return '<div class="cron-entry">' +
        '<div class="cron-info">' +
          '<div class="cron-label">' + statusBadge + priorityBadge + ' ' + escHtml(e.label) + '</div>' +
          '<div class="cron-meta">' + escHtml(e.schedule) + ' · ' + e.executor + ' · next: ' + nextFire + ' · last: ' + lastRan + '</div>' +
        '</div>' +
        '<div class="cron-actions">' +
          pauseBtn +
          '<button class="btn-start" style="background:#0f3460;color:#a0c4ff;" onclick="cronAction(\'' + e.id + '\',\'trigger\')">▶ Run</button>' +
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

  // ── Memory Universe Loader ──────────────────────────────────────────
  window.loadMemoryUniverse = function() {
    if (document.getElementById('memory-universe-overlay')) return;
    var s = document.createElement('script');
    s.src = '/memory-universe.js';
    s.onload = function() { if (window.initMemoryUniverse) window.initMemoryUniverse(token); };
    document.head.appendChild(s);
  };
})();
