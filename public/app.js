'use strict';
/* ═══════════════════════════════════════════════════════════════
   PANELS — app.js
   • No resource polling
   • Home tab: server cards with status, ping, players, address, description
   • Files tab: working SFTP (ssh2-sftp-client via /api/sftp/)
   • ALL addEventListener calls inside DOMContentLoaded → bindUI()
   ═══════════════════════════════════════════════════════════════ */

const API = 'http://127.0.0.1:3847/api';

/* ── state ───────────────────────────────────────────────────── */
let token          = '';
let servers        = [];          // [{id, name}]
let activeId       = null;
let activeTab      = 'home';
let logTimer       = null;
let renameCallback = null;
let editorFile     = null;
let editorDirty    = false;
let lastLogLen     = 0;
let lastServerData = null;
let cmdHistory     = [];   // QOL: console command history
let cmdHistoryIdx  = -1;   // QOL: current history position


/* ═══════════════════════════════════════════════════════════════
   VERSION & CHANGELOG
   v1(<major>).1(<feature>).1(<bugfix>)
   ═══════════════════════════════════════════════════════════════ */
const APP_VERSION = '1.1.1';
const APP_AUTHOR  = '@_._yua_._';

const CHANGELOG = [
  {
    version: '1.1.1',
    date:    '2025-04',
    type:    'bugfix',
    changes: [
      'Fixed all interaction hoisting bugs (showCtxMenu, loadAllServerCards)',
      'Fixed showHomeView undefined crash on init',
      'Fixed showTab/loadServerData/fetchHomeCard infinite recursion',
      'Removed orphaned audit modal from DOM',
      'Memory leaks: AbortController drag listeners, WS handler cleanup, console line cap',
    ],
  },
  {
    version: '1.1.0',
    date:    '2025-04',
    type:    'feature',
    changes: [
      'Player Management Center with op/deop/kick/ban/feed/heal/starve',
      'Player skin sidebar with mc-heads.net body render',
      'Custom emoji picker per action button (right-click / long-press)',
      'Emoji overrides persisted to settings',
      'Neko light theme (vivid hot-pink pastel)',
      'Display & Performance modal with sliders',
      'High-performance / High-fidelity modes',
    ],
  },
  {
    version: '1.0.0',
    date:    '2025-03',
    type:    'major',
    changes: [
      'Initial release — Beacon server panel',
      'SFTP file manager, console, overview, settings',
      'Sakura / Glossy / Moonsedge themes',
      'Particle system per theme',
      'ANSI + Minecraft § colour codes in console',
      'Editor colour popup for #RRGGBB and §x codes',
    ],
  },
];

function showChangelog() {
  const existing = document.getElementById('modalChangelog');
  if (existing) { existing.classList.remove('hidden'); return; }

  const modal = document.createElement('div');
  modal.id = 'modalChangelog';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" id="changelogBackdrop"></div>
    <div class="modal-panel frost" style="max-width:560px;max-height:80vh;overflow-y:auto">
      <div class="modal-head">
        <div>
          <h2 style="display:flex;align-items:center;gap:10px">
            Changelog
            <span class="status-pill ok" style="font-size:11px;padding:3px 10px">v${APP_VERSION}</span>
          </h2>
          <div class="muted small">Panels — by ${APP_AUTHOR}</div>
        </div>
        <button class="icon-btn" id="btnCloseChangelog">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:18px">
        ${CHANGELOG.map(entry => `
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span style="font-family:'Syne',sans-serif;font-weight:700;font-size:1rem">v${esc(entry.version)}</span>
              <span class="status-pill ${entry.type==='major'?'warn':entry.type==='feature'?'ok':'err'}"
                    style="font-size:10px;padding:2px 8px">${esc(entry.type)}</span>
              <span class="muted small" style="font-size:11px">${esc(entry.date)}</span>
            </div>
            <div class="kv-stack">
              ${entry.changes.map(c => `
                <div class="kv-item" style="padding:6px 12px;min-height:0">
                  <span style="color:var(--accent);margin-right:6px;flex-shrink:0">·</span>
                  <span style="font-size:12.5px">${esc(c)}</span>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#btnCloseChangelog').addEventListener('click', () => modal.classList.add('hidden'));
  modal.querySelector('#changelogBackdrop').addEventListener('click', () => modal.classList.add('hidden'));
}

/* ── debounce helper ─────────────────────────────────────────── */
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}


// Per-server SFTP state — keyed by server ID, never wiped on tab/server switch
// { host, port, user, pass, connected, path, autoConnect }
let sftpState = {}; // keyed by server UUID; persisted in data/servers.json via electronAPI

function loadSftpStateFromServers() {
  const out = {};
  for (const s of servers || []) {
    if (s && s.id && s.sftp) out[s.id] = { ...s.sftp };
  }
  return out;
}

async function persistSftpStateToServers() {
  servers = (servers || []).map(s => {
    if (!s?.id) return s;
    const next = { ...s };
    if (sftpState[s.id]) next.sftp = { ...sftpState[s.id] };
    else if (next.sftp) delete next.sftp;
    return next;
  });
  await saveServers();
}


function getSftp(id) {
  if (!sftpState[id] || typeof sftpState[id] !== 'object') sftpState[id] = {};
  const s = sftpState[id];

  if (!s.host) s.host = '';
  if (!s.port) s.port = '2022';

  // migrate older defaults
  if (String(s.port) === '22' || String(s.port) === '2202') s.port = '2022';

  if (typeof s.user !== 'string') s.user = ''; // stored as email:uuid
  if (typeof s.pass !== 'string') s.pass = '';
  if (typeof s.connected !== 'boolean') s.connected = false;
  if (typeof s.path !== 'string') s.path = '/';
  if (typeof s.autoConnect !== 'boolean') s.autoConnect = false;

  return s;
}

/* ── tiny helpers ────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

function toast(msg, type = 'info', dur = 3400) {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, dur);
}

function copyToClipboard(text, label = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast(`${label} ✓`, 'success', 1800))
    .catch(() => toast('Copy failed', 'error'));
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'x-beacon-token': token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024)       return n + ' B';
  if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/* Memoised escape for repeated strings */
const _escCache = new Map();
function esc(s) {
  const k = String(s ?? '');
  if (_escCache.has(k)) return _escCache.get(k);
  const v = k.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  if (_escCache.size > 1500) { const keys = _escCache.keys(); for (let i=0;i<500;i++) _escCache.delete(keys.next().value); }
  _escCache.set(k, v);
  return v;
}

function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = name.split('.').pop().toLowerCase();
  return ({
    js:'🟨',ts:'🔷',json:'🧩',html:'🌐',css:'🎨',md:'📝',txt:'📄',
    png:'🖼',jpg:'🖼',gif:'🖼',svg:'🖼',mp3:'🎵',mp4:'🎬',
    zip:'📦',tar:'📦',gz:'📦',sh:'⚙️',py:'🐍',
    yml:'⚙️',yaml:'⚙️',env:'🔒',conf:'⚙️',log:'📋',
    lua:'🌙',jar:'☕',properties:'⚙️',dat:'💾',nbt:'💾',
  })[ext] || '📄';
}

function detectLang(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({
    js:'JavaScript',ts:'TypeScript',json:'JSON',html:'HTML',css:'CSS',
    py:'Python',sh:'Shell',md:'Markdown',yml:'YAML',yaml:'YAML',
    xml:'XML',lua:'Lua',conf:'Config',env:'Config',toml:'TOML',
    ini:'INI',java:'Java',cpp:'C++',c:'C',go:'Go',rb:'Ruby',rs:'Rust',
    properties:'Properties',
  })[ext] || 'Plain Text';
}

function statusCls(s) {
  const l = (s || '').toLowerCase();
  if (l === 'online' || l.includes('run')) return 'ok';
  if (l === 'offline' || l === 'stopped') return 'err';
  return 'warn';
}

function setDot(id, status) {
  ['dot-', 'gdot-'].forEach(pfx => {
    const d = document.getElementById(pfx + id); if (!d) return;
    d.className = 'srv-dot';
    const l = (status || '').toLowerCase();
    if (l === 'online' || l.includes('run'))       d.classList.add('online');
    else if (l === 'offline' || l === 'stopped')   d.classList.add('offline');
    else                                           d.classList.add('starting');
  });
}

function joinPath(base, name) {
  return (base.replace(/\/$/, '') + '/' + name).replace('//', '/');
}

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
async function loadLocal() {
  const cfg = await window.electronAPI?.getSettings() ?? { token: '', theme: 'sakura' };
  token   = cfg.token || '';
  servers = (await window.electronAPI?.getServers()) ?? [];
  sftpState = loadSftpStateFromServers();
  applyTheme(cfg.theme || 'sakura');
  renderTokenPanel();
}


/* ── Collapsible sidebar sections ─────────────────────────── */
function bindCollapsible() {
  document.querySelectorAll('.section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.section;
      const body = document.getElementById(targetId);
      if (!body) return;
      const chevronId = 'chevron' + targetId.replace('Body','').charAt(0).toUpperCase() + targetId.replace('Body','').slice(1);
      const chevron = document.getElementById(chevronId);
      const collapsed = body.classList.toggle('collapsed');
      if (chevron) chevron.classList.toggle('collapsed', collapsed);
      try {
        const cfg = JSON.parse(localStorage.getItem('panelsSections') || '{}');
        cfg[targetId] = collapsed;
        localStorage.setItem('panelsSections', JSON.stringify(cfg));
      } catch {}
    });
  });
  // Restore
  try {
    const cfg = JSON.parse(localStorage.getItem('panelsSections') || '{}');
    Object.entries(cfg).forEach(([id, collapsed]) => {
      if (!collapsed) return;
      const body = document.getElementById(id);
      if (!body) return;
      body.classList.add('collapsed');
      const chevronId = 'chevron' + id.replace('Body','').charAt(0).toUpperCase() + id.replace('Body','').slice(1);
      const chevron = document.getElementById(chevronId);
      if (chevron) chevron.classList.add('collapsed');
    });
  } catch {}
}


window.addEventListener('DOMContentLoaded', async () => {
  if (window.electronAPI) document.body.classList.add('has-titlebar');

  const cfg = await window.electronAPI?.getSettings() ?? { token: '', theme: 'sakura' };
  token   = cfg.token || '';
  servers = (await window.electronAPI?.getServers()) ?? [];
  sftpState = loadSftpStateFromServers();

  applyTheme(cfg.theme || 'sakura');
  bindUI();
  bindPerfUI();
  bindCollapsible();
  renderTokenPanel();
  renderSidebar();
  await loadPerfSettings();
  showHome();
});

/* ═══════════════════════════════════════════════════════════════
   BIND UI  — every addEventListener lives here
   ═══════════════════════════════════════════════════════════════ */
function bindUI() {
  /* titlebar */
  on('btn-minimize', 'click', () => window.electronAPI?.minimize());
  on('btn-maximize', 'click', () => window.electronAPI?.maximize());
  on('btn-close',    'click', () => window.electronAPI?.close());
  on('refreshNavBtn','click', debounce(loadAllServerCards, 400));
  on('refreshSrvBtn', 'click', () => { if (activeId) loadServerData(activeId); });
  on('btn-errlogs',  'click', () => { renderLogTable(); showModal('modalLogs'); });
  on('btn-changelog', 'click', () => showChangelog());
  on('btn-panelsettings', 'click', () => openSettingsModal());
  on('btnOpenSettings',    'click', () => openSettingsModal());

  /* sidebar home button */
  on('btnNavHome', 'click', () => showHome());

  /* top refresh on home */
  on('btnHomeRefreshTop', 'click', debounce(loadAllServerCards, 400));

  /* sidebar per-server tab buttons */
  document.querySelectorAll('.sb-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!activeId) return;
      showTab(btn.dataset.tab);
      updateSidebarTabs(btn.dataset.tab);
    });
  });

  /* theme pills */
  document.addEventListener('click', async e => {
    const pill = e.target.closest('.theme-pill'); if (!pill) return;
    applyTheme(pill.dataset.theme);
    const s = await window.electronAPI?.getSettings() ?? {};
    await window.electronAPI?.saveSettings({ ...s, theme: pill.dataset.theme });
  });

  /* token */
  on('btnTokenEye', 'click', () => {
    const i = $('sideTokenInput');
    if (i) i.type = i.type === 'password' ? 'text' : 'password';
  });
  on('btnTokenSave', 'click', async () => {
    const val = $('sideTokenInput')?.value.trim();
    if (!val) return toast('Paste your bpat_ token first', 'error');
    token = val;
    const s = await window.electronAPI?.getSettings() ?? {};
    await window.electronAPI?.saveSettings({ ...s, token: val });
    const st = $('tokenStatus');
    if (st) { st.textContent = '✓ Saved!'; st.className = 'token-status ok'; }
    toast('Token saved', 'success');
    if (activeId) loadServerData(activeId);
  });
  on('btnTokenClear', 'click', async () => {
    token = '';
    const i = $('sideTokenInput'); if (i) i.value = '';
    const s = await window.electronAPI?.getSettings() ?? {};
    await window.electronAPI?.saveSettings({ ...s, token: '' });
    const st = $('tokenStatus');
    if (st) { st.textContent = 'Token cleared'; st.className = 'token-status'; }
    toast('Token cleared', 'info');
  });
  on('sideTokenInput', 'input', e => {
    const v = e.target.value.trim(); const st = $('tokenStatus'); if (!st) return;
    if (!v) { st.textContent = ''; st.className = 'token-status'; return; }
    st.textContent = v.startsWith('bpat_') ? '✓ Looks valid' : 'Tokens start with bpat_';
    st.className   = v.startsWith('bpat_') ? 'token-status ok' : 'token-status error';
  });

  /* server add/edit */
  on('btnAddServer',  'click', () => showServerModal());
  on('btnWelcomeAdd', 'click', () => showServerModal());

  /* server filter */
  let _sfRaf = null;
  on('serverFilter', 'input', () => { cancelAnimationFrame(_sfRaf); _sfRaf = requestAnimationFrame(renderSidebar); });
  on('btnQuickAdd', 'click', async () => {
    const id = $('quickServerId')?.value.trim();
    const nm = $('quickServerName')?.value.trim() || id;
    if (!id) return toast('Enter a server UUID', 'error');
    if (servers.find(s => s.id === id)) return toast('Already added', 'error');
    servers.push({ id, name: nm });
    await saveServers();
    renderSidebar();
    toast(`${nm} added`, 'success');
    if ($('quickServerId'))   $('quickServerId').value   = '';
    if ($('quickServerName')) $('quickServerName').value = '';
    selectServer(id);
  });
  on('btnSaveServer', 'click', async () => {
    const id     = $('modalServerId')?.value.trim();
    const name   = $('modalServerName')?.value.trim() || id;
    const editId = $('editServerId')?.value;
    if (!id) return toast('Server UUID required', 'error');
    if (editId) {
      const idx = servers.findIndex(s => s.id === editId);
      if (idx !== -1) servers[idx] = { id, name };
    } else {
      if (servers.find(s => s.id === id)) return toast('Already in list', 'error');
      servers.push({ id, name });
    }
    await saveServers();
    hideModal('modalServer');
    renderSidebar();
    toast('Server saved', 'success');
    selectServer(id);
  });
  on('btnCloseServerModal', 'click', () => hideModal('modalServer'));
  on('btnCancelServer',     'click', () => hideModal('modalServer'));
  on('modalServerBackdrop', 'click', () => hideModal('modalServer'));

  /* rename */
  on('btnConfirmRename',    'click', () => renameCallback?.());
  on('btnCloseRename',      'click', () => hideModal('modalRename'));
  on('btnCancelRename',     'click', () => hideModal('modalRename'));
  on('modalRenameBackdrop', 'click', () => hideModal('modalRename'));

  /* editor */
  on('saveFileBtn',   'click', saveEditorFile);
  on('reloadFileBtn', 'click', () => { if (editorFile) openEditor(editorFile); });
  on('closeEditorBtn','click', () => {
    if (editorDirty && !confirm('Close without saving?')) return;
    removeColourPopup();
    hideModal('editorModal'); editorFile = null; editorDirty = false;
  });
  on('editorBackdrop','click', () => {
    if (editorDirty && !confirm('Close without saving?')) return;
    removeColourPopup();
    hideModal('editorModal');
  });
  on('fileEditorArea','input', () => {
    editorDirty = true; $('editorUnsaved')?.classList.remove('hidden');
    const ta = $('fileEditorArea'); if (ta) editorColourPopupCheck(ta);
  });
  on('fileEditorArea','keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target, s = ta.selectionStart;
      ta.value = ta.value.substring(0, s) + '  ' + ta.value.substring(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveEditorFile(); }
    if (e.key === 'Escape') removeColourPopup();
  });
  on('fileEditorArea','keyup',  updateEditorCursor);
  on('fileEditorArea','click',  updateEditorCursor);

  /* logs */
  on('btnCloseLogs',     'click', () => hideModal('modalLogs'));
  on('modalLogsBackdrop','click', () => hideModal('modalLogs'));
  on('btnClearLogs',     'click', async () => {
    await fetch(`${API}/logs`, { method: 'DELETE' });
    renderLogTable(); toast('Logs cleared', 'info');
  });

  /* audit (modal close only — table rendering removed) */

  /* panel settings */
  on('btnCloseSettings', 'click', () => hideModal('modalSettings'));
  on('modalSettingsBackdrop','click', () => hideModal('modalSettings'));
  // legacy alias
  on('btnClosePanelSettings', 'click', () => hideModal('modalSettings'));
  on('modalPanelSettingsBackdrop','click', () => hideModal('modalPanelSettings'));
  on('btnResetPanelSettings','click', async () => {
    const ok = confirm('Reset local panel settings (token + theme) to defaults?');
    if (!ok) return;
    await window.electronAPI?.resetPanelSettings();
    toast('Panel settings reset', 'success');
    await loadLocal();
    applyTheme((await window.electronAPI?.getSettings())?.theme || 'sakura');
  });
  on('btnWipeDataCache','click', async () => {
    const ok = confirm('WIPE EVERYTHING?\nThis fully resets Panels (all local data, cache, and logs) and relaunches the app.');
    if (!ok) return;
    await window.electronAPI?.wipeEverything();
  });;

  /* tabs */
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => showTab(t.dataset.tab)));

  /* keyboard */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      removeCtxMenu();
      ['modalSettings','modalServer','modalRename','editorModal','modalLogs','modalPanelSettings'].forEach(id => hideModal(id));
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════════════ */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('.theme-pill')
    .forEach(p => p.classList.toggle('active', p.dataset.theme === t));
}

/* ═══════════════════════════════════════════════════════════════
   SIDEBAR TAB SYNC
   ═══════════════════════════════════════════════════════════════ */
function updateSidebarTabs(name) {
  document.querySelectorAll('.sb-tab').forEach(b => {
    b.classList.toggle('active-tab', b.dataset.tab === name);
  });
}

/* ═══════════════════════════════════════════════════════════════
   TOKEN PANEL
   ═══════════════════════════════════════════════════════════════ */
function renderTokenPanel() {
  const inp = $('sideTokenInput'); const st = $('tokenStatus');
  if (!inp || !st) return;
  inp.value = '';
  if (token) {
    inp.placeholder = 'Token saved (hidden)';
    st.textContent  = '✓ Token loaded';
    st.className    = 'token-status ok';
  } else {
    inp.placeholder = 'bpat_…';
    st.textContent  = '';
    st.className    = 'token-status';
  }
}

/* ═══════════════════════════════════════════════════════════════
   SIDEBAR
   ═══════════════════════════════════════════════════════════════ */
let _lastSidebarHash = '';
function renderSidebar() {
  const nav = $('serverSwitcher'); if (!nav) return;
  const filterVal = ($('serverFilter')?.value || '').toLowerCase().trim();
  const hash = servers.map(s=>s.id+s.name+(s.provider||'')).join('|') + '|' + activeId + '|' + filterVal + '|' + activeProvider;
  if (hash === _lastSidebarHash) return; // nothing changed
  _lastSidebarHash = hash;
  nav.innerHTML = '';
  // Filter by both text search AND active provider
  const visible = servers.filter(s => {
    const provMatch = (s.provider || 'beacon') === activeProvider;
    const textMatch = !filterVal || (s.name || '').toLowerCase().includes(filterVal) || (s.id || '').toLowerCase().includes(filterVal);
    return provMatch && textMatch;
  });
  if (!servers.length) {
    nav.innerHTML = '<div class="muted small" style="padding:8px 4px;font-size:12px">No servers yet</div>';
    return;
  }
  if (!visible.length) {
    nav.innerHTML = '<div class="muted small" style="padding:8px 4px;font-size:12px">No matches</div>';
    return;
  }
  // Update server count in sidebar label
  const lbl = document.querySelector('.side-label[data-servers-label]');
  if (lbl) lbl.textContent = `Servers${servers.length ? ' (' + servers.length + ')' : ''}`;
  visible.forEach(srv => {
    const btn = document.createElement('button');
    btn.className = 'switch-btn' + (srv.id === activeId ? ' active' : '');
    btn.innerHTML = `
      <span class="srv-dot" id="dot-${esc(srv.id)}"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(srv.name)}</span>
      <span class="srv-remove" title="Remove">✕</span>`;
    btn.title = srv.id; // show UUID on hover
    btn.addEventListener('click', () => selectServer(srv.id));
    btn.addEventListener('dblclick', e => { e.stopPropagation(); showServerModal(srv.id); });
    btn.querySelector('.srv-remove').addEventListener('click', e => {
      e.stopPropagation(); removeServer(srv.id);
    });
    nav.appendChild(btn);
  });
}

async function saveServers() { await window.electronAPI?.saveServers(servers); }

function showServerModal(editId = null) {
  const t  = $('modalServerTitle');
  const si = $('modalServerId');
  const sn = $('modalServerName');
  const ei = $('editServerId');
  if (editId) {
    const s = servers.find(x => x.id === editId);
    if (t)  t.textContent = 'Edit Server';
    if (si) si.value = s?.id   || '';
    if (sn) sn.value = s?.name || '';
    if (ei) ei.value = editId;
  } else {
    if (t)  t.textContent = 'Add Server';
    if (si) si.value = '';
    if (sn) sn.value = '';
    if (ei) ei.value = '';
  }
  showModal('modalServer');
}

async function removeServer(id, opts = {}) {
  const srv = servers.find(s => s.id === id);
  const msg = opts.confirmText || `Remove ${srv?.name || id} from Panels?`;
  if (!confirm(msg)) return;

  servers = servers.filter(s => s.id !== id);
  delete sftpState[id];
  // Clean up any stored credentials immediately
  if (window._sftpDragAbort && !activeId) { window._sftpDragAbort.abort(); window._sftpDragAbort = null; }
  await saveServers();
  if (activeId === id) { activeId = null; stopPollers(); showWelcome(); }
  renderSidebar();
  toast('Server removed', 'info');
}

/* ═══════════════════════════════════════════════════════════════
   VIEWS
   ═══════════════════════════════════════════════════════════════ */
/* ─── showHome — independent home view (never tied to a server) ─── */
function showHome() {
  // Deselect server — home is global
  activeId = null;
  stopPollers();
  lastServerData = null;
  lastLogLen     = 0;
  renderSidebar();

  $('homeView')?.classList.remove('hidden');
  $('serverView')?.classList.add('hidden');
  $('homeTopbar')?.classList.remove('hidden');
  $('serverTopbar')?.classList.add('hidden');
  $('sbServerNav')?.classList.add('hidden');
  $('btnNavHome')?.classList.add('active');

  loadAllServerCards();
}

function showServerView(id) {
  $('homeView')?.classList.add('hidden');
  $('serverView')?.classList.remove('hidden');
  $('homeTopbar')?.classList.add('hidden');
  $('serverTopbar')?.classList.remove('hidden');
  $('sbServerNav')?.classList.remove('hidden');
  $('btnNavHome')?.classList.remove('active');
  // Update sidebar server label
  const srv = servers.find(s => s.id === id);
  const nameEl = $('sbServerName');
  if (nameEl) nameEl.textContent = srv?.name || id;
}

function selectServer(id) {
  activeId = id;
  stopPollers();
  lastServerData = null;
  lastLogLen     = 0;
  renderSidebar();
  showServerView(id);
  showTab('overview');
  loadServerData(id);
}

function showWelcome() { showHome(); } // compatibility shim

/* ═══════════════════════════════════════════════════════════════
   TABS
   ═══════════════════════════════════════════════════════════════ */
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab')
    .forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  updateSidebarTabs(name);
  if (name !== 'console') { stopLogPoller(); /* ex ws removed */; }

  const srv = servers.find(s => s.id === activeId);
  const provider = srv?.provider || 'beacon';
  const pane = $('serverContent'); if (!pane) return;
  pane.style.padding = '';

  // Beacon-only routing
  if (name === 'overview')  { renderOverviewTab();      return; }
  if (name === 'terminal')  { renderConsoleTab();       return; }
  if (name === 'console')   { renderConsoleTab();       return; }
  if (name === 'files')     { renderFilesTab();         return; }
  if (name === 'minecraft') { renderPlayerManagement(); return; }
  if (name === 'settings' || name === 'backups') { renderServerSettingsTab(); return; }
}


/* ═══════════════════════════════════════════════════════════════
   BACKUPS / STARTUP / SETTINGS  (per-server)
   ═══════════════════════════════════════════════════════════════ */
function renderBackupsTab() { renderServerSettingsTab(); }
function renderStartupTab()  { renderServerSettingsTab(); }


function renderServerSettingsTab() {
  const pane = $('serverContent'); if (!pane) return;
  const srv = servers.find(s => s.id === activeId);
  const d   = lastServerData || {};
  const isEx = false;
  pane.innerHTML = `
    <div class="settings-grid">
      <div>
        <div class="section-head compact" style="margin-bottom:12px">
          <div class="section-title">Server Info</div>
          <span class="provider-badge beacon">Beacon</span>
        </div>
        <div class="kv-stack">
          <div class="kv-item"><span class="kv-label">Name</span><span class="kv-value">${esc(srv?.name || '—')}</span></div>
          ${d.egg    ? `<div class="kv-item"><span class="kv-label">Game</span><span class="kv-value">${esc(d.egg)}</span></div>` : ''}
          ${d.status ? `<div class="kv-item"><span class="kv-label">Status</span><span class="kv-value"><span class="status-pill ${statusCls(d.status)}" style="font-size:10px;padding:3px 8px">${esc(d.status)}</span></span></div>` : ''}
          ${d.ip     ? `<div class="kv-item"><span class="kv-label">Address</span><span class="kv-value mono copyable" onclick="copyToClipboard('${esc(d.ip)}:${esc(String(d.port||25565))}','Address')" title="Click to copy">${esc(d.ip)}:${esc(String(d.port||25565))}</span></div>` : ''}
          <div class="kv-item"><span class="kv-label">UUID</span><span class="kv-value mono copyable" onclick="copyToClipboard('${esc(activeId||'')}','UUID')" title="Click to copy" style="font-size:11px">${esc(activeId||'—')}</span></div>
          ${d.limits?.memory != null ? `<div class="kv-item"><span class="kv-label">RAM</span><span class="kv-value">${d.limits.memory} MB</span></div>` : ''}
          ${d.limits?.disk   != null ? `<div class="kv-item"><span class="kv-label">Disk</span><span class="kv-value">${d.limits.disk} MB</span></div>` : ''}
          ${d.description    ? `<div class="kv-item" style="flex-direction:column;gap:4px"><span class="kv-label">Note</span><span class="kv-value" style="font-size:12px">${esc(d.description)}</span></div>` : ''}
        </div>
      </div>
      <div>
        <div class="section-head compact" style="margin-bottom:12px">
          <div class="section-title">Actions</div>
        </div>
        <div class="kv-stack">
          ${!isEx ? `<div class="kv-item"><span class="kv-label">Backups</span><span class="kv-value"><button class="icon-btn" id="btnOpenBackups" style="font-size:11px;padding:5px 10px">Open in Files</button></span></div>` : ''}
          <div class="kv-item"><span class="kv-label">Rename</span><span class="kv-value"><button class="icon-btn" id="btnRenameServer" style="font-size:11px;padding:5px 10px">Edit name</button></span></div>
          <div class="kv-item" style="margin-top:8px"><span class="kv-label" style="color:var(--danger)">Danger</span><span class="kv-value"><button class="danger-btn" id="btnDeleteServer" style="font-size:11px;padding:5px 12px">Remove</button></span></div>
        </div>
      </div>
    </div>`;
  on('btnOpenBackups',  'click', () => { showTab('files'); setTimeout(() => { const s=getSftp(activeId); if(s.connected) listDir('/backups').catch(()=>listDir('/')); else toast('Connect SFTP first','info'); },50); });
  on('btnRenameServer', 'click', () => showServerModal(activeId));
  on('btnDeleteServer', 'click', () => removeServer(activeId, { confirmText: 'Remove from Panels only (real server untouched). Continue?' }));
}

/* ═══════════════════════════════════════════════════════════════
   LOAD SERVER DATA  (Beacon API)
   ═══════════════════════════════════════════════════════════════ */
const _loadingServers = new Set();
async function loadServerData(id) {
  const srv = servers.find(s => s.id === id);
  if (!srv) return;

  if (!token) return;
  if (_loadingServers.has(id)) return;
  _loadingServers.add(id);
  let r;
  try { r = await apiFetch(`/servers/${id}`); }
  finally { _loadingServers.delete(id); }
  if (!r.ok) { toast('Could not load server: ' + (r.data?.error || r.status), 'error'); return; }
  lastServerData = r.data;
  const name = servers.find(s => s.id === id)?.name || r.data.name || id;
  if ($('topbarTitle')) $('topbarTitle').textContent = name;
  const sbNameEl = $('sbServerName'); if (sbNameEl) sbNameEl.textContent = name;
  if ($('topbarSub'))   $('topbarSub').textContent   = [r.data.egg, r.data.ip ? r.data.ip + (r.data.port ? ':' + r.data.port : '') : null].filter(Boolean).join(' · ') || 'Beacon Hosting';
  setDot(id, r.data.status);
  if (activeTab === 'overview') renderOverviewTab();
}

function stopPollers() {
  stopLogPoller();
}

/* ═══════════════════════════════════════════════════════════════
   HOME TAB — grand overview of ALL servers
   Each card: name, status pill, ping, players, address, description
   ═══════════════════════════════════════════════════════════════ */
/* loadAllServerCards: provider-aware version defined below */

function selectServerAndTab(id, tab) {
  activeId = id;
  stopPollers();
  lastServerData = null;
  lastLogLen     = 0;
  renderSidebar();
  showServerView(id);
  showTab(tab);
  loadServerData(id);
}

async function fetchHomeCard(srv) {
  // Beacon only
  // 1. Beacon API — status, address, description
  let srvData = null;
  if (token) {
    const r = await apiFetch(`/servers/${srv.id}`);
    if (r.ok) srvData = r.data;
  }

  const status  = srvData?.status || 'Unknown';
  const ip      = srvData?.ip || null;
  const port    = srvData?.port || 25565;
  const desc    = srvData?.description || '';
  const egg     = srvData?.egg || '';
  const address = ip ? `${ip}:${port}` : null;

  // Update status pill + dot
  const statusEl = document.getElementById('hstatus-' + srv.id);
  const dotEl    = document.getElementById('hdot-'    + srv.id);
  if (statusEl) { statusEl.textContent = status; statusEl.className = `status-pill ${statusCls(status)}`; statusEl.style.cssText = 'font-size:11px;padding:4px 10px'; }
  if (dotEl)    { dotEl.className = 'srv-dot'; dotEl.classList.add(statusCls(status) === 'ok' ? 'online' : statusCls(status) === 'err' ? 'offline' : 'starting'); }

  // 2. MC Ping — players, version, motd (only if we have an address)
  let pingData = null;
  if (ip) {
    const pr = await fetch(`${API}/ping/${srv.id}?host=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}`);
    if (pr.ok) pingData = await pr.json().catch(() => null);
  }

  // Render body
  const body = document.getElementById('hbody-' + srv.id);
  if (!body) return;

  const rows = [];

  if (address) rows.push(kv('Address', `<span style="font-family:'JetBrains Mono',monospace;font-size:11.5px;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px" title="Click to copy" onclick="copyToClipboard('${esc(address)}','Address')">${esc(address)}</span>`));
  if (egg)     rows.push(kv('Game',    esc(egg)));

  if (pingData) {
    const players = pingData.online != null
      ? `${pingData.online} / ${pingData.max}`
      : '—';
    rows.push(kv('Players', players));
    if (pingData.version) rows.push(kv('Version', esc(pingData.version)));
    if (pingData.motd && pingData.motd !== srvData?.name)
      rows.push(kv('MOTD', `<span style="color:var(--text-soft);font-size:12px">${esc(pingData.motd)}</span>`));
    // Online player names
    if (pingData.players?.length) {
      const names = pingData.players.map(p =>
        `<span style="display:inline-block;padding:2px 8px;border-radius:99px;
                      background:var(--bg-card);border:1px solid var(--line-soft);
                      font-family:'JetBrains Mono',monospace;font-size:11px">${esc(p)}</span>`
      ).join('');
      rows.push(kv('Online', `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px">${names}</div>`));
    }
  } else if (ip && status.toLowerCase() === 'online') {
    rows.push(kv('Players', '<span class="muted small">Ping failed</span>'));
  } else if (!ip) {
    rows.push(kv('Address', '<span class="muted small">Not configured</span>'));
  }

  if (desc) rows.push(kv('Description', `<span style="color:var(--text-soft);font-size:12px">${esc(desc)}</span>`));

  body.innerHTML = rows.length
    ? rows.join('')
    : '<div class="muted small" style="font-size:12px">No data available</div>';
}

function kv(label, val) {
  return `<div style="display:flex;align-items:baseline;gap:8px;font-size:12px">
    <span style="min-width:76px;color:var(--text-muted);font-size:10px;font-weight:700;
                 text-transform:uppercase;letter-spacing:.08em;flex-shrink:0">${label}</span>
    <span style="flex:1;word-break:break-word">${val}</span>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   OVERVIEW TAB
   ═══════════════════════════════════════════════════════════════ */
function renderOverviewTab() {
  const srv  = lastServerData || {};
  const ip   = srv.ip || '';
  const port = srv.port || 25565;
  const pane = $('serverContent'); if (!pane) return;

  if (!lastServerData && token) loadServerData(activeId);

  pane.innerHTML = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">

    <!-- Server details -->
    <div>
      <div class="section-head compact" style="margin-bottom:12px">
        <div class="section-title">Server Details</div>
        <span class="status-pill ${statusCls(srv.status)}" style="font-size:11px;padding:5px 11px">${esc(srv.status || '…')}</span>
      </div>
      <div class="kv-grid two">
        <div class="kv-card frost-light" style="cursor:pointer" title="Click to copy" onclick="copyToClipboard('${esc(ip ? ip + ':' + port : '')}','Address')"><span>Address</span>
          <strong style="font-family:'JetBrains Mono',monospace;font-size:.86rem">${esc(ip ? ip + ':' + port : '—')}</strong></div>
        <div class="kv-card frost-light"><span>Game / Egg</span><strong>${esc(srv.egg || '—')}</strong></div>
        <div class="kv-card frost-light"><span>RAM</span> <strong>${esc(srv.limits?.memory != null ? srv.limits.memory + ' MB' : '—')}</strong></div>
        <div class="kv-card frost-light"><span>Disk</span><strong>${esc(srv.limits?.disk   != null ? srv.limits.disk   + ' MB' : '—')}</strong></div>
        <div class="kv-card frost-light"><span>CPU</span> <strong>${esc(srv.limits?.cpu    != null ? srv.limits.cpu    + '%'   : '—')}</strong></div>
        <div class="kv-card frost-light" style="cursor:pointer" title="Click to copy UUID" onclick="copyToClipboard('${esc(srv.uuid || '')}','UUID')"><span>UUID 📋</span>
          <strong style="font-family:'JetBrains Mono',monospace;font-size:.72rem;word-break:break-all">${esc(srv.uuid || '—')}</strong></div>
      </div>
      ${srv.description ? `<div class="kv-card frost-light" style="margin-top:10px"><span>Description</span><strong style="font-weight:400;font-size:.86rem">${esc(srv.description)}</strong></div>` : ''}
    </div>

    <!-- Ping + Query -->
    <div>
      <div class="section-head compact" style="margin-bottom:12px">
        <div class="section-title">Minecraft Status</div>
        <button class="icon-btn" id="btnOvPing" style="font-size:11px;padding:5px 10px">↻ Ping</button>
      </div>
      <div class="form-row" style="margin-bottom:10px">
        <label class="field">Host   <input type="text"   id="ovPingHost" value="${esc(ip)}" placeholder="Server IP"/></label>
        <label class="field" style="max-width:100px">Port <input type="number" id="ovPingPort" value="${esc(port)}"/></label>
      </div>
      <div id="ovPingResult" class="kv-card frost-light" style="min-height:58px;margin-bottom:14px;padding:14px">
        <span class="muted small">Press Ping to check</span>
      </div>

    </div>

  </div>

  <!-- Power controls -->
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px;
              padding-top:16px;border-top:1px solid var(--line-soft)">
    <span style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-right:4px">Power</span>
    <button class="primary-btn" style="font-size:12px;padding:7px 14px" data-action="start">▶ Start</button>
    <button class="icon-btn"    style="font-size:12px;padding:7px 14px" data-action="restart">↺ Restart</button>
    <button class="icon-btn"    style="font-size:12px;padding:7px 14px" data-action="stop">■ Stop</button>
    <button class="danger-btn"  style="font-size:12px;padding:7px 14px" data-action="kill">⚠ Kill</button>
  </div>`;

  // Power buttons
  pane.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await apiFetch(`/servers/${activeId}/power`, { method: 'POST', body: { action: btn.dataset.action } });
      btn.disabled = false;
      if (r.ok) toast(btn.dataset.action + ' sent ✓', 'success');
      else toast('Power failed: ' + (r.data?.error || r.status), 'error');
      setTimeout(() => loadServerData(activeId), 1800);
    });
  });

  on('btnOvPing',  'click', runOvPing);

  if (ip && (srv.status || '').toLowerCase() === 'online') runOvPing();
}

async function runOvPing() {
  const host = $('ovPingHost')?.value.trim();
  const port = $('ovPingPort')?.value || '25565';
  const box  = $('ovPingResult'); if (!box || !host) return;
  box.innerHTML = '<span class="muted small"><span class="spinner"></span> Pinging…</span>';
  const r = await fetch(`${API}/ping/${activeId}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    box.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><span class="status-pill err">Offline</span><span class="muted small">${esc(d.error || 'Unreachable')}</span></div>`;
    return;
  }
  const sample = d.players?.length
    ? d.players.map(p => `<span style="font-family:'JetBrains Mono',monospace;font-size:11px;padding:2px 8px;border-radius:99px;background:var(--bg-card);border:1px solid var(--line-soft)">${esc(p)}</span>`).join(' ')
    : '';
  box.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="status-pill ok">Online</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">${esc(d.version)}</span>
        </div>
        <div style="font-size:13px;font-weight:500;margin-bottom:4px">${esc(d.motd || '')}</div>
        <div style="font-size:12px;color:var(--text-muted)">${d.online} / ${d.max} players</div>
      </div>
    </div>
    ${sample ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">${sample}</div>` : ''}`;
}


/* ═══════════════════════════════════════════════════════════════
   CONSOLE TAB
   ═══════════════════════════════════════════════════════════════ */
function renderConsoleTab() {
  const pane = $('serverContent'); if (!pane) return;
  pane.innerHTML = `
    <div class="section-head compact">
      <div class="section-title">Console</div>
      <button class="icon-btn" id="btnClearConsole" style="font-size:12px;padding:7px 12px">Clear</button>
    </div>
    <div id="consoleOutput" class="console-output" style="margin-bottom:12px"></div>
    <div class="command-bar">
      <input id="cmdInput" type="text" placeholder="Enter server command… (↑↓ history)" autocomplete="off"/>
      <button class="primary-btn" id="btnSendCmd">Send</button>
    </div>`;
  on('btnSendCmd',     'click',   sendBeaconCommand);
  on('cmdInput',       'keydown', e => {
    if (e.key === 'Enter') { sendBeaconCommand(); return; }
    // ↑/↓ history navigation
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!cmdHistory.length) return;
      cmdHistoryIdx = Math.min(cmdHistoryIdx + 1, cmdHistory.length - 1);
      const inp = $('cmdInput'); if (inp) inp.value = cmdHistory[cmdHistoryIdx] || '';
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdHistoryIdx = Math.max(cmdHistoryIdx - 1, -1);
      const inp = $('cmdInput'); if (inp) inp.value = cmdHistoryIdx >= 0 ? (cmdHistory[cmdHistoryIdx] || '') : '';
    }
  });
  on('btnClearConsole','click',   () => { const o = $('consoleOutput'); if (o) o.innerHTML = ''; lastLogLen = 0; });
  lastLogLen = 0;
  startLogPoller();
}

const CONSOLE_MAX_LINES = 500;
function appendLog(text) {
  const out = $('consoleOutput'); if (!out) return;
  const ts = new Date().toLocaleTimeString();
  const frag = document.createDocumentFragment();
  String(text).split('\n').forEach(line => {
    if (!line.trim()) return;
    const span = document.createElement('span');
    span.className = 'console-line';
    span.innerHTML = `<span class="console-ts">[${ts}]</span>${ansiToHtml(line)}`;
    frag.appendChild(span);
  });
  out.appendChild(frag);
  // Trim old lines to prevent unbounded DOM growth
  while (out.children.length > CONSOLE_MAX_LINES) out.removeChild(out.firstChild);
  if (!appendLog._rafPending) {
    appendLog._rafPending = true;
    requestAnimationFrame(() => { appendLog._rafPending = false; if(out) out.scrollTop = out.scrollHeight; });
  }
}

/** Minecraft §x colour code → CSS colour (returns null if not a colour code) */
const MC_COLOURS = {
  '0':'#000000','1':'#0000AA','2':'#00AA00','3':'#00AAAA',
  '4':'#AA0000','5':'#AA00AA','6':'#FFAA00','7':'#AAAAAA',
  '8':'#555555','9':'#5555FF','a':'#55FF55','b':'#55FFFF',
  'c':'#FF5555','d':'#FF55FF','e':'#FFFF55','f':'#FFFFFF',
  'g':'#DDD605',
};
const MC_FORMAT = { 'l':'bold','m':'line-through','n':'underline','o':'italic','r':null };

/**
 * Full console colourise:
 *  • ANSI SGR  \x1b[...m
 *  • Minecraft §x / &x colour + format codes
 *  • &#RRGGBB  hex colour notation (Paper/Spigot adventure)
 */
function ansiToHtml(input) {
  // ── Step 1: convert Minecraft §/& codes + &#hex into ANSI-like spans ──
  // We'll do a single combined regex pass before ANSI so everything is uniform.
  let intermediate = '';
  // Combined pattern: ANSI | §x | &x (where x is 0-9a-g, l,m,n,o,r) | &#RRGGBB
  const COMBO = /\x1b\[([0-9;]*)m|(§|&)([0-9a-gA-GlLmMnNoOrR])|(§|&)#([0-9a-fA-F]{6})/g;
  let last = 0;
  const tokens = []; // [{type:'text',val}|{type:'ansi',codes}|{type:'color',hex}|{type:'mcfmt',fmt}|{type:'reset'}]

  for (let m; (m = COMBO.exec(input)); ) {
    if (m.index > last) tokens.push({ type:'text', val: input.slice(last, m.index) });
    last = COMBO.lastIndex;

    if (m[1] !== undefined) {
      // ANSI SGR
      tokens.push({ type:'ansi', codes: (m[1]||'0').split(';').filter(Boolean).map(Number) });
    } else if (m[3] !== undefined) {
      // §x or &x
      const code = m[3].toLowerCase();
      if (MC_COLOURS[code]) {
        tokens.push({ type:'color', hex: MC_COLOURS[code] });
      } else if (code === 'r') {
        tokens.push({ type:'reset' });
      } else if (MC_FORMAT[code] !== undefined) {
        tokens.push({ type:'mcfmt', fmt: MC_FORMAT[code] });
      }
    } else if (m[5] !== undefined) {
      // &#RRGGBB
      tokens.push({ type:'color', hex: '#' + m[5] });
    }
  }
  if (last < input.length) tokens.push({ type:'text', val: input.slice(last) });

  // ── Step 2: render tokens into HTML spans ──
  const parts = [];
  let state = { fg: null, fgHex: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false };

  const pushText = (txt) => {
    if (!txt) return;
    const safe = esc(txt);
    const styles = [];
    if (state.fgHex) styles.push(`color:${state.fgHex}`);
    else { const fg = sgrColor(state.fg, false); if (fg) styles.push(`color:${fg}`); }
    const bg = sgrColor(state.bg, true); if (bg) styles.push(`background:${bg};padding:0 2px;border-radius:4px`);
    if (state.bold)      styles.push('font-weight:700');
    if (state.dim)       styles.push('opacity:.75');
    if (state.italic)    styles.push('font-style:italic');
    if (state.underline) styles.push('text-decoration:underline');
    if (state.strike)    styles.push('text-decoration:line-through');
    parts.push(styles.length ? `<span style="${styles.join(';')}">${safe}</span>` : safe);
  };

  for (const tok of tokens) {
    if (tok.type === 'text') {
      pushText(tok.val);
    } else if (tok.type === 'ansi') {
      applySgr(state, tok.codes.length ? tok.codes : [0]);
      if (tok.codes.includes(0)) state.fgHex = null; // ANSI reset clears hex colour too
    } else if (tok.type === 'color') {
      state.fgHex = tok.hex;
    } else if (tok.type === 'reset') {
      state = { fg:null, fgHex:null, bg:null, bold:false, dim:false, italic:false, underline:false, strike:false };
    } else if (tok.type === 'mcfmt') {
      if (tok.fmt === 'bold')         state.bold = true;
      else if (tok.fmt === 'italic')  state.italic = true;
      else if (tok.fmt === 'underline') state.underline = true;
      else if (tok.fmt === 'line-through') state.strike = true;
    }
  }

  return parts.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function applySgr(state, codes) {
  for (const c of codes) {
    if (c === 0) { state.fg = null; state.bg = null; state.bold = false; state.dim = false; state.italic = false; state.underline = false; state.strike = false; continue; }
    if (c === 1) { state.bold = true; continue; }
    if (c === 2) { state.dim = true; continue; }
    if (c === 3) { state.italic = true; continue; }
    if (c === 4) { state.underline = true; continue; }
    if (c === 9) { state.strike = true; continue; }
    if (c === 22) { state.bold = false; state.dim = false; continue; }
    if (c === 23) { state.italic = false; continue; }
    if (c === 24) { state.underline = false; continue; }
    if (c === 29) { state.strike = false; continue; }
    if (c === 39) { state.fg = null; continue; }
    if (c === 49) { state.bg = null; continue; }

    // 30–37 / 90–97 foreground
    if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { state.fg = c; continue; }
    // 40–47 / 100–107 background
    if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) { state.bg = c; continue; }
  }
}

function ansiStyle(state) {
  const styles = [];
  const fg = sgrColor(state.fg, false);
  const bg = sgrColor(state.bg, true);
  if (fg) styles.push(`color:${fg}`);
  if (bg) styles.push(`background:${bg};padding:0 2px;border-radius:6px`);
  if (state.bold) styles.push('font-weight:700');
  if (state.dim) styles.push('opacity:.85');
  if (state.italic) styles.push('font-style:italic');
  if (state.underline) styles.push('text-decoration:underline');
  return styles.join(';');
}

function sgrColor(code, isBg) {
  if (code == null) return null;

  // Map to your theme vars so it stays on-brand.
  const base = {
    30: 'var(--ansi-black)', 31: 'var(--ansi-red)',    32: 'var(--ansi-green)', 33: 'var(--ansi-yellow)',
    34: 'var(--ansi-blue)',  35: 'var(--ansi-magenta)',36: 'var(--ansi-cyan)',  37: 'var(--ansi-white)',
    90: 'var(--ansi-bright-black)', 91: 'var(--ansi-bright-red)', 92: 'var(--ansi-bright-green)', 93: 'var(--ansi-bright-yellow)',
    94: 'var(--ansi-bright-blue)',  95: 'var(--ansi-bright-magenta)',96: 'var(--ansi-bright-cyan)', 97: 'var(--ansi-bright-white)',
  };

  const bgBase = {
    40: base[30], 41: base[31], 42: base[32], 43: base[33], 44: base[34], 45: base[35], 46: base[36], 47: base[37],
    100: base[90],101: base[91],102: base[92],103: base[93],104: base[94],105: base[95],106: base[96],107: base[97],
  };

  return isBg ? (bgBase[code] || null) : (base[code] || null);
}

function startLogPoller() {
  if (logTimer) return;
  fetchLogs();
  logTimer = setInterval(fetchLogs, 3000);
}

function stopLogPoller() {
  clearInterval(logTimer);
  logTimer = null;
}

async function fetchLogs() {
  if (!activeId || !token) return;
  if (document.hidden) return; // don't poll when window is hidden
  const r = await apiFetch(`/servers/${activeId}/logs`); if (!r.ok) return;
  const raw  = r.data?.logs ?? r.data?.data ?? r.data?.output ?? '';
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw);
  if (text.length > lastLogLen) { appendLog(text.slice(lastLogLen)); lastLogLen = text.length; }
}

async function sendBeaconCommand() {
  const inp = $('cmdInput'); if (!inp) return;
  const cmd = inp.value.trim(); if (!cmd) return;
  inp.value = '';
  // Record in history (avoid duplicates at front)
  if (cmdHistory[0] !== cmd) cmdHistory.unshift(cmd);
  if (cmdHistory.length > 80) cmdHistory.length = 80;
  cmdHistoryIdx = -1;
  appendLog('❯ ' + cmd);
  const r = await apiFetch(`/servers/${activeId}/command`, { method: 'POST', body: { command: cmd } });
  if (!r.ok) appendLog('Error: ' + (r.data?.error || r.status));
}

/* ═══════════════════════════════════════════════════════════════
   FILES TAB — SFTP
   ═══════════════════════════════════════════════════════════════ */
function renderFilesTab() {
  const sftp = getSftp(activeId);
  const pane = $('serverContent'); if (!pane) return;

  // Check live status from server in case it disconnected
  fetch(`${API}/sftp/${activeId}/status`)
    .then(r => r.json()).then(d => {
      if (!d.connected && sftp.connected) {
        sftp.connected = false;
        toast('SFTP session ended — reconnecting…', 'info');
        renderFilesTab();
      }
    }).catch(() => {});

  if (!sftp.connected) {
    // Pre-fill saved credentials; fall back to server IP for host
    const defaultHost = sftp.host || '';
    // auto-connect when we have stored creds
    const canAuto = sftp.autoConnect && sftp.host && sftp.port && sftp.user && sftp.pass;
    pane.innerHTML = `
      <div class="section-head compact"><div class="section-title">SFTP Connection</div></div>
      <div style="max-width:500px">
        <div class="form-stack">
          <div class="form-row">
            <label class="field">Host <input type="text"   id="sftpHost" value="${esc(defaultHost)}" placeholder="IP"/></label>
            <label class="field" style="max-width:100px">Port <input type="number" id="sftpPort" value="${esc(sftp.port||'2022')}"/></label>
          </div>
          <label class="field">Email <input type="text"     id="sftpUser" value="${esc((sftp.user||'').split(':')[0])}" autocomplete="off" placeholder="you@example.com"/></label>
          <label class="field">Password <input type="password" id="sftpPass" value="${esc(sftp.pass||'')}"/></label>
          <button class="primary-btn" id="btnSftpConnect" style="margin-top:4px">Connect via SFTP</button>
          <div id="sftpConnStatus" class="muted small"></div>
        </div>
      </div>`;
    on('btnSftpConnect', 'click',   doSftpConnect);
    if (canAuto) { autoConnectSftp(); }
    on('sftpPass',       'keydown', e => { if (e.key === 'Enter') doSftpConnect(); });
  } else {
    renderFileManager();
  }
}

async function autoConnectSftp() {
  const sftp = getSftp(activeId);
  const st = $('sftpConnStatus');
  const btn = $('btnSftpConnect');

  if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }
  if (st) st.textContent = 'Auto-connecting…';

  const host = String(sftp.host || '').replace(/^sftp:\/\//i, '').trim();
  const port = String(sftp.port || '2022');
  const username = String(sftp.user || '');
  const pass = String(sftp.pass || '');

  try {
    const r = await fetch(`${API}/sftp/${activeId}/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, username, password: pass }),
    });
    const d = await r.json().catch(() => ({}));

    if (!r.ok) {
      if (st) st.textContent = 'Auto-connect failed: ' + (d.error || r.status);
      if (btn) { btn.textContent = 'Connect via SFTP'; btn.disabled = false; }
      return;
    }

    sftp.connected = true;
    sftp.path = sftp.path || '/';
    await persistSftpStateToServers();
    toast('SFTP auto-connected ✓', 'success');
    renderFileManager();
  } catch (e) {
    if (st) st.textContent = 'Auto-connect failed.';
    if (btn) { btn.textContent = 'Connect via SFTP'; btn.disabled = false; }
  }
}

async function doSftpConnect() {
  const sftp = getSftp(activeId);
  let host = $('sftpHost')?.value.trim() || '';
  const port = ($('sftpPort')?.value || '2022').toString();
  const baseUser = $('sftpUser')?.value.trim() || '';
  const pass = $('sftpPass')?.value;

  host = host.replace(/^sftp:\/\//i, '').trim();
  const username = baseUser.includes(':') ? baseUser : `${baseUser}:${activeId}`;

  if (!host || !baseUser || !pass) return toast('Fill in all SFTP fields', 'error');

  const btn = $('btnSftpConnect');
  const st  = $('sftpConnStatus');
  if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }

  const r = await fetch(`${API}/sftp/${activeId}/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port, username, password: pass }),
  });
  const d = await r.json().catch(() => ({}));
  if (btn) { btn.textContent = 'Connect via SFTP'; btn.disabled = false; }

  if (!r.ok) {
    if (st) st.textContent = 'Error: ' + (d.error || r.status);
    toast('SFTP failed: ' + (d.error || r.status), 'error');
    return;
  }

  // Save credentials so they survive tab/server switches
  sftp.host       = 'sftp://' + host;
  sftp.port       = port;
  sftp.user       = baseUser; // email only; backend enforces email:uuid
  sftp.pass       = pass;
  sftp.autoConnect = true;
  await persistSftpStateToServers();
  sftp.connected = true;
  sftp.path      = '/';
  toast('SFTP connected ✓', 'success');
  renderFileManager();
}
function renderFileManager() {
  const pane = $('serverContent'); if (!pane) return;
  pane.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button class="icon-btn" id="btnSftpUp"      style="font-size:12px;padding:7px 10px">↑ Up</button>
      <span   class="breadcrumbs-pill" id="sftpBreadcrumb" style="flex:1;min-width:80px">/</span>
      <button class="icon-btn" id="btnSftpRefresh" style="font-size:12px;padding:7px 10px">↻</button>
      <button class="icon-btn" id="btnSftpMkdir"   style="font-size:12px;padding:7px 10px">＋ Folder</button>
      <button class="icon-btn" id="btnSftpNewFile" style="font-size:12px;padding:7px 10px">＋ File</button>
      <button class="icon-btn" id="btnSftpUpload"  style="font-size:12px;padding:7px 10px">↑ Upload</button>
      <button class="danger-btn" id="btnSftpDisc"  style="font-size:12px;padding:7px 10px">Disconnect</button>
    </div>
    <div class="file-drop-wrap">
      <div class="drop-overlay" id="dropOverlay">⬇ Drop files to upload</div>
      <div class="file-list-shell macos" id="sftpFileList">
        <div class="loading-state"><span class="spinner"></span> Loading…</div>
      </div>
    </div>`;

  on('btnSftpUp', 'click', () => {
    const _sftp0 = getSftp(activeId);
    if (_sftp0.path === '/') return;
    listDir(_sftp0.path.replace(/\/[^/]+\/?$/, '') || '/');
  });
  on('btnSftpRefresh', 'click',  () => listDir(getSftp(activeId).path));
  on('btnSftpDisc',    'click',  async () => {
    await fetch(`${API}/sftp/${activeId}/disconnect`, { method: 'POST' });
    const s = getSftp(activeId); s.connected = false; s.path = '/'; await persistSftpStateToServers();
    toast('SFTP disconnected', 'info');
    renderFilesTab();
  });
  on('btnSftpMkdir', 'click', async () => {
    const name = prompt('Folder name:'); if (!name) return;
    const r = await fetch(`${API}/sftp/${activeId}/mkdir`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: joinPath(getSftp(activeId).path, name) }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { toast('Folder created ✓', 'success'); listDir(getSftp(activeId).path); }
    else toast('Error: ' + (d.error || r.status), 'error');
  });
  on('btnSftpNewFile', 'click', () => {
    const name = prompt('New file name:'); if (!name) return;
    openEditor(joinPath(getSftp(activeId).path, name), '');
  });
  on('btnSftpUpload', 'click', async () => {
    const paths = await window.electronAPI?.openFileDialog() ?? [];
    if (paths.length) uploadLocalPaths(paths);
  });

  // Drag & drop — use AbortController so listener is torn down on next renderFileManager call
  if (window._sftpDragAbort) window._sftpDragAbort.abort();
  window._sftpDragAbort = new AbortController();
  const { signal } = window._sftpDragAbort;
  const area = pane;
  area.addEventListener('dragover',  e => { e.preventDefault(); $('dropOverlay')?.classList.add('active'); }, { signal });
  area.addEventListener('dragleave', e => { if (!area.contains(e.relatedTarget)) $('dropOverlay')?.classList.remove('active'); }, { signal });
  area.addEventListener('drop', async e => {
    e.preventDefault(); $('dropOverlay')?.classList.remove('active');
    const files = Array.from(e.dataTransfer.files); if (!files.length) return;
    const fd = new FormData();
    fd.append('remotePath', getSftp(activeId).path);
    files.forEach(f => fd.append('files', f, f.name));
    const r = await fetch(`${API}/sftp/${activeId}/upload`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { toast(`Uploaded ${d.uploaded?.length || 0} file(s) ✓`, 'success'); listDir(getSftp(activeId).path); }
    else toast('Upload failed: ' + (d.error || r.status), 'error');
  }, { signal });

  listDir(getSftp(activeId).path);
}

async function listDir(dir) {
  getSftp(activeId).path = dir;
  const bc = $('sftpBreadcrumb'); if (bc) bc.textContent = dir;
  const list = $('sftpFileList'); if (!list) return;
  list.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading…</div>';

  const r = await fetch(`${API}/sftp/${activeId}/list?path=${encodeURIComponent(dir)}`);
  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    list.innerHTML = `<div class="loading-state">⚠ ${esc(d.error || 'Error loading directory')}</div>`;
    // If session dropped, show reconnect form
    if ((d.error || '').toLowerCase().includes('not connected')) {
      getSftp(activeId).connected = false; renderFilesTab();
    }
    return;
  }
  renderFileList(d.items || []);
}

function renderFileList(items) {
  const list = $('sftpFileList'); if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="loading-state">Empty directory</div>';
    return;
  }
  list.innerHTML = items.map(item => {
    const fp    = joinPath(getSftp(activeId).path, item.name);
    const isDir = item.type === 'directory';
    const sz    = isDir ? '—' : fmtBytes(item.size);
    const dt    = item.modified ? new Date(item.modified * 1000).toLocaleDateString() : '';
    return `
      <div class="file-row macos" data-path="${esc(fp)}" data-type="${item.type}" data-name="${esc(item.name)}">
        <div class="file-ic">${fileIcon(item.name, isDir)}</div>
        <div style="flex:1;min-width:0">
          <div class="file-name">
            <strong class="sftp-name-link" data-path="${esc(fp)}" data-isdir="${isDir}" style="cursor:pointer">${esc(item.name)}</strong>
          </div>
          <div class="file-meta">${sz}${dt ? ' · ' + dt : ''}</div>
        </div>
        <div style="display:flex;gap:5px;align-items:center">
          ${!isDir ? `
            <button class="icon-btn sftp-act" data-action="edit"   data-path="${esc(fp)}" style="font-size:11px;padding:5px 9px">Edit</button>
            <button class="icon-btn sftp-act" data-action="dl"     data-path="${esc(fp)}" style="font-size:11px;padding:5px 9px">↓</button>` : ''}
          <button class="icon-btn sftp-act" data-action="rename" data-path="${esc(fp)}" data-name="${esc(item.name)}" style="font-size:11px;padding:5px 9px">Rename</button>
          <button class="icon-btn sftp-act" data-action="del"    data-path="${esc(fp)}" data-type="${item.type}"
                  style="font-size:11px;padding:5px 9px;color:var(--danger)">Del</button>
        </div>
      </div>`;
  }).join('');

  // Navigate / open
  list.querySelectorAll('.sftp-name-link').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.isdir === 'true') listDir(el.dataset.path);
      else openEditor(el.dataset.path);
    });
  });

  // Action buttons
  list.querySelectorAll('.sftp-act').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { action, path: fp, name, type } = btn.dataset;
      if      (action === 'edit')   openEditor(fp);
      else if (action === 'dl')     downloadFile(fp);
      else if (action === 'rename') promptRename(fp, name);
      else if (action === 'del')    deleteItem(fp, type);
    });
  });

  // Right-click context menu
  list.querySelectorAll('.file-row.macos').forEach(row => {
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e, row.dataset.path, row.dataset.type, row.dataset.name);
    });
  });
}

async function uploadLocalPaths(localPaths) {
  const fd = new FormData();
  fd.append('remotePath', getSftp(activeId).path);
  for (const p of localPaths) {
    const res = await fetch('file://' + p).catch(() => null); if (!res) continue;
    fd.append('files', await res.blob(), p.split(/[\\/]/).pop());
  }
  const r = await fetch(`${API}/sftp/${activeId}/upload`, { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { toast(`Uploaded ${d.uploaded?.length || 0} file(s) ✓`, 'success'); listDir(getSftp(activeId).path); }
  else toast('Upload failed: ' + (d.error || r.status), 'error');
}

function downloadFile(fp) {
  const a = document.createElement('a');
  a.href     = `${API}/sftp/${activeId}/download?path=${encodeURIComponent(fp)}`;
  a.download = fp.split('/').pop();
  a.click();
}

function promptRename(fp, currentName) {
  const inp = $('renameInput'); if (inp) inp.value = currentName || '';
  renameCallback = async () => {
    const newName = $('renameInput')?.value.trim();
    if (!newName || newName === currentName) return hideModal('modalRename');
    const dir = fp.substring(0, fp.lastIndexOf('/'));
    const r = await fetch(`${API}/sftp/${activeId}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: fp, newPath: dir + '/' + newName }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { toast('Renamed ✓', 'success'); listDir(getSftp(activeId).path); }
    else toast('Rename failed: ' + (d.error || r.status), 'error');
    hideModal('modalRename');
  };
  showModal('modalRename');
}

async function deleteItem(fp, type) {
  if (!confirm(`Delete "${fp.split('/').pop()}"?`)) return;
  const r = await fetch(`${API}/sftp/${activeId}/delete`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fp, type }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { toast('Deleted ✓', 'success'); listDir(getSftp(activeId).path); }
  else toast('Delete failed: ' + (d.error || r.status), 'error');
}

function showCtxMenu(e, fp, type, name, customItems) {
  removeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
  const items = customItems ?? (type === 'file'
    ? [['Edit', () => openEditor(fp)], ['Download', () => downloadFile(fp)], null,
       ['Rename', () => promptRename(fp, name)], ['Delete', () => deleteItem(fp, 'file'), true]]
    : [['Open', () => listDir(fp)], null,
       ['Rename', () => promptRename(fp, name)], ['Delete', () => deleteItem(fp, 'directory'), true]]);
  items.forEach(item => {
    if (!item) { const hr = document.createElement('hr'); hr.className = 'ctx-separator'; menu.appendChild(hr); return; }
    const [label, fn, danger] = item;
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (danger ? ' danger' : '');
    btn.textContent = label;
    btn.onclick = () => { fn(); removeCtxMenu(); };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 50);
}
function removeCtxMenu() { document.querySelector('.ctx-menu')?.remove(); }

/* ═══════════════════════════════════════════════════════════════
   EDITOR
   ═══════════════════════════════════════════════════════════════ */
async function openEditor(fp, initialContent) {
  let content = initialContent ?? null;
  if (content === null) {
    const r = await fetch(`${API}/sftp/${activeId}/read?path=${encodeURIComponent(fp)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast('Cannot open: ' + (d.error || r.status), 'error'); return; }
    content = d.content;
  }
  editorFile = fp; editorDirty = false;
  const ta = $('fileEditorArea'); if (ta) ta.value = content;
  if ($('editorTitle'))  $('editorTitle').textContent  = fp.split('/').pop();
  if ($('editorPath'))   $('editorPath').textContent   = fp;
  if ($('editorLang'))   $('editorLang').textContent   = detectLang(fp);
  if ($('editorCursor')) $('editorCursor').textContent = 'Ln 1, Col 1';
  $('editorUnsaved')?.classList.add('hidden');
  showModal('editorModal');
  ta?.focus();
  updateEditorCursor();
}


function updateEditorCursor() {
  const ta = $('fileEditorArea'); if (!ta) return;
  const lines = ta.value.substring(0, ta.selectionStart).split('\n');
  const el = $('editorCursor');
  if (el) el.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  editorColourPopupCheck(ta);
}

/* ═══════════════════════════════════════════════════════════════
   EDITOR COLOUR POPUP
   Detects #RRGGBB / #RGB  and  §x / &x  Minecraft colour codes
   near the cursor and shows a floating swatch + colour picker.
   ═══════════════════════════════════════════════════════════════ */

// Expand #RGB → #RRGGBB
function expandHex(h) {
  if (h.length === 4) return '#' + h[1]+h[1]+h[2]+h[2]+h[3]+h[3];
  return h;
}

// Contrast colour for text on a swatch (black or white)
function contrastColour(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return (r*299 + g*587 + b*114) / 1000 > 128 ? '#111' : '#fff';
}

let _colourPopupActive = false;

function editorColourPopupCheck(ta) {
  const val   = ta.value;
  const pos   = ta.selectionStart;

  // ── Find a colour token that overlaps the cursor ──
  // Patterns: #RRGGBB, #RGB, §x, &x  (where x in 0-9a-g)
  const COLOUR_PAT = /(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|[§&][0-9a-gA-G])/g;
  let found = null;
  for (let m; (m = COLOUR_PAT.exec(val)); ) {
    if (m.index <= pos && pos <= m.index + m[0].length) {
      found = { raw: m[0], start: m.index, end: m.index + m[0].length };
      break;
    }
  }

  if (!found) { removeColourPopup(); return; }

  // Resolve hex value from the token
  let hex;
  const raw = found.raw;
  if (raw.startsWith('#')) {
    hex = expandHex(raw.toLowerCase());
  } else {
    const code = raw[1].toLowerCase();
    hex = MC_COLOURS[code];
    if (!hex) { removeColourPopup(); return; }
  }

  showColourPopup(ta, found, hex);
}

function removeColourPopup() {
  document.getElementById('editorColourPopup')?.remove();
  _colourPopupActive = false;
}

function showColourPopup(ta, token, hex) {
  // Reuse existing popup if already shown for same position
  const existing = document.getElementById('editorColourPopup');
  if (existing && existing.dataset.token === token.raw && existing.dataset.start === String(token.start)) return;
  removeColourPopup();
  _colourPopupActive = true;

  // Position popup near the textarea using caret coordinates
  const coords = getCaretCoords(ta, token.start);
  const taRect  = ta.getBoundingClientRect();

  const popup = document.createElement('div');
  popup.id = 'editorColourPopup';
  popup.dataset.token = token.raw;
  popup.dataset.start = String(token.start);

  const isMC   = !token.raw.startsWith('#');
  const label  = isMC ? `MC §${token.raw[1].toLowerCase()}` : token.raw.toUpperCase();
  const contrast = contrastColour(hex);

  popup.innerHTML = `
    <div class="ecp-swatch" style="background:${hex};color:${contrast}">
      <span class="ecp-label">${label}</span>
      <span class="ecp-hex">${hex.toUpperCase()}</span>
    </div>
    ${!isMC ? `<div class="ecp-picker-row">
      <input type="color" id="ecpPicker" value="${hex}" title="Pick colour"/>
      <button class="ecp-copy" title="Copy hex">📋 Copy</button>
      <button class="ecp-close" title="Close">✕</button>
    </div>` : `<div class="ecp-picker-row">
      <button class="ecp-copy" title="Copy hex">📋 ${hex.toUpperCase()}</button>
      <button class="ecp-close" title="Close">✕</button>
    </div>
    <div class="ecp-mc-grid">${
      Object.entries(MC_COLOURS).map(([k,v]) =>
        `<div class="ecp-mc-chip" style="background:${v}" title="§${k} ${v}" data-code="${k}"></div>`
      ).join('')
    }</div>`}`;

  // Absolute position inside the editorModal panel
  const panel = document.querySelector('#editorModal .modal-panel');
  if (!panel) { removeColourPopup(); return; }
  const panelRect = panel.getBoundingClientRect();

  const top  = (taRect.top - panelRect.top) + coords.top  - panel.scrollTop  + 24;
  let   left = (taRect.left- panelRect.left)+ coords.left - panel.scrollLeft;
  // Clamp so popup doesn't overflow right edge
  const popupW = 248;
  const maxLeft = panelRect.width - popupW - 12;
  left = Math.max(4, Math.min(left, maxLeft));

  popup.style.cssText = `position:absolute;top:${top}px;left:${left}px;z-index:9999`;
  panel.style.position = 'relative';
  panel.appendChild(popup);

  // Wire up events
  const picker  = popup.querySelector('#ecpPicker');
  const copyBtn = popup.querySelector('.ecp-copy');
  const closeBtn= popup.querySelector('.ecp-close');

  if (picker) {
    picker.addEventListener('input', () => {
      const newHex = picker.value;
      const newVal = ta.value.slice(0, token.start) + newHex + ta.value.slice(token.end);
      const newPos = token.start + newHex.length;
      ta.value = newVal;
      ta.selectionStart = ta.selectionEnd = newPos;
      token.end = newPos;
      popup.querySelector('.ecp-swatch').style.background = newHex;
      popup.querySelector('.ecp-swatch').style.color = contrastColour(newHex);
      popup.querySelector('.ecp-label').textContent = newHex.toUpperCase();
      popup.querySelector('.ecp-hex').textContent   = newHex.toUpperCase();
      popup.dataset.token = newHex;
      editorDirty = true;
      $('editorUnsaved')?.classList.remove('hidden');
    });
  }

  // MC grid: clicking a chip replaces the §x token with the new code
  popup.querySelectorAll('.ecp-mc-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const newCode  = chip.dataset.code;
      const newToken = token.raw[0] + newCode; // keep § or &
      const newVal   = ta.value.slice(0, token.start) + newToken + ta.value.slice(token.end);
      ta.value = newVal;
      token.raw = newToken;
      token.end = token.start + newToken.length;
      ta.selectionStart = ta.selectionEnd = token.end;
      editorDirty = true;
      $('editorUnsaved')?.classList.remove('hidden');
      // Update swatch to new colour
      const newHex = MC_COLOURS[newCode];
      const nc     = contrastColour(newHex);
      popup.querySelector('.ecp-swatch').style.background = newHex;
      popup.querySelector('.ecp-swatch').style.color       = nc;
      popup.querySelector('.ecp-label').textContent = `MC §${newCode}`;
      popup.querySelector('.ecp-hex').textContent   = newHex.toUpperCase();
      popup.querySelector('.ecp-copy').textContent  = `📋 ${newHex.toUpperCase()}`;
      popup.dataset.token = newToken;
    });
  });

  copyBtn?.addEventListener('click', () => copyToClipboard(hex.toUpperCase(), 'Colour'));
  closeBtn?.addEventListener('click', removeColourPopup);
}

// Approximate caret pixel position inside a textarea
// Uses a mirror div technique for accuracy
function getCaretCoords(ta, pos) {
  const div = document.createElement('div');
  const style = window.getComputedStyle(ta);
  ['fontFamily','fontSize','fontWeight','letterSpacing','lineHeight',
   'paddingTop','paddingLeft','paddingRight','borderTopWidth','borderLeftWidth',
   'tabSize','whiteSpace','wordWrap','overflowWrap'].forEach(p => div.style[p] = style[p]);
  div.style.cssText += ';position:fixed;visibility:hidden;top:0;left:0;pointer-events:none;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;';
  div.style.width = ta.clientWidth + 'px';

  const before = ta.value.slice(0, pos);
  div.textContent = before;
  const span = document.createElement('span');
  span.textContent = ta.value.slice(pos) || ' ';
  div.appendChild(span);
  document.body.appendChild(div);
  let rect, divRect;
  try {
    rect = span.getBoundingClientRect();
    divRect = div.getBoundingClientRect();
  } finally {
    document.body.removeChild(div); // always clean up
  }
  return { top: rect.top - divRect.top - ta.scrollTop, left: rect.left - divRect.left };
}

/* ═══════════════════════════════════════════════════════════════
   ERROR / REQUEST LOG MODAL
   ═══════════════════════════════════════════════════════════════ */
async function renderLogTable() {
  const tbody = $('logTableBody'); if (!tbody) return;
  const r = await fetch(`${API}/logs`);
  const d = await r.json().catch(() => ({ logs: [] }));
  const logs = d.logs || [];
  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted)">No logs yet</td></tr>`;
    return;
  }
  const srcColor = { beacon:'var(--accent)', rcon:'var(--warn)', query:'var(--success)', ping:'var(--text-soft)' };
  tbody.innerHTML = logs.map(l => {
    const sc  = l.ok === false ? 'var(--danger)' : l.ok ? 'var(--success)' : 'var(--text-muted)';
    const det = l.error
      ? `<span style="color:var(--danger)">${esc(l.error)}</span>`
      : esc((l.endpoint || l.url || '').slice(0, 80));
    return `<tr style="border-bottom:1px solid var(--line-soft)">
      <td style="padding:7px 10px;color:var(--text-muted)">${esc(l.ts?.slice(11,19) || '')}</td>
      <td style="padding:7px 6px;font-weight:600;color:${srcColor[l.source]||'var(--text-muted)'}">${esc(l.source||'—')}</td>
      <td style="padding:7px 6px;color:var(--text-soft)">${esc(l.method||'—')}</td>
      <td style="padding:7px 6px;color:${sc};font-weight:600">${l.status ?? '—'}</td>
      <td style="padding:7px 6px;color:var(--text-muted)">${l.ms != null ? l.ms + 'ms' : '—'}</td>
      <td style="padding:7px 6px;word-break:break-all;max-width:300px">${det}</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════
   MODAL HELPERS
   ═══════════════════════════════════════════════════════════════ */
function showModal(id) {
  const el = $(id); if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('visible');
}
function hideModal(id) {
  const el = $(id); if (!el) return;
  el.classList.remove('visible');
  el.classList.add('hidden');
}

/* ═══════════════════════════════════════════════════════════════
   HOME SERVER CARD STYLES  (injected once)
   ═══════════════════════════════════════════════════════════════ */
(function injectCardStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .home-srv-card {
      border-radius: var(--r-xl);
      padding: 18px;
      transition: box-shadow .2s;
    }
    .home-srv-card:hover {
      box-shadow: var(--frost-shadow), 0 0 0 1px var(--line-strong);
    }
  `;
  document.head.appendChild(style);
})();







/* ═══════════════════════════════════════════════════════════════
   THEME GRADIENT PICKER
   ═══════════════════════════════════════════════════════════════ */

let customGradient = null; // { c1, c2 }

function bindGradientPicker() {
  on('btnApplyGradient', 'click', () => {
    const c1 = $('gradientColor1')?.value || '#0e0410';
    const c2 = $('gradientColor2')?.value || '#240c20';
    customGradient = { c1, c2 };
    applyCustomGradient(c1, c2);
    saveGradient(c1, c2);
    toast('Gradient applied ✓', 'success', 1600);
  });
  on('btnResetGradient', 'click', () => {
    customGradient = null;
    document.documentElement.style.removeProperty('--bg-deep');
    document.documentElement.style.removeProperty('--bg-mid');
    document.querySelector('.page-backdrop')?.style.removeProperty('background');
    saveGradient(null, null);
    toast('Gradient reset to theme default', 'info', 1600);
  });
}

function applyCustomGradient(c1, c2) {
  if (!c1 || !c2) return;
  const root = document.documentElement;
  root.style.setProperty('--bg-deep', c1);
  root.style.setProperty('--bg-mid', c2 + 'aa');
  // Apply to page-backdrop as inline gradient
  const backdrop = document.querySelector('.page-backdrop');
  if (backdrop) backdrop.style.background = `linear-gradient(145deg, ${c1} 0%, ${c2} 100%)`;
  // Update swatch inputs to match
  const g1 = $('gradientColor1'); if (g1) g1.value = c1;
  const g2 = $('gradientColor2'); if (g2) g2.value = c2;
}

async function saveGradient(c1, c2) {
  const cfg = await window.electronAPI?.getSettings() ?? {};
  await window.electronAPI?.saveSettings({ ...cfg, customGradient: c1 && c2 ? { c1, c2 } : null });
}

async function loadGradient() {
  const cfg = await window.electronAPI?.getSettings() ?? {};
  if (cfg.customGradient?.c1 && cfg.customGradient?.c2) {
    customGradient = cfg.customGradient;
    applyCustomGradient(cfg.customGradient.c1, cfg.customGradient.c2);
  }
}

/* ── Init all new systems in DOMContentLoaded ───────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadPterodactylSettings();
  bindPterodactylUI();
  bindGradientPicker();
  loadGradient();
  // Hook Pterodactyl into provider toggle

});


/* ═══════════════════════════════════════════════════════════════
   RADIAL COMMAND MENU  —  Ctrl+K
   8 items arranged in a circle around a centre node
   ═══════════════════════════════════════════════════════════════ */

const RADIAL_ITEMS = [
  { id: 'overview',  icon: 'https://img.icons8.com/fluency/48/server.png',        label: 'Overview', tab: 'overview'   },
  { id: 'console',   icon: 'https://img.icons8.com/fluency/48/console.png',       label: 'Console',  tab: 'console'    },
  { id: 'files',     icon: 'https://img.icons8.com/fluency/48/folder.png',        label: 'Files',    tab: 'files'      },
  { id: 'players',   icon: 'https://img.icons8.com/fluency/48/people.png',        label: 'Players',  tab: 'minecraft'  },
  { id: 'start',     icon: 'https://img.icons8.com/fluency/48/play-button.png',   label: 'Start',    action: 'start'   },
  { id: 'stop',      icon: 'https://img.icons8.com/fluency/48/stop-squared.png',  label: 'Stop',     action: 'stop'    },
  { id: 'restart',   icon: 'https://img.icons8.com/fluency/48/restart.png',       label: 'Restart',  action: 'restart' },
  { id: 'settings',  icon: 'https://img.icons8.com/fluency/48/settings.png',      label: 'Settings', tab: 'settings'   },
];

/* ═══════════════════════════════════════════════════════════════
   SPLASH SCREEN  —  first-launch loading animation
   ═══════════════════════════════════════════════════════════════ */

function initSplash() {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;

  const prog = document.getElementById('splashProgress');
  let pct = 0;
  const steps = [
    { to: 30, ms: 200 },  // initial load
    { to: 60, ms: 350 },  // JS init
    { to: 85, ms: 250 },  // data load
    { to: 100, ms: 200 }, // done
  ];

  function runStep(i) {
    if (i >= steps.length) {
      // Done — fade out
      setTimeout(() => {
        splash.classList.add('out');
        setTimeout(() => splash.remove(), 520);
      }, 120);
      return;
    }
    const { to, ms } = steps[i];
    pct = to;
    if (prog) prog.style.width = pct + '%';
    setTimeout(() => runStep(i + 1), ms);
  }
  runStep(0);
}

/* ═══════════════════════════════════════════════════════════════
   PETAL / FLOWER RADIAL MENU  —  Ctrl+K
   ═══════════════════════════════════════════════════════════════ */

// Icon URLs for each action (Icons8 Fluency pack)
const PETAL_ITEMS = [
  { id:'overview',  label:'Overview', icon:'https://img.icons8.com/fluency/48/server.png',        tab:'overview',  cls:'' },
  { id:'terminal',  label:'Terminal', icon:'https://img.icons8.com/fluency/48/console.png',       tab:'terminal',  cls:'' },
  { id:'files',     label:'Files',    icon:'https://img.icons8.com/fluency/48/folder.png',         tab:'files',     cls:'' },
  { id:'players',   label:'Players',  icon:'https://img.icons8.com/fluency/48/user.png',           tab:'minecraft', cls:'' },
  { id:'start',     label:'Start',    icon:'https://img.icons8.com/fluency/48/play-button.png',    action:'start',  cls:'power-item' },
  { id:'stop',      label:'Stop',     icon:'https://img.icons8.com/fluency/48/stop-squared.png',   action:'stop',   cls:'power-item' },
  { id:'restart',   label:'Restart',  icon:'https://img.icons8.com/fluency/48/restart.png',        action:'restart',cls:'power-item' },
  { id:'settings',  label:'Settings', icon:'https://img.icons8.com/fluency/48/settings.png',       tab:'settings',  cls:'' },
];

let radialOpen = false;

function openRadialMenu() {
  if (!activeId) { toast('Select a server first', 'info', 1600); return; }
  const backdrop = document.getElementById('radialMenu');
  const flower   = document.getElementById('petalFlower');
  if (!backdrop || !flower) return;

  // Remove old petal items (keep center)
  flower.querySelectorAll('.petal-item, .petal-bg').forEach(el => el.remove());

  const count  = PETAL_ITEMS.length;
  const radius = 138; // px from centre of the 360px container
  const cx = 180, cy = 180; // centre

  PETAL_ITEMS.forEach((item, i) => {
    const angle = (2 * Math.PI * i / count) - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);

    // Background petal shape (decorative, between centre and item)
    const bg = document.createElement('div');
    bg.className = 'petal-bg';
    const bgMidX = cx + (radius * .55) * Math.cos(angle);
    const bgMidY = cy + (radius * .55) * Math.sin(angle);
    const deg = (angle * 180 / Math.PI) + 90;
    bg.style.cssText = `left:${bgMidX}px;top:${bgMidY}px;transform:translate(-50%,-50%) rotate(${deg}deg);`;
    flower.appendChild(bg);

    // Action item
    const btn = document.createElement('button');
    btn.className = `petal-item ${item.cls}`;
    btn.style.cssText = `left:${x}px;top:${y}px;transform:translate(-50%,-50%);animation-delay:${i*.028}s`;
    btn.innerHTML = `<img src="${item.icon}" class="petal-item-icon" alt=""/><span class="petal-item-label">${item.label}</span>`;
    btn.setAttribute('title', item.label);

    btn.addEventListener('click', () => {
      closeRadialMenu();
      if (item.tab)    showTab(item.tab);
      else if (item.action) sendPowerAction(item.action);
    });
    flower.appendChild(btn);
  });

  backdrop.classList.remove('hidden');
  radialOpen = true;

  // Theme-aware centre icon
  const ci = document.getElementById('petalCenterIcon');
  if (ci) ci.src = 'https://img.icons8.com/fluency/48/lightning-bolt.png';
}

function closeRadialMenu() {
  document.getElementById('radialMenu')?.classList.add('hidden');
  radialOpen = false;
}

async function sendPowerAction(signal) {
  const r = await apiFetch(`/servers/${activeId}/power`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: signal }),
  });
  if (r.ok || r.status === 204) toast(`${signal} sent ✓`, 'success', 1800);
  else toast('Power action failed: ' + (r.data?.error || r.status), 'error');
  setTimeout(() => loadServerData(activeId), 1800);
}

/* ═══════════════════════════════════════════════════════════════
   QUICK SERVER SWITCHER  —  Ctrl+F
   ═══════════════════════════════════════════════════════════════ */

let _qsOpen = false, _qsIdx = 0, _qsFiltered = [];

function openQuickSwitcher() {
  const bd = document.getElementById('quickSwitcher');
  const inp = document.getElementById('qsInput');
  if (!bd || !inp) return;
  bd.classList.remove('hidden');
  _qsOpen = true;
  inp.value = '';
  inp.focus();
  _renderQs('');
}

function closeQuickSwitcher() {
  document.getElementById('quickSwitcher')?.classList.add('hidden');
  _qsOpen = false; _qsIdx = 0; _qsFiltered = [];
}

function _renderQs(query) {
  const q = query.toLowerCase().trim();
  _qsFiltered = servers.filter(s =>
    !q || (s.name||'').toLowerCase().includes(q) || (s.id||'').toLowerCase().includes(q)
  );
  _qsIdx = 0;
  const res = document.getElementById('qsResults');
  if (!res) return;
  if (!_qsFiltered.length) {
    res.innerHTML = '<div class="qs-empty">No servers match</div>';
    return;
  }
  res.innerHTML = _qsFiltered.map((s, i) => `
    <div class="qs-item${i===0?' selected':''}" data-idx="${i}">
      <div class="qs-item-icon">
        <img src="https://img.icons8.com/fluency/48/server.png" alt=""/>
      </div>
      <div>
        <div class="qs-item-name">${esc(s.name || s.id)}</div>
        <div class="qs-item-meta">🟠 Beacon · ${esc((s.id||'').slice(0,8))}…</div>
      </div>
      ${s.id === activeId ? '<span class="status-pill ok" style="margin-left:auto;font-size:9.5px;padding:2px 7px">Active</span>' : ''}
    </div>`).join('');
  res.querySelectorAll('.qs-item').forEach(el => {
    el.addEventListener('click', () => _pickQs(parseInt(el.dataset.idx)));
  });
}

function _pickQs(idx) {
  const srv = _qsFiltered[idx];
  if (!srv) return;
  closeQuickSwitcher();
  selectServer(srv.id);
}

function _qsMove(delta) {
  if (!_qsFiltered.length) return;
  _qsIdx = (_qsIdx + delta + _qsFiltered.length) % _qsFiltered.length;
  document.querySelectorAll('.qs-item').forEach((el,i) => el.classList.toggle('selected', i===_qsIdx));
  document.querySelectorAll('.qs-item')[_qsIdx]?.scrollIntoView({block:'nearest'});
}

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  // Don't fire inside input fields
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    radialOpen ? closeRadialMenu() : openRadialMenu();
    return;
  }
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    _qsOpen ? closeQuickSwitcher() : openQuickSwitcher();
    return;
  }
  if (_qsOpen) {
    if (e.key === 'Escape')    { closeQuickSwitcher(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); _qsMove(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); _qsMove(-1); return; }
    if (e.key === 'Enter')     { e.preventDefault(); _pickQs(_qsIdx); return; }
  }
  if (radialOpen && e.key === 'Escape') { closeRadialMenu(); return; }
});

/* ═══════════════════════════════════════════════════════════════
   TERMINAL TAB  —  replaces old renderConsoleTab for Beacon
   ═══════════════════════════════════════════════════════════════ */
function renderConsoleTab() { renderTerminalTab(); } // alias

function renderTerminalTab() {
  const pane = $('serverContent'); if (!pane) return;
  pane.innerHTML = `
    <div class="terminal-wrap">
      <div class="terminal-header">
        <img src="https://img.icons8.com/fluency/48/console.png" class="icon-18" alt=""/>
        <span class="terminal-title">Terminal</span>
        <div class="terminal-status">
          <span class="status-pill warn" id="wsStatus" style="font-size:10.5px;padding:3px 9px">Offline</span>
        </div>
        <button class="topbar-btn" id="btnClearConsole" style="font-size:11.5px;padding:5px 11px;margin-left:auto">
          <img src="https://img.icons8.com/fluency/48/clear-symbol.png" class="icon-14" style="width:14px;height:14px;margin-right:4px;" alt=""/> Clear
        </button>
      </div>
      <div class="terminal-body" id="consoleOutput"></div>
      <div class="terminal-input-row">
        <span class="terminal-prompt">❯</span>
        <input class="terminal-cmd" id="cmdInput" type="text"
          placeholder="Enter command… (↑↓ history)" autocomplete="off"/>
      </div>
    </div>`;

  on('btnClearConsole', 'click', () => {
    const o = $('consoleOutput'); if (o) o.innerHTML = ''; lastLogLen = 0;
  });
  on('cmdInput', 'keydown', e => {
    if (e.key === 'Enter') sendBeaconCommand();
    else if (e.key === 'ArrowUp')   { e.preventDefault(); historyUp(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); historyDown(); }
  });
  startLogPoller();
}

/* ═══════════════════════════════════════════════════════════════
   OVERVIEW TAB  —  redesigned with hero, power row, stat cards
   ═══════════════════════════════════════════════════════════════ */
function renderOverviewTab() {
  const pane = $('serverContent'); if (!pane) return;
  const d   = lastServerData || {};
  const srv = servers.find(s => s.id === activeId);
  const status = d.status || '—';
  const scls   = statusCls(status);
  const ip     = d.ip   ? `${d.ip}:${d.port || 25565}` : null;
  const cpuPct = typeof d.cpu_percent === 'number' ? d.cpu_percent.toFixed(1) : null;
  const memMB  = typeof d.memory_bytes === 'number' ? (d.memory_bytes/1024/1024).toFixed(0) : null;

  pane.innerHTML = `
    <!-- Hero row -->
    <div class="ov-hero">
      <div class="ov-icon">
        <img src="https://img.icons8.com/fluency/48/server.png" alt=""/>
      </div>
      <div class="ov-hero-info">
        <div class="ov-name">${esc(srv?.name || d.name || activeId)}</div>
        ${ip ? `<div class="ov-addr copyable" onclick="copyToClipboard('${esc(ip)}','Address')" title="Click to copy">${esc(ip)}</div>` : ''}
        <div class="ov-status-row">
          <span class="status-pill ${scls}" style="font-size:10.5px">${esc(status)}</span>
          ${d.egg ? `<span class="muted small">${esc(d.egg)}</span>` : ''}
          ${d.description ? `<span class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${esc(d.description)}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- Power bar -->
    <div class="ov-power-row">
      <span class="ov-power-label">Power</span>
      <button class="ov-power-btn primary" data-action="start">
        <img src="https://img.icons8.com/fluency/48/play-button.png" alt=""/> Start
      </button>
      <button class="ov-power-btn" data-action="restart">
        <img src="https://img.icons8.com/fluency/48/restart.png" alt=""/> Restart
      </button>
      <button class="ov-power-btn" data-action="stop">
        <img src="https://img.icons8.com/fluency/48/stop-squared.png" alt=""/> Stop
      </button>
      <button class="ov-power-btn" data-action="kill" style="color:var(--danger);border-color:rgba(230,80,100,.3)">
        <img src="https://img.icons8.com/fluency/48/delete-forever.png" alt="" style="opacity:.75"/> Kill
      </button>
      <button class="topbar-btn" id="btnPteroRefresh" style="margin-left:auto;font-size:11.5px;padding:5px 10px">
        <img src="https://img.icons8.com/fluency/48/synchronize.png" class="icon-14" style="width:14px;height:14px;" alt=""/>
      </button>
    </div>

    <!-- Stats grid -->
    <div class="ov-stats-grid">
      ${cpuPct !== null ? `
      <div class="ov-stat">
        <div class="ov-stat-header"><img src="https://img.icons8.com/fluency/48/processor.png" alt=""/><span class="ov-stat-label">CPU</span></div>
        <div class="ov-stat-value">${cpuPct}%</div>
        <div class="gauge-wrap"><div class="gauge-bar${parseFloat(cpuPct)>80?' gauge-danger':parseFloat(cpuPct)>60?' gauge-warn':''}" style="width:${Math.min(parseFloat(cpuPct),100)}%"></div></div>
      </div>` : ''}
      ${memMB !== null ? `
      <div class="ov-stat">
        <div class="ov-stat-header"><img src="https://img.icons8.com/fluency/48/memory-slot.png" alt=""/><span class="ov-stat-label">RAM</span></div>
        <div class="ov-stat-value">${memMB} MB</div>
        ${d.limits?.memory > 0 ? `<div class="ov-stat-sub">of ${d.limits.memory} MB</div><div class="gauge-wrap"><div class="gauge-bar" style="width:${Math.min(parseFloat(memMB)/d.limits.memory*100,100).toFixed(1)}%"></div></div>` : ''}
      </div>` : ''}
      ${d.players !== undefined ? `
      <div class="ov-stat">
        <div class="ov-stat-header"><img src="https://img.icons8.com/fluency/48/user.png" alt=""/><span class="ov-stat-label">Players</span></div>
        <div class="ov-stat-value">${d.players ?? '—'}</div>
        ${d.max_players ? `<div class="ov-stat-sub">of ${d.max_players}</div>` : ''}
      </div>` : ''}
      <div class="ov-stat">
        <div class="ov-stat-header"><img src="https://img.icons8.com/fluency/48/network.png" alt=""/><span class="ov-stat-label">Ping</span></div>
        <div class="ov-ping-row" style="gap:6px;margin-top:4px">
          <input type="text" id="ovPingHost" value="${esc(ip||'')}" placeholder="host:port" style="font-size:11px;padding:5px 8px;flex:1;min-width:0"/>
          <button class="topbar-btn" id="btnOvPing" style="font-size:11.5px;padding:5px 10px">Ping</button>
        </div>
        <div id="ovPingResult" class="muted small" style="font-size:11.5px;margin-top:4px"></div>
        <input type="hidden" id="ovPingPort" value="${esc(String(d.port||25565))}"/>
      </div>
    </div>

    <!-- Server details -->
    <div class="kv-card" style="margin-top:0">
      <div class="kv-stack">
        <div class="kv-item"><span class="kv-label">UUID</span><span class="kv-value mono copyable" onclick="copyToClipboard('${esc(activeId||'')}','UUID')" title="Copy" style="font-size:11px">${esc(activeId||'—')}</span></div>
        ${d.node   ? `<div class="kv-item"><span class="kv-label">Node</span><span class="kv-value">${esc(d.node)}</span></div>` : ''}
        ${d.limits?.memory ? `<div class="kv-item"><span class="kv-label">RAM limit</span><span class="kv-value">${d.limits.memory} MB</span></div>` : ''}
        ${d.limits?.disk   ? `<div class="kv-item"><span class="kv-label">Disk limit</span><span class="kv-value">${d.limits.disk} MB</span></div>` : ''}
      </div>
    </div>`;

  // Power buttons
  pane.querySelectorAll('.ov-power-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await sendPowerAction(btn.dataset.action);
      setTimeout(() => { btn.disabled = false; loadServerData(activeId); }, 2000);
    });
  });
  on('btnPteroRefresh', 'click', () => loadServerData(activeId));
  on('btnOvPing', 'click', runOvPing);
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS TAB  —  icon-rich redesign
   ═══════════════════════════════════════════════════════════════ */
const _origRenderServerSettingsTab = renderServerSettingsTab;
function renderServerSettingsTab() {
  const pane = $('serverContent'); if (!pane) return;
  const srv = servers.find(s => s.id === activeId);
  const d   = lastServerData || {};

  pane.innerHTML = `
    <div class="settings-grid">
      <div class="kv-card">
        <div class="section-head compact">
          <div style="display:flex;align-items:center;gap:8px">
            <img src="https://img.icons8.com/fluency/48/server.png" class="icon-18" alt=""/>
            <div class="section-title">Server Info</div>
          </div>
          <span class="provider-badge beacon">Beacon</span>
        </div>
        <div class="kv-stack" style="margin-top:10px">
          <div class="kv-item"><span class="kv-label">Name</span><span class="kv-value">${esc(srv?.name||'—')}</span></div>
          ${d.egg    ? `<div class="kv-item"><span class="kv-label">Game</span><span class="kv-value">${esc(d.egg)}</span></div>` : ''}
          ${d.status ? `<div class="kv-item"><span class="kv-label">Status</span><span class="kv-value"><span class="status-pill ${statusCls(d.status)}" style="font-size:10px;padding:2px 7px">${esc(d.status)}</span></span></div>` : ''}
          ${d.ip     ? `<div class="kv-item"><span class="kv-label">Address</span><span class="kv-value mono copyable" onclick="copyToClipboard('${esc(d.ip+':'+(d.port||25565))}','Address')" title="Copy">${esc(d.ip)}:${esc(String(d.port||25565))}</span></div>` : ''}
          <div class="kv-item"><span class="kv-label">UUID</span><span class="kv-value mono copyable" onclick="copyToClipboard('${esc(activeId||'')}','UUID')" title="Copy" style="font-size:10.5px">${esc(activeId||'—')}</span></div>
        </div>
      </div>
      <div class="kv-card">
        <div class="section-head compact">
          <div style="display:flex;align-items:center;gap:8px">
            <img src="https://img.icons8.com/fluency/48/settings.png" class="icon-18" alt=""/>
            <div class="section-title">Manage</div>
          </div>
        </div>
        <div class="kv-stack" style="margin-top:10px;gap:8px">
          <button class="icon-btn" id="btnOpenBackups" style="width:100%;justify-content:flex-start;gap:8px;padding:9px 12px">
            <img src="https://img.icons8.com/fluency/48/folder.png" class="icon-16" alt=""/> Open Backups Folder
          </button>
          <button class="icon-btn" id="btnRenameServer" style="width:100%;justify-content:flex-start;gap:8px;padding:9px 12px">
            <img src="https://img.icons8.com/fluency/48/edit.png" class="icon-16" alt=""/> Rename Server
          </button>
          <button class="danger-btn" id="btnDeleteServer" style="width:100%;justify-content:flex-start;gap:8px;padding:9px 12px">
            <img src="https://img.icons8.com/fluency/48/trash.png" class="icon-16" style="opacity:.8" alt=""/> Remove from Panels
          </button>
        </div>
      </div>
    </div>`;

  on('btnOpenBackups', 'click', () => {
    showTab('files');
    setTimeout(() => {
      const s = getSftp(activeId);
      if (s.connected) listDir('/backups').catch(() => listDir('/'));
      else toast('Connect SFTP first','info');
    }, 50);
  });
  on('btnRenameServer', 'click', () => showServerModal(activeId));
  on('btnDeleteServer', 'click', () => removeServer(activeId, {
    confirmText: 'Remove from Panels? (real server untouched)'
  }));
}

/* ═══════════════════════════════════════════════════════════════
   LOG TABLE RENDERER  —  improved layout
   ═══════════════════════════════════════════════════════════════ */
const _origRenderLogTable = renderLogTable;
function renderLogTable() {
  const body = $('logTableBody'); if (!body) return;
  const logs = (window._requestLogs || []).slice().reverse();
  if (!logs.length) {
    body.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">No requests yet</td></tr>`;
    return;
  }
  body.innerHTML = logs.map(l => {
    const ok = l.ok !== false;
    const cls = !l.ok ? 'log-row-err' : l.status >= 300 ? 'log-row-warn' : 'log-row-ok';
    const t = l.time ? new Date(l.time).toLocaleTimeString('en-GB',{hour12:false}) : '—';
    const ms = l.ms ? l.ms + 'ms' : '—';
    const src = l.source || 'beacon';
    return `<tr class="${cls}">
      <td style="color:var(--text-muted)">${t}</td>
      <td><span class="log-source-badge ${src}">${esc(src)}</span></td>
      <td style="color:var(--text-muted)">${esc(l.method||'GET')}</td>
      <td>${esc(String(l.status||'—'))}</td>
      <td style="color:var(--text-muted)">${ms}</td>
      <td style="font-size:11px;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${esc(l.url||l.error||'')}">
        ${esc(l.endpoint || l.url || l.error || '—')}
      </td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════
   INIT — wire new systems on DOMContentLoaded
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Splash screen
  initSplash();

  // Quick switcher input
  const qsInp = document.getElementById('qsInput');
  if (qsInp) qsInp.addEventListener('input', e => _renderQs(e.target.value));

  // Close overlays on backdrop click
  document.getElementById('radialMenu')?.addEventListener('click', e => {
    if (e.target === document.getElementById('radialMenu')) closeRadialMenu();
  });
  document.getElementById('quickSwitcher')?.addEventListener('click', e => {
    if (e.target === document.getElementById('quickSwitcher')) closeQuickSwitcher();
  });

  // Cred tab switching in settings
  document.querySelectorAll('.cred-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cred-tab').forEach(t => t.classList.remove('active'));
      ['credPanelBeacon'].forEach(id => $(id)?.classList.remove('hidden'));
      tab.classList.add('active');
    });
  });
});
