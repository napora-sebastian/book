/* ===========================================================================
   The mixed console — the deck with the graph over it.

   Two views of one archive, and the argument for putting them on the same page
   is that they answer different questions about the same object. A window says
   what was said in a conversation. The graph says where that conversation came
   from and what could be grown out of it. Having to leave one to consult the
   other is what made them feel like separate products.

   So this file is deliberately thin. It does not re-implement the deck and it
   does not re-implement the canvas: the deck is /grimoire's own script, running
   here untouched, and the canvas is the component /grimoire-graphs mounts.
   What lives here is only the seam between them —

     · a ⁂ on every window, which raises the graph standing on that record
     · the modal it is raised in
     · the two directions of travel: "read this one in the deck" going one way,
       "the graph changed the archive, re-read it" coming back the other.
   =========================================================================== */

const modal = document.getElementById('graphModal');
const stage = document.getElementById('graphStage');
const graphBtn = document.getElementById('graphBtn');
const deckEl = document.getElementById('deck');

let constel = null;          // the mounted canvas, once anyone has asked for it
let placed = new Set();      // threads that stand on some graph
let dirty = false;           // the graph wrote something the deck has not read

/* ------------------------------------------------------------ the ⁂ button */

/**
 * Windows are made by the deck, not by us, and it makes them whenever it likes
 * — on load, after a search, after every write. Rather than reach into its
 * rendering, we watch for windows arriving and put the button on each one once.
 */
function decorate(win) {
  if (win.dataset.mixed === '1') return;
  const acts = win.querySelector('.winActs');
  if (!acts) return;
  win.dataset.mixed = '1';

  const btn = document.createElement('button');
  btn.className = 'winAct graphAct';
  btn.dataset.mix = 'graph';
  btn.textContent = '⁂';
  btn.title = 'Where this record stands in the graph — and what can be grown from it';
  acts.prepend(btn);
  markOne(win);
}

const markOne = (win) => {
  const btn = win.querySelector('[data-mix="graph"]');
  if (!btn) return;
  const on = placed.has(Number(win.dataset.id));
  btn.classList.toggle('on', on);
  btn.title = on
    ? 'This record is a point on a graph — open it there'
    : 'This record is not on a graph yet — put it down as a point';
};

const sweep = () => { for (const win of deckEl.querySelectorAll('.win')) decorate(win); };
const markAll = () => { for (const win of deckEl.querySelectorAll('.win')) markOne(win); };

new MutationObserver(sweep).observe(deckEl, { childList: true, subtree: true });

/** Which records are already points. One request for the whole deck. */
async function readPlaced() {
  try {
    const { threadIds } = await (await fetch('/api/graph-threads')).json();
    placed = new Set(threadIds);
  } catch { /* the marks are a hint, not a feature — a failed read just leaves them off */ }
  markAll();
}

// The button belongs to the window it is on, not to the deck's own delegated
// click handler — which would read a click on a window that is not in front as
// "bring this one forward" and swallow it.
deckEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-mix="graph"]');
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  openGraph(Number(btn.closest('.win').dataset.id));
}, true);

/* ---------------------------------------------------------------- the modal */

/**
 * Mounted on first use and then kept for the life of the page.
 *
 * Not torn down on close, and that is load-bearing: a branch opened in the
 * graph can be left answering while the modal is shut, and its tokens have to
 * keep landing in a card that still exists. Closing hides the glass; it does
 * not stop the work behind it.
 */
async function ensureCanvas() {
  if (constel) return constel;
  const { mountConstellation } = await import('/grimoire-graphs/constellation.js');
  constel = mountConstellation(stage, {
    embedded: true,
    onClose: () => closeGraph(),
    // "Read this one properly" — the deck behind is already the better place
    // for a transcript, its document, its traces and its exports.
    onOpenRecord: (threadId) => {
      closeGraph();
      window.deck?.reveal(threadId);
    },
    // A turn, a branch, a deleted conversation. The deck is showing the archive
    // as it was before that, so it is marked stale rather than re-read now —
    // rebuilding the stack under a modal nobody can see would be work spent on
    // nothing, and it would move the deck while the user is not looking at it.
    onArchiveChanged: () => { dirty = true; },
  });
  await constel.ready;
  return constel;
}

async function openGraph(threadId = null) {
  modal.classList.remove('hidden');
  document.body.classList.add('graphOpen');

  const c = await ensureCanvas();
  c.setVisible(true);
  c.fit();

  // A record that is on no graph is not an error — on the first day it is every
  // record. `focusThread` offers to put it down instead of refusing.
  if (threadId != null) await c.focusThread(threadId);
}

async function closeGraph() {
  modal.classList.add('hidden');
  document.body.classList.remove('graphOpen');
  constel?.setVisible(false);

  // Whatever the graph did to the archive lands on the deck now, at the moment
  // the deck becomes the thing being looked at again.
  if (dirty) {
    dirty = false;
    try { await window.deck?.refresh(); } catch { /* the deck reports its own failures */ }
  }
  await readPlaced();
}

modal.addEventListener('click', (ev) => { if (ev.target === modal) closeGraph(); });
graphBtn.addEventListener('click', () => openGraph(window.deck?.front() ?? null));

/* ------------------------------------------------------------------- keys */

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  const open = !modal.classList.contains('hidden');

  if (ev.key === 'Escape' && open) {
    // The canvas gets first refusal: a dialog, a sheet or an open inspector all
    // want ESC before the modal does, and taking it from them would close the
    // whole graph when the user meant to close one panel of it.
    if (constel?.busy()) return;
    ev.preventDefault();
    ev.stopPropagation();
    return void closeGraph();
  }

  if (typing || open) return;
  if (ev.key === 'g' || ev.key === 'G') {
    ev.preventDefault();
    openGraph(window.deck?.front() ?? null);
  }
}, true);

/* -------------------------------------------------------------------- boot */

sweep();
readPlaced();

// The deck builds its windows during its own boot, which may not have finished
// when this module runs. The observer catches those; this catches the case
// where they arrived in between.
requestAnimationFrame(sweep);

// /grimoire-mix#graph=12 opens straight onto the graph standing on record 12,
// which is what the deck's own #thread= link becomes once there is a graph.
const deep = /^#graph=(\d+)$/.exec(location.hash);
if (deep) openGraph(Number(deep[1]));
