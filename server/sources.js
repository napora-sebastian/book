/* ===========================================================================
   Sources — the text a turn is answered from.

   Three things can stand behind a question: a book, a conversation, and a whole
   graph. The graph walks lines to decide which of them apply to a point; a
   plain conversation is handed its list by hand. Either way the rendering is
   the same, and it lives here so that "what a conversation looks like as a
   source" has exactly one answer no matter which screen asked.

   Nothing here is stored. Every part is rendered from the live row at the
   moment the turn is sent, which is what makes an attached source useful: the
   answer you add to it now is read by the next question over there.
   =========================================================================== */

import * as db from './db.js';

// A parent conversation can grow without limit, and pasting all of it into
// every descendant is how a graph three levels deep stops fitting anywhere. So
// a thread source contributes its tail: the most recent turns, whole, up to
// this many characters. Books are not capped here — the context budget and the
// map-reduce split already handle those.
export const THREAD_SOURCE_CHARS = Number(process.env.GRAPH_THREAD_SOURCE_CHARS || 60_000);

// A whole graph is many of those at once, so it gets its own ceiling: points
// are taken in order until this much text is spent, and the part says how many
// of them made it. Without this, attaching a large graph would silently push
// every turn onto the map-reduce path.
export const GRAPH_SOURCE_CHARS = Number(process.env.GRAPH_SOURCE_CHARS || 120_000);

/** The text a book contributes, at whatever version it is pinned to. */
export function documentPart({ documentId, version = null }) {
  const doc = db.getDocument(documentId);
  if (!doc) return null;

  if (version != null) {
    const v = db.getDocumentVersion(doc.id, version);
    if (v) {
      return { kind: 'document', name: v.filename || doc.filename, version: v.version, text: v.text };
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

/** One conversation rendered as `Q:` / `A:` lines, newest turns kept. */
export function renderTranscript(messages, limit = THREAD_SOURCE_CHARS) {
  const rendered = messages
    .filter((m) => m.content?.trim())
    .map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content.trim()}`);

  const kept = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    size += rendered[i].length + 2;
    if (size > limit && kept.length) break;
    kept.unshift(rendered[i]);
  }
  return { text: kept.join('\n\n'), kept: kept.length, total: rendered.length };
}

/**
 * The text a conversation contributes.
 *
 * `last` is the mode that makes branching cheap: when the source's job was to
 * produce a draft chapter, the reader needs that chapter and nothing else — not
 * the six turns of argument that led to it.
 */
export function threadPart({ threadId, mode = 'full', label = null }) {
  const thread = db.getThread(threadId);
  if (!thread) return null;
  // A conversation that was told where it starts starts there for everyone.
  // The marker says "the work before this is settled" — it would be strange
  // for the record itself to skip it while every reader of it did not.
  const messages = db.contextMessages(threadId);
  if (!messages.length) return null;

  const name = label || thread.title || `Thread ${threadId}`;

  if (mode === 'last') {
    const answer = [...messages].reverse().find((m) => m.role === 'assistant' && !m.error);
    if (!answer) return null;
    return { kind: 'thread', name, detail: 'final answer', text: answer.content };
  }

  // Whole transcript, tail-first truncation: turns are dropped from the top, so
  // what survives is always the most recent — and always whole turns, never a
  // sentence cut in half.
  const t = renderTranscript(messages);
  return {
    kind: 'thread',
    name,
    detail: t.kept < t.total ? `last ${t.kept} of ${t.total} messages` : `${t.total} messages`,
    text: t.text,
  };
}

/**
 * The text a note contributes.
 *
 * A note is the one point that owns its content, so there is nothing to fetch
 * and nothing to truncate — the user (or the model, on the user's instruction)
 * decided how long it was when they wrote it. `mode` is honoured only to the
 * extent it can be: a note has no "final answer" to isolate, so `last` reads
 * the same as `full`, and `none` never reaches here at all.
 *
 * A note with no body is a heading — the parent of a split, whose children hold
 * what it used to say. It contributes its name through the shape of the graph
 * and no text of its own, so it returns null rather than an empty source.
 */
export function notePart({ node, label = null }) {
  if (!node || node.kind !== 'note') return null;
  const text = String(node.text ?? '');
  if (!text.trim()) return null;

  // listGraphNodes joins the provenance filename in; getGraphNode returns the
  // bare row, so resolve it here rather than making every caller remember which
  // of the two it happens to be holding.
  const book = node.src_filename
    ?? (node.src_document_id ? db.getDocument(node.src_document_id)?.filename : null);
  const from = book
    ? `from ${book}${node.src_from != null ? ` @ ${node.src_from}–${node.src_to ?? ''}` : ''}`
    : null;

  return {
    kind: 'note',
    name: label || node.label || `Note ${node.id}`,
    detail: from,
    text,
  };
}

/**
 * A whole graph as one source.
 *
 * Points in the order they were put down, which on a graph built outward is
 * reading order, each one labelled with what it is. The lines come first, as a
 * short shape: a graph is not a pile of texts, and the model reads it better
 * knowing that the third point answers the second.
 */
export function graphPart(graphId) {
  const graph = db.getGraph(graphId);
  if (!graph) return null;

  const nodes = db.listGraphNodes(graphId).slice().sort((a, b) => a.id - b.id);
  if (!nodes.length) return null;
  const edges = db.listGraphEdges(graphId);

  const nameOf = (n) => n.label
    || (n.kind === 'document' ? n.doc_filename : n.kind === 'note' ? null : n.thread_title)
    || `Point ${n.id}`;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const blocks = [];
  let used = 0;
  let taken = 0;
  for (const n of nodes) {
    const part = n.kind === 'document'
      ? documentPart({ documentId: n.document_id, version: n.doc_version })
      : n.kind === 'note'
        ? notePart({ node: n })
        : threadPart({ threadId: n.thread_id, label: n.label });
    if (!part?.text?.trim()) continue;
    if (used && used + part.text.length > GRAPH_SOURCE_CHARS) break;

    taken += 1;
    used += part.text.length;
    const head = n.kind === 'document'
      ? `book · ${part.name}${part.version != null ? ` v${part.version}` : ''}`
      : n.kind === 'note'
        ? `note · ${part.name}${part.detail ? ` (${part.detail})` : ''}`
        : `conversation · ${part.name}${part.detail ? ` (${part.detail})` : ''}`;
    blocks.push(`[point ${taken} · ${head}]\n${part.text}`);
  }
  if (!blocks.length) return null;

  const shape = edges
    .map((e) => {
      const from = byId.get(e.source_id);
      const to = byId.get(e.target_id);
      if (!from || !to) return null;
      return `${nameOf(from)} → ${nameOf(to)}${e.mode === 'none' ? ' (carries nothing)' : e.mode === 'last' ? ' (final answer only)' : ''}`;
    })
    .filter(Boolean);

  const eligible = nodes.length;
  const preamble = shape.length
    ? `The points of this graph, and what was opened from what:\n${shape.map((s) => `  ${s}`).join('\n')}\n\n`
    : '';

  return {
    kind: 'graph',
    name: graph.title,
    detail: taken < eligible ? `first ${taken} of ${eligible} points` : `${taken} point${taken === 1 ? '' : 's'}`,
    text: preamble + blocks.join('\n\n'),
  };
}

/**
 * The sources attached to a conversation by hand, in the order they were saved.
 *
 * This never recurses: a conversation attached here contributes its own
 * transcript, and a graph its own points — not whatever *they* read. Two
 * records may therefore read each other without the turn failing to end.
 */
export function attachedParts(threadId) {
  const parts = [];
  for (const row of db.threadSourceRows(threadId)) {
    const part = row.kind === 'graph'
      ? graphPart(row.ref_graph_id)
      : threadPart({ threadId: row.ref_thread_id, mode: row.mode });
    if (part?.text?.trim()) {
      parts.push({ ...part, attached: true, refKind: row.kind, refId: row.ref_thread_id ?? row.ref_graph_id, mode: row.mode });
    }
  }
  return parts;
}

/**
 * Several parts as one body of text.
 *
 * The result goes in exactly where a thread's own document would — so a turn
 * with attached sources is indistinguishable from a plain one from `streamTurn`
 * down, including the prefix-cache handshake and the map-reduce path when it
 * overflows.
 */
export function wrapParts(parts, { header = true, unwrapLoneBook = true } = {}) {
  if (!parts.length) return { text: '', filename: null, parts: [] };

  // One source and it is a book: hand it over as that book, unwrapped. The
  // wrapper earns its place only when there is more than one thing to tell
  // apart, and an unwrapped book is what every existing prompt expects.
  if (unwrapLoneBook && parts.length === 1 && parts[0].kind === 'document') {
    return {
      text: parts[0].text,
      filename: parts[0].version != null ? `${parts[0].name} (v${parts[0].version})` : parts[0].name,
      parts,
    };
  }

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

  const preamble = header
    ? `This conversation was opened from ${parts.length} source${parts.length > 1 ? 's' : ''}, `
      + 'given below in the order they should be read. Treat all of them as the material '
      + 'under discussion.\n\n'
    : '';

  return {
    text: preamble + body,
    filename: parts.map((p) => (p.version != null ? `${p.name} v${p.version}` : p.name)).join(' + '),
    parts,
  };
}

/** What a source assembly costs, without paying to build the text twice. */
export const sourceSummary = (src) => ({
  chars: src.text.length,
  filename: src.filename,
  parts: src.parts.map((p) => ({
    nodeId: p.nodeId ?? null, kind: p.kind, name: p.name,
    version: p.version ?? null, detail: p.detail ?? null, chars: p.text.length,
    attached: Boolean(p.attached), refKind: p.refKind ?? null, refId: p.refId ?? null,
    mode: p.mode ?? null,
  })),
});

/**
 * What a plain conversation — one with no canvas under it — is answered from:
 * its own book, then everything attached to it by hand.
 *
 * Returns null when nothing is attached, so the ordinary single-document path
 * is left exactly as it was rather than being rebuilt into a one-part wrapper.
 */
export function threadSource(threadId, { version = null } = {}) {
  const extra = attachedParts(threadId);
  if (!extra.length) return null;

  const own = db.getThreadDocText(threadId, version);
  const parts = [];
  if (own?.text?.trim()) {
    // Which draft this is, said out loud: with several sources in one body of
    // text, "the document" is no longer unambiguous, and a turn pointed at an
    // older version must not look like a turn pointed at the newest.
    const drafted = version != null
      ? Number(version)
      : (own.document_id ? db.listDocumentVersions(own.document_id)[0]?.version ?? null : null);
    parts.push({
      kind: 'document', name: own.filename || 'document', version: drafted, text: own.text,
    });
  }
  parts.push(...extra);
  return wrapParts(parts);
}
