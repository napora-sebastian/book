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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A parent conversation can grow without limit, and pasting all of it into
// every descendant is how a graph three levels deep stops fitting anywhere. So
// a thread source contributes its tail: the most recent turns, whole, up to
// this many characters. Books are not capped here — the context budget and the
// map-reduce split already handle those.
const THREAD_SOURCE_CHARS = Number(process.env.GRAPH_THREAD_SOURCE_CHARS || 60_000);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ sources */

/** The text a document node contributes, at whatever version it is pinned to. */
function documentSource(node) {
  const doc = db.getDocument(node.document_id);
  if (!doc) return null;

  if (node.doc_version != null) {
    const v = db.getDocumentVersion(doc.id, node.doc_version);
    if (v) {
      return {
        kind: 'document',
        name: v.filename || doc.filename,
        version: v.version,
        text: v.text,
      };
    }
  }
  const newest = db.listDocumentVersions(doc.id)[0];
  return {
    kind: 'document',
    name: doc.filename,
    version: newest?.version ?? 1,
    text: doc.text,
  };
}

/**
 * The text a conversation node contributes.
 *
 * `last` is the mode that makes branching cheap: when the parent's job was to
 * produce a draft chapter, the child needs that chapter and nothing else — not
 * the six turns of argument that led to it.
 */
function threadSource(node, mode) {
  const thread = db.getThread(node.thread_id);
  if (!thread) return null;
  const messages = db.getMessages(node.thread_id);
  if (!messages.length) return null;

  const name = node.label || thread.title || `Thread ${node.thread_id}`;

  if (mode === 'last') {
    const answer = [...messages].reverse().find((m) => m.role === 'assistant' && !m.error);
    if (!answer) return null;
    return { kind: 'thread', name, detail: 'final answer', text: answer.content };
  }

  // Whole transcript, tail-first truncation: turns are dropped from the top, so
  // what survives is always the most recent — and always whole turns, never a
  // sentence cut in half.
  const rendered = messages
    .filter((m) => m.content?.trim())
    .map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content.trim()}`);

  const kept = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    size += rendered[i].length + 2;
    if (size > THREAD_SOURCE_CHARS && kept.length) break;
    kept.unshift(rendered[i]);
  }

  return {
    kind: 'thread',
    name,
    detail: kept.length < rendered.length
      ? `last ${kept.length} of ${rendered.length} messages`
      : `${rendered.length} messages`,
    text: kept.join('\n\n'),
  };
}

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
  for (const id of ids) {
    const node = db.getGraphNode(id);
    if (!node) continue;
    const mode = direct.get(id) ?? 'full';
    if (mode === 'none') continue;

    const src = node.kind === 'document' ? documentSource(node) : threadSource(node, mode);
    if (src?.text?.trim()) parts.push({ ...src, nodeId: id });
  }

  if (!parts.length) return { text: '', filename: null, parts: [] };

  const body = parts
    .map((p) => {
      const attrs = [
        `kind="${p.kind}"`,
        `name="${String(p.name).replace(/"/g, "'")}"`,
        p.version != null ? `version="${p.version}"` : null,
        p.detail ? `scope="${p.detail}"` : null,
      ].filter(Boolean).join(' ');
      return `<source ${attrs}>\n${p.text}\n</source>`;
    })
    .join('\n\n');

  // One source and it is a book: hand it over as that book, unwrapped. The
  // wrapper earns its place only when there is more than one thing to tell
  // apart, and an unwrapped book is what every existing prompt expects.
  if (parts.length === 1 && parts[0].kind === 'document') {
    return {
      text: parts[0].text,
      filename: parts[0].version != null ? `${parts[0].name} (v${parts[0].version})` : parts[0].name,
      parts,
    };
  }

  const header = `This conversation was opened from ${parts.length} source${parts.length > 1 ? 's' : ''}, `
    + 'given below in the order they should be read. Treat all of them as the material '
    + 'under discussion.\n\n';

  return {
    text: header + body,
    filename: parts.map((p) => (p.version != null ? `${p.name} v${p.version}` : p.name)).join(' + '),
    parts,
  };
}

/** What a source assembly costs, without paying to build the text twice. */
const sourceSummary = (src) => ({
  chars: src.text.length,
  filename: src.filename,
  parts: src.parts.map((p) => ({
    nodeId: p.nodeId, kind: p.kind, name: p.name,
    version: p.version ?? null, detail: p.detail ?? null, chars: p.text.length,
  })),
});

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

function freeSpotNear(graphId, parent) {
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

  /** Everything a picker can seed a point from. Text and blobs excluded. */
  app.get('/api/graph-library', (_req, res) => {
    res.json({
      documents: db.listDocuments().map(({ text, data, ...rest }) => rest),
      threads: db.listThreads(),
    });
  });

  /* -------------------------------------------------------------- points */

  /**
   * Put down a point.
   *
   *   { kind: 'document', documentId, docVersion? }  a book, at a version
   *   { kind: 'thread',   threadId }                 a conversation you have
   *   { kind: 'thread',   from?, mode?, title? }     a NEW conversation, opened
   *                                                  from `from` (a node id)
   *
   * The third form is the one the graph is for: it creates the thread, drops
   * the point, and draws the line in a single write, so branching is one click
   * rather than three.
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

    if (kind !== 'thread') return res.status(400).json({ error: 'kind must be document or thread.' });

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
    res.json(db.updateGraphNode(node.id, { x, y, docVersion, label }));
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
    res.json({ ...sourceSummary(src), preview: src.text.slice(0, 4000) });
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

    const history = db.getMessages(threadId).map((m) => ({ role: m.role, content: m.content }));
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
      history: messages.slice(0, userIdx).map((m) => ({ role: m.role, content: m.content })),
      taskId: userMsg.task || 'chat',
      chosenModel,
      source: source.parts.length ? { text: source.text, filename: source.filename } : null,
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

    const inheritedDoc = parent.kind === 'document'
      ? parent.document_id
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
}
