/* ===========================================================================
   Archive Deck — the archive as a stack of windows you travel through.

   There is no "open a dialog" step here: the record you are reading is simply
   the window at the front of the stack, and every other conversation stands
   behind it, see-through, in the order the deck is in. Traversing moves the
   whole stack; the Oracle's citations move it too, which is what keeps the
   answer and the archive the same object seen two ways.
   =========================================================================== */

const $ = (id) => document.getElementById(id);
const el = {
  q: $('q'), clearQ: $('clearQ'), ident: $('ident'),
  deck: $('deck'), index: $('index'), rail: $('rail'), hint: $('hint'), voidNote: $('void'),
  readout: $('readout'), snacks: $('snacks'), upload: $('upload'),
  uploadFile: $('uploadFile'), replaceFile: $('replaceFile'),
  newRec: $('newRec'), savedBtn: $('savedBtn'), linkBtn: $('linkBtn'),
  sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetBody: $('sheetBody'),
  sheetActs: $('sheetActs'), sheetClose: $('sheetClose'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalWhat: $('modalWhat'),
  modalLabel: $('modalLabel'), modalInput: $('modalInput'), modalErr: $('modalErr'),
  modalOk: $('modalOk'), modalCancel: $('modalCancel'),
  rewritePop: $('rewritePop'), rewriteInstr: $('rewriteInstr'),
  rewriteGo: $('rewriteGo'), rewriteCancel: $('rewriteCancel'),
  modeToggle: $('modeToggle'),
  oracle: $('oracle'), oracleLog: $('oracleLog'), oracleStage: $('oracleStage'),
  oracleForm: $('oracleForm'), oracleInput: $('oracleInput'), oracleSend: $('oracleSend'),
  oracleStop: $('oracleStop'), oracleModel: $('oracleModel'),
  oracleToggle: $('oracleToggle'), collapseOracle: $('collapseOracle'), showOracle: $('showOracle'),
};

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// FTS5 snippets arrive wrapped in ⟦ ⟧ — markers no document contains, so they
// survive escaping and become <mark> only here.
const marked = (s) => esc(s).replaceAll('⟦', '<mark>').replaceAll('⟧', '</mark>');

// SQLite writes UTC without a zone; read it as UTC or every timestamp drifts by
// the viewer's offset.
const asDate = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
const fmtWhen = (s) => {
  if (!s) return '—';
  const d = asDate(s);
  return Number.isNaN(+d)
    ? String(s)
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
       .toUpperCase();
};
const fmtTok = (n) => (!n ? '0 TOK' : n >= 1000 ? `${(n / 1000).toFixed(1)}K TOK` : `${n} TOK`);
const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------- state */

let records = [];              // every thread, newest first
let byId = new Map();
let order = [];                // ids in the deck, in deck order
let focus = 0;                 // index into `order` of the front window
let searchHits = new Map();    // threadId → { hits, matches } while a query is on
let searchTerms = [];
let cited = new Set();         // threads the last Oracle answer used
const recordCache = new Map(); // threadId → { messages, document }, fetched on arrival
const docCache = new Map();    // documentId → extracted text
const versionCache = new Map();// documentId → version rows
const traceCache = new Map();  // threadId → { traces, usage }

// Which face of the record is showing. It belongs to the deck rather than to
// one window: travelling with DOCUMENT open should keep showing documents.
let tab = 'transcript';
let diffFrom = null;
let diffTo = null;
const winEls = new Map();      // threadId → the window element on the deck
let controller = null;         // in-flight Oracle ask
const oracleHistory = [];

// One in-flight turn per record: the deck can be travelling while a record
// behind you is still answering, so the abort handle belongs to the record and
// not to the console.
const turns = new Map();       // threadId → AbortController
let cfg = null;                // /api/config — tasks, models, provider

// How far back the stack is built. Beyond this the windows are invisible
// anyway, and every one of them costs a backdrop-filter — so the depth grows
// only when pinching out actually makes the tail worth drawing.
let depth = 5;
const AHEAD = 1;

// Camera. 1 is reading distance; pinching out shrinks the windows and fans the
// stack at the same time, which is what turns "one record" into "all of them".
let zoom = 1;
const ZOOM_MIN = 0.42;
const ZOOM_MAX = 1.25;

/* -------------------------------------------------------------------- deck */

const bandFor = (r) => {
  if (r < 0) return 'past';
  if (r === 0) return 'front';
  if (r <= 2) return 'near';
  if (r <= depth) return 'far';
  return 'gone';
};

function metaLine(rec) {
  // Every field is its own element: the row is a flex line, and bare text
  // nodes between spans would run together with no gap between them.
  return [
    rec.filename ? `<span class="doc">▤ ${esc(rec.filename)}</span>` : '<span>NO DOCUMENT</span>',
    `<span>${rec.message_count} MSG</span>`,
    `<span>${fmtTok(rec.tokens)}</span>`,
    `<span>${fmtWhen(rec.last_at || rec.updated_at)}</span>`,
    rec.error_count ? `<span class="bad">${rec.error_count} FAILED</span>` : '',
    searchHits.has(rec.id) ? `<span class="doc">${searchHits.get(rec.id).hits} HIT</span>` : '',
  ].filter(Boolean).join('');
}

/** Preview body — what a window shows while it is not the one being read. */
function previewHtml(rec) {
  const hit = searchHits.get(rec.id);
  if (hit?.matches?.length) {
    return `<div class="preview">${hit.matches.map((m) => marked(m.snippet)).join('<br><br>')}</div>`;
  }
  return `<div class="preview">${esc(rec.opening || rec.latest || 'NO EXCHANGE RECORDED')}</div>`;
}

function turnsHtml(messages, rec) {
  const last = messages[messages.length - 1];
  return messages.map((m) => `
    <article class="turn ${m.role}" data-msg="${m.id}">
      <span class="turnWho">${m.role === 'user' ? 'OPERATOR' : esc(m.model || 'MODEL')} · ${fmtWhen(m.created_at)}${
        m.ms ? ` · ${(m.ms / 1000).toFixed(1)}S` : ''
      }</span>
      <div class="bubble${m.error ? ' errored' : ''}">${highlight(m.content, searchTerms)}</div>
      ${m.error ? `<span class="turnErr">⚠ ${esc(m.error)}</span>` : ''}
      <span class="turnActs">${turnActs(m, rec, last)}</span>
      <div class="gtBox hidden" data-gt="${m.id}"></div>
    </article>`).join('');
}

/**
 * What can be done with one turn.
 *
 * Retry is offered only on the tail of a record, and only where something went
 * wrong — the server refuses anything else, and a button that always fails is
 * worse than no button. Editing has no such limit: it discards what came after,
 * which is the point of it.
 */
function turnActs(m, rec, last) {
  const acts = [`<button class="winAct" data-act="copyMsg" data-msg="${m.id}">⧉ COPY</button>`];

  if (m.role === 'user') {
    acts.push(`<button class="winAct" data-act="editMsg" data-msg="${m.id}" title="Rewrite this question and answer it again — everything after it is discarded">✎ EDIT</button>`);
    if (m.id === last?.id) {
      acts.push(`<button class="winAct" data-act="retryMsg" data-msg="${m.id}" title="This question never got an answer — ask again">↻ RETRY</button>`);
    }
    return acts.join('');
  }

  if (m.error) {
    if (m.id === last?.id) {
      acts.push(`<button class="winAct" data-act="retryMsg" data-msg="${m.id}" title="Run this turn again">↻ RETRY</button>`);
    }
    return acts.join('');
  }

  acts.push(`<a class="winAct" href="/api/messages/${m.id}/docx" data-act="dl">⤓ DOCX</a>`);
  if (rec?.document) {
    acts.push(`<button class="winAct" data-act="fileVersion" data-msg="${m.id}">⇪ FILE AS VERSION</button>`);
    acts.push(`<button class="winAct${m.has_ground_truth ? ' on' : ''}" data-act="groundTruth" data-msg="${m.id}" title="Compare this answer against the source document, line by line">⌕ ${m.has_ground_truth ? 'GROUND TRUTH' : 'CHECK'}</button>`);
  }
  acts.push(`<button class="winAct${m.saved ? ' on' : ''}" data-act="saveMsg" data-msg="${m.id}" title="Keep this answer for reuse in other records">${m.saved ? '★ SAVED' : '☆ SAVE'}</button>`);
  return acts.join('');
}

function highlight(text, terms) {
  const safe = esc(text);
  if (!terms.length) return safe;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return safe.replace(new RegExp(`(${pattern})`, 'giu'), '<mark>$1</mark>');
}

function makeWindow(rec) {
  const win = document.createElement('article');
  win.className = `win${cited.has(rec.id) ? ' cited' : ''}`;
  win.dataset.id = String(rec.id);
  win.innerHTML = `
    <header class="winTop">
      <span class="winId">REC ${pad(rec.id)}</span>
      <h2 class="winTitle">${esc(rec.title)}</h2>
      <div class="winActs">
        <button class="winAct" data-act="ask" title="Ask the Oracle about this record">◈ ASK</button>
        <button class="winAct" data-act="renameRec" title="Rename this record">✎</button>
        <button class="winAct danger" data-act="removeRec" title="Delete this record and its messages">✕</button>
        <button class="winAct" data-act="expand" title="Expand / restore (F)">⤢</button>
        <button class="winAct" data-act="collapse" title="Collapse / restore (C)">–</button>
      </div>
    </header>
    <div class="winMeta">${metaLine(rec)}</div>
    <nav class="winTabs"></nav>
    <div class="winBody">${previewHtml(rec)}</div>
    <footer class="winFoot hidden">
      <select class="composerTask hudSelect" title="A preset instruction put in front of what you type"></select>
      <textarea class="composerInput" rows="1" placeholder="SAY SOMETHING TO THIS RECORD…  [ENTER]"></textarea>
      <select class="composerModel hudSelect" title="The model that answers in this record"></select>
      <span class="composerStage"></span>
      <button class="hudBtn primary" data-act="send">SEND</button>
      <button class="ghostBtn hidden" data-act="halt">HALT</button>
    </footer>`;
  return win;
}

/**
 * The composer, on the record it addresses.
 *
 * It lives inside the window rather than on the console because the thing you
 * are talking to is the record in front — the same reason its model picker
 * writes to that thread and not to a global setting.
 */
function fitComposer(win, id, rec) {
  const foot = win.querySelector('.winFoot');
  // Shown on every face of the record, not just its transcript: a record with
  // nothing said in it opens on its DOCUMENT, and hiding the composer there
  // would leave the one window you most want to talk to with no way in.
  // Sending turns the record to its transcript by itself.
  foot.classList.remove('hidden');

  if (foot.dataset.filled !== '1') {
    foot.dataset.filled = '1';
    // "chat" is not one of the presets — it is the absence of one, and it has
    // to be first or every message would silently carry an instruction.
    const tasks = (cfg?.tasks ?? []).filter((t) => t.instruction);
    foot.querySelector('.composerTask').innerHTML = '<option value="chat">CHAT</option>'
      + tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.label.toUpperCase())}</option>`).join('');
    const models = cfg?.models?.length ? cfg.models : [cfg?.model].filter(Boolean);
    foot.querySelector('.composerModel').innerHTML = (models.length ? models : ['default'])
      .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  }

  // A thread remembers which model answered in it; the picker has to agree, or
  // the next turn silently changes the model the record was built with.
  const pick = foot.querySelector('.composerModel');
  const want = rec.thread?.model || cfg?.model;
  if (want && [...pick.options].some((o) => o.value === want)) pick.value = want;
  return foot;
}

/**
 * Everything the front window can show about one record, fetched on arrival
 * rather than up front: the deck would otherwise pull every transcript in the
 * archive to show three of them.
 */
async function fetchRecord(id) {
  if (!recordCache.has(id)) {
    const body = winEls.get(id)?.querySelector('.winBody');
    if (body) body.innerHTML = '<p class="loadingRec">READING RECORD</p>';
    const { thread, messages, document: doc } = await api(`/api/oracle/threads/${id}`);
    recordCache.set(id, { thread, messages, document: doc });
  }
  return recordCache.get(id);
}

/** Which faces this record has. A thread with no document has no document tab. */
function tabsFor(rec) {
  const tabs = [{ id: 'transcript', label: `TRANSCRIPT · ${rec.messages.length}` }];
  if (rec.document) {
    tabs.push({ id: 'document', label: 'DOCUMENT' });
    tabs.push({ id: 'versions', label: `VERSIONS · ${rec.document.versions}` });
  }
  tabs.push({ id: 'traces', label: 'TRACES' });
  return tabs;
}

/**
 * `auto` is the difference between arriving at a record and choosing a face of
 * it: on arrival an empty transcript falls through to the document, but a tab
 * the user actually clicked is never overridden — bouncing off a click reads
 * as a broken button.
 */
async function openFront(id, { auto = true } = {}) {
  const win = winEls.get(id);
  if (!win) return;

  let rec;
  try {
    rec = await fetchRecord(id);
  } catch (err) {
    toast(`Record ${pad(id)} did not load — ${err.message}`, 'err');
    return;
  }
  if (order[focus] !== id) return;   // the stack moved on while that was in flight

  const tabs = tabsFor(rec);
  // A thread with nothing said in it IS its document — landing on an empty
  // transcript and calling that the record was the whole complaint.
  if (!tabs.some((t) => t.id === tab)) tab = 'transcript';
  if (auto && tab === 'transcript' && !rec.messages.length && rec.document) tab = 'document';

  win.querySelector('.winTabs').innerHTML = tabs
    .map((t) => `<button class="tab${t.id === tab ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`)
    .join('');

  fitComposer(win, id, rec);
  await renderTab(win, id, rec);
}

async function renderTab(win, id, rec) {
  const body = win.querySelector('.winBody');
  const show = (html) => { if (order[focus] === id) body.innerHTML = html; };

  try {
    if (tab === 'transcript') {
      show(rec.messages.length
        ? turnsHtml(rec.messages, rec)
        : `<div class="notice">NO EXCHANGE RECORDED${
            rec.document ? ' — this record is its document; see the DOCUMENT tab.' : '.'}</div>`);
      body.scrollTop = 0;
      return;
    }

    if (tab === 'document') return show(await documentHtml(rec));
    if (tab === 'versions') return show(await versionsHtml(rec));
    if (tab === 'traces') return show(await tracesHtml(id));
  } catch (err) {
    show(`<div class="notice bad">${esc(err.message)}</div>`);
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ record faces */

async function documentHtml(rec) {
  const doc = rec.document;
  if (!docCache.has(doc.id)) {
    const { text } = await api(`/api/documents/${doc.id}/text`);
    docCache.set(doc.id, text);
  }
  const text = docCache.get(doc.id);
  const v = doc.newest ?? doc.versions;
  return `
    <div class="tools">
      <button class="winAct" data-act="copyDoc">⧉ COPY</button>
      <a class="winAct" href="/api/documents/${doc.id}/versions/${v}/docx" data-act="dl">⤓ DOCX</a>
      <a class="winAct" href="/api/documents/${doc.id}/versions/${v}/rtf" data-act="dl">⤓ RTF</a>
      <button class="winAct" data-act="renameDoc">✎ RENAME</button>
      <button class="winAct" data-act="replaceDoc">⇄ REPLACE</button>
      <button class="winAct danger" data-act="removeDoc">✕ REMOVE</button>
      <span class="toolsMeta">${doc.chars.toLocaleString()} CHARS${
        doc.words ? ` · ${doc.words.toLocaleString()} WORDS` : ''} · V${v}</span>
    </div>
    <p class="hintLine">⌘/CTRL + SELECT A PASSAGE TO REWRITE IT — THE RESULT IS FILED AS A NEW VERSION</p>
    <div class="docText">${highlight(text, searchTerms)}</div>`;
}

async function versionsHtml(rec) {
  const doc = rec.document;
  if (!versionCache.has(doc.id)) {
    const { versions } = await api(`/api/documents/${doc.id}/versions`);
    versionCache.set(doc.id, versions);
  }
  const versions = versionCache.get(doc.id);

  // Default comparison is the newest change — the one you almost always want.
  if (diffTo == null || !versions.some((v) => v.version === diffTo)) {
    diffTo = versions[0]?.version ?? 1;
    diffFrom = Math.max(1, diffTo - 1);
  }

  const rows = versions.map((v) => `
    <div class="verRow${v.version === diffTo ? ' isTo' : ''}${v.version === diffFrom ? ' isFrom' : ''}">
      <span class="verNo">V${v.version}</span>
      <span class="verStat">${
        v.additions == null ? 'ORIGINAL' : `<span class="add">+${v.additions}</span> <span class="del">−${v.deletions}</span>`}</span>
      <span class="verMeta">${v.chars.toLocaleString()} CHARS · ${fmtWhen(v.created_at)}</span>
      <span class="verActs">
        <button class="winAct" data-act="from" data-v="${v.version}">FROM</button>
        <button class="winAct" data-act="to" data-v="${v.version}">TO</button>
        <a class="winAct" href="/api/documents/${doc.id}/versions/${v.version}/docx" data-act="dl">⤓ DOCX</a>
        <a class="winAct" href="/api/documents/${doc.id}/versions/${v.version}/rtf" data-act="dl">⤓ RTF</a>
        <button class="winAct danger" data-act="rmVersion" data-v="${v.version}">✕</button>
      </span>
    </div>`).join('');

  return `
    <div class="tools">
      <button class="winAct" data-act="diff">◫ COMPARE V${diffFrom} → V${diffTo}</button>
      <span class="toolsMeta">${versions.length} VERSION${versions.length === 1 ? '' : 'S'} OF ${esc(doc.filename)}</span>
    </div>
    <div class="verList">${rows}</div>
    <div class="diffOut" id="diffOut"></div>`;
}

async function tracesHtml(threadId) {
  if (!traceCache.has(threadId)) {
    const [traces, usage] = await Promise.all([
      api(`/api/traces?threadId=${threadId}&limit=100`),
      api(`/api/threads/${threadId}/usage`).catch(() => null),
    ]);
    traceCache.set(threadId, { traces, usage });
  }
  const { traces, usage } = traceCache.get(threadId);
  if (!traces.length) return '<div class="notice">NO CALLS RECORDED FOR THIS RECORD.</div>';

  const total = usage?.thread ?? {};
  const rows = traces.map((t) => `
    <div class="traceRow${t.status === 'ok' ? '' : ' bad'}">
      <span class="traceKind">${esc(t.kind.toUpperCase())}</span>
      <span>${esc(t.served_model || t.model)}</span>
      <span>${t.total_tokens ? `${t.total_tokens.toLocaleString()} TOK` : '—'}</span>
      <span>${t.ttft_ms ? `TTFT ${(t.ttft_ms / 1000).toFixed(1)}S` : '—'}</span>
      <span>${t.duration_ms ? `${(t.duration_ms / 1000).toFixed(1)}S` : '—'}</span>
      <span>${fmtWhen(t.created_at)}</span>
      ${t.error ? `<span class="traceErr">⚠ ${esc(t.error)}</span>` : ''}
    </div>`).join('');

  return `
    <div class="tools">
      <span class="toolsMeta">${traces.length} CALLS · ${
        (total.total_tokens ?? 0).toLocaleString()} TOK TOTAL · IN ${
        (total.prompt_tokens ?? 0).toLocaleString()} · OUT ${(total.completion_tokens ?? 0).toLocaleString()}</span>
    </div>
    <div class="traceList">${rows}</div>`;
}

/** The version diff, in the same shape the lab renders it. */
async function showDiff(docId) {
  const out = document.getElementById('diffOut');
  if (!out) return;
  out.innerHTML = '<p class="loadingRec">COMPARING</p>';
  const d = await api(`/api/documents/${docId}/diff?from=${diffFrom}&to=${diffTo}`);

  if (!d.hunks.length) {
    out.innerHTML = '<div class="notice">NO CHANGES BETWEEN THESE VERSIONS.</div>';
    return;
  }
  out.innerHTML = `
    <div class="diffHead">
      V${d.from} → V${d.to} <span class="add">+${d.additions}</span> <span class="del">−${d.deletions}</span>
      ${d.truncated ? '<span class="warn">· too many changes to line up precisely</span>' : ''}
    </div>
    ${d.hunks.map((h) => `
      <div class="hunk">
        <div class="hunkHead">${esc(h.header ?? '')}</div>
        ${h.lines.map((l) => `
          <div class="dLine ${l.type}">
            <span class="dMark">${l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
            <span class="dText">${diffLineHtml(l)}</span>
          </div>`).join('')}
      </div>`).join('')}`;
}

// Word-level spans when the server paired the line with its counterpart.
const diffLineHtml = (l) => (l.parts
  ? l.parts.map((p) => (p.eq ? esc(p.text) : `<span class="wch">${esc(p.text)}</span>`)).join('')
  : esc(l.text));

/** Rebuild only the slice of the stack that can be seen, and place it. */
function renderDeck() {
  if (!order.length) {
    el.deck.innerHTML = '';
    winEls.clear();
    el.voidNote.classList.remove('hidden');
    el.voidNote.textContent = el.q.value.trim() ? 'NO RECORD MATCHES THAT QUERY' : 'ARCHIVE EMPTY';
    return;
  }
  el.voidNote.classList.add('hidden');

  const from = Math.max(0, focus - AHEAD);
  const to = Math.min(order.length, focus + depth + 1);
  const visible = order.slice(from, to);

  for (const [id, node] of winEls) {
    if (!visible.includes(id)) { node.remove(); winEls.delete(id); }
  }

  visible.forEach((id) => {
    const rec = byId.get(id);
    let win = winEls.get(id);
    if (!win) {
      win = makeWindow(rec);
      winEls.set(id, win);
      el.deck.append(win);
    }
    const r = order.indexOf(id) - focus;
    win.style.setProperty('--r', String(r));
    win.dataset.band = bandFor(r);
    win.classList.toggle('cited', cited.has(id));
    // A window that fell out of the front reverts to its preview, so the deck
    // never carries more transcripts than the one being read.
    if (r !== 0 && win.dataset.full === '1') {
      win.querySelector('.winBody').innerHTML = previewHtml(rec);
      win.dataset.full = '0';
    }
    if (r === 0) {
      win.dataset.full = '1';
      openFront(id);
      win.querySelector('[data-act="expand"]').textContent = winState === 'expanded' ? '⤡' : '⤢';
      win.querySelector('[data-act="collapse"]').textContent = winState === 'collapsed' ? '+' : '–';
    }
  });

  renderRail();
  const rec = byId.get(order[focus]);
  el.ident.textContent = `REC ${pad(rec.id)} · ${pad(focus + 1)}/${pad(order.length)} · ${
    rec.filename ? rec.filename.toUpperCase() : 'NO DOCUMENT'}`;
}

function renderRail() {
  el.rail.innerHTML = `<div class="railCount">${pad(focus + 1)} / ${pad(order.length)}${
    zoom === 1 ? '' : ` · ${Math.round(zoom * 100)}%`}</div>`;
  order.forEach((id, i) => {
    const tick = document.createElement('button');
    tick.className = `tick${i === focus ? ' on' : ''}${cited.has(id) ? ' cited' : ''}`;
    tick.title = byId.get(id).title;
    tick.addEventListener('click', () => setFocus(i));
    el.rail.append(tick);
  });
}

/**
 * Pinch. The two numbers move together on purpose: as each window shrinks the
 * stack fans out by the inverse, so zooming out reveals the tail instead of
 * just making the same overlap smaller. More of the deck is drawn at that
 * point too — there is no reason to render eleven windows at reading distance.
 */
function setZoom(z) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (Math.abs(next - zoom) < 0.004) return;
  zoom = next;
  const spread = 1 + (1 - zoom) * 1.9;
  el.deck.style.setProperty('--zoom', zoom.toFixed(3));
  el.deck.style.setProperty('--spread', spread.toFixed(3));
  el.deck.classList.toggle('spread', zoom < 0.8);
  depth = Math.round(5 + (1 - zoom) * 12);
  renderDeck();
}

/**
 * How big the record in front is: read at its normal size, expanded to take the
 * console, or collapsed to its title bar so the stack behind is unobstructed.
 * The state is on the deck, not the window, because it belongs to whichever
 * record is in front — travelling keeps the size you chose.
 */
let winState = 'normal';

function setWinState(next) {
  winState = winState === next ? 'normal' : next;
  el.deck.classList.toggle('expanded', winState === 'expanded');
  el.deck.classList.toggle('collapsed', winState === 'collapsed');
  const front = winEls.get(order[focus]);
  if (!front) return;
  front.querySelector('[data-act="expand"]').textContent = winState === 'expanded' ? '⤡' : '⤢';
  front.querySelector('[data-act="collapse"]').textContent = winState === 'collapsed' ? '+' : '–';
}

/** Prefill the Oracle with a question aimed at one record. */
function askAbout(id) {
  const rec = byId.get(id);
  if (!rec) return;
  openOracle();
  el.oracleInput.value = `About REC ${pad(id)} ("${rec.title}"): `;
  el.oracleInput.focus();
  el.oracleInput.setSelectionRange(el.oracleInput.value.length, el.oracleInput.value.length);
}

function setFocus(i) {
  const next = Math.max(0, Math.min(order.length - 1, i));
  if (next === focus && winEls.size) return;
  focus = next;
  renderDeck();
}

/**
 * Carry out a movement the Oracle asked for. Every form resolves against the
 * deck as it currently stands, filtered or not — the model was shown that same
 * state, so "the third one" means the third window on screen.
 */
function applyNavigation(nav) {
  if (!nav || typeof nav !== 'object') return;
  showDeck();

  if (Number.isInteger(nav.record) && byId.has(nav.record)) return reveal(nav.record);
  if (Number.isInteger(nav.position)) return setFocus(nav.position - 1);

  const steps = Math.max(1, Math.min(50, Number(nav.steps) || 1));
  const to = String(nav.to ?? 'next').toLowerCase();
  if (to === 'first') return setFocus(0);
  if (to === 'last') return setFocus(order.length - 1);
  if (to === 'prev' || to === 'previous' || to === 'back') return setFocus(focus - steps);
  setFocus(focus + steps);
}

const navLabel = (nav) => {
  if (Number.isInteger(nav?.record)) return `REC ${pad(nav.record)}`;
  if (Number.isInteger(nav?.position)) return `POS ${pad(nav.position)}`;
  const steps = Number(nav?.steps) || 1;
  return `${String(nav?.to ?? 'next').toUpperCase()}${steps > 1 ? ` ×${steps}` : ''}`;
};

/** Bring a conversation to the front wherever it sits — or say it is filtered out. */
function reveal(threadId) {
  const at = order.indexOf(threadId);
  if (at === -1) {
    // It exists, but the current query filtered it away: clear the query and
    // try again rather than silently doing nothing.
    if (byId.has(threadId) && el.q.value) {
      toast(`REC ${pad(threadId)} was filtered out — clearing the query`, 'info');
      el.q.value = '';
      el.clearQ.classList.add('hidden');
      applyOrder(records);
      return reveal(threadId);
    }
    return;
  }
  showDeck();
  setFocus(at);
}

function applyOrder(list) {
  order = list.map((r) => r.id);
  focus = 0;
  for (const [, node] of winEls) node.remove();
  winEls.clear();
  renderDeck();
  renderIndex(list);
}

/* -------------------------------------------------------------- index mode */

function renderIndex(list) {
  el.index.innerHTML = list.map((rec) => {
    const hit = searchHits.get(rec.id);
    const excerpt = hit?.matches?.length
      ? hit.matches.map((m) => marked(m.snippet)).join(' · ')
      : esc(rec.opening || rec.latest || 'NO EXCHANGE RECORDED');
    return `
      <button class="card${cited.has(rec.id) ? ' cited' : ''}" data-id="${rec.id}">
        <div class="cardTop">
          <span class="winId">REC ${pad(rec.id)}</span>
          <h3 class="cardTitle">${esc(rec.title)}</h3>
        </div>
        <p class="cardExcerpt">${excerpt}</p>
        <div class="cardMeta">${metaLine(rec)}</div>
      </button>`;
  }).join('');
}

const inIndex = () => !el.index.classList.contains('hidden');

function showDeck() {
  el.index.classList.add('hidden');
  el.deck.classList.remove('hidden');
  el.rail.classList.remove('hidden');
  el.hint.classList.remove('hidden');
  el.modeToggle.textContent = '◫ INDEX';
}
function showIndex() {
  el.deck.classList.add('hidden');
  el.index.classList.remove('hidden');
  el.rail.classList.add('hidden');
  el.hint.classList.add('hidden');
  el.modeToggle.textContent = '◈ DECK';
}

el.modeToggle.addEventListener('click', () => (inIndex() ? showDeck() : showIndex()));

el.index.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) reveal(Number(card.dataset.id));
});

// Clicking anywhere on a window that is standing behind brings it to the front
// — including on its controls, which belong to whichever record is in front.
el.deck.addEventListener('click', (e) => {
  const win = e.target.closest('.win');
  if (!win) return;
  const id = Number(win.dataset.id);

  if (win.dataset.band !== 'front') {
    // Let the LAB link act as a link on the front window, but not from behind.
    e.preventDefault();
    return reveal(id);
  }

  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    return openFront(id, { auto: false });
  }

  // Not just .winAct: the composer's own SEND and HALT are console buttons that
  // happen to live inside the window, and they carry the same data-act contract.
  const el2 = e.target.closest('[data-act]');
  const act = el2?.dataset.act;
  if (!act) return;

  const rec = recordCache.get(id);
  if (act === 'ask') askAbout(id);
  if (act === 'send') sendFromComposer(id, win);
  if (act === 'halt') turns.get(id)?.abort();

  const msgId = Number(el2.dataset.msg);
  if (act === 'copyMsg') copyMessage(id, msgId, el2);
  if (act === 'saveMsg') saveResponse(msgId, el2);
  if (act === 'groundTruth') groundTruth(id, msgId, el2);
  if (act === 'retryMsg') retryTurn(id, msgId);
  if (act === 'editMsg') beginEdit(win, id, msgId);
  if (act === 'editRun') commitEdit(win, id, msgId);
  if (act === 'editCancel') openFront(id, { auto: false });
  if (act === 'expand') setWinState('expanded');
  if (act === 'collapse') setWinState('collapsed');
  if (act === 'dl') toast(`Exporting ${el2.textContent.replace(/[^A-Z]/g, '')} — check your downloads`, 'info');

  if (act === 'renameRec') renameRecord(id);
  if (act === 'removeRec') removeRecord(id);
  if (act === 'renameDoc' && rec?.document) renameDocument(id, rec.document);
  if (act === 'replaceDoc' && rec?.document) {
    replaceTarget = { docId: rec.document.id, threadId: id };
    el.replaceFile.click();
  }
  if (act === 'removeDoc' && rec?.document) removeDocument(id, rec.document);
  if (act === 'rmVersion' && rec?.document) removeVersion(id, rec.document, Number(el2.dataset.v));
  if (act === 'fileVersion' && rec?.document) fileMessageAsVersion(id, rec, Number(el2.dataset.msg));

  if (act === 'copyDoc' && rec?.document) {
    navigator.clipboard.writeText(docCache.get(rec.document.id) ?? '')
      .then(() => toast(`${rec.document.filename} copied — ${docCache.get(rec.document.id).length.toLocaleString()} chars`))
      .catch((err) => toast(`Copy failed — ${err.message}`, 'err'));
  }

  // Picking the two sides of a comparison, then running it.
  if (act === 'from' || act === 'to') {
    const v = Number(el2.dataset.v);
    if (act === 'from') diffFrom = v; else diffTo = v;
    if (rec) openFront(id, { auto: false }).then(() => toast(`Comparing V${diffFrom} → V${diffTo}`, 'info'));
  }
  if (act === 'diff' && rec?.document) {
    showDiff(rec.document.id).catch((err) => toast(err.message, 'err'));
  }
});

el.deck.addEventListener('keydown', (e) => {
  const input = e.target.closest('.composerInput');
  if (!input) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const win = input.closest('.win');
    sendFromComposer(Number(win.dataset.id), win);
  }
});

el.deck.addEventListener('input', (e) => {
  const input = e.target.closest('.composerInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
});

// Double-clicking the title bar expands, the way a window manager does.
el.deck.addEventListener('dblclick', (e) => {
  if (e.target.closest('.win[data-band="front"] .winTop') && !e.target.closest('.winAct')) {
    setWinState('expanded');
  }
});

// Wheel does three things depending on how it arrives.
//   · with ctrlKey — which is what a trackpad pinch sends — it is the zoom
//   · over the record you are reading, it scrolls that text
//   · anywhere else on the deck, it travels through the stack
// The listener has to be non-passive for the first case: without preventDefault
// the browser zooms the whole page instead.
let wheelLock = 0;
el.deck.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    setZoom(zoom * (1 - e.deltaY * 0.012));
    return;
  }
  if (e.target.closest('.win[data-band="front"] .winBody')) return;
  const now = Date.now();
  if (now - wheelLock < 260) return;
  wheelLock = now;
  setFocus(focus + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

// Safari sends its own gesture events for a pinch rather than a ctrl-wheel.
let gestureBase = 1;
el.deck.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureBase = zoom; }, { passive: false });
el.deck.addEventListener('gesturechange', (e) => { e.preventDefault(); setZoom(gestureBase * e.scale); }, { passive: false });

/* ------------------------------------------------------------------- touch */

// One finger across the deck travels through it; two fingers pinch it, the same
// gesture as the trackpad. Vertical drags are left alone so the record in front
// still scrolls the way a page does.
let touch = null;
const spanOf = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

el.deck.addEventListener('touchstart', (e) => {
  const t = e.touches;
  touch = t.length >= 2
    ? { pinch: true, span: spanOf(t), base: zoom }
    : { pinch: false, x: t[0].clientX, y: t[0].clientY, moved: false };
}, { passive: true });

el.deck.addEventListener('touchmove', (e) => {
  if (!touch) return;
  if (touch.pinch && e.touches.length >= 2) {
    e.preventDefault();
    setZoom(touch.base * (spanOf(e.touches) / touch.span));
    return;
  }
  if (touch.pinch) return;
  const dx = e.touches[0].clientX - touch.x;
  const dy = e.touches[0].clientY - touch.y;
  // Claim the gesture only once it is clearly sideways, so a vertical drag
  // inside the record still scrolls it.
  if (!touch.moved && Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    touch.moved = true;
    setFocus(focus + (dx < 0 ? 1 : -1));
  }
}, { passive: false });

el.deck.addEventListener('touchend', () => { touch = null; }, { passive: true });

/* ------------------------------------------------------------------ search */

let searchTimer = null;

el.q.addEventListener('input', () => {
  el.clearQ.classList.toggle('hidden', !el.q.value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});

el.clearQ.addEventListener('click', () => {
  el.q.value = '';
  el.clearQ.classList.add('hidden');
  runSearch();
  el.q.focus();
});

async function runSearch() {
  const q = el.q.value.trim();
  if (!q) {
    searchHits = new Map();
    searchTerms = [];
    applyOrder(records);
    return;
  }

  const { threads: found } = await api(`/api/oracle/search?q=${encodeURIComponent(q)}&limit=40`);
  toast(found.length
    ? `${found.length} record${found.length === 1 ? '' : 's'} match "${q}"`
    : `Nothing matches "${q}"`, found.length ? 'info' : 'err');
  searchHits = new Map(found.map((f) => [f.threadId, f]));
  searchTerms = q.split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 2);
  // Relevance order, not recency: the point of the query was to be shown the
  // best match first — and on this deck "first" means "at the front".
  applyOrder(found.map((f) => byId.get(f.threadId)).filter(Boolean));
}

/* ------------------------------------------------------------------ oracle */

const openOracle = () => {
  el.oracle.classList.remove('away');
  el.showOracle.classList.add('hidden');
  document.body.classList.add('oracleOpen');
  el.oracleToggle.setAttribute('aria-expanded', 'true');
};
const stowOracle = () => {
  el.oracle.classList.add('away');
  el.showOracle.classList.remove('hidden');
  document.body.classList.remove('oracleOpen');
  el.oracleToggle.setAttribute('aria-expanded', 'false');
};

el.oracleToggle.addEventListener('click', () => (el.oracle.classList.contains('away') ? openOracle() : stowOracle()));
el.collapseOracle.addEventListener('click', stowOracle);
el.showOracle.addEventListener('click', openOracle);

/** Answer text → HTML. Citations become buttons; nothing else is trusted. */
function formatAnswer(text) {
  return esc(text)
    .replace(/\[#(\d+)\]/g, '<button class="cite" data-thread="$1">#$1</button>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function addTurn(who, html) {
  el.oracleLog.querySelector('.oracleIntro')?.remove();
  const turn = document.createElement('div');
  turn.className = `oracleTurn ${who}`;
  turn.innerHTML = html;
  el.oracleLog.append(turn);
  el.oracleLog.scrollTop = el.oracleLog.scrollHeight;
  return turn;
}

/**
 * Snackbar. Everything that happens without a visible result says so here —
 * a copy, an export, a failed fetch — because on a console where windows are
 * translucent and half-lit, silence is indistinguishable from breakage.
 */
function toast(text, kind = 'ok', action = null) {
  const bar = document.createElement('div');
  bar.className = `snack ${kind}`;
  bar.innerHTML = `<span class="snackMark">${kind === 'err' ? '⚠' : kind === 'info' ? '▸' : '✓'}</span>${esc(text)}`;
  // A change filed somewhere the user cannot see needs the way there attached
  // to the message that announced it.
  if (action) {
    const go = document.createElement('button');
    go.className = 'snackAct';
    go.textContent = action.label;
    go.addEventListener('click', () => { bar.remove(); action.onClick(); });
    bar.append(go);
    bar.style.pointerEvents = 'auto';
  }
  el.snacks.append(bar);
  // Long enough to read a filename, short enough not to stack up while
  // travelling quickly through the deck.
  setTimeout(() => {
    bar.classList.add('out');
    bar.addEventListener('transitionend', () => bar.remove(), { once: true });
  }, action ? 8000 : kind === 'err' ? 5200 : 3000);
}

const stage = (text, working = false) => {
  el.oracleStage.textContent = text;
  el.oracleStage.classList.toggle('working', working);
};

// A citation is a destination: it moves the deck to the record it came from.
el.oracleLog.addEventListener('click', (e) => {
  const target = e.target.closest('.cite, .sourceLink');
  if (target) return reveal(Number(target.dataset.thread));
  const seed = e.target.closest('.seed');
  if (seed) {
    el.oracleInput.value = seed.textContent;
    el.oracleForm.requestSubmit();
  }
});

el.oracleInput.addEventListener('input', () => {
  el.oracleInput.style.height = 'auto';
  el.oracleInput.style.height = `${Math.min(el.oracleInput.scrollHeight, 130)}px`;
});

el.oracleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.oracleForm.requestSubmit(); }
});

el.oracleStop.addEventListener('click', () => controller?.abort());

function markCited(ids) {
  cited = new Set(ids);
  for (const [id, node] of winEls) node.classList.toggle('cited', cited.has(id));
  el.index.querySelectorAll('.card').forEach((c) => c.classList.toggle('cited', cited.has(Number(c.dataset.id))));
  renderRail();
}

el.oracleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = el.oracleInput.value.trim();
  if (!question || controller) return;

  el.oracleInput.value = '';
  el.oracleInput.style.height = 'auto';
  addTurn('you', `<div class="said">${esc(question)}</div>`);

  const turn = addTurn('answer', '<div class="trail"></div><div class="said"></div><div class="trail sources"></div>');
  const trail = turn.querySelector('.trail');
  const said = turn.querySelector('.said');
  const sources = turn.querySelector('.sources');

  const chip = (cls, text) => {
    const c = document.createElement('span');
    c.className = `trailChip ${cls}`;
    c.textContent = text;
    trail.append(c);
    el.oracleLog.scrollTop = el.oracleLog.scrollHeight;
  };

  controller = new AbortController();
  el.oracleSend.disabled = true;
  el.oracleStop.classList.remove('hidden');
  stage('querying archive…', true);

  let answer = '';
  let thinking = 0;

  try {
    const res = await fetch('/api/oracle/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question,
        history: oracleHistory.slice(-8),
        model: el.oracleModel.value || undefined,
        // Where the deck is standing, so "the next one" and "the third" resolve
        // against what the user can actually see — including after a query has
        // filtered and reordered the stack.
        deck: {
          position: focus + 1,
          total: order.length,
          records: order.map((id) => ({ id, title: byId.get(id)?.title ?? '' })),
        },
      }),
      signal: controller.signal,
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
        const { type, v } = JSON.parse(line.slice(5));

        if (type === 'token') {
          answer += v;
          said.innerHTML = formatAnswer(answer);
          el.oracleLog.scrollTop = el.oracleLog.scrollHeight;
        } else if (type === 'thinking') {
          thinking += v.length;
          stage(`reasoning · ${thinking.toLocaleString()} chars`, true);
        } else if (type === 'stage') {
          stage(v, true);
        } else if (type === 'thought') {
          chip('thought', v);
        } else if (type === 'hits') {
          chip('', `⌕ ${v.query} · ${v.hits.length} REC`);
        } else if (type === 'opened') {
          chip('', `▤ REC ${pad(v.threadId)}`);
        } else if (type === 'navigate') {
          applyNavigation(v);
          chip('', `▶ ${navLabel(v)}`);
          toast(`Deck moved — ${navLabel(v)}`, 'info');
        } else if (type === 'sources') {
          markCited(v.map((s) => s.threadId));
          sources.innerHTML = v.map((s) => (
            `<button class="sourceLink" data-thread="${s.threadId}" title="${esc(s.title)}">` +
            `REC ${pad(s.threadId)} · ${esc(s.title.length > 34 ? `${s.title.slice(0, 34)}…` : s.title)}</button>`
          )).join('');
          // Fly the deck to the first record the answer rests on, so the text
          // and its evidence are on screen together.
          if (v.length) reveal(v[0].threadId);
        } else if (type === 'done') {
          oracleHistory.push({ role: 'user', content: question });
          oracleHistory.push({ role: 'assistant', content: v.text || answer });
          const tok = v.usage?.total_tokens ? ` · ${v.usage.total_tokens.toLocaleString()} tok` : '';
          stage(`answered in ${(v.ms / 1000).toFixed(1)}s${tok} · ${v.searched.length} queries`);
        } else if (type === 'error') {
          throw new Error(v);
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      stage('halted');
      // Half an answer is still an answer; keeping it lets the next question
      // build on it instead of starting over.
      if (answer) oracleHistory.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    } else {
      said.innerHTML = `<p style="color:var(--alert)">⚠ ${esc(err.message)}</p>`;
      stage('archive did not answer');
      toast(err.message, 'err');
    }
  } finally {
    controller = null;
    el.oracleSend.disabled = false;
    el.oracleStop.classList.add('hidden');
    el.oracleStage.classList.remove('working');
  }
});

/* --------------------------------------------------------------- shortcuts */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');

  if (e.key === 'Escape') {
    if (typing) document.activeElement.blur();
    else if (inIndex()) showDeck();
    return;
  }
  if (typing) return;

  if (e.key === '/') { e.preventDefault(); el.q.focus(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); openOracle(); el.oracleInput.focus(); return;
  }
  if (e.key.toLowerCase() === 'i') { inIndex() ? showDeck() : showIndex(); return; }
  if (inIndex()) return;

  if (e.key.toLowerCase() === 'f') { setWinState('expanded'); return; }
  if (e.key.toLowerCase() === 'c') { setWinState('collapsed'); return; }
  if (e.key === '+' || e.key === '=') { setZoom(zoom + 0.12); return; }
  if (e.key === '-' || e.key === '_') { setZoom(zoom - 0.12); return; }
  if (e.key === '0') { setZoom(1); return; }

  if (e.key === 'ArrowRight') { e.preventDefault(); setFocus(focus + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); setFocus(focus - 1); }
  // Up/Down read the record at the front rather than moving the stack.
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const body = winEls.get(order[focus])?.querySelector('.winBody');
    if (body) { e.preventDefault(); body.scrollBy({ top: e.key === 'ArrowDown' ? 120 : -120 }); }
  }
});

/* -------------------------------------------------------------------- boot */

const [archive, loadedCfg] = await Promise.all([
  api('/api/oracle/gallery'),
  // The model picker is a convenience; the Oracle falls back to the configured
  // main model, so an unreachable cluster must not blank the deck too.
  api('/api/config').catch(() => null),
]);
// Task presets and the model list are read by every composer on the deck, so
// they are held once rather than fetched per window.
cfg = loadedCfg;

// Newest first, but a thread nobody ever said anything in goes to the back of
// the deck rather than greeting you as record one.
records = archive.threads
  .slice()
  .sort((a, b) => (a.message_count === 0) - (b.message_count === 0));
byId = new Map(records.map((r) => [r.id, r]));
applyOrder(records);

if (cfg?.models?.length) {
  el.oracleModel.innerHTML = cfg.models
    .map((m) => `<option value="${esc(m)}"${m === cfg.model ? ' selected' : ''}>${esc(m)}</option>`)
    .join('');
} else {
  el.oracleModel.innerHTML = `<option value="">${esc(cfg?.model || 'default')}</option>`;
}

el.hint.textContent = '◀ ▶ SWIPE · PINCH ZOOM · ↑ ↓ READ · [F] EXPAND · [C] COLLAPSE · [I] INDEX · [/] QUERY';

// The provider screen is the plugin's own, mounted without its button so it
// opens from the console's chrome instead of the lab's.
const { mountLlmSettings } = await import('/plugins/llm-settings/llm-settings.js');
const llmSettings = mountLlmSettings({ button: false });
el.linkBtn.addEventListener('click', () => llmSettings.open());

// The link line names whichever provider actually answers, which is not the
// main one when the cluster is down — a readout that says otherwise would be
// worse than no readout.
const link = cfg?.reachable
  ? `<b>${esc(cfg.provider?.label || 'MAIN')}</b> · ${esc(cfg.model)}`
  : cfg?.fallbackReady
    ? `<span class="live">FALLBACK</span> · ${esc(cfg.fallbackReady.label)}`
    : '<span class="live">NO LINK</span>';
el.readout.innerHTML = [
  `RECORDS   <b>${pad(archive.stats.threads)}</b>`,
  `EXCHANGES <b>${pad(archive.stats.messages)}</b>`,
  `DOCUMENTS <b>${pad(archive.stats.documents)}</b>`,
  `LINK      ${link}`,
].map((l) => `<span>${l}</span>`).join('');

// Deep link the other way: /grimoire#thread=12 brings that record to the front.
const deep = /^#thread=(\d+)$/.exec(location.hash);
if (deep) reveal(Number(deep[1]));

/* ======================================================== dialogs & writes */

/**
 * One dialog for every prompt and every confirmation.
 *
 * `confirmWord` is the gate the lab puts on anything that cannot be undone:
 * the button stays dead until the word is typed. Resolves with the field's
 * value, or null when the user backs out — so a caller can always tell "they
 * said no" from "they said yes to an empty string".
 */
function openModal({ title, what = '', label = null, value = '', confirmWord = null, ok = 'CONFIRM', danger = false }) {
  el.modalTitle.textContent = title;
  el.modalWhat.textContent = what;
  el.modalWhat.classList.toggle('hidden', !what);
  el.modalErr.textContent = '';

  const wantsInput = label != null || confirmWord != null;
  el.modalLabel.textContent = confirmWord ? `Type ${confirmWord} to confirm` : (label ?? '');
  el.modalLabel.classList.toggle('hidden', !wantsInput);
  el.modalInput.classList.toggle('hidden', !wantsInput);
  el.modalInput.value = confirmWord ? '' : value;
  el.modalInput.placeholder = confirmWord ?? '';

  el.modalOk.textContent = ok;
  el.modalOk.classList.toggle('danger', danger);
  el.modalOk.disabled = Boolean(confirmWord);
  el.modal.classList.remove('hidden');
  if (wantsInput) { el.modalInput.focus(); el.modalInput.select(); }

  return new Promise((resolve) => {
    const done = (result) => {
      el.modal.classList.add('hidden');
      el.modalInput.removeEventListener('input', check);
      el.modalInput.removeEventListener('keydown', onKey);
      el.modalOk.removeEventListener('click', accept);
      el.modalCancel.removeEventListener('click', cancel);
      document.removeEventListener('keydown', onEsc, true);
      resolve(result);
    };
    const valid = () => (confirmWord
      ? el.modalInput.value.trim() === confirmWord
      : !wantsInput || el.modalInput.value.trim().length > 0);
    const check = () => { el.modalOk.disabled = !valid(); };
    const accept = () => { if (valid()) done(wantsInput ? el.modalInput.value.trim() : ''); };
    const cancel = () => done(null);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); accept(); } };
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };

    el.modalInput.addEventListener('input', check);
    el.modalInput.addEventListener('keydown', onKey);
    el.modalOk.addEventListener('click', accept);
    el.modalCancel.addEventListener('click', cancel);
    document.addEventListener('keydown', onEsc, true);
  });
}

/**
 * Re-read the archive after a write and stay where the user was standing.
 * Caches for the touched record are dropped, since that is exactly what
 * changed.
 */
async function refreshArchive({ keep = null, drop = null } = {}) {
  if (drop != null) {
    recordCache.delete(drop);
    traceCache.delete(drop);
  }
  const archive = await api('/api/oracle/gallery');
  records = archive.threads.slice().sort((a, b) => (a.message_count === 0) - (b.message_count === 0));
  byId = new Map(records.map((r) => [r.id, r]));
  renderCounts(archive.stats);

  const target = keep ?? order[focus];
  order = records.map((r) => r.id).filter((id) => (searchHits.size ? searchHits.has(id) : true));

  // A record created or changed by an action must not land behind the active
  // query — being sent somewhere else after uploading a file reads as the
  // upload having failed.
  if (target != null && !order.includes(target) && byId.has(target)) {
    searchHits = new Map();
    searchTerms = [];
    el.q.value = '';
    el.clearQ.classList.add('hidden');
    order = records.map((r) => r.id);
  }
  for (const [, node] of winEls) node.remove();
  winEls.clear();
  focus = Math.max(0, order.indexOf(target));
  renderDeck();
  renderIndex(records.filter((r) => order.includes(r.id)));
}

function renderCounts(stats) {
  el.readout.querySelectorAll('span')[0].innerHTML = `RECORDS   <b>${pad(stats.threads)}</b>`;
  el.readout.querySelectorAll('span')[1].innerHTML = `EXCHANGES <b>${pad(stats.messages)}</b>`;
  el.readout.querySelectorAll('span')[2].innerHTML = `DOCUMENTS <b>${pad(stats.documents)}</b>`;
}

/* ------------------------------------------------------------ file actions */

/** Upload a document and open a record for it — a document nothing points at would be invisible on a deck of conversations. */
el.upload.addEventListener('click', () => el.uploadFile.click());

el.uploadFile.addEventListener('change', async () => {
  const file = el.uploadFile.files?.[0];
  el.uploadFile.value = '';
  if (!file) return;

  toast(`Uploading ${file.name}…`, 'info');
  try {
    const form = new FormData();
    form.append('file', file);
    const doc = await api('/api/documents', { method: 'POST', body: form });
    const thread = await api('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: doc.filename, documentId: doc.id }),
    });
    await refreshArchive({ keep: thread.id });
    tab = 'document';
    await openFront(thread.id, { auto: false });
    toast(doc.reused
      ? `${doc.filename} was already in the library — opened REC ${pad(thread.id)}`
      : `${doc.filename} stored · ${doc.chars.toLocaleString()} chars · REC ${pad(thread.id)}`);
  } catch (err) {
    toast(`Upload failed — ${err.message}`, 'err');
  }
});

let replaceTarget = null;

el.replaceFile.addEventListener('change', async () => {
  const file = el.replaceFile.files?.[0];
  el.replaceFile.value = '';
  if (!file || replaceTarget == null) return;
  const { docId, threadId } = replaceTarget;
  replaceTarget = null;

  toast(`Replacing with ${file.name}…`, 'info');
  try {
    const form = new FormData();
    form.append('file', file);
    const out = await api(`/api/documents/${docId}/replace`, { method: 'POST', body: form });
    docCache.delete(docId);
    versionCache.delete(docId);
    await refreshArchive({ keep: threadId, drop: threadId });

    if (out.unchanged) {
      toast('That file is byte-for-byte what is already stored — nothing filed.', 'info');
      return;
    }
    // The outgoing content is not lost: it stays as its own version, which is
    // the whole reason to offer the diff right here.
    diffTo = out.version;
    diffFrom = Math.max(1, out.version - 1);
    toast(`Filed as v${out.version} — the previous text is kept`, 'ok', {
      label: 'REVIEW CHANGES',
      onClick: async () => { tab = 'versions'; await openFront(threadId, { auto: false }); showDiff(docId); },
    });
  } catch (err) {
    toast(`Replace failed — ${err.message}`, 'err');
  }
});

/* ------------------------------------------------------- inline rewriting */

// Ctrl/⌘ + a selection inside the document text is the gesture from the lab's
// preview: mark a passage, say what to do with it, get it rewritten in place.
//
// The passage and its offsets are captured here, not read back when RUN is
// pressed: focusing the instruction field collapses the document selection, so
// by the time the user has typed an instruction there is nothing selected left
// to rewrite.
let rewriteMark = null;

document.addEventListener('mouseup', (e) => {
  // Clicking inside the popup is not a new selection gesture.
  if (e.target.closest('.rewritePop')) return;
  if (!e.ctrlKey && !e.metaKey) return hideRewrite();
  const root = e.target.closest('.docText');
  if (!root) return;

  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text || text.length < 2) return;

  const range = sel.getRangeAt(0);
  rewriteMark = {
    root,
    passage: text,
    start: offsetOf(root, range.startContainer, range.startOffset),
    end: offsetOf(root, range.endContainer, range.endOffset),
  };
  el.rewriteInstr.value = '';
  el.rewritePop.classList.remove('hidden');

  // Anchored to the selection, then pulled back inside the viewport — a popup
  // hanging off the edge of the console is unusable on the right-hand side
  // where the Oracle already is.
  const rect = range.getBoundingClientRect();
  const width = 420;
  el.rewritePop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  el.rewritePop.style.top = `${Math.max(12, rect.top - 46)}px`;
  el.rewriteInstr.focus();
});

function hideRewrite() {
  if (!el.rewritePop.classList.contains('hidden')) el.rewritePop.classList.add('hidden');
  rewriteMark = null;
}

el.rewriteCancel.addEventListener('click', hideRewrite);
el.rewriteInstr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.rewriteGo.click(); }
  if (e.key === 'Escape') hideRewrite();
});

/** Character offset of a DOM position within `root`, counting text only. */
function offsetOf(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === node) return total + offset;
    total += walker.currentNode.textContent.length;
  }
  return total;
}

el.rewriteGo.addEventListener('click', async () => {
  if (!rewriteMark) return hideRewrite();
  const { root, passage, start, end } = rewriteMark;

  const id = order[focus];
  const rec = recordCache.get(id);
  const docId = rec?.document?.id;
  if (!docId) return hideRewrite();

  const instruction = el.rewriteInstr.value.trim();

  el.rewriteGo.disabled = true;
  el.rewriteGo.textContent = 'RUNNING';
  try {
    const { rewritten, model } = await api('/api/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passage, instruction, model: el.oracleModel.value || undefined }),
    });

    const full = docCache.get(docId) ?? root.textContent;
    const next = full.slice(0, start) + rewritten + full.slice(end);
    hideRewrite();

    // Filed as a version rather than written over the document: the change is
    // then reviewable as a diff, and the text the threads were answered from
    // is still there.
    const saved = await api(`/api/documents/${docId}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: next, model }),
    });

    docCache.set(docId, next);
    versionCache.delete(docId);
    // The version count and newest-version number live on the record, so its
    // cache has to go as well or the tab keeps advertising the old count.
    recordCache.delete(id);
    diffTo = saved.version;
    diffFrom = Math.max(1, saved.version - 1);
    await openFront(id, { auto: false });

    toast(`Rewrite filed as v${saved.version} · ${rewritten.length} chars from ${model}`, 'ok', {
      label: 'REVIEW CHANGES',
      onClick: async () => { tab = 'versions'; await openFront(id, { auto: false }); showDiff(docId); },
    });
  } catch (err) {
    toast(err.message.includes('identical')
      ? 'The rewrite matched the current text — nothing filed.'
      : `Rewrite failed — ${err.message}`, 'err');
  } finally {
    el.rewriteGo.disabled = false;
    el.rewriteGo.textContent = 'RUN';
  }
});

/* ------------------------------------------------------- record & document */

async function renameRecord(id) {
  const rec = byId.get(id);
  const title = await openModal({
    title: `RENAME REC ${pad(id)}`, label: 'Record title', value: rec?.title ?? '', ok: 'RENAME',
  });
  if (title == null) return;
  try {
    await api(`/api/threads/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    await refreshArchive({ keep: id, drop: id });
    await openFront(id, { auto: false });
    toast(`REC ${pad(id)} renamed`);
  } catch (err) { toast(`Rename failed — ${err.message}`, 'err'); }
}

async function removeRecord(id) {
  const rec = byId.get(id);
  const ok = await openModal({
    title: `DELETE REC ${pad(id)}`,
    what: `"${rec?.title ?? ''}" and its ${rec?.message_count ?? 0} message(s). The document itself is not touched. This cannot be undone.`,
    confirmWord: 'REMOVE', ok: 'DELETE RECORD', danger: true,
  });
  if (ok == null) return;
  try {
    await api(`/api/threads/${id}`, { method: 'DELETE' });
    recordCache.delete(id);
    await refreshArchive({ drop: id });
    toast(`REC ${pad(id)} deleted`);
  } catch (err) { toast(`Delete failed — ${err.message}`, 'err'); }
}

async function renameDocument(id, doc) {
  const filename = await openModal({
    title: 'RENAME DOCUMENT', label: 'Filename', value: doc.filename, ok: 'RENAME',
  });
  if (filename == null) return;
  try {
    await api(`/api/documents/${doc.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    // Every record bound to this document shows the old name, so the whole
    // deck is re-read rather than the one window patched.
    await refreshArchive({ keep: id, drop: id });
    await openFront(id, { auto: false });
    toast(`Renamed to ${filename}`);
  } catch (err) { toast(`Rename failed — ${err.message}`, 'err'); }
}

async function removeDocument(id, doc) {
  const ok = await openModal({
    title: 'REMOVE DOCUMENT',
    what: `${doc.filename}, its stored bytes and all ${doc.versions} version(s). Records keep their messages but lose the document. This cannot be undone.`,
    confirmWord: 'REMOVE', ok: 'REMOVE DOCUMENT', danger: true,
  });
  if (ok == null) return;
  try {
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    docCache.delete(doc.id);
    versionCache.delete(doc.id);
    tab = 'transcript';
    await refreshArchive({ keep: id, drop: id });
    await openFront(id, { auto: false });
    toast(`${doc.filename} removed from the library`);
  } catch (err) { toast(`Remove failed — ${err.message}`, 'err'); }
}

async function removeVersion(id, doc, version) {
  const ok = await openModal({
    title: `REMOVE V${version}`,
    what: `Version ${version} of ${doc.filename}. The other versions stay. This cannot be undone.`,
    confirmWord: 'REMOVE', ok: 'REMOVE VERSION', danger: true,
  });
  if (ok == null) return;
  try {
    await api(`/api/documents/${doc.id}/versions/${version}`, { method: 'DELETE' });
    versionCache.delete(doc.id);
    docCache.delete(doc.id);
    diffTo = null;
    await refreshArchive({ keep: id, drop: id });
    await openFront(id, { auto: false });
    toast(`v${version} removed`);
  } catch (err) { toast(`Remove failed — ${err.message}`, 'err'); }
}

/**
 * File a model's answer as the next version of the document it rewrote — the
 * lab's "save this response as a version", where the point is that the stored
 * document is left alone and the change becomes reviewable as a diff.
 */
async function fileMessageAsVersion(id, rec, messageId) {
  const message = rec.messages.find((m) => m.id === messageId);
  if (!message) return;
  try {
    const saved = await api(`/api/documents/${rec.document.id}/versions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message.content, messageId, threadId: id, model: message.model }),
    });
    versionCache.delete(rec.document.id);
    recordCache.delete(id);
    diffTo = saved.version;
    diffFrom = Math.max(1, saved.version - 1);
    // Re-read the record so the VERSIONS tab shows the count it now has,
    // rather than waiting for the user to go and look.
    await openFront(id, { auto: false });
    toast(`Filed as v${saved.version} · ${message.content.length.toLocaleString()} chars`, 'ok', {
      label: 'REVIEW CHANGES',
      onClick: async () => { tab = 'versions'; await openFront(id, { auto: false }); showDiff(rec.document.id); },
    });
  } catch (err) {
    toast(err.message.includes('identical')
      ? 'That answer is identical to the current version — nothing filed.'
      : `Could not file it — ${err.message}`, 'err');
  }
}

/* ============================================================ live turns */

/**
 * Send, retry and edit all come down to the same thing: an SSE stream that
 * writes one exchange into the record it belongs to. The differences are which
 * endpoint opens it and which turns have to be cleared out of the way first —
 * a retry replaces the tail, an edit replaces everything from the edited
 * question onwards, a plain send replaces nothing.
 *
 * The stream is deliberately not bound to the front of the deck. You can walk
 * away from a record mid-answer; the turn keeps running, the server keeps
 * writing it down, and the record has it when you come back.
 */
async function runTurn(id, url, body) {
  if (turns.has(id)) return toast(`REC ${pad(id)} is already answering — halt it first`, 'err');

  // A message means nothing on a diff or a document face, so the record is
  // turned to its transcript before anything is streamed into it.
  if (tab !== 'transcript') { tab = 'transcript'; await openFront(id, { auto: false }); }

  const win = winEls.get(id);
  const pane = win?.querySelector('.winBody');
  pane?.querySelector('.notice')?.remove();

  const ac = new AbortController();
  turns.set(id, ac);
  composerBusy(win, true);

  let live = null;         // the assistant bubble being written into
  let answer = '';
  let thinking = 0;
  let lastSaid = '';
  const say = (text, working = false) => {
    lastSaid = text;
    const stageEl = win?.querySelector('.composerStage');
    if (stageEl) {
      stageEl.textContent = text;
      stageEl.classList.toggle('working', working);
    }
  };
  const stick = () => { if (pane) pane.scrollTop = pane.scrollHeight; };

  say('sending…', true);

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
        const { type, v } = JSON.parse(line.slice(5));

        if (type === 'user') {
          // The question comes back from the server rather than being echoed
          // locally: it now has an id, which is what every action on it needs.
          pane?.append(liveTurn('user', 'OPERATOR', v.content, v.id));
          live = liveTurn('assistant', body.model || cfg?.model || 'MODEL', '');
          pane?.append(live);
          stick();
        } else if (type === 'token') {
          answer += v;
          if (live) live.querySelector('.bubble').textContent = answer;
          stick();
        } else if (type === 'thinking') {
          thinking += v.length;
          say(`reasoning · ${thinking.toLocaleString()} chars`, true);
        } else if (type === 'stage') {
          say(v, true);
        } else if (type === 'usage') {
          if (v.totalTokens) say(`${v.totalTokens.toLocaleString()} tok`, true);
        } else if (type === 'fallback') {
          toast(`${v.failed} is down — ${v.next} is answering`, 'info');
        } else if (type === 'done') {
          // `usage` on this frame is the whole record's total, not this turn's.
          say(`answered · ${fmtTok(v.usage?.total_tokens ?? 0)} in this record`);
          for (const note of v.fallbacks ?? []) toast(note, 'info');
        } else if (type === 'error') {
          throw new Error(v);
        }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      say('halted');
      toast(`REC ${pad(id)} halted — what arrived is kept`, 'info');
    } else {
      say('failed');
      if (live) live.querySelector('.bubble').classList.add('errored');
      toast(err.message, 'err');
    }
  } finally {
    turns.delete(id);
    composerBusy(win, false);
    // Re-read rather than patch: the turn changed the message count, the token
    // total and — on the first message — the record's own name.
    recordCache.delete(id);
    traceCache.delete(id);
    await refreshArchive({ keep: id });
    if (order[focus] === id) {
      tab = 'transcript';
      await openFront(id, { auto: false });
      const fresh = winEls.get(id);
      const body2 = fresh?.querySelector('.winBody');
      if (body2) body2.scrollTop = body2.scrollHeight;
      // The window this turn was streamed into no longer exists — the archive
      // was re-read to pick up the new count. Carry the closing line across, or
      // the turn ends with the status blank and nothing says how it went.
      const stageEl = fresh?.querySelector('.composerStage');
      if (stageEl) stageEl.textContent = lastSaid;
    }
  }
}

function liveTurn(who, label, text, msgId = null) {
  const art = document.createElement('article');
  art.className = `turn ${who}`;
  if (msgId) art.dataset.msg = String(msgId);
  art.innerHTML = `<span class="turnWho">${esc(label)} · NOW</span><div class="bubble"></div>`;
  art.querySelector('.bubble').textContent = text;
  return art;
}

function composerBusy(win, busy) {
  const foot = win?.querySelector('.winFoot');
  if (!foot) return;
  foot.querySelector('[data-act="send"]').classList.toggle('hidden', busy);
  foot.querySelector('[data-act="halt"]').classList.toggle('hidden', !busy);
  foot.querySelector('.composerInput').disabled = busy;
}

async function sendFromComposer(id, win) {
  const foot = win.querySelector('.winFoot');
  const input = foot.querySelector('.composerInput');
  const content = input.value.trim();
  if (!content) return;

  input.value = '';
  input.style.height = 'auto';
  await runTurn(id, `/api/threads/${id}/messages`, {
    content,
    taskId: foot.querySelector('.composerTask').value || 'chat',
    model: foot.querySelector('.composerModel').value || undefined,
  });
}

/** Run the tail of a record again. The server drops the failed reply itself. */
async function retryTurn(id, msgId) {
  const win = winEls.get(id);
  const rec = recordCache.get(id);
  const target = rec?.messages.find((m) => m.id === msgId);

  // Clear the turns this replaces before the stream starts, so the retry does
  // not appear underneath the failure it is retrying.
  dropTurnsFrom(win, target?.role === 'assistant'
    ? rec.messages[rec.messages.length - 2]?.id ?? msgId
    : msgId);

  await runTurn(id, `/api/threads/${id}/messages/${msgId}/retry`, {
    model: win?.querySelector('.composerModel')?.value || undefined,
  });
}

/** Remove the turn with this id and every turn after it. */
function dropTurnsFrom(win, msgId) {
  const from = win?.querySelector(`.turn[data-msg="${msgId}"]`);
  if (!from) return;
  let node = from;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
}

function beginEdit(win, id, msgId) {
  const art = win.querySelector(`.turn[data-msg="${msgId}"]`);
  const m = recordCache.get(id)?.messages.find((x) => x.id === msgId);
  if (!art || !m) return;

  art.classList.add('editing');
  art.innerHTML = `
    <span class="turnWho">EDIT · EVERYTHING AFTER THIS IS DISCARDED</span>
    <textarea class="editInput"></textarea>
    <span class="turnActs">
      <button class="winAct" data-act="editRun" data-msg="${msgId}">↻ ASK AGAIN</button>
      <button class="winAct" data-act="editCancel">✕ CANCEL</button>
    </span>`;
  const input = art.querySelector('.editInput');
  input.value = m.content;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function commitEdit(win, id, msgId) {
  const input = win.querySelector(`.turn[data-msg="${msgId}"] .editInput`);
  const content = input?.value.trim();
  if (!content) return;

  dropTurnsFrom(win, msgId);
  await runTurn(id, `/api/threads/${id}/messages/${msgId}/edit`, {
    content,
    model: win.querySelector('.composerModel')?.value || undefined,
  });
}

/* ------------------------------------------------------- message actions */

async function copyMessage(id, msgId, btn) {
  const m = recordCache.get(id)?.messages.find((x) => x.id === msgId);
  if (!m) return;
  try {
    await navigator.clipboard.writeText(m.content);
    const was = btn.textContent;
    btn.textContent = '✓ COPIED';
    setTimeout(() => { btn.textContent = was; }, 1200);
  } catch (err) { toast(`Copy failed — ${err.message}`, 'err'); }
}

async function saveResponse(msgId, btn) {
  if (btn.classList.contains('on')) return toast('Already kept — open ★ SAVED to reuse it', 'info');
  try {
    await api('/api/saved-responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: msgId }),
    });
    btn.classList.add('on');
    btn.textContent = '★ SAVED';
    toast('Kept — it can be attached to any record from ★ SAVED');
  } catch (err) { toast(`Could not keep it — ${err.message}`, 'err'); }
}

/**
 * Ask the model to check one answer against the document it came from, and
 * show every difference it names. The check is stored, so a second visit reads
 * it back instead of paying for it again.
 */
async function groundTruth(id, msgId, btn) {
  const box = winEls.get(id)?.querySelector(`.gtBox[data-gt="${msgId}"]`);
  if (!box) return;

  if (!box.classList.contains('hidden')) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="loadingRec">CHECKING AGAINST THE DOCUMENT</p>';

  try {
    if (!btn.classList.contains('on')) {
      btn.disabled = true;
      await api(`/api/threads/${id}/messages/${msgId}/ground-truth`, { method: 'POST' });
      btn.classList.add('on');
      btn.textContent = '⌕ GROUND TRUTH';
    }
    const check = await api(`/api/messages/${msgId}/ground-truth`);
    box.innerHTML = groundTruthHtml(check);
  } catch (err) {
    box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function groundTruthHtml(check) {
  if (!check.diff.length) {
    return '<div class="notice">FULLY GROUNDED — NOTHING IN THIS ANSWER DEPARTS FROM THE DOCUMENT.</div>';
  }
  // Findings are not line numbers, so each one is its own little diff: what the
  // document says on top, what the answer said underneath.
  return `
    <div class="diffHead">${check.diff.length} FINDING${check.diff.length === 1 ? '' : 'S'} · ${
      esc(check.model || '')}</div>
    ${check.diff.map((d, i) => `
      <div class="hunk">
        <div class="hunkHead">@@ FINDING ${i + 1} @@</div>
        ${d.old != null ? `<div class="dLine del"><span class="dMark">−</span><span class="dText">${esc(d.old)}</span></div>` : ''}
        ${d.new != null ? `<div class="dLine add"><span class="dMark">+</span><span class="dText">${esc(d.new)}</span></div>` : ''}
        ${d.note ? `<div class="dNote">${esc(d.note)}</div>` : ''}
      </div>`).join('')}`;
}

/* --------------------------------------------------------------- sheets */

/** The wide panel. Anything that is a list rather than a question shows here. */
function openSheet({ title, body, acts = [] }) {
  el.sheetTitle.textContent = title;
  el.sheetBody.innerHTML = body;
  el.sheetActs.innerHTML = '';
  for (const a of acts) {
    const b = document.createElement('button');
    b.className = `hudBtn${a.primary ? ' primary' : ''}`;
    b.textContent = a.label;
    b.disabled = Boolean(a.disabled);
    if (a.id) b.id = a.id;
    b.addEventListener('click', a.onClick);
    el.sheetActs.append(b);
  }
  el.sheet.classList.remove('hidden');
}
const closeSheet = () => el.sheet.classList.add('hidden');
el.sheetClose.addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });

/**
 * Responses kept for reuse. Ticking them and pressing USE attaches them to the
 * record in front, which is how a good answer from one conversation becomes
 * context for another.
 */
el.savedBtn.addEventListener('click', openSaved);

async function openSaved() {
  const id = order[focus];
  openSheet({ title: '★ SAVED RESPONSES', body: '<p class="loadingRec">READING</p>' });

  try {
    const [rows, assigned] = await Promise.all([
      api('/api/saved-responses'),
      id != null ? api(`/api/threads/${id}/saved-responses`).catch(() => []) : [],
    ]);
    const on = new Set(assigned);

    const body = rows.length ? rows.map((r) => `
      <label class="pickRow${on.has(r.id) ? ' on' : ''}">
        <input type="checkbox" class="pickBox" data-id="${r.id}"${on.has(r.id) ? ' checked disabled' : ''} />
        <span class="pickMeta">${esc(r.model || 'MODEL')} · ${fmtWhen(r.created_at)}${
          on.has(r.id) ? ' · ALREADY ON THIS RECORD' : ''}</span>
        <span class="pickText">${esc(r.content.slice(0, 320))}${r.content.length > 320 ? '…' : ''}</span>
        <button class="winAct danger" data-act="unsave" data-id="${r.id}">✕</button>
      </label>`).join('')
      : '<div class="notice">NOTHING KEPT YET — ☆ SAVE UNDER ANY ANSWER PUTS IT HERE.</div>';

    openSheet({
      title: `★ SAVED RESPONSES · ${rows.length}`,
      body,
      acts: id == null ? [] : [{
        label: `USE IN REC ${pad(id)}`,
        primary: true,
        onClick: async () => {
          const ids = [...el.sheetBody.querySelectorAll('.pickBox:checked:not(:disabled)')]
            .map((b) => Number(b.dataset.id));
          if (!ids.length) return toast('Tick the ones to attach first', 'info');
          try {
            await api(`/api/threads/${id}/saved-responses`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ savedResponseIds: ids }),
            });
            closeSheet();
            toast(`${ids.length} response${ids.length === 1 ? '' : 's'} attached to REC ${pad(id)}`);
          } catch (err) { toast(err.message, 'err'); }
        },
      }],
    });
  } catch (err) {
    openSheet({ title: '★ SAVED RESPONSES', body: `<div class="notice bad">${esc(err.message)}</div>` });
  }
}

el.sheetBody.addEventListener('click', async (e) => {
  const drop = e.target.closest('[data-act="unsave"]');
  if (drop) {
    e.preventDefault();
    const ok = await openModal({
      title: 'FORGET RESPONSE',
      what: 'This removes the kept copy. Records it is already attached to are not changed.',
      confirmWord: 'REMOVE', ok: 'FORGET', danger: true,
    });
    if (ok == null) return;
    await api(`/api/saved-responses/${drop.dataset.id}`, { method: 'DELETE' });
    toast('Forgotten');
    openSaved();
    return;
  }

  const doc = e.target.closest('[data-act="openDoc"]');
  if (doc) {
    closeSheet();
    newRecordOn(Number(doc.dataset.id), doc.dataset.name);
  }
});

/**
 * A second record on a document already in the library — the same document
 * read twice, without uploading it twice.
 */
el.newRec.addEventListener('click', async () => {
  openSheet({ title: '⊞ NEW RECORD', body: '<p class="loadingRec">READING LIBRARY</p>' });
  try {
    const docs = await api('/api/documents');
    openSheet({
      title: '⊞ NEW RECORD ON…',
      body: docs.length ? docs.map((d) => `
        <button class="pickRow" data-act="openDoc" data-id="${d.id}" data-name="${esc(d.filename)}">
          <span class="pickMeta">${esc(d.kind || '')} · ${(d.chars ?? 0).toLocaleString()} CHARS · ${fmtWhen(d.created_at)}</span>
          <span class="pickText">${esc(d.filename)}</span>
        </button>`).join('')
        : '<div class="notice">THE LIBRARY IS EMPTY — USE + UPLOAD.</div>',
    });
  } catch (err) {
    openSheet({ title: '⊞ NEW RECORD', body: `<div class="notice bad">${esc(err.message)}</div>` });
  }
});

async function newRecordOn(documentId, filename) {
  const title = await openModal({
    title: 'NEW RECORD', label: 'Record title', value: filename, ok: 'OPEN',
  });
  if (title == null) return;
  try {
    const thread = await api('/api/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, documentId }),
    });
    await refreshArchive({ keep: thread.id });
    winEls.get(thread.id)?.querySelector('.composerInput')?.focus();
    toast(`REC ${pad(thread.id)} opened on ${filename}`);
  } catch (err) { toast(`Could not open a record — ${err.message}`, 'err'); }
}
