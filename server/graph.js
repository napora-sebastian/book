/* ===========================================================================
   The Graph — the archive as a network instead of a list.

   The deck answers "which conversations do I have?". The graph answers the
   question that comes after it: "what came *from* what?". You put down one
   point — a book at a chosen version, or a conversation you have already had —
   and every line out of it is a new conversation opened from that point, which
   reads it as its context. That conversation is itself a point, so the next
   line comes off it, and the work grows outward instead of down.

   Two rules make the whole thing:

     1. A node is a pointer, never a copy. A conversation on the canvas is an
        ordinary thread — the deck lists it, the Oracle searches it, its answers
        file as document versions. The graph records only where it came from.

     2. Context is walked, not stored. Sending a turn on a node assembles its
        sources by walking upstream at that moment, so re-pinning a book to
        another version, or drawing one more line into a node, changes what the
        next turn reads without touching anything that was already said.
   =========================================================================== */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';
import * as llm from './llm.js';
import {
  documentPart, threadPart, notePart, attachedParts, wrapParts, sourceSummary,
} from './sources.js';
import { graphTitlePrompt, suggestTitle } from './naming.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ sources */

/**
 * Everything upstream of a node, in reading order, as one body of text.
 *
 * The result goes in exactly where a thread's own document would — so a graph
 * turn is indistinguishable from a normal one from `streamTurn` down, including
 * the prefix-cache handshake and the map-reduce path when it overflows.
 *
 * The per-line mode is honoured at the *first* hop only: it says how this node
 * reads its own parent. Points further upstream contribute in full, because
 * they are what that parent was itself answered from.
 */
export function assembleSource(nodeId) {
  const direct = new Map(db.parentEdges(nodeId).map((e) => [e.source_id, e.mode]));
  const ids = db.ancestorIds(nodeId);

  const parts = [];
  const walked = new Set();
  for (const id of ids) {
    const node = db.getGraphNode(id);
    if (!node) continue;
    const mode = direct.get(id) ?? 'full';
    if (mode === 'none') continue;

    const src = node.kind === 'document'
      ? documentPart({ documentId: node.document_id, version: node.doc_version })
      : node.kind === 'note'
        ? notePart({ node })
        : threadPart({ threadId: node.thread_id, mode, label: node.label });
    if (src?.text?.trim()) {
      parts.push({ ...src, nodeId: id });
      // Only pointers can arrive twice — a note is unique to its canvas, so
      // there is nothing for the de-duplication below to match it against.
      if (node.kind === 'document') walked.add(`document:${node.document_id}`);
      else if (node.kind === 'thread') walked.add(`thread:${node.thread_id}`);
    }
  }

  // Then whatever was attached to this conversation by hand. A line on the
  // canvas and a source picked from the list are the same promise — "answer me
  // from this too" — so they arrive in the same body of text, the drawn ones
  // first because they are what the point was opened from.
  //
  // Anything already carried in by a line is dropped here rather than sent
  // twice: the two routes can name the same conversation — one drawn on this
  // canvas, one attached before the line existed — and paying for that
  // transcript twice is the whole cost of the turn for nothing.
  const self = db.getGraphNode(nodeId);
  if (self?.thread_id) {
    parts.push(...attachedParts(self.thread_id)
      .filter((p) => !(p.refKind === 'thread' && walked.has(`thread:${p.refId}`))));
  }

  return wrapParts(parts);
}

/**
 * Somewhere to put an auto-placed point: one column right of its parent, and
 * pushed down until it is not sitting on anything.
 *
 * Counting the parent's existing children and multiplying by a lane height is
 * the obvious version, and it is wrong the moment the canvas has been tidied or
 * dragged — the lane index says nothing about where those siblings actually
 * ended up. This looks at the positions instead.
 */
const COL_X = 360;     // one column right
const ROW_Y = 220;     // one card down, with air
const CLEAR_X = 300;   // a card is 272 wide; anything nearer shares its column
const CLEAR_Y = 190;

export function freeSpotNear(graphId, parent) {
  const placed = db.listGraphNodes(graphId);
  const x = parent.x + COL_X;
  let y = parent.y;

  // Bounded: a canvas cannot have more collisions than it has points.
  for (let tries = 0; tries <= placed.length; tries++) {
    const clash = placed.some((n) => Math.abs(n.x - x) < CLEAR_X && Math.abs(n.y - y) < CLEAR_Y);
    if (!clash) break;
    y += ROW_Y;
  }
  return { x, y };
}

/* --------------------------------------------------------------- importing

   An archive that has been used for months is already a graph — it is just
   written down as a `document_id` on a thread, a `source_message_id` on a
   version, and a row in `saved_response_threads`. Import reads those three
   facts back out and draws them.

   What it will NOT do is invent lineage. Two conversations on the same book are
   siblings under that book, not a chain: nothing in the archive says one was
   answered from the other, and a line that claims otherwise would send text
   into a prompt that never informed it. Every line laid down here corresponds
   to something the store actually records.
   ------------------------------------------------------------------------ */

const IMPORT_COL_X = 380;   // book column → conversation column
const IMPORT_ROW_Y = 210;   // one conversation to the next
const IMPORT_GROUP_GAP = 90;

/**
 * What an import would do, before it does any of it.
 *
 * Shown in full rather than summarised, because the interesting part is always
 * the exceptions: the conversation already on a canvas, the book nobody ever
 * asked anything about, the answer that was carried from one record into
 * another two months ago and is the only real line in the whole archive.
 */
export function migrationPlan() {
  const placedThreads = new Set(db.placedThreadIds());
  const threads = db.listThreads(1000);
  const documents = db.listDocuments(1000);

  // Authorship: which conversations actually rewrote the book, as opposed to
  // merely talking about it. Not a line — a book has no incoming lines — but it
  // is written onto the line that feeds the conversation, so the canvas can say
  // "this is the one that produced v5".
  const authored = new Map();               // threadId → [versions]
  for (const row of db.versionAuthors()) {
    if (!authored.has(row.thread_id)) authored.set(row.thread_id, []);
    authored.get(row.thread_id).push(row.version);
  }

  const byDoc = new Map(documents.map((d) => [d.id, []]));
  const loose = [];
  for (const t of threads) {
    const row = {
      id: t.id,
      title: t.title,
      message_count: t.message_count,
      updated_at: t.updated_at,
      placed: placedThreads.has(t.id),
      filed: authored.get(t.id) ?? [],
    };
    if (t.document_id && byDoc.has(t.document_id)) byDoc.get(t.document_id).push(row);
    else loose.push(row);
  }

  const known = new Set(threads.map((t) => t.id));
  const reuse = db.answerReuseLinks()
    .filter((r) => known.has(r.from_thread) && known.has(r.to_thread));

  const docs = documents.map((d) => ({
    id: d.id,
    filename: d.filename,
    chars: d.chars,
    versions: d.version,
    threads: byDoc.get(d.id) ?? [],
  }));

  const importable = [...docs.flatMap((d) => d.threads), ...loose].filter((t) => !t.placed);

  return {
    documents: docs,
    loose,
    reuse,
    graphs: db.listGraphs(),
    totals: {
      documents: docs.length,
      documentsWithWork: docs.filter((d) => d.threads.length).length,
      conversations: threads.length,
      placed: threads.length - importable.length,
      importable: importable.length,
      loose: loose.filter((t) => !t.placed).length,
      authored: authored.size,
      reuse: reuse.length,
    },
  };
}

/**
 * Draw the plan.
 *
 *   per-document  one graph per book — the way the archive is actually shaped,
 *                 and the one that stays readable when a book has nine chats
 *   single        everything on one canvas, for seeing the whole archive at once
 *
 * Idempotent by default: a conversation already standing on some graph is left
 * where it is, so running this twice does not put a second copy of the archive
 * beside the first.
 */
export function runMigration({
  mode = 'per-document',
  followReuse = true,
  skipPlaced = true,
  threadIds = null,
  title = null,
} = {}) {
  const plan = migrationPlan();
  const want = threadIds ? new Set(threadIds.map(Number)) : null;
  const take = (t) => (want ? want.has(t.id) : true) && !(skipPlaced && t.placed);

  const groups = plan.documents
    .map((d) => ({ doc: d, threads: d.threads.filter(take) }))
    .filter((g) => g.threads.length);
  const looseThreads = plan.loose.filter(take);

  if (!groups.length && !looseThreads.length) {
    return { graphs: [], nodes: 0, edges: 0, reuseSkipped: 0, skipped: plan.totals.placed, empty: true };
  }

  // threadId → { graphId, nodeId }, so the reuse lines can be drawn afterwards
  // and only where both ends landed on the same canvas.
  const placement = new Map();
  const made = [];
  let nodeCount = 0;
  let edgeCount = 0;
  // A reused answer whose two ends land on different canvases cannot be drawn:
  // a line is a relationship *within* one graph. Counted rather than swallowed,
  // because the user ticked a box that promised it.
  let reuseSkipped = 0;

  const authoredNote = (t) => (t.filed.length
    ? `produced v${t.filed.join(', v')}`
    : null);

  /** One book and its conversations: the book on the left, the chats fanned
   *  out to its right, and a line from the book into each of them. */
  const layGroup = (graphId, group, topY) => {
    const n = group.threads.length;
    const doc = db.addGraphNode({
      graphId, kind: 'document', documentId: group.doc.id,
      x: 0, y: Math.round(topY + ((n - 1) * IMPORT_ROW_Y) / 2),
    });
    nodeCount++;

    group.threads.forEach((t, i) => {
      const node = db.addGraphNode({
        graphId, kind: 'thread', threadId: t.id,
        x: IMPORT_COL_X, y: Math.round(topY + i * IMPORT_ROW_Y),
      });
      nodeCount++;
      placement.set(t.id, { graphId, nodeId: node.id });
      db.addGraphEdge({
        graphId, sourceId: doc.id, targetId: node.id, mode: 'full', label: authoredNote(t),
      });
      edgeCount++;
    });

    return topY + Math.max(1, n) * IMPORT_ROW_Y + IMPORT_GROUP_GAP;
  };

  /** A conversation with no book behind it is a root in its own right — the
   *  "I only have a chat, and it is the source" case. */
  const layLoose = (graphId, list, topY) => {
    list.forEach((t, i) => {
      const node = db.addGraphNode({
        graphId, kind: 'thread', threadId: t.id, x: 0, y: Math.round(topY + i * IMPORT_ROW_Y),
      });
      nodeCount++;
      placement.set(t.id, { graphId, nodeId: node.id });
    });
    return topY + list.length * IMPORT_ROW_Y + IMPORT_GROUP_GAP;
  };

  if (mode === 'single') {
    const graph = db.createGraph(title?.trim() || 'The archive');
    made.push(graph);
    let y = 0;
    for (const g of groups) y = layGroup(graph.id, g, y);
    if (looseThreads.length) layLoose(graph.id, looseThreads, y);
  } else {
    for (const g of groups) {
      const graph = db.createGraph(g.doc.filename);
      made.push(graph);
      layGroup(graph.id, g, 0);
    }
    if (looseThreads.length) {
      const graph = db.createGraph('Conversations with no book');
      made.push(graph);
      layLoose(graph.id, looseThreads, 0);
    }
  }

  // The one relationship the archive records outright: an answer from one
  // conversation that somebody attached to another. Drawn as `last`, because
  // what was carried across was the answer, not the argument behind it.
  if (followReuse) {
    for (const link of plan.reuse) {
      const from = placement.get(link.from_thread);
      const to = placement.get(link.to_thread);
      if (!from || !to) continue;
      if (from.graphId !== to.graphId) { reuseSkipped++; continue; }
      try {
        db.addGraphEdge({
          graphId: from.graphId, sourceId: from.nodeId, targetId: to.nodeId,
          mode: 'last', label: 'answer reused',
        });
        edgeCount++;
      } catch {
        // A loop or a duplicate. The rest of the import is not worth losing
        // over one line that the graph refuses to hold.
        reuseSkipped++;
      }
    }
  }

  return {
    graphs: made.map((g) => db.getGraph(g.id)),
    nodes: nodeCount,
    edges: edgeCount,
    reuseSkipped,
    skipped: plan.totals.placed,
    empty: false,
  };
}

/* ------------------------------------------------------------------- mount */

export function mountGraph(app, { streamTurn }) {
  const publicDir = path.join(__dirname, '..', 'public', 'grimoire-graphs');

  // Clean URL, same reason the deck has one: static would otherwise redirect
  // /grimoire-graphs to /grimoire-graphs/.
  app.get('/grimoire-graphs', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  /* ------------------------------------------------------------- graphs */

  app.get('/api/graphs', (_req, res) => res.json(db.listGraphs()));

  app.post('/api/graphs', (req, res) => {
    res.json(db.createGraph(req.body?.title));
  });

  app.patch('/api/graphs/:id', (req, res) => {
    const title = (req.body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const g = db.renameGraph(Number(req.params.id), title);
    if (!g) return res.status(404).json({ error: 'No such graph.' });
    res.json(g);
  });

  /**
   * What this graph could be called, read from the points standing on it.
   * A suggestion only — PATCH above is still what writes a name, and only
   * once the user has kept it.
   */
  app.post('/api/graphs/:id/suggest-title', asyncRoute(async (req, res) => {
    const built = graphTitlePrompt(Number(req.params.id));
    if (!built) return res.status(404).json({ error: 'No such graph.' });
    try {
      const out = await suggestTitle(built.messages, { model: req.body?.model });
      res.json({ title: out.title, model: out.model, current: built.subject.title });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }));

  app.delete('/api/graphs/:id', (req, res) => {
    // Points go with the graph; the threads and books they pointed at do not.
    if (!db.deleteGraph(Number(req.params.id))) {
      return res.status(404).json({ error: 'No such graph.' });
    }
    res.json({ ok: true });
  });

  /**
   * The whole canvas in one request: points, lines, and the library the
   * "add a source" pickers are filled from. Drawing a graph means knowing all
   * of it at once, so there is no per-node round trip.
   */
  app.get('/api/graphs/:id', (req, res) => {
    const id = Number(req.params.id);
    const graph = db.getGraph(id);
    if (!graph) return res.status(404).json({ error: 'No such graph.' });
    res.json({ graph, nodes: db.listGraphNodes(id), edges: db.listGraphEdges(id) });
  });

  /**
   * Everything a picker can seed a point from. Text and blobs excluded, and
   * every row carries the graphs it already stands on: placing a conversation
   * that is already the root of another graph is a legitimate thing to do — the
   * point is a pointer, not a copy — but it should be a decision, not a
   * surprise found later.
   */
  app.get('/api/graph-library', (_req, res) => {
    const documents = db.listDocuments().map(({ text, data, ...rest }) => ({
      ...rest,
      graphs: db.graphsUsing({ documentId: rest.id }),
    }));
    const threads = db.listThreads().map((t) => ({
      ...t,
      graphs: db.graphsUsing({ threadId: t.id }),
    }));
    res.json({ documents, threads });
  });

  /**
   * The shelf rather than one canvas: every graph, what each stands on, and
   * what any two of them share. This is the view that cannot be had from inside
   * a graph — where a book is reused across four lines of work, which graphs
   * are entangled, and which stand alone.
   */
  app.get('/api/graph-atlas', (_req, res) => res.json(db.graphAtlas()));

  /**
   * Where else this exact book or conversation stands. Asked per point by the
   * inspector, so travelling from one canvas to another that reads the same
   * thing is one click rather than a hunt through the picker.
   */
  app.get('/api/graph-usage', (req, res) => {
    const documentId = req.query.document != null ? Number(req.query.document) : null;
    const threadId = req.query.thread != null ? Number(req.query.thread) : null;
    if (documentId == null && threadId == null) {
      return res.status(400).json({ error: 'document or thread is required.' });
    }
    res.json({ graphs: db.graphsUsing({ documentId, threadId }) });
  });

  /* -------------------------------------------------------------- points */

  /**
   * Put down a point.
   *
   *   { kind: 'document', documentId, docVersion? }  a book, at a version
   *   { kind: 'thread',   threadId }                 a conversation you have
   *   { kind: 'thread',   from?, mode?, title? }     a NEW conversation, opened
   *                                                  from `from` (a node id)
   *   { kind: 'note',     text, label?, from? }      a piece of text of its own
   *
   * The third form is the one the graph is for: it creates the thread, drops
   * the point, and draws the line in a single write, so branching is one click
   * rather than three.
   *
   * The fourth is what makes a canvas an outline as well as a history — a
   * heading, a category, a passage lifted out of the book — and it takes `from`
   * on the same terms, so a category hangs off the book it categorises.
   */
  app.post('/api/graphs/:id/nodes', (req, res) => {
    const graphId = Number(req.params.id);
    if (!db.getGraph(graphId)) return res.status(404).json({ error: 'No such graph.' });

    const { kind, documentId, threadId, docVersion, label, x = 0, y = 0 } = req.body || {};
    const from = req.body?.from != null ? Number(req.body.from) : null;

    if (kind === 'document') {
      const doc = db.getDocument(Number(documentId));
      if (!doc) return res.status(404).json({ error: 'No such document.' });
      const node = db.addGraphNode({
        graphId, kind: 'document', documentId: doc.id,
        docVersion: docVersion != null ? Number(docVersion) : null,
        label: label ?? null, x, y,
      });
      return res.json({ node, edge: null });
    }

    if (kind === 'note') {
      const body = String(req.body?.text ?? '');
      if (!body.trim() && !String(label ?? '').trim()) {
        return res.status(400).json({ error: 'A note needs text or a label.' });
      }

      let parent = null;
      if (from != null) {
        parent = db.getGraphNode(from);
        if (!parent || parent.graph_id !== graphId) {
          return res.status(404).json({ error: 'No such source point.' });
        }
      }
      // A note dropped by hand lands where the user clicked; one hung off a
      // point lands beside that point, because nothing chose a position for it.
      const at = parent && !('x' in (req.body || {})) ? freeSpotNear(graphId, parent) : { x, y };

      // Provenance follows the parent when the parent is a book, so "categorise
      // this chapter" produces notes that remember which chapter.
      const srcDocumentId = req.body?.srcDocumentId != null
        ? Number(req.body.srcDocumentId)
        : parent?.kind === 'document' ? parent.document_id
          : parent?.kind === 'note' ? parent.src_document_id
            : null;

      const node = db.addGraphNode({
        graphId, kind: 'note', label: label ?? null, text: body,
        srcDocumentId,
        srcFrom: req.body?.srcFrom != null ? Number(req.body.srcFrom) : null,
        srcTo: req.body?.srcTo != null ? Number(req.body.srcTo) : null,
        x: at.x, y: at.y,
      });

      let edge = null;
      if (parent) {
        try {
          edge = db.addGraphEdge({
            graphId, sourceId: parent.id, targetId: node.id, mode: req.body?.mode || 'full',
          });
        } catch (err) {
          return res.status(200).json({ node, edge: null, warning: err.message });
        }
      }
      return res.json({ node, edge });
    }

    if (kind !== 'thread') {
      return res.status(400).json({ error: 'kind must be document, thread or note.' });
    }

    // An existing conversation being placed on the canvas.
    let thread = threadId != null ? db.getThread(Number(threadId)) : null;
    if (threadId != null && !thread) return res.status(404).json({ error: 'No such thread.' });

    // A new one, branched off a point. It inherits that point's book — not for
    // context (the walk supplies that) but so the version rail and "file this
    // answer as a version" keep working on the branch.
    if (!thread) {
      let inheritedDoc = null;
      if (from != null) {
        const parent = db.getGraphNode(from);
        if (!parent || parent.graph_id !== graphId) {
          return res.status(404).json({ error: 'No such source point.' });
        }
        inheritedDoc = parent.kind === 'document'
          ? parent.document_id
          : parent.kind === 'note'
            ? parent.src_document_id
            : db.getThread(parent.thread_id)?.document_id ?? null;
      }
      thread = db.createThread({
        title: (req.body?.title ?? '').trim() || 'New branch',
        documentId: inheritedDoc,
        model: req.body?.model ?? null,
      });
    }

    const node = db.addGraphNode({
      graphId, kind: 'thread', threadId: thread.id, label: label ?? null, x, y,
    });

    let edge = null;
    if (from != null) {
      try {
        edge = db.addGraphEdge({
          graphId, sourceId: from, targetId: node.id, mode: req.body?.mode || 'full',
        });
      } catch (err) {
        // The point stands even if the line was refused — the user can draw it
        // by hand, and deleting the node behind their back would be worse.
        return res.status(200).json({ node, edge: null, warning: err.message });
      }
    }

    res.json({ node, edge });
  });

  app.patch('/api/graphs/:gid/nodes/:id', (req, res) => {
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== Number(req.params.gid)) {
      return res.status(404).json({ error: 'No such point.' });
    }
    const { x, y, label } = req.body || {};
    const docVersion = 'docVersion' in (req.body || {})
      ? (req.body.docVersion == null ? null : Number(req.body.docVersion))
      : undefined;
    const text = 'text' in (req.body || {}) ? req.body.text : undefined;
    try {
      res.json(db.updateGraphNode(node.id, { x, y, docVersion, label, text }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Take a point off the canvas. `?withThread=1` also deletes the conversation
   * it pointed at — the branch was a mistake and should not linger in the deck.
   */
  app.delete('/api/graphs/:gid/nodes/:id', (req, res) => {
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== Number(req.params.gid)) {
      return res.status(404).json({ error: 'No such point.' });
    }
    const withThread = String(req.query.withThread ?? '') === '1';
    db.deleteGraphNode(node.id);
    if (withThread && node.kind === 'thread' && node.thread_id) db.deleteThread(node.thread_id);
    res.json({ ok: true, threadDeleted: withThread && node.kind === 'thread' });
  });

  /**
   * Break a note into its parts.
   *
   * body: { parts: [{ label?, text }] }
   *
   * The parent keeps its label and loses its body — it becomes the heading over
   * what it used to say. See `db.splitGraphNote` for why the text moves instead
   * of being copied.
   */
  app.post('/api/graphs/:gid/nodes/:id/split', (req, res) => {
    const graphId = Number(req.params.gid);
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== graphId) {
      return res.status(404).json({ error: 'No such point.' });
    }
    try {
      // Laid out down one column beside the parent, each part cleared against
      // whatever is already standing there — the same placement a branch gets.
      const out = db.splitGraphNote(node.id, req.body?.parts, {
        spot: () => freeSpotNear(graphId, node),
      });
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* --------------------------------------------------------------- lines */

  app.post('/api/graphs/:id/edges', (req, res) => {
    const graphId = Number(req.params.id);
    if (!db.getGraph(graphId)) return res.status(404).json({ error: 'No such graph.' });
    const { sourceId, targetId, mode, label } = req.body || {};
    try {
      res.json(db.addGraphEdge({
        graphId, sourceId: Number(sourceId), targetId: Number(targetId), mode, label,
      }));
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  app.patch('/api/graphs/:gid/edges/:id', (req, res) => {
    const edge = db.updateGraphEdge(Number(req.params.id), req.body || {});
    if (!edge) return res.status(404).json({ error: 'No such line.' });
    res.json(edge);
  });

  app.delete('/api/graphs/:gid/edges/:id', (req, res) => {
    if (!db.deleteGraphEdge(Number(req.params.id))) {
      return res.status(404).json({ error: 'No such line.' });
    }
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------- reading */

  /**
   * What this point will be answered from, without answering anything. The
   * inspector shows it before you send, which is the only way to tell a branch
   * that reads a whole book from one that reads a single paragraph of it.
   */
  app.get('/api/graphs/:gid/nodes/:id/source', (req, res) => {
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== Number(req.params.gid)) {
      return res.status(404).json({ error: 'No such point.' });
    }
    const src = assembleSource(node.id);
    // The attached list goes back whole, not only the parts that made it into
    // the text: a source that is empty, or already carried in by a line, is
    // still attached — and the panel that offers to detach it has to show it.
    res.json({
      ...sourceSummary(src),
      attached: node.thread_id ? db.listThreadSources(node.thread_id) : [],
      preview: src.text.slice(0, 4000),
    });
  });

  /** The conversation on a point, plus the lines feeding it. */
  app.get('/api/graphs/:gid/nodes/:id/thread', (req, res) => {
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== Number(req.params.gid)) {
      return res.status(404).json({ error: 'No such point.' });
    }
    if (node.kind !== 'thread') return res.status(409).json({ error: 'That point is a source, not a conversation.' });

    const thread = db.getThread(node.thread_id);
    if (!thread) return res.status(404).json({ error: 'The conversation is gone.' });

    const { text, data, ...rest } = thread;
    let document = null;
    if (thread.document_id) {
      const doc = db.getDocument(thread.document_id);
      if (doc) {
        const versions = db.listDocumentVersions(doc.id);
        document = {
          id: doc.id, filename: doc.filename, chars: doc.chars,
          versions: versions.length || 1, newest: versions[0]?.version ?? 1,
        };
      }
    }

    res.json({
      node,
      thread: rest,
      messages: db.getMessages(node.thread_id),
      // Handed over with the transcript rather than fetched per answer: the
      // canvas draws its log as one string, and a render arriving mid-fetch
      // would wipe whichever ones had landed.
      suggestions: db.listThreadSuggestions(node.thread_id),
      document,
      parents: db.parentEdges(node.id),
      usage: db.threadUsage(node.thread_id),
    });
  });

  /* --------------------------------------------------------------- turns */

  /**
   * Send a turn on a point. Same SSE contract as `/api/threads/:id/messages` —
   * the only difference is where the context came from, and that difference is
   * resolved here before `streamTurn` ever sees it.
   */
  app.post('/api/graphs/:gid/nodes/:id/messages', asyncRoute(async (req, res) => {
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== Number(req.params.gid)) {
      return res.status(404).json({ error: 'No such point.' });
    }
    if (node.kind !== 'thread') return res.status(409).json({ error: 'A source point cannot be asked a question.' });

    const threadId = node.thread_id;
    const thread = db.getThread(threadId);
    if (!thread) return res.status(404).json({ error: 'The conversation is gone.' });

    const { content, taskId = 'chat', model } = req.body || {};
    const question = (content ?? '').trim();
    if (!question) return res.status(400).json({ error: 'Empty message.' });

    const chosenModel = model || thread.model || llm.config().model;
    if (model && model !== thread.model) db.setThreadModel(threadId, model);

    // Honours the point's own start marker, the same as a turn sent from the
    // deck: the graph supplies the upstream sources, the thread supplies as
    // much of itself as the user left switched on.
    const history = db.contextMessages(threadId).map((m) => ({ role: m.role, content: m.content }));
    const userMsg = db.addMessage({ threadId, role: 'user', content: question, task: taskId });

    if (history.length === 0 && (!thread.title || /^(New thread|New branch)$/.test(thread.title))) {
      db.renameThread(threadId, question.slice(0, 60));
    }

    // Assembled per turn, never cached: re-pinning a book upstream or drawing
    // one more line in must change the very next answer.
    const source = assembleSource(node.id);

    await streamTurn(res, {
      threadId, userMsg, history, taskId, chosenModel,
      source: source.parts.length ? { text: source.text, filename: source.filename } : null,
      // Which canvas the question was asked from. The tool layer defaults its
      // writes here, so "add a note for that" lands where the user is looking
      // instead of asking them which graph they meant.
      graphId: node.graph_id,
    });
  }));

  /**
   * Re-run the tail of a point's conversation. The plain thread route would do
   * this too — but it would rebuild the context from the thread's own document,
   * which on a graph is not what the turn was answered from. So the retry lives
   * here, where the upstream walk is.
   */
  app.post('/api/graphs/:gid/nodes/:id/messages/:messageId/retry', asyncRoute(async (req, res) => {
    const node = db.getGraphNode(Number(req.params.id));
    if (!node || node.graph_id !== Number(req.params.gid)) {
      return res.status(404).json({ error: 'No such point.' });
    }
    if (node.kind !== 'thread') return res.status(409).json({ error: 'A source point has nothing to retry.' });

    const threadId = node.thread_id;
    const thread = db.getThread(threadId);
    if (!thread) return res.status(404).json({ error: 'The conversation is gone.' });

    const messages = db.getMessages(threadId);
    const last = messages[messages.length - 1];
    const target = messages.find((m) => m.id === Number(req.params.messageId));

    if (!target) return res.status(404).json({ error: 'No such message.' });
    if (target.id !== last.id) return res.status(409).json({ error: 'Only the last turn can be retried.' });
    if (target.role === 'assistant' && !target.error) {
      return res.status(409).json({ error: 'That turn succeeded — send a new message instead.' });
    }

    // Drop the failed reply so the retry does not stack a second answer under
    // the same question. Its traces stay behind for the trace sheet.
    if (target.role === 'assistant') db.deleteMessage(target.id);

    const userIdx = target.role === 'user' ? messages.length - 1 : messages.length - 2;
    const userMsg = messages[userIdx];
    if (!userMsg || userMsg.role !== 'user') return res.status(409).json({ error: 'No question to retry.' });

    const chosenModel = req.body?.model || thread.model || llm.config().model;
    if (req.body?.model && req.body.model !== thread.model) db.setThreadModel(threadId, req.body.model);

    const source = assembleSource(node.id);
    await streamTurn(res, {
      threadId,
      userMsg,
      history: messages.slice(db.contextStartIndex(threadId, messages), userIdx)
        .map((m) => ({ role: m.role, content: m.content })),
      taskId: userMsg.task || 'chat',
      chosenModel,
      source: source.parts.length ? { text: source.text, filename: source.filename } : null,
      graphId: node.graph_id,
    });
  }));

  /**
   * Branch straight from one answer: create the point, draw the line, and put
   * that answer in as the child's only source. This is the "build the next
   * point off this line" move, done without going back to the canvas.
   */
  app.post('/api/graphs/:gid/nodes/:id/branch', (req, res) => {
    const graphId = Number(req.params.gid);
    const parent = db.getGraphNode(Number(req.params.id));
    if (!parent || parent.graph_id !== graphId) {
      return res.status(404).json({ error: 'No such point.' });
    }

    // Which book the branch inherits — not for context (the upstream walk
    // supplies that) but so the version rail and "file this answer as a
    // version" keep working on it. A note passes on the book it was lifted from.
    const inheritedDoc = parent.kind === 'document'
      ? parent.document_id
      : parent.kind === 'note'
        ? parent.src_document_id
        : db.getThread(parent.thread_id)?.document_id ?? null;

    const thread = db.createThread({
      title: (req.body?.title ?? '').trim() || 'New branch',
      documentId: inheritedDoc,
      model: req.body?.model ?? null,
    });

    // An explicit position wins — that is the user dropping the line somewhere
    // deliberate. Otherwise find open ground next to the parent.
    const spot = freeSpotNear(graphId, parent);
    const node = db.addGraphNode({
      graphId, kind: 'thread', threadId: thread.id,
      x: req.body?.x ?? spot.x,
      y: req.body?.y ?? spot.y,
    });

    let edge = null;
    try {
      edge = db.addGraphEdge({
        graphId, sourceId: parent.id, targetId: node.id, mode: req.body?.mode || 'full',
      });
    } catch (err) {
      return res.json({ node, thread, edge: null, warning: err.message });
    }
    res.json({ node, thread, edge });
  });

  /* ----------------------------------------------------------- importing */

  /**
   * Kept off `/api/graphs/:id` on purpose: that route is registered above and
   * would happily read "migration-plan" as a graph id.
   */
  app.get('/api/graph-migration/plan', (_req, res) => res.json(migrationPlan()));

  app.post('/api/graph-migration/run', (req, res) => {
    const { mode, followReuse, skipPlaced, threadIds, title } = req.body || {};
    if (mode && !['per-document', 'single'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be per-document or single.' });
    }
    res.json(runMigration({
      mode: mode || 'per-document',
      followReuse: followReuse !== false,
      skipPlaced: skipPlaced !== false,
      threadIds: Array.isArray(threadIds) ? threadIds : null,
      title,
    }));
  });

  /** Which conversations stand on a canvas at all. One request, so a deck of
   *  fifty windows can mark its graph buttons without fifty of them. */
  app.get('/api/graph-threads', (_req, res) => res.json({ threadIds: db.placedThreadIds() }));

  /**
   * Where a conversation stands, if it stands anywhere. The deck asks this to
   * decide whether its graph button opens a canvas or offers to start one.
   */
  app.get('/api/graph-node-for-thread/:threadId', (req, res) => {
    const node = db.graphNodeForThread(Number(req.params.threadId));
    if (!node) return res.json({ node: null, graph: null });
    res.json({ node, graph: db.getGraph(node.graph_id) });
  });

  /**
   * Put a conversation that already exists onto a canvas, with the book it was
   * opened on. Idempotent in both halves: the conversation is not placed twice,
   * and a book already on that canvas is reused rather than duplicated — two
   * points standing for the same book would silently double its text in every
   * prompt downstream of both.
   */
  app.post('/api/graphs/:id/adopt-thread', (req, res) => {
    const graphId = Number(req.params.id);
    if (!db.getGraph(graphId)) return res.status(404).json({ error: 'No such graph.' });

    const thread = db.getThread(Number(req.body?.threadId));
    if (!thread) return res.status(404).json({ error: 'No such conversation.' });

    const placed = db.listGraphNodes(graphId);
    const already = placed.find((n) => n.thread_id === thread.id);
    if (already) return res.json({ node: already, docNode: null, edge: null, already: true });

    const withDocument = req.body?.withDocument !== false && thread.document_id != null;
    let docNode = withDocument ? placed.find((n) => n.document_id === thread.document_id) : null;

    // Somewhere clear: under everything already down, so an adopted point never
    // lands on top of the work that is already on the canvas.
    const floor = placed.length ? Math.max(...placed.map((n) => n.y)) + ROW_Y : 0;

    if (withDocument && !docNode) {
      docNode = db.addGraphNode({
        graphId, kind: 'document', documentId: thread.document_id, x: 0, y: floor,
      });
    }

    const spot = docNode ? freeSpotNear(graphId, docNode) : { x: 0, y: floor };
    const node = db.addGraphNode({ graphId, kind: 'thread', threadId: thread.id, ...spot });

    let edge = null;
    if (docNode) {
      try {
        edge = db.addGraphEdge({ graphId, sourceId: docNode.id, targetId: node.id, mode: 'full' });
      } catch { /* the point stands; the line can be drawn by hand */ }
    }
    res.json({ node, docNode, edge, already: false });
  });

}
