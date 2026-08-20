/* ===========================================================================
   Chat tools — the model acting on the workspace, not just reading from it.

   Every other inference path here is an answer *about* something: a book, a
   transcript, a graph walked into one body of text. This is the path where the
   model can also put something down — a graph, a category, a line between two
   of them — because the work the user actually wants ("break this chapter into
   themes and lay them out") is a dozen small writes, and dictating them one
   click at a time is the slow half of the job.

   The protocol is a JSON round over plain completions, the same choice the
   Oracle made and for the same reason: llm.js talks to whatever endpoint the
   settings plugin points at, and a local vLLM build is not guaranteed to have
   tool support compiled in. A JSON object is the one thing all of them emit.

     round → {"calls": [...]} → run them → results back into the prompt → round
                              ↘ {"calls": []} → stop, answer normally

   Writes apply immediately. Everything a tool can do is something the canvas
   can already undo by hand, and staging them behind a confirmation would put a
   modal between the user and the one thing they asked for.

   Mounting is a call to `runTools` before the answer prompt is built; deleting
   that call removes the feature whole.
   =========================================================================== */

import * as db from './db.js';
import * as llm from './llm.js';
import { freeSpotNear } from './graph.js';

/* ------------------------------------------------------------------ budgets */

// How many plan→act cycles one turn may spend. Two is enough for the shape this
// is actually used in — "read the graph, then write to it" — and a third round
// exists only so a failed call can be corrected rather than ending the turn.
const MAX_ROUNDS = Number(process.env.CHAT_TOOL_ROUNDS ?? 3);
// What all tool results together may contribute to the answer prompt. They
// share the context budget with the book, and a graph read in full must not be
// what pushes an ordinary question onto the map-reduce path.
const RESULT_CHARS = Number(process.env.CHAT_TOOL_RESULT_CHARS || 40_000);
// One book span per call. Categorising a long chapter is several calls by
// design: the model has to say which part it is looking at.
const DOC_SPAN_CHARS = Number(process.env.CHAT_TOOL_DOC_CHARS || 20_000);
// Calls per round. A model that emits forty writes in one object has lost the
// thread of what it was asked, and the user should see that as a stop rather
// than as forty rows appearing on their canvas.
const MAX_CALLS_PER_ROUND = 12;

const clip = (s, n) => {
  const text = String(s ?? '');
  return text.length <= n ? text : `${text.slice(0, n)}… [${text.length - n} more chars]`;
};

const num = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`expected a number, got ${JSON.stringify(v)}`);
  return n;
};

const str = (v, what) => {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
};

/* -------------------------------------------------------------------- tools

   Each entry is { args, describe, run }. `describe` is one line in the
   catalogue the planner reads, `run` does the work and returns a plain object
   that is JSON-stringified back into the next round.

   `run` receives the live context — which thread the chat is in, which graph
   its point stands on — so the common case ("put this on the graph I am
   looking at") does not need the user to have said an id out loud.
   =========================================================================== */

const nodeBrief = (n) => ({
  id: n.id,
  kind: n.kind,
  label: n.label
    ?? (n.kind === 'document' ? n.doc_filename : n.kind === 'thread' ? n.thread_title : null),
  // A note that has been split kept its label and lost its body. Saying so is
  // the difference between "this heading has parts" and "this note is empty",
  // and the model writes into the second one if you let it think that.
  ...(n.kind === 'note'
    ? (String(n.text ?? '').trim() ? { text: clip(n.text, 600) } : { heading: true })
    : {}),
  ...(n.kind === 'document' ? { documentId: n.document_id, version: n.doc_version ?? 'newest' } : {}),
  ...(n.kind === 'thread' ? { threadId: n.thread_id, messages: n.message_count } : {}),
  ...(n.src_document_id ? { fromBook: n.src_filename ?? n.src_document_id } : {}),
  at: { x: Math.round(n.x), y: Math.round(n.y) },
});

/** The graph a write should land on when the user did not name one. */
function resolveGraph(args, ctx) {
  const id = args?.graphId != null ? num(args.graphId) : ctx.graphId;
  if (id == null) {
    throw new Error('no graphId, and this conversation is not standing on a graph — '
      + 'call graph_create first, or name an existing graph');
  }
  if (!db.getGraph(id)) throw new Error(`no graph ${id}`);
  return id;
}

/** A node, checked to be on the graph the caller thinks it is on. */
function resolveNode(args, ctx, { kind = null } = {}) {
  const node = db.getGraphNode(num(args?.nodeId));
  if (!node) throw new Error(`no point ${args?.nodeId}`);
  if (kind && node.kind !== kind) throw new Error(`point ${node.id} is a ${node.kind}, not a ${kind}`);
  return node;
}

export const TOOLS = {
  /* ------------------------------------------------------------- reading */

  graph_list: {
    args: '{}',
    describe: 'every graph in the workspace, with how many points each holds',
    run: () => ({
      graphs: db.listGraphs().map((g) => ({
        id: g.id, title: g.title, points: g.node_count, lines: g.edge_count, updated: g.updated_at,
      })),
    }),
  },

  graph_read: {
    args: '{"graphId": 3}',
    describe: 'one graph in full — every point (notes with their text) and every line',
    run: (args, ctx) => {
      const id = resolveGraph(args, ctx);
      const nodes = db.listGraphNodes(id);
      return {
        graph: db.getGraph(id),
        nodes: nodes.map(nodeBrief),
        edges: db.listGraphEdges(id).map((e) => ({
          id: e.id, from: e.source_id, to: e.target_id, mode: e.mode, label: e.label,
        })),
      };
    },
  },

  thread_list: {
    args: '{}',
    describe: 'every conversation in the archive: id, title, its book, how many turns',
    run: () => ({
      threads: db.listThreads().map((t) => ({
        id: t.id, title: t.title, book: t.filename ?? null,
        messages: t.message_count ?? null, updated: t.updated_at,
      })),
    }),
  },

  thread_read: {
    args: '{"threadId": 12, "limit": 20}',
    describe: 'the transcript of one conversation, most recent turns first-class',
    run: (args) => {
      const id = num(args?.threadId);
      const thread = db.getThread(id);
      if (!thread) throw new Error(`no thread ${id}`);
      const limit = Math.min(Number(args?.limit) || 20, 60);
      const all = db.getMessages(id);
      return {
        thread: { id, title: thread.title, book: thread.filename ?? null, turns: all.length },
        messages: all.slice(-limit).map((m) => ({
          id: m.id, role: m.role, at: m.created_at, content: clip(m.content, 1_500),
        })),
      };
    },
  },

  document_list: {
    args: '{}',
    describe: 'every book in the library: id, filename, length in characters',
    run: () => ({
      documents: db.listDocuments().map((d) => ({
        id: d.id, filename: d.filename, chars: d.chars, pages: d.pages,
      })),
    }),
  },

  document_read: {
    args: '{"documentId": 4, "from": 0, "to": 20000}',
    describe: `a span of a book's text by character offset — this is how you read the `
      + `material you are categorising. Max ${DOC_SPAN_CHARS.toLocaleString()} chars per call; `
      + 'the reply says how long the whole book is so you can ask for the next span',
    run: (args) => {
      const doc = db.getDocument(num(args?.documentId));
      if (!doc) throw new Error(`no document ${args?.documentId}`);
      const text = String(doc.text ?? '');
      const from = Math.max(0, Number(args?.from) || 0);
      const to = Math.min(text.length, Number(args?.to) || from + DOC_SPAN_CHARS);
      const end = Math.min(to, from + DOC_SPAN_CHARS);
      return {
        documentId: doc.id,
        filename: doc.filename,
        totalChars: text.length,
        span: { from, to: end },
        more: end < text.length,
        text: text.slice(from, end),
      };
    },
  },

  /* ------------------------------------------------------------- writing */

  graph_create: {
    args: '{"title": "Chapter 3 — themes"}',
    describe: 'start a new graph and make it the one later calls write to',
    run: (args, ctx) => {
      const graph = db.createGraph(str(args?.title, 'title'));
      ctx.graphId = graph.id;   // later calls in this same turn land here
      return { graph, note: 'later calls in this turn default to this graph' };
    },
  },

  note_create: {
    args: '{"graphId": 3, "label": "The argument about money", "text": "…", "from": 7}',
    describe: 'put down a note — a category, a heading, a passage lifted out of the book. '
      + '`from` is the id of a point it hangs off (the book, or a broader note), and a line '
      + 'is drawn from it. This is the item you make when you categorise something',
    run: (args, ctx) => {
      const graphId = resolveGraph(args, ctx);
      const text = String(args?.text ?? '');
      const label = args?.label != null ? String(args.label).trim() : null;
      if (!text.trim() && !label) throw new Error('a note needs text or a label');

      const parent = args?.from != null ? db.getGraphNode(num(args.from)) : null;
      if (args?.from != null && (!parent || parent.graph_id !== graphId)) {
        throw new Error(`no point ${args.from} on graph ${graphId}`);
      }
      const at = parent
        ? freeSpotNear(graphId, parent)
        : freeSpotNear(graphId, { x: -360, y: 0 });

      const node = db.addGraphNode({
        graphId, kind: 'note', label, text,
        srcDocumentId: args?.srcDocumentId != null ? num(args.srcDocumentId)
          : parent?.kind === 'document' ? parent.document_id
            : parent?.src_document_id ?? null,
        srcFrom: args?.srcFrom != null ? num(args.srcFrom) : null,
        srcTo: args?.srcTo != null ? num(args.srcTo) : null,
        x: at.x, y: at.y,
      });

      let edge = null;
      if (parent) edge = db.addGraphEdge({ graphId, sourceId: parent.id, targetId: node.id });
      return { node: nodeBrief(node), edge: edge ? { id: edge.id, from: edge.source_id, to: edge.target_id } : null };
    },
  },

  note_update: {
    args: '{"nodeId": 9, "label": "…", "text": "…"}',
    describe: "rewrite a note's body or rename it. Send only the field you are changing",
    run: (args) => {
      const node = resolveNode(args, null, { kind: 'note' });
      return {
        node: nodeBrief(db.updateGraphNode(node.id, {
          label: args?.label !== undefined ? args.label : undefined,
          text: args?.text !== undefined ? String(args.text) : undefined,
        })),
      };
    },
  },

  note_split: {
    args: '{"nodeId": 9, "parts": [{"label": "…", "text": "…"}, {"label": "…", "text": "…"}]}',
    describe: 'break one note into several. The parent keeps its label, loses its body and '
      + 'becomes the heading over the parts; lines already drawn into it still reach them',
    run: (args, ctx) => {
      const node = resolveNode(args, ctx, { kind: 'note' });
      const out = db.splitGraphNote(node.id, args?.parts, {
        spot: () => freeSpotNear(node.graph_id, node),
      });
      return { parent: nodeBrief(out.parent), parts: out.parts.map(nodeBrief) };
    },
  },

  node_place: {
    args: '{"graphId": 3, "kind": "document", "documentId": 4}',
    describe: 'put an existing book or conversation on a graph as a point. '
      + 'kind is "document" (with documentId) or "thread" (with threadId)',
    run: (args, ctx) => {
      const graphId = resolveGraph(args, ctx);
      const kind = str(args?.kind, 'kind');
      if (kind !== 'document' && kind !== 'thread') throw new Error('kind must be document or thread');

      const parent = args?.from != null ? db.getGraphNode(num(args.from)) : null;
      const at = parent ? freeSpotNear(graphId, parent) : freeSpotNear(graphId, { x: -360, y: 0 });

      if (kind === 'document') {
        const doc = db.getDocument(num(args?.documentId));
        if (!doc) throw new Error(`no document ${args?.documentId}`);
        const node = db.addGraphNode({
          graphId, kind: 'document', documentId: doc.id,
          docVersion: args?.docVersion != null ? num(args.docVersion) : null,
          label: args?.label ?? null, x: at.x, y: at.y,
        });
        return { node: nodeBrief(node) };
      }

      const thread = db.getThread(num(args?.threadId));
      if (!thread) throw new Error(`no thread ${args?.threadId}`);
      const node = db.addGraphNode({
        graphId, kind: 'thread', threadId: thread.id, label: args?.label ?? null, x: at.x, y: at.y,
      });
      let edge = null;
      if (parent) edge = db.addGraphEdge({ graphId, sourceId: parent.id, targetId: node.id });
      return { node: nodeBrief(node), edge: edge ? { id: edge.id } : null };
    },
  },

  node_move: {
    args: '{"nodeId": 9, "x": 720, "y": 200}',
    describe: 'move a point on the canvas. x grows right, y grows down; '
      + 'one column is about 360 wide and one row about 220 tall',
    run: (args, ctx) => {
      const node = resolveNode(args, ctx);
      return { node: nodeBrief(db.updateGraphNode(node.id, { x: num(args?.x), y: num(args?.y) })) };
    },
  },

  node_delete: {
    args: '{"nodeId": 9}',
    describe: 'take a point off the canvas. The book or conversation it pointed at is '
      + 'left in the archive; a note has nowhere else to live and is gone',
    run: (args, ctx) => {
      const node = resolveNode(args, ctx);
      db.deleteGraphNode(node.id);
      return { deleted: node.id, kind: node.kind };
    },
  },

  edge_create: {
    args: '{"sourceId": 7, "targetId": 9, "mode": "full"}',
    describe: 'draw a line: the target reads the source. mode is "full" (all of it), '
      + '"last" (a conversation\'s final answer only) or "none" (drawn, carries nothing). '
      + 'A book can never be the target, and a line that would close a loop is refused',
    run: (args, ctx) => {
      const source = db.getGraphNode(num(args?.sourceId));
      if (!source) throw new Error(`no point ${args?.sourceId}`);
      const edge = db.addGraphEdge({
        graphId: source.graph_id,
        sourceId: source.id,
        targetId: num(args?.targetId),
        mode: args?.mode || 'full',
        label: args?.label ?? null,
      });
      return { edge: { id: edge.id, from: edge.source_id, to: edge.target_id, mode: edge.mode } };
    },
  },

  edge_delete: {
    args: '{"edgeId": 4}',
    describe: 'remove a line',
    run: (args) => ({ deleted: db.deleteGraphEdge(num(args?.edgeId)) ? num(args.edgeId) : null }),
  },

  /* ---------------------------------------------------------- suggesting */

  /**
   * Propose something about an answer that has already been given.
   *
   * `content` is the suggestion itself, written by you in this same object —
   * the same way a note's body is. That is what keeps every tool here a plain
   * write: the thinking happens where the thinking already is, in the round
   * that decided to make the call, rather than in a second model call hidden
   * behind a tool boundary.
   */
  suggest: {
    args: '{"messageId": 42, "ask": "another category", "content": "…the suggestion…"}',
    describe: 'add a suggestion UNDER an answer the model already gave — a further category, '
      + 'a counter-argument, a shorter title, whatever `ask` names. It hangs under that answer '
      + 'in the transcript and is not a turn of the conversation. Omit messageId to attach it '
      + 'to the most recent answer in this conversation',
    run: (args, ctx) => {
      const messageId = args?.messageId != null
        ? num(args.messageId)
        : db.lastAssistantMessage(ctx?.threadId)?.id;
      if (messageId == null) {
        throw new Error('no answer to attach a suggestion to — nothing has been answered here yet');
      }
      const message = db.getMessage(messageId);
      if (!message) throw new Error(`no message ${messageId}`);
      if (message.role !== 'assistant') {
        throw new Error('a suggestion attaches to an answer, not to a question');
      }

      const content = String(args?.content ?? '').trim();
      if (!content) throw new Error('content is required — write the suggestion itself, not a plan to write one');

      const row = db.addSuggestion({
        messageId,
        ask: String(args?.ask ?? '').trim() || 'a suggestion',
        content,
        model: ctx?.model ?? null,
      });
      return { suggestion: { id: row.id, messageId, ask: row.ask, chars: content.length } };
    },
  },
};

const WRITES = new Set([
  'graph_create', 'note_create', 'note_update', 'note_split',
  'node_place', 'node_move', 'node_delete', 'edge_create', 'edge_delete',
  'suggest',
]);

/* A suggestion changes the transcript, not the canvas. Both are writes, but
   only the canvas ones make an open graph view stale — telling the user to
   reload a canvas because a suggestion appeared under an answer would send
   them to look at the wrong screen. */
const CANVAS_WRITES = new Set([
  'graph_create', 'note_create', 'note_update', 'note_split',
  'node_place', 'node_move', 'node_delete', 'edge_create', 'edge_delete',
]);

/** Tools a user may name after a slash, in the order a menu should list them. */
export const SLASH_TOOLS = [
  'suggest',
  'graph_read', 'graph_list', 'graph_create',
  'note_create', 'note_update', 'note_split',
  'node_place', 'node_move', 'node_delete',
  'edge_create', 'edge_delete',
  'thread_list', 'thread_read', 'document_list', 'document_read',
];

/**
 * A message the user opened with `/toolname`.
 *
 * Returns the tool they named and the message with the command taken off the
 * front, or null when there is no command — an ordinary message beginning with
 * a slash ("/etc is where it lives") names no tool and is left alone.
 */
export function parseSlash(question) {
  const m = /^\s*\/([a-z_]+)\b[ \t]*([\s\S]*)$/.exec(String(question ?? ''));
  if (!m || !TOOLS[m[1]]) return null;
  return { tool: m[1], rest: m[2].trim() };
}

/* ------------------------------------------------------------------ prompts */

/** The tool list as the planner reads it. Exported: the Oracle prints it too. */
export const toolCatalogue = () => Object.entries(TOOLS)
  .map(([name, t]) => `  ${name} ${t.args}\n      ${t.describe}`)
  .join('\n');

const PLANNER = `You are working inside a local document lab. The user has books, conversations
about them, and graphs — canvases where books, conversations and notes stand as points with
lines between them. You can read all of it and you can change the graphs.

Reply with ONE JSON object and nothing else. No prose, no markdown fence.

  {"thought": "<one short sentence, in the user's language>",
   "calls": [{"tool": "graph_read", "args": {"graphId": 3}}]}

  calls  — the tools to run now, in order. Later calls may use ids returned by earlier
           ones ONLY if you already know them; otherwise read first and write next round.

An EMPTY calls list ends the round and you answer. That is the ONLY way to finish, so do not
end while work the user asked for is still undone: a round that only read something has not
done it yet. Read on one round, look at the results, write on the next.

Return {"calls": []} — immediately, on round one — when the user's message is an ordinary
question about the document or the conversation. Most messages are, and answering one costs
nothing here because the material is already in front of the answer. Tools are for when the
user asks you to look at the wider workspace, or to change it.

Ask yourself only: does answering this require something OUTSIDE this conversation, or does
it ask me to CHANGE something? If neither — and it usually is neither — return no calls.

TOOLS

${toolCatalogue()}

HOW TO CATEGORISE A BOOK
The user asking you to break material into items means: read the span with document_read,
decide the categories, then note_create one per category — each with a real body, not just a
title — hanging off the book's point with \`from\`. If a category turns out to hold two
distinct things, note_split it. Give every note a label short enough to read on a card.
Do not invent ids. Every id you pass must have come back from a read in this same turn, or
be listed in the workspace below.`;

/* --------------------------------------------------------------- the runner */

/**
 * Run a batch of calls, announce each one, and render the results as the text
 * the next round (or the answerer) reads.
 *
 * Shared by the chat's own loop and by the Oracle, which has a planning loop of
 * its own and only needed the acting half of this.
 */
export function runCalls(calls, ctx, { send = () => {}, budget = RESULT_CHARS, signal = null } = {}) {
  const entries = [];
  const lines = [];
  let spent = 0;
  let touched = false;
  let canvasTouched = false;

  for (const call of (Array.isArray(calls) ? calls : []).slice(0, MAX_CALLS_PER_ROUND)) {
    if (signal?.aborted) break;
    if (spent >= budget) {
      lines.push('[tool budget spent — answer from what you already have]');
      break;
    }

    const out = runOne(call, ctx);
    entries.push(out);
    if (out.ok && WRITES.has(out.tool)) touched = true;
    if (out.ok && CANVAS_WRITES.has(out.tool)) canvasTouched = true;

    // The canvas is open in another window as often as not, so every call is
    // announced as it happens rather than summarised at the end.
    send('tool', {
      tool: out.tool, args: out.args, ok: out.ok,
      error: out.error ?? null,
      write: WRITES.has(out.tool),
      canvas: CANVAS_WRITES.has(out.tool),
      // The suggestion the call just filed, so the surface that is showing the
      // answer can hang it underneath without re-reading the whole thread.
      suggestion: out.ok && out.tool === 'suggest'
        ? { ...out.result.suggestion, content: String(out.args?.content ?? '') }
        : null,
      summary: summarise(out),
    });

    const body = out.ok
      ? clip(JSON.stringify(out.result), Math.max(500, budget - spent))
      : `ERROR: ${out.error}`;
    spent += body.length;
    lines.push(`${out.tool}(${clip(JSON.stringify(out.args), 300)}) →\n${body}`);
  }

  return { entries, lines, touched, canvasTouched, spent };
}

/**
 * What the answerer is told about the calls that ran.
 *
 * The framing above and below the block is not decoration. Handed a block of
 * tool calls with no instruction around it, a model reads it as a format it is
 * in the middle of and writes another one — inventing a call that never ran and
 * showing the user raw XML instead of an answer. So the block is named as a
 * finished record on the way in, and the ban on imitating it comes last, where
 * it is closest to the tokens being generated.
 */
export const toolsRunBlock = (lines) =>
  `The following is a RECORD OF WORK ALREADY DONE. These calls have finished and their `
  + `results are below. It is a report to read, not a format to continue.\n\n<tools-run>\n${
    lines.join('\n\n')}\n</tools-run>\n\n`
  + `Now write your reply as ordinary prose. Never emit XML tags, JSON or tool calls in your `
  + `answer — nothing there will run, and the user sees it raw. Say in one or two sentences `
  + `what you created or changed, naming it. A call that came back ERROR did NOT take effect: `
  + `say so plainly rather than describing it as done.`;

/**
 * Strip a fence, take the outermost object. Models add prose no matter what.
 *
 * And they truncate. A plan carrying four notes with a paragraph of body each
 * is a long object, and a model that stops one bracket short of finishing it
 * has still decided everything — throwing that away costs the user the whole
 * round and looks, from their side, like the model ignoring them. So a plan
 * that will not parse is balanced and tried again.
 */
function parsePlan(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  if (start === -1) return null;

  const end = text.lastIndexOf('}');
  if (end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* fall through to the repair */ }
  }

  const repaired = balance(text.slice(start));
  if (!repaired) return null;
  try {
    const plan = JSON.parse(repaired.json);
    // Truncation inside a string means the last call's arguments were cut off
    // mid-word. Everything before it is whole and worth keeping; that one is
    // not, and writing half a note is worse than not writing it.
    if (repaired.cutMidString && Array.isArray(plan.calls)) plan.calls.pop();
    return plan;
  } catch {
    return null;
  }
}

/**
 * Close whatever the model left open: an unterminated string, then every
 * bracket still on the stack, innermost first. Returns null if there was
 * nothing open — that text failed to parse for some other reason, and guessing
 * further would be inventing a plan rather than recovering one.
 */
function balance(text) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (!inString && !stack.length) return null;

  let json = text;
  // A trailing comma or a half-written key is not repairable by adding
  // brackets, so the dangling fragment goes first.
  if (inString) json += '"';
  json = json.replace(/,\s*("[^"]*"\s*:?\s*)?$/, '');
  while (stack.length) json += stack.pop() === '{' ? '}' : ']';

  return { json, cutMidString: inString };
}

/**
 * What the planner is told when the user typed `/toolname`.
 *
 * The choice is theirs and is not up for review — so this does not describe the
 * tool as an option, it says the call is already decided and only its arguments
 * are still open. Round two exists so a call that came back ERROR can be
 * corrected; it is not an invitation to go and do something else.
 */
const chosenToolBlock = (name, round) => `<chosen-tool>
The user typed /${name}. They have ALREADY CHOSEN the tool — do not weigh whether to use it,
and do not use a different one. Your only job is to fill in its arguments from what they wrote.

  ${name} ${TOOLS[name].args}
      ${TOOLS[name].describe}

${round === 1
  ? 'Call it now, in this round.'
  : 'It has already run — see <results>. If it succeeded, return {"calls": []}. '
    + 'If it came back ERROR, fix the arguments and call it once more.'}
</chosen-tool>`;

/**
 * Where the user is standing, so the common instruction ("add it to this graph")
 * resolves without them having said an id out loud.
 */
function workspaceIndex({ threadId, graphId }) {
  const lines = [];

  if (threadId) {
    const thread = db.getThread(threadId);
    if (thread) {
      lines.push(`You are in conversation #${thread.id} "${thread.title}"${
        thread.document_id ? ` · book #${thread.document_id} ${thread.filename}` : ' · no book'}.`);
      // The single most expensive misunderstanding available to the planner.
      // Without this it calls document_read to answer "what happens in chapter
      // one?" — a whole extra round, for text that is already in the prompt it
      // is about to be handed.
      if (thread.document_id) {
        lines.push(`That book's full text is ALREADY in front of you when you answer. `
          + `You do not need document_read to answer a question about it. Read it only to `
          + `work through material you are turning into notes, or to quote exact offsets.`);
      }
    }
  }
  if (graphId) {
    const graph = db.getGraph(graphId);
    const nodes = graph ? db.listGraphNodes(graphId) : [];
    if (graph) {
      lines.push(`It stands on graph #${graph.id} "${graph.title}", which holds ${nodes.length} point${
        nodes.length === 1 ? '' : 's'}:`);
      lines.push(...nodes.slice(0, 40).map((n) => {
        const name = n.label || (n.kind === 'document' ? n.doc_filename : n.kind === 'thread' ? n.thread_title : null);
        return `  point ${n.id} · ${n.kind} · ${name || '(unnamed)'}`;
      }));
      lines.push('Writes with no graphId land on this graph.');
    }
  } else {
    lines.push('This conversation is not standing on any graph. A write with no graphId will fail — '
      + 'call graph_create, or name an existing graph.');
  }

  const graphs = db.listGraphs().slice(0, 20);
  if (graphs.length) {
    lines.push(`Graphs: ${graphs.map((g) => `#${g.id} "${g.title}"`).join(', ')}`);
  }

  return `<workspace>\n${lines.join('\n')}\n</workspace>`;
}

/** One call, run and rendered. Never throws — a failed tool is a result. */
function runOne(call, ctx) {
  const name = String(call?.tool ?? '');
  const tool = TOOLS[name];
  if (!tool) return { tool: name, args: call?.args ?? {}, ok: false, error: `no such tool: ${name}` };

  try {
    return { tool: name, args: call?.args ?? {}, ok: true, result: tool.run(call?.args ?? {}, ctx) };
  } catch (err) {
    // Errors go back to the model rather than ending the turn: "that line would
    // close a loop" is something it can act on, and usually does.
    return { tool: name, args: call?.args ?? {}, ok: false, error: err.message };
  }
}

/**
 * Let the model look at and change the workspace before it answers.
 *
 * Returns the transcript of what it did, as text for the answer prompt and as a
 * list for the caller to stream. A turn where nothing was called returns null,
 * which is the signal to build the answer prompt exactly as it was built before
 * any of this existed.
 */
export async function runTools({
  question, history = [], threadId = null, graphId = null,
  model, signal, send = () => {}, trace = () => {}, forcedTool = null,
}) {
  // A tool named after a slash is an instruction, not a suggestion: the user
  // has already decided, so it runs even where the automatic layer is switched
  // off. Turning tools off means "stop deciding for me", not "refuse me".
  if (MAX_ROUNDS <= 0 && !forcedTool) return null;
  send('stage', forcedTool ? `/${forcedTool}` : 'checking the workspace…');

  const ctx = { threadId, graphId, model };
  const index = workspaceIndex({ threadId, graphId });
  const done = [];              // every call made, in order
  const transcript = [];        // what the planner reads between rounds
  let spent = 0;
  let touched = false;          // did anything actually change?
  let canvasTouched = false;    // …and was any of it on a canvas?

  const recent = history
    .filter((m) => m && m.content)
    .slice(-6)
    .map((m) => `${m.role}: ${clip(m.content, 600)}`)
    .join('\n');

  // A named tool gets at least two rounds even where the automatic layer is
  // switched off: one to run, one to correct a call the arguments were wrong on.
  const rounds = forcedTool ? Math.max(2, MAX_ROUNDS) : MAX_ROUNDS;

  for (let round = 1; round <= rounds; round++) {
    if (signal?.aborted) break;

    const messages = [
      { role: 'system', content: PLANNER },
      {
        role: 'user',
        content: [
          index,
          recent ? `<chat-so-far>\n${recent}\n</chat-so-far>` : '',
          transcript.length ? `<results>\n${transcript.join('\n\n')}\n</results>` : '',
          forcedTool ? chosenToolBlock(forcedTool, round) : '',
          `<request>${question}</request>`,
          `Round ${round} of ${rounds}. JSON only.`,
        ].filter(Boolean).join('\n\n'),
      },
    ];

    const started = Date.now();
    let result;
    try {
      result = await llm.complete(messages, { model, signal });
    } catch (err) {
      // The planner is an extra; it must never be what fails the turn. Answer
      // with whatever it managed before it broke.
      send('stage', `tools unavailable (${err.message}) — answering without them`);
      break;
    }
    trace({ kind: 'tool-plan', model, messages, result, started });

    const plan = parsePlan(result.text);
    // A model that will not emit JSON is not going to start on round two, and
    // an ordinary question is the overwhelmingly likely reason it did not.
    if (!plan) {
      if (forcedTool && !done.length) {
        send('tool', {
          tool: forcedTool, args: {}, ok: false, write: false, canvas: false, suggestion: null,
          error: 'the model did not return a usable call',
          summary: `/${forcedTool} — the model did not return a usable call`,
        });
      }
      break;
    }

    if (plan.thought && !done.length) send('thought', String(plan.thought).slice(0, 300));

    // An empty list is the only way out. A model that read a book and declared
    // itself finished in the same breath has not done the work it was asked
    // for — it has only found out what the work is — so the loop keeps going
    // and lets it see the results it just asked for.
    if (!(Array.isArray(plan.calls) && plan.calls.length)) break;

    const ran = runCalls(plan.calls, ctx, { send, signal, budget: RESULT_CHARS - spent });
    done.push(...ran.entries);
    transcript.push(...ran.lines);
    spent += ran.spent;
    touched = touched || ran.touched;
    canvasTouched = canvasTouched || ran.canvasTouched;

    // A tool the user named has one job, and it just did it. The extra round
    // exists to correct a call that came back ERROR, not to ask a model that
    // has already obeyed whether it would like to do something else.
    if (forcedTool && ran.entries.some((c) => c.ok && c.tool === forcedTool)) break;
  }

  if (!done.length) return null;

  return {
    calls: done,
    touched,
    canvasTouched,
    // Everything filed under an answer this turn, so the surface showing that
    // answer can hang them underneath without re-reading the thread.
    suggestions: done
      .filter((c) => c.ok && c.tool === 'suggest')
      .map((c) => ({ ...c.result.suggestion, content: String(c.args?.content ?? '') })),
    // The same transcript the planner read, handed to the answerer so its reply
    // is about what actually happened rather than about what it intended — and
    // the index with it, because an answerer that does not know it is standing
    // on a graph writes a paragraph apologising for not having one.
    text: `${index}\n\n${toolsRunBlock(transcript)}`,
  };
}

/** One line a human can read, for the chat and for the log. */
function summarise(out) {
  if (!out.ok) return `${out.tool} failed — ${out.error}`;
  const r = out.result ?? {};
  switch (out.tool) {
    case 'graph_create': return `created graph #${r.graph?.id} "${r.graph?.title}"`;
    case 'graph_read': return `read graph #${r.graph?.id} "${r.graph?.title}" · ${r.nodes?.length ?? 0} points`;
    case 'graph_list': return `listed ${r.graphs?.length ?? 0} graphs`;
    case 'thread_list': return `listed ${r.threads?.length ?? 0} conversations`;
    case 'thread_read': return `read #${r.thread?.id} "${r.thread?.title}"`;
    case 'document_list': return `listed ${r.documents?.length ?? 0} books`;
    case 'document_read': return `read ${r.filename} ${r.span?.from}–${r.span?.to} of ${r.totalChars}`;
    case 'note_create': return `note ${r.node?.id} · ${r.node?.label ?? 'unnamed'}`;
    case 'note_update': return `edited note ${r.node?.id}`;
    case 'note_split': return `split note ${r.parent?.id} into ${r.parts?.length ?? 0}`;
    case 'node_place': return `placed ${r.node?.kind} as point ${r.node?.id}`;
    case 'node_move': return `moved point ${r.node?.id}`;
    case 'node_delete': return `removed point ${r.deleted}`;
    case 'edge_create': return `line ${r.edge?.from} → ${r.edge?.to}`;
    case 'edge_delete': return `removed line ${r.deleted}`;
    case 'suggest': return `suggested ${r.suggestion?.ask} under answer ${r.suggestion?.messageId}`;
    default: return out.tool;
  }
}
