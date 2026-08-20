/* ===========================================================================
   The source picker — what a conversation should read besides its own book.

   Three surfaces ask this question (the deck, a point on the canvas, a record
   in the grimoire) and a fourth pins the same things to an Oracle question.
   They used to each own a flat tick list of records and graphs. Two things were
   missing from all four at once, which is the argument for doing it here:

     · a grain finer than "the whole thing". Wanting one paragraph of a graph
       meant attaching the graph and paying for all of it on every turn, so
       people attached nothing instead.
     · a way to find anything. A shelf that has grown for months cannot be
       ticked from memory — you know what you want the next conversation to
       have read, not which of two hundred records holds it.

   So a row expands into what it contains, every level is tickable, and there is
   a box at the top you can describe your need to.

   Style stays with each surface: this writes semantic class names and reads
   nothing back, the same contract tools-ui.js has.
   =========================================================================== */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (n) => Number(n ?? 0).toLocaleString();

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/** A key that identifies one tickable thing across the whole list. */
export const keyOf = (kind, id) => `${kind}:${id}`;

/* ------------------------------------------------------------------- tags

   Six things can be a source now, and a glyph does not say which. ◈ and ▪ and
   ⁂ are learnable, but nobody should have to learn them to know whether they
   are about to attach one paragraph or a whole book — and the four grains are
   the entire point of the list. So every row carries the word as well.

   The vocabulary is overridable because the app deliberately calls the same
   object different things in different views: the deck's "conversation" is the
   grimoire's "record". A tag that disagrees with the heading above it is worse
   than no tag.
   ------------------------------------------------------------------------- */

export const TAGS = {
  thread: 'CHAT',
  note: 'NOTE',
  graph: 'GRAPH',
  message: 'ANSWER',
  question: 'QUESTION',
  document: 'BOOK',
};

/**
 * The tag for one row. `kind` is the source kind; `as` overrides the word.
 *
 * `data-kind` is what the stylesheets colour off, and it stays the machine
 * kind even when the word is overridden — so a canvas calling a thread a
 * CONVERSATION still gets the same colour as the deck calling it a CHAT.
 */
export const tagHtml = (kind, as = null) =>
  `<span class="srcTag" data-kind="${kind}">${esc(as ?? TAGS[kind] ?? kind)}</span>`;

/* --------------------------------------------------------------- one row */

/** Counts row instances, so each one owns the drawer that hangs under it. */
let rowSeq = 0;

/**
 * `on` maps "kind:id" → the saved row, so a source already attached comes back
 * ticked, in the position it was saved in, with the mode it was saved with.
 */
function rowHtml({
  kind, id, glyph, name, meta, expandable = false, mode = null,
  cur = null, why = null, depth = 0, tag = null,
}) {
  const ticked = Boolean(cur);
  const key = `${kind}:${id}`;
  // The drawer belongs to the ROW, not to the source. One source legitimately
  // stands in two places in the same list — a conversation under CONVERSATIONS
  // and that very conversation as a point on a graph further down — and while
  // the drawers were keyed "kind:id" the second copy opened the first copy's:
  // the row you clicked stayed empty and its contents landed off-screen.
  const uid = `sr${++rowSeq}`;
  return `
    <div class="srcRow${ticked ? ' on' : ''}${why ? ' picked' : ''}" data-key="${key}" data-uid="${uid}" data-depth="${depth}">
      <label class="srcMain">
        <input type="checkbox" class="srcBox" data-kind="${kind}" data-id="${id}"${ticked ? ' checked' : ''} />
        ${expandable
          // A button, not part of the label: inside one, a click would tick the
          // row as well as open it, and opening is not choosing.
          ? `<button type="button" class="srcTwisty" data-expand="${uid}" data-kind="${kind}" data-id="${id}"
                     title="Show what this holds" aria-expanded="false">▸</button>`
          : '<span class="srcTwisty spacer"></span>'}
        <span class="srcGlyph">${glyph}</span>
        <span class="srcText">
          <span class="srcTop">
            ${tagHtml(kind, tag)}
            <span class="srcName">${esc(name)}</span>
          </span>
          <span class="srcMeta">${meta}</span>
          ${why ? `<span class="srcWhy" data-i18n-skip>✦ ${esc(why)}</span>` : ''}
        </span>
      </label>
      ${mode
        ? `<select class="srcMode" data-key="${key}" title="How much of it is read">
             <option value="full"${cur?.mode === 'last' ? '' : ' selected'}>WHOLE</option>
             <option value="last"${cur?.mode === 'last' ? ' selected' : ''}>LAST ANSWER</option>
           </select>`
        : ''}
    </div>
    <div class="srcKids hidden" data-kids="${uid}"></div>`;
}

/* ------------------------------------------------------------- the list */

/**
 * The whole tick list.
 *
 * `on` is a Map of "kind:id" → saved row. `picks` is a Map of the same keys to
 * the reason the search chose them, which is what turns a suggestion into
 * something the user can judge rather than just accept.
 */
export function sourceListHtml(catalog, on, { picks = new Map(), heads = {}, tags = {} } = {}) {
  const rank = (kind, x) => (on.has(keyOf(kind, x.id)) ? on.get(keyOf(kind, x.id)).position : Infinity);
  const H = {
    records: 'RECORDS', graphs: 'GRAPHS', notes: 'NOTES',
    none: 'Nothing here yet.', ...heads,
  };
  const T = { ...TAGS, ...tags };

  const records = [...(catalog.threads ?? [])]
    .sort((a, b) => rank('thread', a) - rank('thread', b))
    .map((t) => rowHtml({
      kind: 'thread', id: t.id, glyph: '◈',
      name: t.title,
      meta: `${t.messages} MSG · ${num(t.chars)} CHARS${t.filename ? ` · ◆ ${esc(t.filename)}` : ''}${
        t.messages ? '' : ' · EMPTY, CARRIES NOTHING'}`,
      // A record with turns can be opened and read one answer at a time.
      expandable: t.messages > 0,
      mode: true,
      tag: T.thread,
      cur: on.get(keyOf('thread', t.id)),
      why: picks.get(keyOf('thread', t.id)),
    })).join('');

  const notes = [...(catalog.notes ?? [])]
    .sort((a, b) => rank('note', a) - rank('note', b))
    .map((n) => rowHtml({
      kind: 'note', id: n.id, glyph: '▪',
      name: n.label || clip(n.text, 60) || 'untitled note',
      meta: `${num(n.chars)} CHARS · ON ⁂ ${esc(n.graph_title)}${
        n.src_filename ? ` · ◆ ${esc(n.src_filename)}` : ''}`,
      tag: T.note,
      cur: on.get(keyOf('note', n.id)),
      why: picks.get(keyOf('note', n.id)),
    })).join('');

  const graphs = [...(catalog.graphs ?? [])]
    .sort((a, b) => rank('graph', a) - rank('graph', b))
    .map((g) => rowHtml({
      kind: 'graph', id: g.id, glyph: '⁂',
      name: g.title,
      // The cost is on the row because it is the thing being decided: a source
      // is re-read on every question from now on, and a graph carrying a whole
      // book is a different proposition from a note.
      meta: `${g.points} POINT${g.points === 1 ? '' : 'S'} · ${g.lines} LINE${g.lines === 1 ? '' : 'S'} · ~${
        num(g.chars)} CHARS${g.points ? '' : ' · EMPTY, CARRIES NOTHING'}`,
      tag: T.graph,
      expandable: g.points > 0,
      cur: on.get(keyOf('graph', g.id)),
      why: picks.get(keyOf('graph', g.id)),
    })).join('');

  return `
    <div class="srcPicker">
      <h4 class="srcHead">${H.records}</h4>
      ${records || `<p class="srcNone">${H.none}</p>`}
      ${notes ? `<h4 class="srcHead">${H.notes}</h4>${notes}` : ''}
      <h4 class="srcHead">${H.graphs}</h4>
      ${graphs || `<p class="srcNone">${H.none}</p>`}
    </div>`;
}

/** The search box that goes above the list. */
export const sourceSearchHtml = (placeholder = 'what should this conversation have read?') => `
  <div class="srcPicker srcFind">
    <input type="text" class="srcNeed" placeholder="${esc(placeholder)}" />
    <button type="button" class="srcFindGo">✦ FIND</button>
    <span class="srcFindSay"></span>
  </div>`;

/* ------------------------------------------------------------- children */

const CHILD = {
  graph: {
    url: (id) => `/api/source-catalog/graph/${id}`,
    rows: (data, on, picks) => (data.points ?? []).map((p) => {
      // A point is offered at whatever grain it actually has. A note holds its
      // own text and can be taken alone; a book or a conversation standing on a
      // canvas is reachable as itself, and is shown here so the graph's shape
      // is legible — but ticking it means ticking that record, not the point.
      if (p.kind === 'note') {
        return rowHtml({
          kind: 'note', id: p.id, glyph: '▪', depth: 1,
          name: p.label || clip(p.preview, 60) || 'untitled note',
          meta: p.chars ? `${num(p.chars)} CHARS · ${esc(clip(p.preview, 90))}`
            : 'HEADING — CARRIES NOTHING ITSELF',
          tag: p.chars ? null : 'HEADING',
          cur: on.get(keyOf('note', p.id)),
          why: picks.get(keyOf('note', p.id)),
        });
      }
      if (p.kind === 'thread') {
        return rowHtml({
          kind: 'thread', id: p.thread_id, glyph: '◈', depth: 1,
          name: p.label || p.thread_title || 'untitled',
          meta: `${p.messages} MSG · ON THIS GRAPH`,
          expandable: p.messages > 0, mode: true, tag: null,
          cur: on.get(keyOf('thread', p.thread_id)),
          why: picks.get(keyOf('thread', p.thread_id)),
        });
      }
      // A book. Not tickable here: a conversation already reads its own, and
      // this one belongs to whichever record was opened from it.
      return `
        <div class="srcRow flat" data-depth="1">
          <span class="srcMain">
            <span class="srcTwisty spacer"></span><span class="srcTwisty spacer"></span>
            <span class="srcGlyph">◆</span>
            <span class="srcText">
              <span class="srcTop">
                ${tagHtml('document')}
                <span class="srcName">${esc(p.label || p.doc_filename || 'missing book')}</span>
              </span>
              <span class="srcMeta">${num(p.doc_chars)} CHARS · A BOOK — READ IT BY TAKING THE GRAPH</span>
            </span>
          </span>
        </div>`;
    }).join(''),
  },
  thread: {
    url: (id) => `/api/source-catalog/thread/${id}`,
    rows: (data, on, picks) => (data.messages ?? []).map((m) => rowHtml({
      kind: 'message', id: m.id, glyph: m.role === 'user' ? '▸' : '◈', depth: 1,
      name: clip(m.preview, 80),
      meta: `${num(m.chars)} CHARS${m.model ? ` · ${esc(m.model)}` : ''}${m.error ? ' · FAILED' : ''}`,
      // The tag carries the whole distinction here, so it does not have to be
      // repeated in the name: one row is what was asked, the next what came back.
      tag: m.role === 'user' ? TAGS.question : TAGS.message,
      cur: on.get(keyOf('message', m.id)),
      why: picks.get(keyOf('message', m.id)),
    })).join(''),
  },
};

/* --------------------------------------------------------------- wiring */

/**
 * Make one rendered list live.
 *
 * `root` is whatever element the list was written into. Returns a handle with
 * `ticked()` — what to save — and `apply(picks)` for the search results.
 */
export function wireSourceList(root, {
  on = new Map(), api, onChange = () => {}, threadId = null, model = null,
} = {}) {
  const picks = new Map();
  const loaded = new Set();

  const rowOf   = (uid) => root.querySelector(`.srcRow[data-uid="${uid}"]`);
  const kidsOf  = (uid) => root.querySelector(`[data-kids="${uid}"]`);
  const modeOf  = (row) => row?.querySelector('.srcMode') ?? null;
  const copiesOf = (kind, id) => [...root.querySelectorAll(`.srcBox[data-kind="${kind}"][data-id="${id}"]`)];

  /* Rows that arrive late start from what the list already says: a graph opened
     after one of its conversations was ticked upstairs shows it ticked, rather
     than offering it again as though it were something else. */
  const adopt = (scope) => {
    scope.querySelectorAll('.srcBox').forEach((b) => {
      // A copy that is itself covered says nothing about what the user wants —
      // it was forced off by its own parent — so only a free copy is followed.
      const twin = copiesOf(b.dataset.kind, b.dataset.id)
        .find((o) => o !== b && !o.disabled && !scope.contains(o));
      if (!twin) return;
      b.checked = twin.checked;
      b.closest('.srcRow').classList.toggle('on', b.checked);
      const from = modeOf(twin.closest('.srcRow'));
      const to = modeOf(b.closest('.srcRow'));
      if (from && to) to.value = from.value;
    });
  };

  /* A parent and its own children are the same text twice. Ticking the parent
     turns the children off and holds them off; untick it and they are yours
     again. Without this the obvious gesture — tick the graph, then tick the one
     note you care about — quietly pays for that note twice. */
  const syncKids = (uid) => {
    const kids = kidsOf(uid);
    if (!kids) return;
    const parentOn = Boolean(rowOf(uid)?.querySelector('.srcBox')?.checked);
    kids.classList.toggle('covered', parentOn);
    kids.querySelectorAll('.srcBox').forEach((b) => {
      b.disabled = parentOn;
      if (parentOn && b.checked) {
        b.checked = false;
        b.closest('.srcRow').classList.remove('on');
      }
    });
    // Uncovered again, a child goes back to whatever the list says about that
    // source elsewhere — otherwise unticking the graph leaves the note inside
    // it reading as untouched while its own row upstairs is still ticked.
    if (!parentOn) adopt(kids);
  };

  const syncAll = () => root.querySelectorAll('.srcRow[data-uid]').forEach((r) => syncKids(r.dataset.uid));

  /* Two rows for one source are still one source. A conversation ticked in the
     list has to show as ticked where it stands on a graph as well, or the list
     says a thing is both attached and not, and the count says two. */
  const mirror = (kind, id, { checked = null, mode = null } = {}) => {
    for (const b of copiesOf(kind, id)) {
      const row = b.closest('.srcRow');
      if (checked != null && !b.disabled) {
        b.checked = checked;
        row.classList.toggle('on', checked);
      }
      if (mode != null) {
        const sel = modeOf(row);
        if (sel) sel.value = mode;
      }
    }
    syncAll();
  };

  const expand = async (twisty) => {
    const uid = twisty.dataset.expand;
    const { kind, id } = twisty.dataset;
    const kids = kidsOf(uid);
    if (!kids) return;

    const open = kids.classList.contains('hidden');
    kids.classList.toggle('hidden', !open);
    twisty.textContent = open ? '▾' : '▸';
    twisty.setAttribute('aria-expanded', String(open));
    if (!open || loaded.has(uid)) return;

    kids.innerHTML = '<p class="srcNone">READING…</p>';
    try {
      const data = await api(CHILD[kind].url(Number(id)));
      kids.innerHTML = CHILD[kind].rows(data, on, picks) || '<p class="srcNone">NOTHING IN IT.</p>';
      loaded.add(uid);
      wireRows(kids);
      adopt(kids);
      syncAll();
    } catch (err) {
      kids.innerHTML = `<p class="srcNone">${esc(err.message)}</p>`;
    }
  };

  function wireRows(scope) {
    scope.querySelectorAll('.srcTwisty[data-expand]').forEach((t) => {
      if (t.dataset.wired) return;
      t.dataset.wired = '1';
      t.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        expand(t);
      });
    });
    scope.querySelectorAll('.srcBox').forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('change', () => {
        mirror(b.dataset.kind, b.dataset.id, { checked: b.checked });
        onChange();
      });
    });
    // Inside a <label>, a click on the mode picker would toggle the tick too.
    scope.querySelectorAll('.srcMode').forEach((s) => {
      if (s.dataset.wired) return;
      s.dataset.wired = '1';
      s.addEventListener('click', (ev) => ev.preventDefault());
      s.addEventListener('change', () => {
        const box = s.closest('.srcRow')?.querySelector('.srcBox');
        if (box) mirror(box.dataset.kind, box.dataset.id, { mode: s.value });
        onChange();
      });
    });
  }

  wireRows(root);
  syncAll();

  /* ------------------------------------------------------------ the find */

  const need = root.querySelector('.srcNeed');
  const go = root.querySelector('.srcFindGo');
  const say = root.querySelector('.srcFindSay');

  const find = async () => {
    const text = need?.value.trim();
    if (!text) return;
    go.disabled = true;
    go.textContent = '✦ READING…';
    say.textContent = '';
    try {
      const out = await api('/api/source-suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ need: text, threadId, model }),
      });
      picks.clear();
      for (const p of out.picks ?? []) picks.set(keyOf(p.kind, p.id), p.why || 'suits what you asked for');

      // Tick what it found and say why, rather than filtering the list down to
      // it: the user is choosing, and a list that hides everything else has
      // made the choice for them.
      let hit = 0;
      for (const p of out.picks ?? []) {
        // Every row standing for that source, not just the first one found:
        // a conversation is picked once but may be shown in two places.
        const boxes = copiesOf(p.kind, p.id).filter((b) => !b.disabled);
        if (!boxes.length) continue;
        hit += 1;
        for (const box of boxes) {
          const row = box.closest('.srcRow');
          row.classList.add('picked');
          if (!row.querySelector('.srcWhy')) {
            const w = document.createElement('span');
            w.className = 'srcWhy';
            w.dataset.i18nSkip = '';
            w.textContent = `✦ ${picks.get(keyOf(p.kind, p.id))}`;
            row.querySelector('.srcText').appendChild(w);
          }
        }
        mirror(p.kind, p.id, { checked: true, mode: p.mode ?? 'full' });
      }
      root.querySelector('.srcRow.picked')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      say.textContent = hit
        ? `${out.thought || ''} — ${hit} ticked, review them`.trim()
        : (out.thought || 'Nothing in the archive fits that.');
      onChange();
    } catch (err) {
      say.textContent = `⚠ ${err.message}`;
    } finally {
      go.disabled = false;
      go.textContent = '✦ FIND';
    }
  };

  go?.addEventListener('click', find);
  need?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); find(); }
  });

  /** What to save, in the order the list shows it — a source at most once. */
  const chosen = () => {
    const out = [];
    const seen = new Set();
    for (const b of root.querySelectorAll('.srcBox')) {
      if (!b.checked || b.disabled) continue;
      const key = keyOf(b.dataset.kind, b.dataset.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: b.dataset.kind,
        id: Number(b.dataset.id),
        mode: modeOf(b.closest('.srcRow'))?.value ?? 'full',
      });
    }
    return out;
  };

  return { ticked: chosen, count: () => chosen().length };
}
