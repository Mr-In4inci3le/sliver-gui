const App = () => window.go.main.App;
let selectedConfigPath = null, pollTimer = null, activeCtxAgent = null;
let lastConfigPath = null, reconnectTimer = null, reconnecting = false;
let teamserverLabel = 'teamserver';
let allSessions = [], allBeacons = [];
// Graph interaction state (persists across refreshes).
const graphPos = {};                 // agent id -> {x,y} in graph coords
let graphView = { tx: 0, ty: 0, scale: 1 };
let graphCenter = null;
const openTabs = {};
const eventLog = [];
const EVENT_MAX = 500;
const notesMap = {};          // agent id -> operator notes (in-memory, cleared on disconnect)
const integrityMap = {};      // agent id -> real integrity level from getprivs (System/High/Medium/Low)
let activeInteractId = null;  // currently focused agent tab

// ── Utils ──────────────────────────────────────────────────────────────────
function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toast(type, msg, dur=3000) {
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), dur);
}

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
  const ver = await App().GetVersion().catch(() => null);
  if (ver) document.getElementById('server-version').textContent = `v${ver.major}.${ver.minor}.${ver.patch}`;
  wireEventStream();
  pinServerConsole();     // Server console docked by default
  pinEvents();            // Event Log docked in the console by default
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
    tr.innerHTML = `<td class="${typeCls}">${kind.toUpperCase()}</td><td>${esc(o.name||o.id.slice(0,8))}</td><td>${esc(o.hostname)}</td>${userCell(o)}<td>${esc(o.os)}/${esc(o.arch)}</td><td>${o.pid}</td><td>${esc(o.transport)}</td><td>${esc(o.remoteAddress)}</td><td>${esc(o.lastCheckin)}</td><td class="${o.isDead?'status-dead':'status-alive'}">${o.isDead?'DEAD':'ALIVE'}</td>`;
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
function renderGraph() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  const nodes = [
    ...allSessions.map(s => ({ kind:'session', obj:s })),
    ...allBeacons.map(b => ({ kind:'beacon', obj:b })),
  ];
  const W = svg.clientWidth || 900, H = svg.clientHeight || 460;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!graphCenter) graphCenter = { x: W/2, y: H/2 };
  const cx = graphCenter.x, cy = graphCenter.y, baseR = Math.min(W, H)/2 - 78;

  // Assign a persistent position to each node (ring layout for new ones).
  const n = nodes.length;
  nodes.forEach((nd, i) => {
    if (!graphPos[nd.obj.id]) {
      const ring = n > 9 && i%2 ? 0.62 : 1, r = baseR * ring;
      const a = (i/Math.max(n,1))*2*Math.PI - Math.PI/2;
      graphPos[nd.obj.id] = { x: cx + r*Math.cos(a), y: cy + r*Math.sin(a) };
    }
  });

  // Straight edges (do not bend).
  const edgePath = (x1,y1,x2,y2) => `M${x1} ${y1} L${x2} ${y2}`;

  let html = `<g id="g-root" transform="translate(${graphView.tx},${graphView.ty}) scale(${graphView.scale})">`;

  // Edges (straight; dashed for beacons; red for privileged agents)
  nodes.forEach(nd => {
    const p = graphPos[nd.obj.id], dead = nd.obj.isDead, priv = isPrivileged(nd.obj);
    const cls = `gedge${nd.kind==='beacon'?' beacon':''}${priv&&!dead?' priv':''}${dead?' dead':''}`;
    html += `<path id="ge-${nd.obj.id}" d="${edgePath(cx,cy,p.x,p.y)}" class="${cls}" fill="none"/>`;
  });

  // Teamserver core — C2 icon
  html += `<image href="./icons/C2.png" x="${cx-30}" y="${cy-30}" width="60" height="60" pointer-events="none"/>`;
  html += `<text x="${cx}" y="${cy+48}" text-anchor="middle" fill="var(--accent)" font-size="10" font-weight="bold" font-family="var(--font)" pointer-events="none">${esc(teamserverLabel)}</text>`;

  // Agent nodes — icon from the icons folder; grey filter when dead.
  nodes.forEach(nd => {
    const o = nd.obj, p = graphPos[o.id];
    const dead = o.isDead, priv = isPrivileged(o);
    const labelColor = dead ? 'var(--muted)' : 'var(--text)';
    html += `<g class="gnode${dead?' dead':''}" data-id="${esc(o.id)}" transform="translate(${p.x},${p.y})" style="cursor:grab">`;
    // Transparent hit area so the group receives drag/dblclick (images below are inert).
    html += `<rect x="-28" y="-32" width="56" height="86" fill="transparent"/>`;
    html += `<image href="${osIconHref(o.os, priv, dead)}" x="-26" y="-26" width="52" height="52" pointer-events="none"/>`;
    html += `<text y="38" text-anchor="middle" fill="${labelColor}" font-size="10" font-weight="bold" font-family="var(--font)" pointer-events="none">${esc(o.hostname||o.id.slice(0,6))}</text>`;
    html += `<text y="50" text-anchor="middle" fill="var(--muted)" font-size="8.5" font-family="var(--mono)" pointer-events="none">${esc(shortUser(o.username))} · ${nd.kind}</text>`;
    if (priv && !dead) html += `<text y="-30" text-anchor="middle" fill="var(--accent)" font-size="8" font-weight="bold" font-family="var(--mono)" pointer-events="none">★ ${integrityLabel(o) || 'PRIV'}</text>`;
    if (dead) html += `<text y="-30" text-anchor="middle" fill="var(--muted)" font-size="8" font-weight="bold" font-family="var(--mono)" pointer-events="none">DEAD</text>`;
    html += `</g>`;
  });

  html += `</g>`;
  svg.innerHTML = html;

  // dblclick on a live node opens its console.
  const byId = {}; nodes.forEach(nd => byId[nd.obj.id] = nd);
  svg.querySelectorAll('.gnode').forEach(el => {
    const nd = byId[el.dataset.id];
    if (nd && !nd.obj.isDead) el.addEventListener('dblclick', () => openInteract(nd.kind, nd.obj));
  });

  setupGraphInteraction(svg, cx, cy, edgePath);
}

// setupGraphInteraction wires drag (nodes), pan (background) and wheel zoom.
// Attached once per svg element; survives innerHTML re-renders.
function setupGraphInteraction(svg, cx, cy, edgePath) {
  if (svg._wired) { svg._cx = cx; svg._cy = cy; svg._edgePath = edgePath; return; }
  svg._wired = true; svg._cx = cx; svg._cy = cy; svg._edgePath = edgePath;
  let mode = null, dragId = null, startX = 0, startY = 0, origX = 0, origY = 0;

  const applyView = () => {
    const root = document.getElementById('g-root');
    if (root) root.setAttribute('transform', `translate(${graphView.tx},${graphView.ty}) scale(${graphView.scale})`);
  };

  svg.addEventListener('mousedown', e => {
    const nodeEl = e.target.closest('.gnode');
    startX = e.clientX; startY = e.clientY;
    if (nodeEl) {
      mode = 'node'; dragId = nodeEl.dataset.id;
      origX = graphPos[dragId].x; origY = graphPos[dragId].y;
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
      graphPos[dragId] = { x: nx, y: ny };
      const g = svg.querySelector(`.gnode[data-id="${CSS.escape(dragId)}"]`);
      if (g) g.setAttribute('transform', `translate(${nx},${ny})`);
      const edge = document.getElementById(`ge-${dragId}`);
      if (edge) edge.setAttribute('d', svg._edgePath(svg._cx, svg._cy, nx, ny));
    } else if (mode === 'pan') {
      graphView.tx = origX + (e.clientX - startX);
      graphView.ty = origY + (e.clientY - startY);
      applyView();
    }
  });

  document.addEventListener('mouseup', () => {
    if (mode === 'pan') svg.style.cursor = '';
    if (mode === 'node') { const g = svg.querySelector(`.gnode[data-id="${CSS.escape(dragId)}"]`); if (g) g.style.cursor = 'grab'; }
    mode = null; dragId = null;
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    const ns = Math.min(3, Math.max(0.3, graphView.scale * factor));
    // Keep the point under the cursor fixed while zooming.
    graphView.tx = mx - (mx - graphView.tx) * (ns/graphView.scale);
    graphView.ty = my - (my - graphView.ty) * (ns/graphView.scale);
    graphView.scale = ns;
    applyView();
  }, { passive: false });
}

// Reset the graph layout/view to its default.
function resetGraph() {
  for (const k in graphPos) delete graphPos[k];
  graphView = { tx: 0, ty: 0, scale: 1 };
  graphCenter = null;
  renderGraph();
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
  const label = integrityLabel(obj) || r.integrity;
  toast(isPrivileged(obj) ? 'ok' : 'info', `${obj.hostname}: ${label} integrity`);
  renderTable();
  if (!document.getElementById('graph-view').classList.contains('hidden')) renderGraph();
});
document.getElementById('ctx-rename').addEventListener('click', async () => {
  if (!activeCtxAgent || activeCtxAgent.kind !== 'session') return;
  const n = prompt('New name:'); if (!n) return;
  await App().RenameSession(activeCtxAgent.obj.id, n).catch(alert); refreshAgents();
});
document.getElementById('ctx-kill').addEventListener('click', async () => {
  if (!activeCtxAgent) return;
  if (!confirm('Kill this agent?')) return;
  if (activeCtxAgent.kind === 'session') await App().KillSession(activeCtxAgent.obj.id).catch(alert);
  else await App().KillBeacon(activeCtxAgent.obj.id).catch(alert);
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
  panel.innerHTML = `<div class="console-out" id="cout-${id}"><span class="info">${esc(helpText)}</span></div><div class="console-in"><span class="console-prompt">${esc(promptStr)} </span><input class="console-input" id="cinp-${id}" placeholder="type a command..." autocomplete="off"/></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  // Wire input
  const inp = document.getElementById(`cinp-${id}`);
  const hist = []; let hIdx = -1;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { runAgentCmd(kind, id, inp, hist); hIdx = -1; }
    if (e.key === 'ArrowUp') { if (hIdx < hist.length-1) { hIdx++; inp.value = hist[hIdx]; } e.preventDefault(); }
    if (e.key === 'ArrowDown') { if (hIdx > 0) { hIdx--; inp.value = hist[hIdx]; } else { hIdx=-1; inp.value=''; } e.preventDefault(); }
  });
  activateTab(id);
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
  execute <path> [args]      Run a program directly (no shell wrapper)
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
  reg query|read|write ...   Windows registry (HKLM/HKCU/...)
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
  services                   List Windows services

Beacon only:
  tasks                      Show the beacon task queue
  reconfig <interval> <jitter>   Change the beacon check-in interval (seconds)
  interactive                Open an interactive session from this beacon
  (all commands are queued and run on next check-in)
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
  if (cmd === 'shell' && !args.length) return appendOut(id, "usage: shell <command>  — the GUI has no interactive PTY; pass the command inline, e.g. shell whoami", 'info');

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
      const svcs = await App().ListServices(id);
      let out = 'STATUS      NAME                           DISPLAY\n';
      svcs.forEach(s => { out += `${(s.status||'').padEnd(12)}${(s.name||'').slice(0,30).padEnd(31)}${s.displayName||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
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
      return appendOut(id, 'usage: reg query|read|write <HIVE> <path> [key] [value]', 'err');
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
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') hideModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModal(); });

// ── Operator notes (per agent, in-memory) ───────────────────────────────────
document.getElementById('notes-btn').addEventListener('click', openNotes);
function openNotes() {
  if (!activeInteractId) return toast('info', 'Open an agent first (double-click a session/beacon)');
  const t = openTabs[activeInteractId], o = t && t.obj;
  const title = `Notes — ${o ? (o.hostname || o.id.slice(0,8)) : activeInteractId}`;
  openViewPanel('_notes', title,
    `<p style="color:var(--muted);font-size:12px;margin-bottom:8px">Notes are per-agent and kept for this session (cleared on disconnect). Auto-saved as you type.</p>
     <textarea id="notes-area" class="notes-area" placeholder="Credentials found, next steps, IOCs, todo...">${esc(notesMap[activeInteractId] || '')}</textarea>`);
  const ta = document.getElementById('notes-area');
  ta.addEventListener('input', () => { notesMap[activeInteractId] = ta.value; markNoted(activeInteractId); });
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
  loot [rm <id>]           list / remove loot
  hosts [rm <id>]          list / remove hosts DB entries
  creds [add <u> <p> | rm <id>]   list / add / remove credentials
  builds                   list implant builds
  regenerate <name>        re-download a previous build
  profiles                 list implant profiles
  websites [rm <name>]     list / remove hosted websites
  canaries                 list DNS canaries (tripwires)
  stager <host> <port> <profile>   start a TCP stager listener
  use <id-prefix>          interact with a session/beacon
  c2profiles               list HTTP C2 profiles
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
      case 'hosts': {
        if (args[0] === 'rm') { await App().DeleteHost(args[1]); return appendServer(`[+] host ${args[1]} removed`, 'out'); }
        const h = await App().ListHosts(); if (!h.length) return appendServer('no hosts in the database', 'info');
        let o = 'HOSTNAME             OS                             UUID\n';
        h.forEach(x => o += `${(x.hostname||'').slice(0,20).padEnd(21)}${(x.os||'').slice(0,30).padEnd(31)}${(x.uuid||'').slice(0,12)}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'creds': {
        if (args[0] === 'add') { if (args.length < 3) return appendServer('usage: creds add <username> <password>', 'err'); await App().AddCred(args[1], args[2], ''); return appendServer('[+] credential added', 'out'); }
        if (args[0] === 'rm') { await App().DeleteCred(args[1]); return appendServer(`[+] credential ${args[1]} removed`, 'out'); }
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
  el.innerHTML = builds.map(b => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(b.name)}</span><span style="color:var(--muted)">${esc(b.goos)}/${esc(b.goarch)}</span><span style="color:var(--muted)">${esc(b.format)}</span><span style="color:var(--muted);font-family:var(--mono);max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc((b.c2Urls||[]).join(','))}</span><button class="btn small" onclick="buildRegen('${esc(b.name)}')">Download</button><button class="btn small danger" onclick="if(confirm('Delete build ${esc(b.name)}?'))App().DeleteBuild('${esc(b.name)}').then(refreshBuildsList)">Del</button></div>`).join('');
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
      res.textContent = r.error ? `[ERROR] ${r.error}` : `[OK] ${r.file}`;
      res.style.color = r.error ? 'var(--accent)' : 'var(--ok)';
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
