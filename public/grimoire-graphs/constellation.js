/* ===========================================================================
   Constellation — the archive as a network you build outward.

   The deck reads conversations. This view *grows* them. You put down one point
   — a book at a version, or a conversation you already had — and then you pull
   a line out of it, and the line is a new conversation that reads what it came
   from. Pull three lines out of the same book and you have three drafts being
   argued in parallel from one source. Pull a line out of one of those and the
   grandchild reads the book *and* the argument.

   Two things are worth knowing before reading any of it:

   1. NOTHING ON THE CANVAS IS A COPY. A point is a pointer at a thread or a
      document that already exists in the archive. So a conversation started
      here is an ordinary conversation — the deck lists it, the Oracle searches
      it, its answers file as document versions. The graph stores where it came
      from, and that is all it stores.

   2. CONTEXT IS RESOLVED AT SEND TIME, ON THE SERVER. The client never
      assembles a prompt. Re-pin a book to an older draft, or draw one more line
      into a point, and the very next turn reads the new arrangement — there is
      no cached context to invalidate, because there is no cached context.

   It is a component, not a page. The whole canvas — chrome, inspector, sheet,
   dialog — is built into a detached element when this module loads, and
   `mountConstellation` hangs that element wherever it is wanted: over the whole
   viewport on /grimoire-graphs, or inside a modal above the deck on
   /grimoire-mix. Nothing below asks which of the two it is standing in, with
   two exceptions, both of them options: whether the DECK link is a link or a
   close button, and whether opening a conversation belongs to the inspector or
   to the deck behind the modal.
   =========================================================================== */

/* The whole view, built once, off-document. Held together by `data-el` rather
   than ids: mounted over a page that has its own #modal and #snacks, ids would
   be a collision waiting for the first `getElementById`. */
const MARKUP = `
  <header class="bar">
    <a class="back" data-el="back" href="/grimoire" title="The deck — the same archive as a stack of records">◀ DECK</a>

    <div class="ident">
      <span class="identName">CONSTELLATION</span>
      <span class="identSub" data-el="ident">— · —</span>
    </div>

    <div class="graphPick">
      <select data-el="graphSel" class="hudSelect" title="Which graph is on the canvas"></select>
      <button data-el="newGraph" class="hudBtn" title="Start a new graph">+ GRAPH</button>
      <button data-el="renameGraph" class="ghostBtn" title="Rename this graph">✎</button>
      <button data-el="dropGraph" class="ghostBtn" title="Delete this graph (the conversations survive)">✕</button>
    </div>

    <div class="barRight">
      <button data-el="importBtn" class="hudBtn" title="Draw the conversations you already have as graphs">⇱ IMPORT</button>
      <button data-el="addDoc" class="hudBtn" title="Put a book on the canvas as a source">◆ BOOK</button>
      <button data-el="addThread" class="hudBtn" title="Put a conversation you already have on the canvas">◈ THREAD</button>
      <button data-el="tidy" class="hudBtn" title="Lay the graph out left to right (L)">⇥ TIDY</button>
      <button data-el="fit" class="hudBtn" title="Frame everything (F)">⛶ FIT</button>
      <button data-el="linkBtn" class="hudBtn" title="Providers, keys, models and the fallback chain">⚙ LINK</button>
    </div>
  </header>

  <main data-el="canvas" class="canvas">
    <div data-el="world" class="world">
      <svg data-el="wires" class="wires" aria-hidden="true">
        <defs>
          <marker id="cnArrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--cyanDim)" />
          </marker>
          <marker id="cnArrowLive" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--amber)" />
          </marker>
        </defs>
        <g data-el="wireLines"></g>
        <path data-el="ghostWire" class="ghostWire hidden" />
      </svg>
      <div data-el="points" class="points"></div>
    </div>

    <div data-el="seed" class="seed hidden">
      <p class="seedMark">⁂</p>
      <h2>NOTHING ON THIS CANVAS</h2>
      <p class="seedWhat">A graph starts from one point you already have. Put it down, then
         pull a line out of it — every line you pull is a new conversation that reads
         what it came from.</p>
      <div class="seedActs">
        <button data-el="seedDoc" class="hudBtn primary">◆ START FROM A BOOK</button>
        <button data-el="seedThread" class="hudBtn">◈ START FROM A CONVERSATION</button>
        <button data-el="seedImport" class="hudBtn">⇱ IMPORT WHAT I ALREADY HAVE</button>
      </div>
    </div>
  </main>

  <div class="readout" data-el="readout" aria-hidden="true"></div>

  <div class="canvasHint" data-el="hint">DRAG OR SCROLL TO PAN · PINCH TO ZOOM · DRAG THE ○ PORT TO PULL A NEW LINE · F FIT · L TIDY</div>

  <aside data-el="inspector" class="inspector hidden" aria-label="Point inspector">
    <header class="inspTop">
      <span class="inspGlyph" data-el="inspGlyph">◈</span>
      <div class="inspIdent">
        <h2 data-el="inspTitle">—</h2>
        <p class="inspSub" data-el="inspSub">—</p>
      </div>
      <button data-el="inspRead" class="hudBtn hidden" title="Read this conversation in the deck behind">▤ IN DECK</button>
      <button data-el="inspBranch" class="hudBtn" title="Open a new conversation from this point">⑂ BRANCH</button>
      <button data-el="inspClose" class="ghostBtn" title="Close (ESC)">✕</button>
    </header>

    <section class="sources" data-el="sources"></section>

    <div class="inspLog" data-el="inspLog"></div>

    <form class="composer" data-el="composer">
      <div class="composerRow">
        <select data-el="cTask" class="hudSelect" title="What kind of turn this is"></select>
        <select data-el="cModel" class="hudSelect" title="Model that answers"></select>
        <span class="composerStage" data-el="cStage"></span>
      </div>
      <div class="composerRow">
        <textarea data-el="cInput" rows="1" placeholder="ASK THIS POINT…  [ENTER]"></textarea>
        <button data-el="cSend" type="submit" class="hudBtn primary">SEND</button>
        <button data-el="cHalt" type="button" class="ghostBtn hidden">HALT</button>
      </div>
    </form>
  </aside>

  <div data-el="snacks" class="snacks" aria-live="polite"></div>

  <div data-el="sheet" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modalBox sheetBox">
      <header class="modalTop">
        <span data-el="sheetTitle">—</span>
        <button data-el="sheetClose" class="ghostBtn">✕</button>
      </header>
      <div data-el="sheetBody" class="sheetBody"></div>
      <footer data-el="sheetActs" class="modalActs"></footer>
    </div>
  </div>

  <div data-el="modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modalBox">
      <header class="modalTop"><span data-el="modalTitle">—</span></header>
      <div class="modalBody">
        <p data-el="modalWhat" class="modalWhat"></p>
        <label data-el="modalLabel" class="modalLabel"></label>
        <input data-el="modalInput" class="modalInput" autocomplete="off" spellcheck="false" />
        <p data-el="modalErr" class="modalErr"></p>
      </div>
      <footer class="modalActs">
        <button data-el="modalCancel" class="hudBtn">CANCEL</button>
        <button data-el="modalOk" class="hudBtn primary">CONFIRM</button>
      </footer>
    </div>
  </div>`;

const root = document.createElement('div');
root.className = 'constel';
root.innerHTML = MARKUP;

const $ = (key) => root.querySelector(`[data-el="${key}"]`);
const el = new Proxy({}, {
  get: (cache, key) => (cache[key] ??= $(key)),
});

// How this mount behaves. Set once by `mountConstellation`; everything below
// reads it rather than sniffing the page it ended up on.
const host = {
  mounted: false,
  embedded: false,        // inside the deck's modal rather than owning the page
  visible: true,          // the modal is open — keyboard shortcuts obey this
  onOpenRecord: null,     // (threadId) → the deck travels to that conversation
  onArchiveChanged: null, // () → the graph wrote something the deck should re-read
};

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const patch = (url, body) => api(url, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const del = (url) => api(url, { method: 'DELETE' });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// SQLite writes UTC without a zone; read it as UTC or every timestamp drifts.
const asDate = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
const fmtWhen = (s) => {
  if (!s) return '—';
  const d = asDate(s);
  return Number.isNaN(+d) ? String(s)
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).toUpperCase();
};
const fmtNum = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));
const fmtTok = (n) => (!n ? '0 TOK' : n >= 1000 ? `${(n / 1000).toFixed(1)}K TOK` : `${n} TOK`);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/* ------------------------------------------------------------------- state */

let graphs = [];
let graphId = null;
let nodes = [];                 // graph_nodes rows, joined with what they point at
let edges = [];
let byNode = new Map();         // nodeId → node row
let library = { documents: [], threads: [] };
let cfg = null;                 // /api/config
let selected = null;            // nodeId open in the inspector
let inspected = null;           // the inspector's loaded payload for `selected`

// One composer serves every point, so what is half-typed into it has to belong
// to the point it was typed at. Without this, opening another point and
// pressing send would fire the previous point's question at it — and its
// closing status line would still be on screen, describing a turn that ran
// somewhere else.
const drafts = new Map();       // nodeId → { text, task, stage }
const draftOf = (id) => {
  let d = drafts.get(id);
  if (!d) { d = { text: '', task: 'chat', stage: '' }; drafts.set(id, d); }
  return d;
};

// One live turn per point, held outside the DOM for exactly the reason the deck
// holds its own outside the DOM: the canvas is rebuilt on every write, and a
// stream that wrote into a card it captured at start would lose the rest of its
// answer the moment anything else on the canvas changed.
const sessions = new Map();     // nodeId → { ac, answer, reasoning, stage, working, user, status }

// The camera. World coordinates are what the server stores; screen coordinates
// are these applied to them, and nothing else ever converts between the two.
const cam = { x: 0, y: 0, z: 1 };
const Z_MIN = 0.25;
const Z_MAX = 1.8;

const NODE_W = 272;             // must match --nodeW in the stylesheet
const PORT_Y = 28;              // centre of the in/out ports, from a card's top
const WIRE_OFF = 20000;         // the wire plane's origin offset, from the CSS

const nodeEls = new Map();      // nodeId → the card element
const sizes = new Map();        // nodeId → measured card height, for the wires

/* ------------------------------------------------------------------ camera */

function applyCam() {
  el.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
}

/** Screen point → world point. The inverse of `applyCam`, and the only one. */
function toWorld(clientX, clientY) {
  const r = el.canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left - cam.x) / cam.z,
    y: (clientY - r.top - cam.y) / cam.z,
  };
}

function zoomAt(clientX, clientY, factor) {
  const before = toWorld(clientX, clientY);
  cam.z = Math.min(Z_MAX, Math.max(Z_MIN, cam.z * factor));
  const after = toWorld(clientX, clientY);
  cam.x += (after.x - before.x) * cam.z;
  cam.y += (after.y - before.y) * cam.z;
  applyCam();
  renderReadout();
}

/** Frame everything on the canvas, with room to breathe. */
function fitAll() {
  if (!nodes.length) { cam.x = 0; cam.y = 0; cam.z = 1; return applyCam(); }

  const pad = 90;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
  const maxY = Math.max(...nodes.map((n) => n.y + (sizes.get(n.id) ?? 180)));

  const r = el.canvas.getBoundingClientRect();
  const z = Math.min(Z_MAX, Math.max(Z_MIN,
    Math.min((r.width - pad * 2) / Math.max(1, maxX - minX), (r.height - pad * 2) / Math.max(1, maxY - minY))));

  cam.z = Math.min(z, 1);
  cam.x = (r.width - (maxX - minX) * cam.z) / 2 - minX * cam.z;
  cam.y = (r.height - (maxY - minY) * cam.z) / 2 - minY * cam.z;
  applyCam();
  renderReadout();
}

/* ------------------------------------------------------------------- wires */

const parentsOf = (id) => edges.filter((e) => e.target_id === id);
const childrenOf = (id) => edges.filter((e) => e.source_id === id);

/**
 * Anchors. A line leaves a card from its OUT port and arrives at the next
 * card's IN port, so it always reads left to right even when the cards have
 * been dragged the other way round — the direction of the work is not
 * something the layout gets to contradict.
 */
const outAnchor = (n) => ({ x: n.x + NODE_W + WIRE_OFF, y: n.y + PORT_Y + WIRE_OFF });
const inAnchor = (n) => ({ x: n.x + WIRE_OFF, y: n.y + PORT_Y + WIRE_OFF });

function wirePath(a, b) {
  // The horizontal pull scales with the gap, so short links stay tight and long
  // ones bow enough to be followed across a crowded canvas.
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.45);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function renderWires() {
  const lineage = new Set();
  if (selected != null) {
    for (const e of parentsOf(selected)) lineage.add(e.id);
    for (const e of childrenOf(selected)) lineage.add(e.id);
  }

  const svg = [];
  for (const e of edges) {
    const a = byNode.get(e.source_id);
    const b = byNode.get(e.target_id);
    if (!a || !b) continue;

    const d = wirePath(outAnchor(a), inAnchor(b));
    const cls = ['wire'];
    if (e.mode === 'none') cls.push('mute');
    if (sessions.has(e.target_id)) cls.push('live');
    else if (lineage.has(e.id)) cls.push('lit');

    const title = e.mode === 'none' ? 'carries no context'
      : e.mode === 'last' ? 'carries the final answer only'
      : 'carries the whole source';
    svg.push(
      `<path class="${cls.join(' ')}" d="${d}" />`
      + `<path class="wireHit" d="${d}" data-edge="${e.id}"><title>${esc(title)} — click to change</title></path>`,
    );
  }
  el.wireLines.innerHTML = svg.join('');
}

/* ------------------------------------------------------------------- cards */

const glyphOf = (n) => (n.kind === 'document' ? '◆' : '◈');
const titleOf = (n) => n.label
  || (n.kind === 'document' ? n.doc_filename : n.thread_title)
  || (n.kind === 'document' ? 'missing book' : 'untitled');

/**
 * The drafts a book actually has, newest first. Versions can be deleted from
 * the middle, so this is the stored list — never a 1..newest range, which would
 * offer a draft that is not there and silently fall back to the newest one.
 */
const versionsOf = (n) => {
  const list = String(n.doc_versions ?? '').split(',').map(Number).filter((v) => v > 0);
  return (list.length ? list : [n.doc_newest ?? 1]).sort((a, b) => b - a);
};

/** The version a document point is standing on — a number, or the newest. */
const pinnedVersion = (n) => {
  const list = versionsOf(n);
  return list.includes(n.doc_version) ? n.doc_version : list[0];
};

function docNodeBody(n) {
  const list = versionsOf(n);
  const newest = list[0];
  const opts = list.map((v) => `<option value="${v}"${n.doc_version === v ? ' selected' : ''}>v${v}</option>`);

  return `
    <div class="nodeBody">
      <div class="nodeMeta">
        <span><b>${fmtNum(n.doc_chars)}</b> CHARS</span>
        ${n.doc_pages ? `<span><b>${n.doc_pages}</b> PAGES</span>` : ''}
        <span><b>${list.length}</b> VERSION${list.length === 1 ? '' : 'S'}</span>
      </div>
      <div class="nodeMeta">
        <span>READS</span>
        <select class="nodeVersion" data-act="version" title="Which draft the branches off this point are answered from">
          <option value="">newest (v${newest})</option>
          ${opts.join('')}
        </select>
      </div>
    </div>`;
}

function threadNodeBody(n) {
  const s = sessions.get(n.id);
  if (s) {
    return `
      <div class="nodeBody">
        <div class="nodeStage"><span class="dot">◈</span>${esc(clip(s.stage, 40))}</div>
        <div class="nodeLive">${esc(clip(s.answer || s.reasoning || '…', 260))}</div>
      </div>`;
  }

  const turns = Math.floor((n.message_count ?? 0) / 2);
  const preview = n.last_answer || n.last_user;
  return `
    <div class="nodeBody">
      <div class="nodeMeta">
        <span><b>${turns}</b> TURN${turns === 1 ? '' : 'S'}</span>
        <span>${esc(fmtWhen(n.thread_updated_at))}</span>
      </div>
      <div class="nodePreview">${
        preview ? esc(clip(preview, 190)) : '<em>nothing asked here yet</em>'
      }</div>
    </div>`;
}

function cardHtml(n) {
  const isDoc = n.kind === 'document';
  const tag = isDoc ? `V${pinnedVersion(n)}` : 'CHAT';
  const sources = parentsOf(n.id).length;

  return `
    <div class="port in" data-port="in" title="${sources} source${sources === 1 ? '' : 's'} feed this point"></div>
    <div class="port out" data-port="out" title="Pull a line out — drag onto a point to feed it, or onto empty canvas to open a new conversation from here"></div>

    <header class="nodeTop">
      <span class="nodeGlyph">${glyphOf(n)}</span>
      <span class="nodeTitle" title="${esc(titleOf(n))}">${esc(titleOf(n))}</span>
      <span class="nodeTag">${tag}</span>
    </header>

    ${isDoc ? docNodeBody(n) : threadNodeBody(n)}

    <footer class="nodeActs">
      ${isDoc
        ? '<button class="nodeAct" data-act="branch">⑂ ASK THIS BOOK</button>'
        : '<button class="nodeAct" data-act="open">▸ OPEN</button>'
          + '<button class="nodeAct" data-act="branch">⑂ BRANCH</button>'}
      <span class="spacer"></span>
      ${sources ? `<span class="nodeMeta" title="Lines feeding this point">↥${sources}</span>` : ''}
      <button class="nodeAct warn" data-act="remove" title="Take this point off the canvas">✕</button>
    </footer>`;
}

function renderNodes() {
  const seen = new Set();

  for (const n of nodes) {
    seen.add(n.id);
    let node = nodeEls.get(n.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'node';
      node.dataset.node = String(n.id);
      el.points.append(node);
      nodeEls.set(n.id, node);
    }
    node.className = `node ${n.kind === 'document' ? 'doc' : 'thread'}`
      + (selected === n.id ? ' sel' : '')
      + (sessions.has(n.id) ? ' live' : '');
    node.style.transform = `translate(${n.x}px, ${n.y}px)`;
    node.innerHTML = cardHtml(n);
  }

  for (const [id, node] of nodeEls) {
    if (!seen.has(id)) { node.remove(); nodeEls.delete(id); sizes.delete(id); }
  }

  // Heights are measured, not assumed: a document card and a mid-stream chat
  // card are different heights, and the wires anchor to what is actually drawn.
  for (const [id, node] of nodeEls) sizes.set(id, node.offsetHeight);
}

/**
 * Redraw one card in place — what a streaming turn calls on every token.
 * Rebuilding the whole canvas per token would be a full relayout of every card
 * plus every wire, sixty times a second.
 *
 * Even one card is too much per token: a fast model emits them faster than the
 * screen refreshes, so the work is coalesced onto the next frame and the tokens
 * that arrive in between cost nothing but a string append.
 */
const dirty = new Set();
let frame = 0;

function repaintNode(id) {
  dirty.add(id);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const ids = [...dirty];
    dirty.clear();
    for (const nid of ids) paintCardNow(nid);
    if (ids.some((nid) => selected === nid)) renderLog();
  });
}

function paintCardNow(id) {
  const n = byNode.get(id);
  const node = nodeEls.get(id);
  if (!n || !node) return;
  node.className = `node ${n.kind === 'document' ? 'doc' : 'thread'}`
    + (selected === id ? ' sel' : '') + (sessions.has(id) ? ' live' : '');
  node.innerHTML = cardHtml(n);
  sizes.set(id, node.offsetHeight);
}

function render() {
  renderNodes();
  renderWires();
  el.seed.classList.toggle('hidden', nodes.length > 0);
  renderReadout();
}

function renderReadout() {
  const docs = nodes.filter((n) => n.kind === 'document').length;
  const chats = nodes.length - docs;
  const live = sessions.size;
  el.readout.innerHTML = [
    `<span><b>${nodes.length}</b> POINTS · <b>${docs}</b> SOURCE · <b>${chats}</b> CHAT</span>`,
    `<span><b>${edges.length}</b> LINES · ZOOM <b>${Math.round(cam.z * 100)}%</b></span>`,
    live ? `<span class="live">◈ ${live} ANSWERING</span>` : '<span>◈ IDLE</span>',
  ].join('');
}

/* -------------------------------------------------------------------- load */

async function loadGraphs({ select = null } = {}) {
  graphs = await api('/api/graphs');
  el.graphSel.innerHTML = graphs.length
    ? graphs.map((g) => `<option value="${g.id}">${esc(g.title)} · ${g.node_count} pts</option>`).join('')
    : '<option value="">— no graphs yet —</option>';

  const want = select ?? graphId ?? graphs[0]?.id ?? null;
  if (want && graphs.some((g) => g.id === want)) {
    el.graphSel.value = String(want);
    await openGraph(want);
  } else if (graphs.length) {
    await openGraph(graphs[0].id);
  } else {
    graphId = null; nodes = []; edges = []; byNode = new Map();
    for (const [, node] of nodeEls) node.remove();
    nodeEls.clear();
    el.ident.textContent = 'NO GRAPH';
    render();
  }
}

async function openGraph(id, { keepCam = false } = {}) {
  const changed = graphId !== id;
  graphId = id;
  const data = await api(`/api/graphs/${id}`);
  nodes = data.nodes;
  edges = data.edges;
  byNode = new Map(nodes.map((n) => [n.id, n]));

  if (changed) {
    // The inspector was showing a point on the graph we just left. Torn down
    // by hand rather than through `closeInspector`, which would repaint a
    // canvas that is about to be thrown away.
    selected = null;
    inspected = null;
    root.classList.remove('inspecting');
    el.inspector.classList.add('hidden');
    for (const [, node] of nodeEls) node.remove();
    nodeEls.clear();
  }

  el.graphSel.value = String(id);
  el.ident.textContent = `${data.graph.title.toUpperCase()} · ${nodes.length} PTS`;
  // The picker was filled before this write happened, so its count is stale.
  // Patched in place rather than by re-listing every graph — a point added is
  // not a reason to re-read the whole shelf.
  const opt = el.graphSel.selectedOptions[0];
  if (opt) opt.textContent = `${data.graph.title} · ${nodes.length} pts`;
  render();
  if (changed && !keepCam) fitAll();
  if (selected != null && byNode.has(selected)) refreshSources();
}

/** Re-read the canvas after a write, without moving the camera. */
const reload = () => openGraph(graphId, { keepCam: true });

/* ------------------------------------------------------- canvas navigation */

let pan = null;

el.canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (ev.target.closest('.node, .wireHit, .seed')) return;
  pan = { x: ev.clientX, y: ev.clientY, camX: cam.x, camY: cam.y };
  el.canvas.classList.add('panning');
  el.canvas.setPointerCapture(ev.pointerId);
});

el.canvas.addEventListener('pointermove', (ev) => {
  if (!pan) return;
  cam.x = pan.camX + (ev.clientX - pan.x);
  cam.y = pan.camY + (ev.clientY - pan.y);
  applyCam();
});

const endPan = () => { pan = null; el.canvas.classList.remove('panning'); };
el.canvas.addEventListener('pointerup', endPan);
el.canvas.addEventListener('pointercancel', endPan);

// Trackpad pinch arrives as a wheel event with ctrlKey set; a plain two-finger
// scroll pans, which is what a canvas of this shape is expected to do.
el.canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.01));
  } else {
    cam.x -= ev.deltaX;
    cam.y -= ev.deltaY;
    applyCam();
  }
}, { passive: false });

/* ------------------------------------------------------------ moving cards */

let drag = null;

el.points.addEventListener('pointerdown', (ev) => {
  const port = ev.target.closest('.port.out');
  const card = ev.target.closest('.node');
  if (!card) return;
  const id = Number(card.dataset.node);

  if (port) return startLink(ev, id, card);
  // Controls inside a card are controls, not a handle to drag it by.
  if (ev.target.closest('button, select, .port')) return;
  if (ev.button !== 0) return;

  const n = byNode.get(id);
  if (!n) return;
  drag = { id, card, startX: ev.clientX, startY: ev.clientY, x0: n.x, y0: n.y, moved: false };
  card.classList.add('dragging');
  card.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

el.points.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const dx = (ev.clientX - drag.startX) / cam.z;
  const dy = (ev.clientY - drag.startY) / cam.z;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;

  const n = byNode.get(drag.id);
  n.x = Math.round(drag.x0 + dx);
  n.y = Math.round(drag.y0 + dy);
  drag.card.style.transform = `translate(${n.x}px, ${n.y}px)`;
  renderWires();
});

el.points.addEventListener('pointerup', async (ev) => {
  if (linking) return finishLink(ev);
  if (!drag) return;
  const { id, card, moved } = drag;
  drag = null;
  card.classList.remove('dragging');

  // A click that never moved is a selection, not a move.
  if (!moved) return void openPoint(id);

  const n = byNode.get(id);
  try {
    await patch(`/api/graphs/${graphId}/nodes/${id}`, { x: n.x, y: n.y });
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* -------------------------------------------------------- pulling a line */

let linking = null;

/**
 * The gesture the whole view is built around. Drag the OUT port:
 *   · onto another conversation  → that conversation now reads this point too
 *   · onto empty canvas          → a NEW conversation is opened here, reading
 *                                  this point, and the inspector opens on it
 */
function startLink(ev, id, card) {
  linking = { from: id, card };
  card.setPointerCapture(ev.pointerId);
  el.ghostWire.classList.remove('hidden');

  // Only a conversation can take a line; a book reads nothing.
  for (const [nid, node] of nodeEls) {
    if (nid !== id && byNode.get(nid)?.kind === 'thread') node.classList.add('droppable');
  }
  ev.preventDefault();
  ev.stopPropagation();
}

el.points.addEventListener('pointermove', (ev) => {
  if (!linking) return;
  const from = byNode.get(linking.from);
  const to = toWorld(ev.clientX, ev.clientY);
  el.ghostWire.setAttribute('d', wirePath(outAnchor(from), { x: to.x + WIRE_OFF, y: to.y + WIRE_OFF }));

  const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
  for (const [, node] of nodeEls) node.classList.remove('dropTarget');
  if (over && over !== linking.card && over.classList.contains('droppable')) over.classList.add('dropTarget');
});

async function finishLink(ev) {
  const { from } = linking;
  linking = null;
  el.ghostWire.classList.add('hidden');
  for (const [, node] of nodeEls) node.classList.remove('droppable', 'dropTarget');

  const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
  const target = over ? Number(over.dataset.node) : null;

  try {
    if (target != null && target !== from) {
      if (byNode.get(target)?.kind !== 'thread') {
        return toast('A book reads nothing — pull the line the other way', 'err');
      }
      await post(`/api/graphs/${graphId}/edges`, { sourceId: from, targetId: target, mode: 'full' });
      await reload();
      toast(`${titleOf(byNode.get(target))} now reads ${titleOf(byNode.get(from))}`);
    } else {
      // Dropped on empty canvas: open the next conversation right there.
      const at = toWorld(ev.clientX, ev.clientY);
      const made = await post(`/api/graphs/${graphId}/nodes/${from}/branch`, {
        x: Math.round(at.x), y: Math.round(at.y - PORT_Y), mode: 'full',
      });
      await reload();
      if (made.warning) toast(made.warning, 'err');
      openPoint(made.node.id);
      el.cInput.focus();
      host.onArchiveChanged?.();
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

el.points.addEventListener('pointercancel', () => {
  if (!linking) return;
  linking = null;
  el.ghostWire.classList.add('hidden');
  for (const [, node] of nodeEls) node.classList.remove('droppable', 'dropTarget');
});

/* ------------------------------------------------------------ card actions */

el.points.addEventListener('click', async (ev) => {
  const card = ev.target.closest('.node');
  if (!card) return;
  const id = Number(card.dataset.node);
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  ev.stopPropagation();

  if (act === 'open') return void openPoint(id);

  if (act === 'branch') {
    try {
      const made = await post(`/api/graphs/${graphId}/nodes/${id}/branch`, { mode: 'full' });
      await reload();
      openPoint(made.node.id);
      el.cInput.focus();
      host.onArchiveChanged?.();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (act === 'remove') return void removePoint(id);
});

// The version picker is a change, not a click.
el.points.addEventListener('change', async (ev) => {
  const sel = ev.target.closest('[data-act="version"]');
  if (!sel) return;
  const id = Number(sel.closest('.node').dataset.node);
  try {
    await patch(`/api/graphs/${graphId}/nodes/${id}`, { docVersion: sel.value === '' ? null : Number(sel.value) });
    await reload();
    const n = byNode.get(id);
    toast(`${titleOf(n)} now reads ${n.doc_version == null ? `the newest draft (v${pinnedVersion(n)})` : `v${pinnedVersion(n)}`}`);
    if (selected != null) refreshSources();
  } catch (err) { toast(err.message, 'err'); }
});

/** Change what a line carries, or cut it. */
el.wires.addEventListener('click', (ev) => {
  const hit = ev.target.closest('.wireHit');
  if (!hit) return;
  const edge = edges.find((e) => e.id === Number(hit.dataset.edge));
  if (!edge) return;

  const source = byNode.get(edge.source_id);
  const target = byNode.get(edge.target_id);
  const modes = [
    ['full', 'THE WHOLE SOURCE', source?.kind === 'document'
      ? 'The entire book, at the version this point is pinned to.'
      : 'The whole conversation, most recent turns first if it is long.'],
    ['last', 'THE FINAL ANSWER ONLY', 'Just the last thing the source said. The cheap branch: use it when the parent produced a draft and the argument that led there is noise.'],
    ['none', 'NOTHING', 'The line stays drawn — it records where this came from — but carries no text into the prompt.'],
  ];

  openSheet({
    title: `LINE · ${clip(titleOf(source), 24)} → ${clip(titleOf(target), 24)}`,
    body: `<p class="modalWhat">What should this line carry into <b>${esc(titleOf(target))}</b>?</p>`
      + modes.map(([mode, label, what]) => `
        <button class="pickRow${edge.mode === mode ? ' thread' : ''}" data-mode="${mode}">
          <span class="pickGlyph">${edge.mode === mode ? '◉' : '○'}</span>
          <span class="pickMain">
            <span class="pickName">${label}</span>
            <span class="pickMeta">${esc(what)}</span>
          </span>
        </button>`).join(''),
    acts: [{
      label: '✂ CUT THIS LINE', danger: true, run: async () => {
        await del(`/api/graphs/${graphId}/edges/${edge.id}`);
        closeSheet();
        await reload();
        if (selected != null) refreshSources();
        toast('Line cut — the conversation stays, it just stops reading that source', 'info');
      },
    }],
    onPick: async (target_) => {
      const mode = target_.closest('[data-mode]')?.dataset.mode;
      if (!mode) return;
      await patch(`/api/graphs/${graphId}/edges/${edge.id}`, { mode });
      closeSheet();
      await reload();
      if (selected != null) refreshSources();
    },
  });
});

async function removePoint(id) {
  const n = byNode.get(id);
  if (!n) return;
  const isThread = n.kind === 'thread';
  const turns = n.message_count ?? 0;

  const ok = await openModal({
    title: 'TAKE THIS POINT OFF THE CANVAS',
    what: isThread
      ? `“${titleOf(n)}” leaves the graph. The conversation itself stays in the archive — the deck will still list it — and the lines into and out of this point are cut.${
        turns ? '' : ' It has no turns in it, so there is nothing to keep.'}`
      : `“${titleOf(n)}” leaves the graph. The book stays in the library, and every conversation branched off it keeps its own history.`,
    ok: 'REMOVE',
    danger: true,
    extra: isThread && turns === 0
      ? { id: 'withThread', label: 'Delete the empty conversation too', checked: true }
      : isThread
        ? { id: 'withThread', label: `Also delete the conversation and its ${turns} messages`, checked: false }
        : null,
  });
  if (!ok) return;

  try {
    await del(`/api/graphs/${graphId}/nodes/${id}${ok.withThread ? '?withThread=1' : ''}`);
    if (selected === id) closeInspector();
    await reload();
    if (ok.withThread) host.onArchiveChanged?.();
    toast('Point removed');
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------------------------------------------------------------- inspector */

async function openPoint(id) {
  const n = byNode.get(id);
  if (!n) return;
  if (selected != null && selected !== id) stashDraft();

  selected = id;
  root.classList.add('inspecting');
  el.inspector.classList.remove('hidden');
  renderNodes();
  renderWires();

  el.inspGlyph.textContent = glyphOf(n);
  el.inspTitle.textContent = titleOf(n);

  if (n.kind === 'document') {
    // A book cannot be asked anything directly — the question belongs to a
    // conversation, and that is exactly the branch button below.
    inspected = null;
    el.inspRead.classList.add('hidden');
    const drafts = versionsOf(n);
    el.inspSub.textContent = `BOOK · v${pinnedVersion(n)} of ${drafts.length} DRAFT${drafts.length === 1 ? '' : 'S'} · ${fmtNum(n.doc_chars)} CHARS`;
    el.composer.classList.add('hidden');
    el.sources.innerHTML = `<div class="sourcesTop"><b>SOURCE POINT</b></div>
      <p class="srcNone">This is a source, not a conversation. Pull a line out of it — or press BRANCH — to open one that reads it.</p>`;
    el.inspLog.innerHTML = `<p class="logNote">
      EVERY CONVERSATION BRANCHED OFF THIS POINT IS ANSWERED FROM ${esc(String(n.doc_filename ?? '').toUpperCase())}<br>
      AT ${n.doc_version == null ? `ITS NEWEST DRAFT (V${drafts[0]})` : `V${pinnedVersion(n)}`}.<br><br>
      CHANGE THE VERSION ON THE CARD TO ARGUE TWO DRAFTS IN PARALLEL.</p>`;
    return;
  }

  el.composer.classList.remove('hidden');
  el.inspRead.classList.toggle('hidden', !host.onOpenRecord);

  // The point's own half-typed question and its own last status line, not
  // whatever the previous point left in the panel.
  const d = draftOf(id);
  const running = sessions.get(id);
  el.cInput.value = d.text;
  el.cInput.style.height = 'auto';
  el.cInput.style.height = d.text ? `${Math.min(140, el.cInput.scrollHeight)}px` : '';
  el.cTask.value = d.task;
  el.cStage.textContent = running ? running.stage : d.stage;
  el.cStage.classList.toggle('working', Boolean(running?.working));
  el.cSend.classList.toggle('hidden', Boolean(running));
  el.cHalt.classList.toggle('hidden', !running);

  el.inspLog.innerHTML = '<p class="logNote">READING…</p>';
  await loadThread(id);
  refreshSources();
}

/** Park what is in the composer against the point it was typed at. */
function stashDraft() {
  const d = draftOf(selected);
  d.text = el.cInput.value;
  d.task = el.cTask.value || 'chat';
  d.stage = el.cStage.textContent;
}

async function loadThread(id) {
  try {
    inspected = await api(`/api/graphs/${graphId}/nodes/${id}/thread`);
  } catch (err) {
    inspected = null;
    el.inspLog.innerHTML = `<p class="logNote">${esc(err.message)}</p>`;
    return;
  }
  if (selected !== id) return;   // travelled away while it was loading

  const t = inspected.thread;
  el.inspTitle.textContent = titleOf(byNode.get(id));
  el.inspSub.textContent = [
    `${inspected.messages.length} MSG`,
    inspected.usage?.total_tokens ? fmtTok(inspected.usage.total_tokens) : null,
    t.model ? String(t.model).toUpperCase() : null,
    inspected.document ? `◆ ${inspected.document.filename}` : null,
  ].filter(Boolean).join(' · ');

  if (t.model) el.cModel.value = t.model;
  renderLog();
}

/** What this point will be answered from — asked of the server, not guessed. */
async function refreshSources() {
  if (selected == null) return;
  const n = byNode.get(selected);
  if (!n || n.kind !== 'thread') return;

  const at = selected;
  let src;
  try {
    src = await api(`/api/graphs/${graphId}/nodes/${at}/source`);
  } catch { return; }
  if (selected !== at) return;

  const parents = new Map(parentsOf(at).map((e) => [e.source_id, e]));

  const rows = src.parts.map((p) => {
    const edge = parents.get(p.nodeId);
    const direct = Boolean(edge);
    return `
      <div class="srcRow ${p.kind}">
        <span class="srcGlyph">${p.kind === 'document' ? '◆' : '◈'}</span>
        <span class="srcName" title="${esc(p.name)}${p.detail ? ` — ${esc(p.detail)}` : ''}">
          ${direct ? '' : '↳ '}${esc(p.name)}${p.version != null ? ` v${p.version}` : ''}
        </span>
        <span class="srcSize">${fmtNum(p.chars)}c</span>
        ${direct ? `
          <select class="srcMode" data-edge="${edge.id}" title="What this line carries">
            <option value="full"${edge.mode === 'full' ? ' selected' : ''}>WHOLE</option>
            <option value="last"${edge.mode === 'last' ? ' selected' : ''}>LAST</option>
            <option value="none"${edge.mode === 'none' ? ' selected' : ''}>NONE</option>
          </select>
          <button class="turnAct" data-cut="${edge.id}" title="Cut this line">✕</button>` : ''}
      </div>`;
  }).join('');

  el.sources.innerHTML = `
    <div class="sourcesTop">
      <b>READS</b>
      <span>${src.parts.length} SOURCE${src.parts.length === 1 ? '' : 'S'} · ${fmtNum(src.chars)} CHARS</span>
      <span class="spacer"></span>
      ${src.parts.length ? '<button class="turnAct" data-act="peek">PREVIEW</button>' : ''}
    </div>
    ${rows || '<p class="srcNone">No sources. This point is a conversation with nothing behind it — drag a line into its left port to give it one.</p>'}`;
}

el.sources.addEventListener('change', async (ev) => {
  const sel = ev.target.closest('.srcMode');
  if (!sel) return;
  try {
    await patch(`/api/graphs/${graphId}/edges/${sel.dataset.edge}`, { mode: sel.value });
    await reload();
    refreshSources();
  } catch (err) { toast(err.message, 'err'); }
});

el.sources.addEventListener('click', async (ev) => {
  const cut = ev.target.closest('[data-cut]');
  if (cut) {
    try {
      await del(`/api/graphs/${graphId}/edges/${cut.dataset.cut}`);
      await reload();
      refreshSources();
      toast('Line cut', 'info');
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (ev.target.closest('[data-act="peek"]')) {
    const src = await api(`/api/graphs/${graphId}/nodes/${selected}/source`);
    openSheet({
      title: `SOURCE · ${fmtNum(src.chars)} CHARS`,
      body: `<p class="modalWhat">The first 4,000 characters of exactly what the next turn on this
             point will be answered from — assembled from ${src.parts.length} source${src.parts.length === 1 ? '' : 's'},
             in reading order.</p>
             <div class="srcPreview">${esc(src.preview)}${src.chars > 4000 ? '\n\n…' : ''}</div>`,
    });
  }
});

function closeInspector() {
  if (selected != null) stashDraft();
  selected = null;
  inspected = null;
  root.classList.remove('inspecting');
  el.inspector.classList.add('hidden');
  renderNodes();
  renderWires();
}

el.inspClose.addEventListener('click', closeInspector);

// Only mounted over a deck does this mean anything: hand the conversation back
// to the stack behind, which is where its document, traces and exports live.
el.inspRead.addEventListener('click', () => {
  const threadId = selected != null ? byNode.get(selected)?.thread_id : null;
  if (threadId != null) host.onOpenRecord?.(threadId);
});

el.inspBranch.addEventListener('click', async () => {
  if (selected == null) return;
  try {
    const made = await post(`/api/graphs/${graphId}/nodes/${selected}/branch`, { mode: 'full' });
    await reload();
    openPoint(made.node.id);
    el.cInput.focus();
    host.onArchiveChanged?.();
  } catch (err) { toast(err.message, 'err'); }
});

/* ------------------------------------------------------------------ the log */

const thinkHtml = (reasoning, open = false) => (reasoning ? `
  <details class="think"${open ? ' open' : ''}>
    <summary>◈ THOUGHT · ${reasoning.length.toLocaleString()} CHARS</summary>
    <div class="thinkBody">${esc(reasoning)}</div>
  </details>` : '');

function turnHtml(m, isLast) {
  const you = m.role === 'user';
  const acts = [];
  if (!you) {
    acts.push(`<button class="turnAct" data-msg="${m.id}" data-act="copy">COPY</button>`);
    acts.push(`<button class="turnAct" data-msg="${m.id}" data-act="branch">⑂ BRANCH FROM THIS</button>`);
    if (inspected?.document && m.content?.trim()) {
      acts.push(`<button class="turnAct" data-msg="${m.id}" data-act="version">⇪ FILE AS VERSION</button>`);
    }
  }
  if (isLast && m.error) acts.push(`<button class="turnAct" data-msg="${m.id}" data-act="retry">RETRY</button>`);

  return `
    <div class="turn ${you ? 'you' : 'them'}${m.error ? ' fail' : ''}">
      <div class="turnTop">
        <span class="who">${you ? '▸ YOU' : '◈ MODEL'}</span>
        <span class="spacer"></span>
        <span>${esc(fmtWhen(m.created_at))}${m.ms ? ` · ${(m.ms / 1000).toFixed(1)}S` : ''}</span>
      </div>
      ${thinkHtml(m.reasoning)}
      ${m.content?.trim() ? `<div class="bubble">${esc(m.content)}</div>` : ''}
      ${m.error ? `<p class="turnErr">✕ ${esc(m.error)}</p>` : ''}
      ${acts.length ? `<div class="turnActs">${acts.join('')}</div>` : ''}
    </div>`;
}

function renderLog() {
  if (selected == null) return;
  const s = sessions.get(selected);
  const stored = inspected?.messages ?? [];

  const parts = stored.map((m, i) => turnHtml(m, i === stored.length - 1));

  if (s) {
    if (s.user) {
      parts.push(`
        <div class="turn you">
          <div class="turnTop"><span class="who">▸ YOU</span></div>
          <div class="bubble">${esc(s.user.content)}</div>
        </div>`);
    }
    parts.push(`
      <div class="turn them">
        <div class="turnTop"><span class="who">◈ MODEL</span><span class="spacer"></span><span>${esc(s.model ?? '')}</span></div>
        ${thinkHtml(s.reasoning, !s.answer)}
        <div class="bubble">${esc(s.answer)}<span class="caret">&nbsp;</span></div>
      </div>`);
  }

  if (!parts.length) {
    parts.push(`<p class="logNote">
      NOTHING ASKED ON THIS POINT YET.<br><br>
      IT READS WHAT IS ABOVE. ASK IT SOMETHING, AND WHAT IT ANSWERS<br>
      BECOMES THE SOURCE FOR EVERY LINE YOU PULL OUT OF IT.</p>`);
  }

  const atBottom = el.inspLog.scrollHeight - el.inspLog.scrollTop - el.inspLog.clientHeight < 80;
  el.inspLog.innerHTML = parts.join('');
  if (s || atBottom) el.inspLog.scrollTop = el.inspLog.scrollHeight;
}

el.inspLog.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const msgId = Number(btn.dataset.msg);
  const act = btn.dataset.act;
  const m = inspected?.messages.find((x) => x.id === msgId);
  if (!m) return;

  if (act === 'copy') {
    await navigator.clipboard.writeText(m.content ?? '');
    btn.textContent = 'COPIED';
    setTimeout(() => { btn.textContent = 'COPY'; }, 1200);
    return;
  }

  if (act === 'retry') {
    return void runTurn(selected, `/api/graphs/${graphId}/nodes/${selected}/messages/${msgId}/retry`, {
      model: el.cModel.value || undefined,
    });
  }

  if (act === 'version') {
    try {
      const saved = await post(`/api/documents/${inspected.document.id}/versions`, {
        text: m.content, messageId: msgId, threadId: inspected.thread.id, model: m.model,
      });
      await reload();
      host.onArchiveChanged?.();
      toast(`Filed as v${saved.version} · +${saved.additions} −${saved.deletions}`);
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (act === 'branch') {
    // Branch off one answer: the child reads that answer alone, which is the
    // move that keeps a chain of drafts from dragging its whole argument along.
    try {
      const made = await post(`/api/graphs/${graphId}/nodes/${selected}/branch`, { mode: 'last' });
      await reload();
      openPoint(made.node.id);
      el.cInput.focus();
      host.onArchiveChanged?.();
      toast('Branched — this point reads that answer and nothing else', 'info');
    } catch (err) { toast(err.message, 'err'); }
  }
});

/* ------------------------------------------------------------- live turns */

/**
 * One exchange, streamed over SSE into the session rather than into the DOM.
 * Identical in shape to the deck's, and for the same reason: the card it
 * started on is redrawn on every canvas write, so nothing here may hold a node.
 */
async function runTurn(nodeId, url, body) {
  if (sessions.has(nodeId)) return toast('That point is already answering — halt it first', 'err');

  const ac = new AbortController();
  const s = {
    ac, status: 'running', stage: 'sending…', working: true,
    answer: '', reasoning: '', user: null,
    model: body.model || cfg?.model || 'MODEL',
  };
  sessions.set(nodeId, s);

  const say = (text, working = false) => {
    s.stage = text; s.working = working;
    repaintNode(nodeId);
    if (selected === nodeId) {
      el.cStage.textContent = text;
      el.cStage.classList.toggle('working', working);
    }
  };

  // `repaintNode` already redraws the inspector log for the point in front,
  // on the same frame — calling renderLog here too would rebuild it twice.
  const paint = () => repaintNode(nodeId);

  renderWires();
  if (selected === nodeId) {
    el.cSend.classList.add('hidden');
    el.cHalt.classList.remove('hidden');
  }
  paint();
  renderReadout();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const { type, v: payload } = JSON.parse(line.slice(5));

        if (type === 'user') { s.user = { id: payload.id, content: payload.content }; paint(); }
        else if (type === 'token') { s.answer += payload; paint(); }
        else if (type === 'thinking') {
          s.reasoning += payload;
          say(`reasoning · ${s.reasoning.length.toLocaleString()} chars`, true);
        }
        else if (type === 'stage') say(payload, true);
        else if (type === 'usage') { if (payload.totalTokens) say(`${payload.totalTokens.toLocaleString()} tok`, true); }
        else if (type === 'fallback') toast(`${payload.failed} is down — ${payload.next} is answering`, 'info');
        else if (type === 'done') {
          say(`answered · ${fmtTok(payload.usage?.total_tokens ?? 0)} in this point`);
          for (const note of payload.fallbacks ?? []) toast(note, 'info');
        }
        else if (type === 'error') throw new Error(payload);
      }
    }
    s.status = 'done';
  } catch (err) {
    if (ac.signal.aborted) { s.status = 'halted'; say('halted'); toast('Halted — what arrived is kept', 'info'); }
    else { s.status = 'error'; say('failed'); toast(err.message, 'err'); }
  } finally {
    draftOf(nodeId).stage = s.stage;
    sessions.delete(nodeId);
    if (selected === nodeId) {
      el.cSend.classList.remove('hidden');
      el.cHalt.classList.add('hidden');
    }
    // The turn changed the card's turn count, its preview, and — on the first
    // message — the conversation's own name, so the canvas is re-read.
    await reload();
    if (selected === nodeId) { await loadThread(nodeId); refreshSources(); }
    renderReadout();
    // A turn renames a fresh conversation and adds two messages to it — the
    // deck behind the modal is showing both, and is now wrong.
    host.onArchiveChanged?.();
  }
}

el.composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (selected == null || !inspected) return;
  const content = el.cInput.value.trim();
  if (!content) return;
  el.cInput.value = '';
  el.cInput.style.height = 'auto';
  draftOf(selected).text = '';
  await runTurn(selected, `/api/graphs/${graphId}/nodes/${selected}/messages`, {
    content,
    taskId: el.cTask.value || 'chat',
    model: el.cModel.value || undefined,
  });
});

el.cHalt.addEventListener('click', () => { if (selected != null) sessions.get(selected)?.ac.abort(); });

el.cInput.addEventListener('input', () => {
  el.cInput.style.height = 'auto';
  el.cInput.style.height = `${Math.min(140, el.cInput.scrollHeight)}px`;
  if (selected != null) draftOf(selected).text = el.cInput.value;
});

el.cTask.addEventListener('change', () => {
  if (selected != null) draftOf(selected).task = el.cTask.value;
});

el.cInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    el.composer.requestSubmit();
  }
});

/* ------------------------------------------------------- putting points down */

/** Where a new point lands: the middle of what you are looking at. */
function centreOfView() {
  const r = el.canvas.getBoundingClientRect();
  const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  return { x: Math.round(c.x - NODE_W / 2), y: Math.round(c.y - 70) };
}

async function loadLibrary() {
  library = await api('/api/graph-library');
}

async function pickDocument() {
  await loadLibrary();
  if (!library.documents.length) {
    return toast('No books in the library yet — upload one on the deck first', 'err', {
      label: 'DECK', run: () => { location.href = '/grimoire'; },
    });
  }

  openSheet({
    title: 'PUT A BOOK ON THE CANVAS',
    body: `<p class="modalWhat">A book is a source point: it reads nothing, and everything branched
           off it is answered from it. Pin it to a version on the card afterwards to run two
           drafts side by side.</p>`
      + library.documents.map((d) => `
        <button class="pickRow" data-doc="${d.id}">
          <span class="pickGlyph">◆</span>
          <span class="pickMain">
            <span class="pickName">${esc(d.filename)}</span>
            <span class="pickMeta">${fmtNum(d.chars)} CHARS · ${d.version} VERSION${d.version === 1 ? '' : 'S'} · ${d.thread_count} CONVERSATION${d.thread_count === 1 ? '' : 'S'} · ${esc(fmtWhen(d.created_at))}</span>
          </span>
        </button>`).join(''),
    onPick: async (target) => {
      const docId = target.closest('[data-doc]')?.dataset.doc;
      if (!docId) return;
      closeSheet();
      await ensureGraph();
      const at = centreOfView();
      await post(`/api/graphs/${graphId}/nodes`, { kind: 'document', documentId: Number(docId), ...at });
      await reload();
      if (nodes.length === 1) fitAll();
      toast('Book placed — drag its ○ port out to open a conversation from it', 'info');
    },
  });
}

async function pickThread() {
  await loadLibrary();
  const placed = new Set(nodes.filter((n) => n.kind === 'thread').map((n) => n.thread_id));
  const available = library.threads.filter((t) => !placed.has(t.id));

  if (!available.length) {
    return toast(library.threads.length ? 'Every conversation is already on this canvas' : 'No conversations yet', 'info');
  }

  openSheet({
    title: 'PUT A CONVERSATION ON THE CANVAS',
    body: `<p class="modalWhat">A conversation you have already had becomes a point like any other:
           branch off it and the branch reads it. This is how a chat with no book behind it
           becomes the root of a graph.</p>`
      + available.map((t) => `
        <button class="pickRow thread" data-thread="${t.id}">
          <span class="pickGlyph">◈</span>
          <span class="pickMain">
            <span class="pickName">${esc(t.title)}</span>
            <span class="pickMeta">${t.message_count} MSG${t.filename ? ` · ◆ ${esc(t.filename)}` : ' · NO BOOK'} · ${esc(fmtWhen(t.updated_at))}</span>
          </span>
        </button>`).join(''),
    onPick: async (target) => {
      const threadId = target.closest('[data-thread]')?.dataset.thread;
      if (!threadId) return;
      closeSheet();
      await ensureGraph();
      const at = centreOfView();
      const made = await post(`/api/graphs/${graphId}/nodes`, { kind: 'thread', threadId: Number(threadId), ...at });
      await reload();
      if (nodes.length === 1) fitAll();
      openPoint(made.node.id);
    },
  });
}

/** Placing a point with no graph open creates the graph it goes on. */
async function ensureGraph() {
  if (graphId != null) return;
  const g = await post('/api/graphs', { title: 'New graph' });
  await loadGraphs({ select: g.id });
}

/* ------------------------------------------------------------------ layout */

/**
 * Lay the graph out left to right, one column per generation. Depth is the
 * LONGEST path from a root, not the shortest, so a point that reads both the
 * book and a conversation about it stands to the right of both — a line that
 * ran backwards would be unreadable however pretty the columns were.
 */
async function tidy() {
  if (!nodes.length) return;

  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const n of nodes) {
      const ps = parentsOf(n.id);
      const d = ps.length ? Math.max(...ps.map((e) => depth.get(e.source_id) + 1)) : 0;
      if (d !== depth.get(n.id)) { depth.set(n.id, d); moved = true; }
    }
    if (!moved) break;
  }

  const columns = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }

  const GAP_X = 380;
  const GAP_Y = 34;
  const moves = [];

  for (const [d, column] of [...columns].sort((a, b) => a[0] - b[0])) {
    // Keep siblings near the parent they came from: order each column by where
    // its parents ended up, so the lines fan out instead of crossing.
    column.sort((a, b) => {
      const key = (n) => {
        const ps = parentsOf(n.id).map((e) => byNode.get(e.source_id)?.y ?? 0);
        return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : n.y;
      };
      return key(a) - key(b) || a.id - b.id;
    });

    let y = 0;
    for (const n of column) {
      const h = sizes.get(n.id) ?? 170;
      moves.push({ id: n.id, x: d * GAP_X, y });
      y += h + GAP_Y;
    }
  }

  // Centre each column against the tallest, so the graph reads as a spine.
  const tallest = Math.max(...[...columns.keys()].map((d) => {
    const col = moves.filter((m) => m.x === d * GAP_X);
    return col.length ? col[col.length - 1].y + (sizes.get(col[col.length - 1].id) ?? 170) : 0;
  }));
  for (const [d] of columns) {
    const col = moves.filter((m) => m.x === d * GAP_X);
    if (!col.length) continue;
    const height = col[col.length - 1].y + (sizes.get(col[col.length - 1].id) ?? 170);
    const shift = (tallest - height) / 2;
    for (const m of col) m.y = Math.round(m.y + shift);
  }

  for (const m of moves) {
    const n = byNode.get(m.id);
    n.x = m.x; n.y = m.y;
  }
  render();
  fitAll();

  try {
    await Promise.all(moves.map((m) => patch(`/api/graphs/${graphId}/nodes/${m.id}`, { x: m.x, y: m.y })));
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------------------------------------------------------------- graph bar */

el.graphSel.addEventListener('change', () => {
  if (el.graphSel.value) openGraph(Number(el.graphSel.value));
});

el.newGraph.addEventListener('click', async () => {
  const answer = await openModal({
    title: 'NEW GRAPH', label: 'Name', value: 'New graph', ok: 'CREATE',
    what: 'A graph is one line of work: a source, and everything you grew out of it.',
  });
  if (!answer) return;
  const g = await post('/api/graphs', { title: answer.value });
  await loadGraphs({ select: g.id });
  toast('Graph created — put a book or a conversation down to start it');
});

el.renameGraph.addEventListener('click', async () => {
  if (graphId == null) return;
  const current = graphs.find((g) => g.id === graphId);
  const answer = await openModal({
    title: 'RENAME GRAPH', label: 'Name', value: current?.title ?? '', ok: 'RENAME',
  });
  if (!answer?.value.trim()) return;
  await patch(`/api/graphs/${graphId}`, { title: answer.value.trim() });
  await loadGraphs({ select: graphId });
});

el.dropGraph.addEventListener('click', async () => {
  if (graphId == null) return;
  const current = graphs.find((g) => g.id === graphId);
  const ok = await openModal({
    title: 'DELETE GRAPH',
    what: `“${current?.title}” and its ${current?.node_count ?? 0} points go. The conversations and books
           they point at stay in the archive — this deletes the map, not the work.`,
    label: 'Type DELETE to confirm', confirmWord: 'DELETE', ok: 'DELETE', danger: true,
  });
  if (!ok) return;
  await del(`/api/graphs/${graphId}`);
  graphId = null;
  closeInspector();
  await loadGraphs();
  toast('Graph deleted — the conversations are still on the deck', 'info');
});

el.importBtn.addEventListener('click', openImport);
$('seedImport').addEventListener('click', openImport);
el.addDoc.addEventListener('click', pickDocument);
el.seedDoc.addEventListener('click', pickDocument);
el.addThread.addEventListener('click', pickThread);
el.seedThread.addEventListener('click', pickThread);
el.tidy.addEventListener('click', tidy);
el.fit.addEventListener('click', fitAll);

/* -------------------------------------------------------------- shortcuts */

document.addEventListener('keydown', (ev) => {
  // Mounted in a modal, this canvas shares the page with a deck that has its
  // own shortcuts. Keys are ours only while the modal is the thing in front.
  if (!host.mounted || !host.visible) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);

  if (ev.key === 'Escape') {
    if (!el.modal.classList.contains('hidden')) return;
    if (!el.sheet.classList.contains('hidden')) return closeSheet();
    if (selected != null) return closeInspector();
  }
  if (typing) return;

  if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); fitAll(); }
  if (ev.key === 'l' || ev.key === 'L') { ev.preventDefault(); tidy(); }
  if (ev.key === '0') { cam.z = 1; applyCam(); renderReadout(); }
  if (ev.key === '+' || ev.key === '=') {
    const r = el.canvas.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
  }
  if (ev.key === '-' || ev.key === '_') {
    const r = el.canvas.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
  }
});

/* ------------------------------------------------------------ snacks, sheet */

function toast(text, kind = 'ok', action = null) {
  const node = document.createElement('div');
  node.className = `snack ${kind}`;
  node.innerHTML = `<span class="snackMark">${kind === 'err' ? '✕' : kind === 'info' ? '◈' : '✓'}</span><span>${esc(text)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'turnAct';
    btn.textContent = action.label;
    btn.style.pointerEvents = 'auto';
    btn.addEventListener('click', () => { action.run(); node.remove(); });
    node.append(btn);
  }
  el.snacks.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, action ? 7000 : 3800);
}

let sheetPick = null;

function openSheet({ title, body, acts = [], onPick = null }) {
  el.sheetTitle.textContent = title;
  el.sheetBody.innerHTML = body;
  sheetPick = onPick;

  el.sheetActs.innerHTML = '';
  for (const a of acts) {
    const btn = document.createElement('button');
    btn.className = `hudBtn${a.danger ? ' danger' : ''}`;
    btn.textContent = a.label;
    btn.addEventListener('click', () => a.run());
    el.sheetActs.append(btn);
  }
  el.sheet.classList.remove('hidden');
}

const closeSheet = () => { el.sheet.classList.add('hidden'); sheetPick = null; };
el.sheetClose.addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (ev) => { if (ev.target === el.sheet) closeSheet(); });
el.sheetBody.addEventListener('click', (ev) => sheetPick?.(ev.target));

/**
 * One dialog for every prompt and confirmation. Resolves to null on cancel, or
 * an object — `{ value }` for a prompt, `{ withThread }` when a checkbox was
 * offered — so a caller never has to guess which shape it asked for.
 */
function openModal({ title, what = '', label = null, value = '', confirmWord = null, ok = 'CONFIRM', danger = false, extra = null }) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title;
    el.modalWhat.textContent = what;
    el.modalWhat.classList.toggle('hidden', !what);
    el.modalErr.textContent = '';

    const wants = Boolean(label || confirmWord);
    el.modalLabel.textContent = label ?? '';
    el.modalLabel.classList.toggle('hidden', !wants);
    el.modalInput.classList.toggle('hidden', !wants);
    el.modalInput.value = confirmWord ? '' : value;

    // The checkbox is built here rather than living in the markup: only two
    // callers offer one, and an always-present control would need hiding twice.
    let box = null;
    if (extra) {
      box = document.createElement('label');
      box.className = 'modalLabel';
      box.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none';
      box.innerHTML = `<input type="checkbox"${extra.checked ? ' checked' : ''} /> ${esc(extra.label)}`;
      el.modalInput.after(box);
    }

    el.modalOk.textContent = ok;
    el.modalOk.classList.toggle('danger', danger);
    el.modal.classList.remove('hidden');
    (wants ? el.modalInput : el.modalOk).focus();
    if (wants && !confirmWord) el.modalInput.select();

    const done = (result) => {
      el.modal.classList.add('hidden');
      box?.remove();
      el.modalOk.removeEventListener('click', accept);
      el.modalCancel.removeEventListener('click', cancel);
      el.modalInput.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEsc);
      resolve(result);
    };

    const accept = () => {
      if (confirmWord && el.modalInput.value.trim().toUpperCase() !== confirmWord) {
        el.modalErr.textContent = `Type ${confirmWord} to confirm.`;
        return;
      }
      done({
        value: el.modalInput.value,
        [extra?.id ?? 'extra']: box?.querySelector('input').checked ?? false,
      });
    };
    const cancel = () => done(null);
    const onKey = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); accept(); } };
    const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); cancel(); } };

    el.modalOk.addEventListener('click', accept);
    el.modalCancel.addEventListener('click', cancel);
    el.modalInput.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onEsc);
  });
}

/* ------------------------------------------------------------------ import

   Almost nobody starts a graph on an empty canvas. They start with an archive:
   a shelf of books, and conversations scattered across them. Import reads that
   archive and draws what it already says — a book with three chats under it
   becomes a source with three lines out of it, and an answer that was carried
   from one conversation into another becomes the line it always was.

   It deliberately draws less than it could. Two chats on the same book are
   drawn as siblings, not as a chain, because nothing in the archive says one
   was answered from the other — and a line that lies about that would push text
   into a prompt that never informed it.
   ------------------------------------------------------------------------ */

async function openImport() {
  openSheet({ title: '⇱ IMPORT', body: '<p class="logNote">READING THE ARCHIVE…</p>' });

  let plan;
  try {
    plan = await api('/api/graph-migration/plan');
  } catch (err) {
    return openSheet({ title: '⇱ IMPORT', body: `<p class="logNote">${esc(err.message)}</p>` });
  }

  const t = plan.totals;
  if (!t.importable) {
    return openSheet({
      title: '⇱ IMPORT',
      body: `<p class="modalWhat">Every conversation in the archive is already on a canvas —
             ${t.placed} of ${t.conversations}. There is nothing left to bring in.</p>`,
    });
  }

  const groups = plan.documents.filter((d) => d.threads.some((x) => !x.placed));
  const loose = plan.loose.filter((x) => !x.placed);

  const groupRows = groups.map((d) => {
    const fresh = d.threads.filter((x) => !x.placed);
    return `
      <label class="pickRow" data-group="${d.id}">
        <span class="pickGlyph">◆</span>
        <span class="pickMain">
          <span class="pickName">${esc(d.filename)}</span>
          <span class="pickMeta">${fmtNum(d.chars)} CHARS · ${d.versions} VERSION${d.versions === 1 ? '' : 'S'} · ${fresh.length} CONVERSATION${fresh.length === 1 ? '' : 'S'}${
            d.threads.length > fresh.length ? ` · ${d.threads.length - fresh.length} ALREADY PLACED` : ''}</span>
          <span class="pickMeta">${fresh.map((x) => `◈ ${esc(clip(x.title, 34))}${x.filed.length ? ` (produced v${x.filed.join(', v')})` : ''}`).join('  ·  ')}</span>
        </span>
        <input type="checkbox" class="pickBox" data-doc="${d.id}" checked />
      </label>`;
  }).join('');

  const looseRow = loose.length ? `
    <label class="pickRow thread">
      <span class="pickGlyph">◈</span>
      <span class="pickMain">
        <span class="pickName">${loose.length} conversation${loose.length === 1 ? '' : 's'} with no book</span>
        <span class="pickMeta">${loose.map((x) => esc(clip(x.title, 30))).join('  ·  ')}</span>
        <span class="pickMeta">Each becomes a root point in its own right — a chat that is itself the source for whatever you branch off it.</span>
      </span>
      <input type="checkbox" class="pickBox" data-loose="1" checked />
    </label>` : '';

  const reuseRow = plan.reuse.length ? `
    <label class="pickRow">
      <span class="pickGlyph">⑂</span>
      <span class="pickMain">
        <span class="pickName">${plan.reuse.length} line${plan.reuse.length === 1 ? '' : 's'} the archive already records</span>
        <span class="pickMeta">An answer saved in one conversation and attached to another. Drawn as LAST — what was carried across was the answer, not the argument behind it. A line whose two ends belong to different books can only be drawn on one canvas.</span>
      </span>
      <input type="checkbox" class="pickBox" data-reuse="1" checked />
    </label>` : '';

  openSheet({
    title: `⇱ IMPORT · ${t.importable} CONVERSATION${t.importable === 1 ? '' : 'S'}`,
    body: `
      <p class="modalWhat">The archive is already a graph — it is written down as the book a
         conversation was opened on, and the answers carried from one record into another.
         This draws that, and nothing it cannot support: two chats on the same book come out
         as siblings under it, never as a chain.${
           t.placed ? ` ${t.placed} conversation${t.placed === 1 ? ' is' : 's are'} already on a canvas and will be left alone.` : ''}</p>
      <div class="sourcesTop"><b>ONE GRAPH PER BOOK</b><span class="spacer"></span>
        <label class="srcNone" style="display:flex;gap:6px;align-items:center;cursor:pointer">
          <input type="checkbox" class="pickBox" data-single="1" /> PUT EVERYTHING ON ONE CANVAS INSTEAD
        </label>
      </div>
      ${groupRows}${looseRow}${reuseRow}`,
    acts: [{
      label: `⇱ IMPORT ${t.importable}`, run: async () => {
        const ticked = (sel) => [...el.sheetBody.querySelectorAll(sel)].filter((b) => b.checked);
        const docIds = new Set(ticked('[data-doc]').map((b) => Number(b.dataset.doc)));
        const wantLoose = ticked('[data-loose]').length > 0;

        const threadIds = [
          ...groups.filter((d) => docIds.has(d.id)).flatMap((d) => d.threads.filter((x) => !x.placed).map((x) => x.id)),
          ...(wantLoose ? loose.map((x) => x.id) : []),
        ];
        if (!threadIds.length) return toast('Nothing ticked', 'info');

        try {
          const done = await post('/api/graph-migration/run', {
            mode: ticked('[data-single]').length ? 'single' : 'per-document',
            followReuse: ticked('[data-reuse]').length > 0,
            threadIds,
          });
          closeSheet();
          await loadGraphs({ select: done.graphs[0]?.id ?? null });
          fitAll();
          host.onArchiveChanged?.();
          toast(`${done.nodes} points and ${done.edges} lines drawn across ${done.graphs.length} graph${done.graphs.length === 1 ? '' : 's'}`);
          if (done.reuseSkipped) {
            toast(`${done.reuseSkipped} reused-answer line${done.reuseSkipped === 1 ? '' : 's'} could not be drawn — ${
              done.reuseSkipped === 1 ? 'its two ends are' : 'their ends are'} on different canvases. Import onto one canvas to keep ${
              done.reuseSkipped === 1 ? 'it' : 'them'}.`, 'info');
          }
        } catch (err) { toast(err.message, 'err'); }
      },
    }],
  });
}

/* -------------------------------------------------------------------- boot */

/**
 * Find the conversation on whichever canvas it stands on, and stand in front
 * of it. This is the deck's way in: it knows a thread id and nothing else.
 *
 * A conversation that is on no canvas at all is the interesting case, and it is
 * not an error — it is most of the archive, on the day the graph is first
 * opened. So it is offered a place rather than refused.
 */
async function focusThread(threadId, { offerPlacement = true } = {}) {
  let found;
  try {
    found = await api(`/api/graph-node-for-thread/${threadId}`);
  } catch { found = { node: null }; }

  if (found.node) {
    if (graphId !== found.node.graph_id) await openGraph(found.node.graph_id);
    if (byNode.has(found.node.id)) {
      centreOn(found.node.id);
      await openPoint(found.node.id);
    }
    return true;
  }
  if (offerPlacement) await offerPlacementFor(threadId);
  return false;
}

/** Put the camera on one point, at reading distance. */
function centreOn(nodeId) {
  const n = byNode.get(nodeId);
  if (!n) return;
  const r = el.canvas.getBoundingClientRect();
  cam.z = Math.min(Z_MAX, Math.max(Z_MIN, 1));
  cam.x = r.width / 2 - (n.x + NODE_W / 2) * cam.z;
  cam.y = r.height / 2 - (n.y + 90) * cam.z;
  applyCam();
  renderReadout();
}

/**
 * A conversation the graph has never seen. Rather than an error, this is the
 * one moment where putting it on a canvas is obviously the right move, so it
 * is one button — and the book it was opened on comes with it, because a point
 * with no source is a conversation the graph cannot grow anything from.
 */
async function offerPlacementFor(threadId) {
  const list = graphs.length
    ? graphs.map((g) => `
        <button class="pickRow" data-onto="${g.id}">
          <span class="pickGlyph">⁂</span>
          <span class="pickMain">
            <span class="pickName">${esc(g.title)}</span>
            <span class="pickMeta">${g.node_count} POINTS · ${g.edge_count} LINES</span>
          </span>
        </button>`).join('')
    : '';

  openSheet({
    title: 'THIS CONVERSATION IS NOT ON A GRAPH YET',
    body: `<p class="modalWhat">Put it down as a point and it becomes something you can grow
           from: pull a line out of it and the branch reads it. The book it was opened on comes
           with it, so the branches are answered from the book too.</p>
           ${list || '<p class="srcNone">No graphs yet — the button below makes one.</p>'}`,
    acts: [{
      label: '+ ON A NEW GRAPH', run: async () => {
        const g = await post('/api/graphs', { title: 'New graph' });
        await adoptOnto(g.id, threadId);
      },
    }],
    onPick: async (target) => {
      const onto = target.closest('[data-onto]')?.dataset.onto;
      if (onto) await adoptOnto(Number(onto), threadId);
    },
  });
}

async function adoptOnto(gid, threadId) {
  try {
    const made = await post(`/api/graphs/${gid}/adopt-thread`, { threadId });
    closeSheet();
    await loadGraphs({ select: gid });
    centreOn(made.node.id);
    await openPoint(made.node.id);
    host.onArchiveChanged?.();
    toast(made.already ? 'Already on this canvas' : 'Placed — pull the ○ port out to branch from it', 'info');
  } catch (err) { toast(err.message, 'err'); }
}

let booted = null;

const onResize = () => { if (host.mounted && host.visible) renderWires(); };

async function boot() {
  cfg = await api('/api/config').catch(() => null);

  // CHAT is not one of the server's presets — it is the absence of one, and it
  // has to be first, or every message would silently carry a preset instruction.
  // `custom` is dropped for the same reason: its instruction IS what you type, so
  // on this composer it is indistinguishable from chat.
  el.cTask.innerHTML = '<option value="chat">CHAT</option>'
    + (cfg?.tasks ?? [])
      .filter((t) => t.instruction)
      .map((t) => `<option value="${esc(t.id)}">${esc(t.label.toUpperCase())}</option>`)
      .join('');

  const models = cfg?.models?.length ? cfg.models : (cfg?.model ? [cfg.model] : []);
  el.cModel.innerHTML = models.map((m) => `<option value="${esc(m)}"${m === cfg?.model ? ' selected' : ''}>${esc(m)}</option>`).join('')
    || '<option value="">no model</option>';

  // The LLM settings plugin owns every provider, key and model in the app; this
  // view borrows its dialog rather than growing a second opinion about them.
  const { mountLlmSettings } = await import('/plugins/llm-settings/llm-settings.js');
  const llmSettings = mountLlmSettings({ button: false });
  el.linkBtn.addEventListener('click', () => llmSettings.open());

  if (!cfg?.reachable) {
    toast(cfg?.fallbackReady
      ? `Main provider is down — ${cfg.fallbackReady.label} will answer`
      : 'No provider reachable — open LINK', cfg?.fallbackReady ? 'info' : 'err');
  }

  await loadGraphs();
}

/**
 * Hang the canvas somewhere and start it.
 *
 * Mounted once per page: everything above closes over one root, one camera and
 * one set of sessions, which is what lets a turn keep streaming into a card
 * while the canvas around it is rebuilt. On /grimoire-mix the modal hides and
 * shows this element rather than tearing it down, so a branch left answering
 * behind a closed modal still has somewhere to land.
 */
export function mountConstellation(target, {
  embedded = false,
  deepLink = false,
  onOpenRecord = null,
  onArchiveChanged = null,
  onClose = null,
} = {}) {
  if (host.mounted) throw new Error('The constellation is already mounted on this page.');

  host.mounted = true;
  host.embedded = embedded;
  host.onOpenRecord = onOpenRecord;
  host.onArchiveChanged = onArchiveChanged;
  target.append(root);

  if (embedded) {
    root.classList.add('embedded');
    // The corner that says "leave" on the page says "put this away" in a modal.
    if (onClose) {
      el.back.textContent = '✕ CLOSE';
      el.back.removeAttribute('href');
      el.back.title = 'Put the graph away and go back to the deck (ESC)';
      el.back.addEventListener('click', onClose);
    } else {
      el.back.remove();
    }
    el.hint.textContent = 'DRAG THE ○ PORT TO PULL A NEW LINE · ESC CLOSES · F FIT · L TIDY';
  }

  booted = boot().then(async () => {
    // Heights measure as zero off-document, so the first frame is drawn again
    // now that there is a viewport to draw it in.
    render();
    fitAll();

    window.addEventListener('resize', onResize);

    if (deepLink) {
      const deep = /^#graph=(\d+)$/.exec(location.hash);
      if (deep && graphs.some((g) => g.id === Number(deep[1]))) await openGraph(Number(deep[1]));
    }
  });

  return {
    ready: booted,
    root,
    /** The modal opened or closed. Shortcuts and the camera follow it. */
    setVisible(on) {
      host.visible = on;
      if (on) { render(); renderWires(); }
    },
    focusThread: async (threadId, opts) => { await booted; return focusThread(threadId, opts); },
    /** Whether ESC belongs to the canvas rather than to whoever is hosting it:
     *  a dialog, a sheet or an open inspector all want it first. */
    busy: () => !el.modal.classList.contains('hidden')
      || !el.sheet.classList.contains('hidden')
      || selected != null,
    refresh: async () => { await booted; if (graphId != null) await reload(); else await loadGraphs(); },
    fit: fitAll,
    /** Which conversation the inspector is standing on, if any — the deck uses
     *  it to travel to what you were just reading when the modal closes. */
    selectedThread: () => (selected != null ? byNode.get(selected)?.thread_id ?? null : null),
  };
}
