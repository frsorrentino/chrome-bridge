const $ = (id) => document.getElementById(id);

const stateLabels = {
  connected: 'Connesso',
  connecting: 'Connessione…',
  disconnected: 'Disconnesso',
};

function renderState(state) {
  $('indicator').className = `dot ${state}`;
  $('status-text').textContent = stateLabels[state] || state;
}

function agoLabel(ts) {
  if (!ts) return 'ultimo';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `ultimo · ${s}s fa`;
  if (s < 3600) return `ultimo · ${Math.round(s / 60)}m fa`;
  return `ultimo · ${Math.round(s / 3600)}h fa`;
}

let lastData = null;

function renderPopupData(d) {
  lastData = d;
  renderState(d.state);
  $('ws-url').textContent = `ws://localhost:${d.port}`;
  $('versions').textContent = d.serverVersion
    ? `ext ${d.extensionVersion} · srv ${d.serverVersion}`
    : `v${d.extensionVersion}`;

  const st = d.stats || { toolCallCount: 0, lastTool: null, lastToolTs: null, recentErrors: [] };
  $('st-calls').textContent = st.toolCallCount;
  $('st-last').textContent = st.lastTool || '—';
  $('st-last-ago').textContent = agoLabel(st.lastToolTs);
  $('st-errors').textContent = st.recentErrors.length;
  $('st-errors').classList.toggle('bad', st.recentErrors.length > 0);

  const errList = $('err-list');
  if (st.recentErrors.length) {
    errList.hidden = false;
    $('err-items').replaceChildren(...st.recentErrors.slice().reverse().map((e) => {
      const li = document.createElement('li');
      const tool = document.createElement('b');
      tool.textContent = e.tool;
      li.append(tool, ` ${new Date(e.ts).toLocaleTimeString()} — ${e.message}`);
      return li;
    }));
  } else {
    errList.hidden = true;
  }
}

function renderPageInfo(info) {
  const body = $('page-body');
  const unavailable = $('page-unavailable');
  if (!info || !info.available) {
    body.hidden = true;
    unavailable.hidden = false;
    return;
  }
  body.hidden = false;
  unavailable.hidden = true;

  const hasInstrument = info.consoleErrors !== null;
  $('pg-hint').hidden = hasInstrument;
  if (hasInstrument) {
    $('pg-errors').textContent = info.consoleErrors;
    $('pg-errors').classList.toggle('bad', info.consoleErrors > 0);
    $('pg-vitals').textContent = info.vitals
      ? `${info.vitals.lcp != null ? (info.vitals.lcp / 1000).toFixed(1) + 's' : '—'} · ${info.vitals.cls}`
      : '—';
  } else {
    $('pg-errors').textContent = '—';
    $('pg-vitals').textContent = '—';
  }
  $('pg-stack').textContent = info.stack?.length ? info.stack.join(' · ') : '—';
}

// --- Caricamento iniziale ---
chrome.runtime.sendMessage({ type: 'getPopupData' }, (d) => { if (d) renderPopupData(d); });
chrome.runtime.sendMessage({ type: 'getPageInfo' }, (info) => renderPageInfo(info));

// Stato live mentre il popup è aperto
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connectionState') renderState(msg.state);
});

// --- Warning userScripts ---
let userScriptsEnabled = true;
try {
  chrome.userScripts.getScripts;
} catch {
  userScriptsEnabled = false;
  $('us-warning').hidden = false;
}
$('us-fix').addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// --- Azioni ---
$('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {});
});

$('diagnostics').addEventListener('click', async () => {
  const d = lastData || {};
  const report = globalThis.__cbTelemetry.buildDiagnostics({
    extensionVersion: d.extensionVersion || chrome.runtime.getManifest().version,
    serverVersion: d.serverVersion || null,
    chromeVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || 'unknown',
    state: d.state || 'unknown',
    port: d.port || null,
    userScriptsEnabled,
    instrument: d.instrument ?? null,
    toolCallCount: d.stats?.toolCallCount ?? 0,
    lastTool: d.stats?.lastTool ?? null,
    recentErrors: d.stats?.recentErrors ?? [],
  });
  await navigator.clipboard.writeText(report);
  $('diagnostics').textContent = '✓ Copiato';
  setTimeout(() => { $('diagnostics').textContent = '⧉ Diagnostica'; }, 1500);
});

// --- Config (collassata dietro ⚙) ---
$('toggle-config').addEventListener('click', () => {
  $('config').hidden = !$('config').hidden;
});

chrome.storage.local.get({ port: 8765, token: '', instrument: true }, (cfg) => {
  $('port').value = cfg.port;
  $('token').value = cfg.token;
  $('instrument').checked = cfg.instrument;
});

$('save').addEventListener('click', () => {
  const p = parseInt($('port').value, 10);
  const port = (p >= 1 && p <= 65535) ? p : 8765;
  chrome.storage.local.set({ port, token: $('token').value.trim(), instrument: $('instrument').checked });
  $('ws-url').textContent = `ws://localhost:${port}`;
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {});
});
