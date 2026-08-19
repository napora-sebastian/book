import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { Document, Packer, Paragraph, TextRun } from 'docx';

import { extractText } from './extract.js';
import { chunkText, estimateTokens } from './chunk.js';
import { buildDiff } from './diff.js';
import {
  buildThreadMessages,
  buildThreadMapMessages,
  buildThreadReduceMessages,
  buildGroundTruthMessages,
  buildRewriteMessages,
  TASKS,
} from './tasks.js';
import * as llm from './llm.js';
import * as db from './db.js';
import { llmSettings } from './llm-settings.js';
import { threadSource as attachedThreadSource, sourceSummary } from './sources.js';
import { threadTitlePrompt, suggestTitle } from './naming.js';
import { mountOracle } from './oracle.js';
import { mountGraph } from './graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5173);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 40 * 1024 * 1024);
const CONTEXT_BUDGET = Number(process.env.CONTEXT_BUDGET_CHARS || 600_000);
const CHUNK = Number(process.env.CHUNK_CHARS || 48_000);
const OVERLAP = Number(process.env.CHUNK_OVERLAP_CHARS || 800);
// Conservative heuristic, not a benchmarked figure — see the route for why.
const GROUND_TRUTH_MAX_CHARS = Number(process.env.GROUND_TRUTH_MAX_CHARS || 40_000);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

app.use(express.json({ limit: '64mb' }));

// The Grimoire: an alternative reading view of the same archive, plus the
// Oracle that searches it. Mounted before the static handler so /grimoire is
// served as a clean URL instead of being redirected to /grimoire/ by express.
// Removing this line and public/grimoire/ removes the feature whole.
mountOracle(app);

// The Graph: the same archive as a network of sources and the conversations
// branched off them. It reuses `streamTurn` verbatim — a graph turn is an
// ordinary thread turn whose context was assembled from upstream points.
mountGraph(app, { streamTurn });

// The mixed console: the deck of windows with the graph raised over it in a
// modal. It serves the deck's own script and the graph's own component, so it
// adds a page and a seam, not a third implementation of either.
app.get('/grimoire-mix', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'grimoire-mix', 'index.html')));

app.use(express.static(path.join(__dirname, '..', 'public')));

// The llm-settings plugin brings its own routes (/api/llm/*) and its own UI
// assets (/plugins/llm-settings/*). It is the only thing that decides which
// endpoint, key and model a request uses — this app never reads LLM_BASE_URL,
// LLM_API_KEY or LLM_MODEL directly any more.
llmSettings.mount(app);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Storing the document verbatim in every trace would multiply a 600k-char book
// by the number of turns. The text already lives in `documents`, so traces keep
// the prompt structure and elide only the document body — `prompt_chars` still
// records the true size that went over the wire. Set TRACE_FULL_PROMPTS=true to
// store the prompt byte-for-byte instead.
const TRACE_FULL = String(process.env.TRACE_FULL_PROMPTS || '').toLowerCase() === 'true';

function compactMessages(messages) {
  if (TRACE_FULL) return messages;
  return messages.map((m) => ({
    ...m,
    content: m.content.replace(
      /<document>[\s\S]*?<\/document>/g,
      (match) => `<document elided chars="${match.length - 21}" />`,
    ),
  }));
}

/** Record one call to the cluster. Never throws — tracing must not break a turn. */
function trace(row) {
  try {
    return db.addTrace(row);
  } catch (err) {
    console.error('trace write failed:', err.message);
    return null;
  }
}

function traceRow({ threadId, kind, task, model, result, messages, status, error }) {
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  return {
    threadId,
    kind,
    task,
    model,
    servedModel: result?.servedModel,
    // The provider that actually answered, which is not the main one when the
    // chain fell back — a trace pointing at a box that refused the call would
    // be worse than no endpoint at all.
    baseUrl: result?.baseUrl ?? llm.config().baseUrl,
    fingerprint: result?.fingerprint,
    requestJson: JSON.stringify(compactMessages(messages)),
    requestParams: JSON.stringify({
      temperature: Number(process.env.TEMPERATURE ?? 0.2),
      // What actually went over the wire, which is not MAX_TOKENS when a large
      // document has already claimed part of the shared budget.
      max_tokens: result?.maxTokens ?? Number(process.env.MAX_TOKENS ?? 4096),
      max_tokens_configured: Number(process.env.MAX_TOKENS ?? 4096),
      stream: kind !== 'map',
    }),
    promptChars,
    promptMessages: messages.length,
    responseText: result?.text ?? '',
    reasoningText: result?.reasoning || null,
    usage: result?.usage ?? null,
    ttftMs: result?.ttftMs ?? null,
    durationMs: result?.durationMs ?? null,
    status: status ?? 'ok',
    error: error ?? null,
    finishReason: result?.finishReason ?? null,
  };
}

/**
 * A reasoning model can burn its whole output budget thinking and stop before
 * writing a word of the answer. The HTTP call succeeds, so nothing looks wrong:
 * you get a blank bubble after two minutes and no way to tell why. `length` is
 * the only signal that distinguishes it from a model with nothing to say.
 */
function truncationError(finishReason, answer, model, cap) {
  if (finishReason !== 'length') return null;
  const asked = Number(process.env.MAX_TOKENS ?? 4096);
  // A cap below MAX_TOKENS means the prompt itself ate the shared budget, which
  // is a different problem with a different fix — say which one it was.
  const why = cap < asked
    ? `the document left room for only ${cap.toLocaleString()} output tokens of the `
      + `${asked.toLocaleString()} configured. Shorten the document or attach fewer chapters.`
    : `it hit the ${cap.toLocaleString()}-token output cap. Raise MAX_TOKENS in .env.`;

  return answer.trim()
    ? `Answer cut off mid-sentence — ${why}`
    : `${model} spent the whole output budget on reasoning and never began the answer — ${why}`
      + ' A lighter model (ds4-high, ds4-non-thinking) also reasons less.';
}

/* ------------------------------------------------------------------- config */

app.get('/api/config', asyncRoute(async (_req, res) => {
  const { baseUrl, model, source, provider, fallbacks } = llm.config();
  const out = {
    baseUrl,
    model,
    // Where that came from, so the UI can say "using .env — nothing saved yet"
    // and name the provider that will answer if the main one is down.
    providerSource: source,
    provider,
    fallbacks,
    tasks: Object.entries(TASKS).map(([id, t]) => ({
      id,
      label: t.label,
      needsQuestion: Boolean(t.needsQuestion),
      questionLabel: t.questionLabel || 'Question',
      instruction: t.instruction,
    })),
    contextBudgetChars: CONTEXT_BUDGET,
    stats: db.stats(),
    reachable: false,
    models: [],
  };
  try {
    out.models = await llm.listModels();
    out.reachable = true;
    out.modelServed = out.models.includes(model);
  } catch (err) {
    out.error = err.message;

    // The main provider is down, but the app is not: a turn sent now would be
    // answered by the first fallback that responds. Say which one, and offer its
    // models — an empty picker would suggest nothing works.
    for (const fb of fallbacks) {
      try {
        out.models = await llmSettings.fetchModels(llmSettings.getSecret(fb.id) ?? fb);
        out.fallbackReady = { label: fb.label, model: fb.model, apiUrl: fb.apiUrl };
        break;
      } catch { /* try the next one; the error already names the main provider */ }
    }
  }
  res.json(out);
}));

/* ---------------------------------------------------------------- documents */

/** Upload → extract → store in the library. Identical text is deduped. */
app.post('/api/documents', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let extracted;
  try {
    extracted = await extractText(req.file);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const { doc, reused } = db.saveDocument({
    filename: req.file.originalname,
    kind: extracted.kind,
    text: extracted.text,
    words: extracted.text.split(/\s+/).filter(Boolean).length,
    pages: extracted.pages ?? null,
    bytes: req.file.size,
    data: req.file.buffer,
  });

  res.json({ ...withoutText(doc), reused, warnings: extracted.warnings ?? [] });
}));

/** Re-upload into an existing library slot — same id/filename, new content. */
app.post('/api/documents/:id/replace', upload.single('file'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!db.getDocument(id)) return res.status(404).json({ error: 'No such document.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let extracted;
  try {
    extracted = await extractText(req.file);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  let result;
  try {
    result = db.replaceDocumentContent(id, {
      kind: extracted.kind,
      text: extracted.text,
      words: extracted.text.split(/\s+/).filter(Boolean).length,
      pages: extracted.pages ?? null,
      bytes: req.file.size,
      data: req.file.buffer,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This exact content already exists as another document in the library.' });
    }
    throw err;
  }

  res.json({
    ...withoutText(result.doc),
    reused: false,
    version: result.version,
    identical: result.identical,
    additions: result.additions,
    deletions: result.deletions,
    warnings: extracted.warnings ?? [],
  });
}));

/** History rail: every stored state of this document, newest first. */
app.get('/api/documents/:id/versions', (req, res) => {
  const id = Number(req.params.id);
  const doc = db.getDocument(id);
  if (!doc) return res.status(404).json({ error: 'No such document.' });

  const versions = db.listDocumentVersions(id);
  // A document uploaded before versioning existed has no rows yet. Rather than
  // write one on a GET, present its current content as the version 1 it is.
  res.json({
    filename: doc.filename,
    versions: versions.length ? versions : [{
      document_id: id, version: 1, filename: doc.filename, kind: doc.kind,
      chars: doc.chars, words: doc.words, pages: doc.pages, bytes: doc.bytes,
      sha256: doc.sha256, additions: null, deletions: null, created_at: doc.created_at,
    }],
  });
});

/**
 * File a model's rewritten text as the next version of a document. The stored
 * document is left untouched — the model's answer is a candidate revision the
 * user reviews in the diff before a manual "Replace…" upload promotes it.
 */
app.post('/api/documents/:id/versions', (req, res) => {
  const id = Number(req.params.id);
  const doc = db.getDocument(id);
  if (!doc) return res.status(404).json({ error: 'No such document.' });

  const text = (req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required.' });

  const messageId = req.body?.messageId != null ? Number(req.body.messageId) : null;
  if (messageId != null) {
    const message = db.getMessage(messageId);
    if (!message || message.thread_id !== Number(req.body.threadId)) {
      return res.status(400).json({ error: 'messageId does not belong to this thread.' });
    }
  }

  const saved = db.saveModelVersion(id, { text, sourceMessageId: messageId, model: req.body?.model ?? null });
  if (!saved) return res.status(409).json({ error: 'This text is identical to the current version — nothing to save.' });

  res.json({ ...saved, filename: doc.filename });
});

/** Remove one saved version. The last remaining version is protected. */
app.delete('/api/documents/:id/versions/:version', (req, res) => {
  const id = Number(req.params.id);
  const doc = db.getDocument(id);
  if (!doc) return res.status(404).json({ error: 'No such document.' });

  const version = Number(req.params.version);
  const removed = db.deleteDocumentVersion(id, version);
  if (removed == null) {
    const exists = db.getDocumentVersion(id, version);
    if (!exists) return res.status(404).json({ error: `No version ${version}.` });
    return res.status(409).json({ error: 'A document must keep at least one version.' });
  }

  res.json({ deleted: removed });
});

/**
 * Make an older version the document's live content again.
 *
 * The version rail records what a document has been; it did not, until now, let
 * you go back to any of it. A saved draft that reads better than what is in the
 * slot was a download, a hand-edit and a re-upload away from being current.
 *
 * Nothing is rewound: the restored text is filed forward as the newest version,
 * carrying `restored_from`, so the drafts made after it survive the decision and
 * can be restored in turn. Every thread and every point reading this document
 * answers from the restored text on its next turn.
 */
app.post('/api/documents/:id/versions/:version/restore', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getDocument(id)) return res.status(404).json({ error: 'No such document.' });

  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ error: 'version must be a positive integer.' });
  }

  let result;
  try {
    result = db.restoreDocumentVersion(id, version);
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This exact content already exists as another document in the library.' });
    }
    throw err;
  }
  if (!result) return res.status(404).json({ error: `No version ${version}.` });

  res.json({
    ...withoutText(result.doc),
    version: result.version,
    restoredFrom: result.restoredFrom,
    identical: result.identical,
    additions: result.additions,
    deletions: result.deletions,
  });
});

/**
 * Unified diff between two versions of one document, GitHub-style: `from`
 * defaults to the version before `to`, and `to` defaults to the newest.
 */
app.get('/api/documents/:id/diff', (req, res) => {
  const id = Number(req.params.id);
  const doc = db.getDocument(id);
  if (!doc) return res.status(404).json({ error: 'No such document.' });

  const versions = db.listDocumentVersions(id);
  const newest = versions.length ? versions[0].version : 1;
  const to = Number(req.query.to || newest);
  const from = Number(req.query.from ?? to - 1);

  // Version 1 has nothing before it; comparing it to itself is the honest
  // answer and renders as "no changes" rather than an error.
  const textOf = (v) => {
    if (v < 1) return null;
    const row = db.getDocumentVersion(id, v);
    if (row) return row.text;
    return v === 1 ? doc.text : null;
  };

  const oldText = textOf(from);
  const newText = textOf(to);
  if (oldText == null && from >= 1) return res.status(404).json({ error: `No version ${from}.` });
  if (newText == null) return res.status(404).json({ error: `No version ${to}.` });

  // from = 0 is the state before the first upload: everything reads as added,
  // which is exactly how the original content should look in a history view.
  res.json({
    from: Math.max(from, 0),
    to,
    ...buildDiff({ filename: doc.filename, oldText: oldText ?? '', newText }),
  });
});

app.get('/api/documents', (_req, res) => {
  res.json(db.listDocuments().map((d) => ({ ...d, estTokens: estimateTokens(d.chars) })));
});

app.get('/api/documents/:id', (req, res) => {
  const doc = db.getDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'No such document.' });
  const { data, ...rest } = doc;
  res.json(rest);
});

/** Extracted text for the preview modal — docx and text files render from this. */
app.get('/api/documents/:id/text', (req, res) => {
  const doc = db.getDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'No such document.' });
  res.json({ filename: doc.filename, kind: doc.kind, text: doc.text });
});

/**
 * Hand-edit a document's text. Same contract as a re-upload — the outgoing text
 * stays behind as its own version — except the new text arrives from a textarea
 * rather than a file, so every view that can show a document can also correct
 * one. Every thread reading this document sees the edit on its next turn.
 */
app.put('/api/documents/:id/text', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getDocument(id)) return res.status(404).json({ error: 'No such document.' });

  const text = typeof req.body?.text === 'string' ? req.body.text : null;
  if (text == null) return res.status(400).json({ error: 'text is required.' });
  // An empty document is not an edit, it is a deletion with the entry left
  // behind — and there is a route for that which says so.
  if (!text.trim()) return res.status(400).json({ error: 'text cannot be empty — delete the document instead.' });

  let result;
  try {
    result = db.editDocumentText(id, { text });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This exact content already exists as another document in the library.' });
    }
    throw err;
  }

  res.json({
    ...withoutText(result.doc),
    version: result.version,
    identical: result.identical,
    additions: result.additions,
    deletions: result.deletions,
  });
});

/** Raw bytes for the preview modal — only PDFs need this; docx/text preview from the extracted text. */
app.get('/api/documents/:id/file', (req, res) => {
  const file = db.getDocumentFile(Number(req.params.id));
  if (!file || !file.data) return res.status(404).json({ error: 'No stored file for this document.' });

  const contentType = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }[file.kind] || 'text/plain';

  res.set('Content-Type', contentType);
  res.send(Buffer.from(file.data));
});

// Takes the stored bytes and every filed version with it. Threads survive with
// their history; their document_id goes NULL. The UI gates this behind a
// type-the-word dialog, so a 404 here means the library list was stale.
app.delete('/api/documents/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getDocument(id)) return res.status(404).json({ error: 'No such document.' });
  res.json({ deleted: db.deleteDocument(id) });
});

app.patch('/api/documents/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getDocument(id)) return res.status(404).json({ error: 'No such document.' });

  const filename = req.body?.filename?.trim();
  if (!filename) return res.status(400).json({ error: 'filename is required.' });

  res.json(withoutText(db.renameDocument(id, filename)));
});

/* ------------------------------------------------------------------ threads */

app.get('/api/threads', (_req, res) => res.json(db.listThreads()));

app.post('/api/threads', (req, res) => {
  const { title, documentId, model } = req.body || {};

  if (documentId != null && !db.getDocument(documentId)) {
    return res.status(400).json({ error: 'No such document.' });
  }
  const doc = documentId != null ? db.getDocument(documentId) : null;
  res.json(db.createThread({ title: title || doc?.filename || 'New thread', documentId, model }));
});

app.get('/api/threads/:id', (req, res) => {
  const thread = db.getThread(Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'No such thread.' });
  res.json({ thread, messages: db.getMessages(thread.id) });
});

app.patch('/api/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getThread(id)) return res.status(404).json({ error: 'No such thread.' });
  if (req.body?.title) db.renameThread(id, req.body.title);
  if (req.body?.model) db.setThreadModel(id, req.body.model);

  // Where the model is told the conversation begins. `null` clears the mark and
  // sends the whole thing again; presence of the key is what counts, so a
  // caller can distinguish "leave it alone" from "send everything".
  if ('contextFromMessageId' in (req.body || {})) {
    const messageId = req.body.contextFromMessageId;
    if (messageId != null) {
      const message = db.getMessage(Number(messageId));
      if (!message || message.thread_id !== id) {
        return res.status(400).json({ error: 'That message is not in this conversation.' });
      }
      // Starting at the first message is starting at the beginning. Storing a
      // mark for it would be a mark that excludes nothing — and every view
      // would then have to draw a cut with no turns above it.
      const first = db.getMessages(id)[0];
      db.setThreadContextStart(id, message.id === first?.id ? null : message.id);
    } else {
      db.setThreadContextStart(id, null);
    }
  }

  // `documentId: null` detaches, so presence of the key is what counts here.
  if ('documentId' in (req.body || {})) {
    const documentId = req.body.documentId;
    if (documentId != null && !db.getDocument(documentId)) {
      return res.status(400).json({ error: 'No such document.' });
    }
    db.setThreadDocument(id, documentId);
  }
  res.json(db.getThread(id));
});

app.delete('/api/threads/:id', (req, res) => {
  res.json({ deleted: db.deleteThread(Number(req.params.id)) });
});

/**
 * What this conversation could be called, read from what is actually in it.
 *
 * A suggestion and nothing more: the title is returned, never written. The
 * caller shows it, and the rename it already has does the writing if the user
 * keeps it. That split is the whole point — the model never renames anything
 * behind the user's back.
 */
app.post('/api/threads/:id/suggest-title', asyncRoute(async (req, res) => {
  const built = threadTitlePrompt(Number(req.params.id));
  if (!built) return res.status(404).json({ error: 'No such thread.' });

  const model = req.body?.model || llm.config().model;
  try {
    const out = await suggestTitle(built.messages, { model });
    trace(traceRow({
      threadId: built.subject.id, kind: 'chat', task: 'title', model,
      result: out.result, messages: built.messages,
    }));
    res.json({ title: out.title, model: out.model, current: built.subject.title });
  } catch (err) {
    trace(traceRow({
      threadId: built.subject.id, kind: 'chat', task: 'title', model,
      messages: built.messages, status: 'error', error: err.message,
    }));
    res.status(502).json({ error: err.message });
  }
}));

/* --------------------------------------------------------- saved responses */

app.post('/api/saved-responses', (req, res) => {
  const message = db.getMessage(Number(req.body?.messageId));
  if (!message) return res.status(404).json({ error: 'No such message.' });

  res.json(db.saveResponse({
    messageId: message.id, content: message.content, model: message.model, task: message.task,
  }));
});

app.get('/api/saved-responses', (_req, res) => res.json(db.listSavedResponses()));

app.get('/api/threads/:id/saved-responses', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getThread(id)) return res.status(404).json({ error: 'No such thread.' });
  res.json(db.listAssignedSavedResponseIds(id));
});

app.post('/api/threads/:id/saved-responses', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getThread(id)) return res.status(404).json({ error: 'No such thread.' });

  const ids = (req.body?.savedResponseIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return res.status(400).json({ error: 'savedResponseIds is required.' });

  res.json(db.assignSavedResponsesToThread(id, ids));
});

app.delete('/api/saved-responses/:id', (req, res) => {
  res.json({ deleted: db.deleteSavedResponse(Number(req.params.id)) });
});

/* ------------------------------------------------------------- extra sources

   Every screen that talks to the model can hand the conversation more to read
   than its own book: other conversations, and whole graphs. The list is on the
   thread, not on the screen, so a record given two sources on the deck arrives
   at the canvas already reading them.
   ------------------------------------------------------------------------- */

/** Everything that can be attached, minus the conversation doing the asking. */
app.get('/api/source-catalog', (req, res) => {
  const exclude = req.query.thread ? Number(req.query.thread) : null;
  res.json(db.sourceCatalog({ excludeThreadId: Number.isFinite(exclude) ? exclude : null }));
});

/**
 * What this conversation reads besides its own book, and what that costs.
 *
 * The size is assembled, not stored: a source grows when someone answers in it,
 * and a number filed at the moment of attaching would be wrong by the next turn.
 */
app.get('/api/threads/:id/sources', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getThread(id)) return res.status(404).json({ error: 'No such thread.' });

  const items = db.listThreadSources(id);
  const assembled = attachedThreadSource(id);
  res.json({
    items,
    summary: assembled ? sourceSummary(assembled) : { chars: 0, filename: null, parts: [] },
    preview: assembled ? assembled.text.slice(0, 4000) : '',
  });
});

/** Save the whole list at once — it is a set of ticks, so it replaces. */
app.put('/api/threads/:id/sources', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getThread(id)) return res.status(404).json({ error: 'No such thread.' });
  if (!Array.isArray(req.body?.items)) {
    return res.status(400).json({ error: 'items must be an array.' });
  }
  res.json({ items: db.setThreadSources(id, req.body.items) });
});

/* -------------------------------------------------------------- ground truth */

/** Ask the model to compare a response's wording against the source document. */
app.post('/api/threads/:id/messages/:messageId/ground-truth', asyncRoute(async (req, res) => {
  const threadId = Number(req.params.id);
  const thread = db.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'No such thread.' });

  const message = db.getMessage(Number(req.params.messageId));
  if (!message || message.thread_id !== threadId) return res.status(404).json({ error: 'No such message.' });

  const { text: docText, filename } = db.getThreadDocText(threadId);
  if (!docText) return res.status(400).json({ error: 'This thread has no document to check against.' });

  // Unlike a normal answer, this asks the model to enumerate every difference
  // across the whole document — a 268k-char book reliably outran the client's
  // 5-minute connection timeout in testing (cryptic network error, not a model
  // failure). Fail fast and clearly instead of hanging; a real fix needs either
  // a longer timeout or a map-reduce pass, both out of scope for this change.
  if (docText.length + message.content.length > GROUND_TRUTH_MAX_CHARS) {
    return res.status(400).json({
      error: `This document is too large for a single-pass ground-truth check `
        + `(${(docText.length + message.content.length).toLocaleString()} chars, `
        + `limit ${GROUND_TRUTH_MAX_CHARS.toLocaleString()}). Try a shorter document or response.`,
    });
  }

  const messages = buildGroundTruthMessages({ docText, filename, response: message.content });
  const chosenModel = thread.model || llm.config().model;

  let result;
  try {
    result = await llm.complete(messages, { model: chosenModel });
  } catch (err) {
    trace(traceRow({
      threadId, kind: 'chat', task: 'ground-truth', model: chosenModel, messages, status: 'error', error: err.message,
    }));
    return res.status(502).json({ error: err.message });
  }
  trace(traceRow({ threadId, kind: 'chat', task: 'ground-truth', model: chosenModel, result, messages }));

  let diff;
  try {
    diff = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    if (!Array.isArray(diff)) throw new Error('response was not a JSON array');
  } catch (err) {
    return res.status(502).json({ error: `Model did not return a valid diff (${err.message}). Try again.` });
  }

  res.json(db.saveGroundTruthCheck({ messageId: message.id, diff, model: result.servedModel || chosenModel }));
}));

app.get('/api/messages/:id/ground-truth', (req, res) => {
  const check = db.getGroundTruthCheck(Number(req.params.id));
  if (!check) return res.status(404).json({ error: 'No ground-truth check yet.' });
  res.json(check);
});

/* ------------------------------------------------------------ inline rewrite */

/**
 * Rewrite a single selected passage (Ctrl+select in the preview). The model
 * returns only the rewritten span, which the client splices back into the
 * document at the exact place it was marked.
 */
app.post('/api/rewrite', asyncRoute(async (req, res) => {
  const { passage, instruction, model } = req.body || {};
  if (!passage?.trim()) return res.status(400).json({ error: 'passage is required.' });

  const chosenModel = model || llm.config().model;
  const messages = buildRewriteMessages({ passage, instruction });
  const started = Date.now();

  let result;
  try {
    result = await llm.complete(messages, { model: chosenModel });
  } catch (err) {
    trace(traceRow({
      threadId: null, kind: 'chat', task: 'rewrite', model: chosenModel, messages, status: 'error', error: err.message,
    }));
    return res.status(502).json({ error: err.message });
  }
  trace(traceRow({ threadId: null, kind: 'chat', task: 'rewrite', model: chosenModel, result, messages }));

  const rewritten = result.text.trim();
  if (!rewritten) {
    return res.status(502).json({ error: 'The model returned an empty rewrite. Try again.' });
  }
  res.json({ rewritten, model: result.servedModel || chosenModel, ms: Date.now() - started });
}));

/* -------------------------------------------------------------------- docx */

/**
 * Unlike the PDF export (a browser print dialog, needs no server support),
 * there is no browser-native way to write a .docx, so this builds one
 * server-side with the `docx` package and streams it down as an attachment.
 */
app.get('/api/messages/:id/docx', asyncRoute(async (req, res) => {
  const message = db.getMessage(Number(req.params.id));
  if (!message) return res.status(404).json({ error: 'No such message.' });

  const thread = db.getThread(message.thread_id);
  const meta = [message.model, message.task && message.task !== 'chat' ? message.task : null]
    .filter(Boolean).join(' · ');

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: thread?.title || 'Response', bold: true, size: 32 })] }),
        ...(meta ? [new Paragraph({ children: [new TextRun({ text: meta, color: '6b7280', size: 20 })] })] : []),
        new Paragraph({ text: '' }),
        ...message.content.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  // Header values must be Latin-1, but thread titles are free text (e.g. Polish
  // diacritics) — keep an ASCII-only fallback name and the real one via filename*.
  const rawName = thread?.title || 'response';
  const utf8Name = rawName.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'response';
  const asciiName = utf8Name.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="${asciiName}.docx"; filename*=UTF-8''${encodeURIComponent(utf8Name)}.docx`,
  });
  res.send(buffer);
}));

/* ------------------------------------------------------- version export */

/** Shared download-name helper: ASCII fallback + UTF-8 filename* for diacritics. */
function downloadName(rawName, ext) {
  const utf8Name = String(rawName || 'document').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'document';
  const asciiName = utf8Name.replace(/[^\x20-\x7e]/g, '_');
  return {
    'Content-Disposition': `attachment; filename="${asciiName}.${ext}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}.${ext}`,
  };
}

/** Resolve a document version's text, or 404. `version` defaults to the newest. */
function versionTextOr404(res, documentId, version) {
  const doc = db.getDocument(documentId);
  if (!doc) return { error: res.status(404).json({ error: 'No such document.' }) };

  const versions = db.listDocumentVersions(documentId);
  const newest = versions.length ? versions[0].version : 1;
  const v = Number(version ?? newest);

  const row = db.getDocumentVersion(documentId, v);
  if (!row) return { error: res.status(404).json({ error: `No version ${v}.` }) };
  return { doc, row, v };
}

/** Download a version's text as plain text. */
app.get('/api/documents/:id/versions/:version/text', (req, res) => {
  const { error, doc, row } = versionTextOr404(res, Number(req.params.id), req.params.version);
  if (error) return;
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', ...downloadName(`${doc.filename} v${row.version}`, 'txt') });
  res.send(row.text);
});

/** Download a version's text as .docx, built server-side with the `docx` package. */
app.get('/api/documents/:id/versions/:version/docx', asyncRoute(async (req, res) => {
  const { error, doc, row } = versionTextOr404(res, Number(req.params.id), req.params.version);
  if (error) return;

  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: `${doc.filename} — v${row.version}`, bold: true, size: 28 })] }),
        new Paragraph({ text: '' }),
        ...row.text.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(document);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ...downloadName(`${doc.filename} v${row.version}`, 'docx'),
  });
  res.send(buffer);
}));

/** Download a version's text as .rtf (Word-compatible rich text). */
app.get('/api/documents/:id/versions/:version/rtf', (req, res) => {
  const { error, doc, row } = versionTextOr404(res, Number(req.params.id), req.params.version);
  if (error) return;

  const esc = (s) => s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\par\n');
  const body = row.text.split('\n').map((line) => esc(line)).join('\n\\par\n');
  const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil\\fcharset238 Arial;}}\\f0\\fs24 ${body}\\par}`;

  res.set({ 'Content-Type': 'application/rtf', ...downloadName(`${doc.filename} v${row.version}`, 'rtf') });
  res.send(Buffer.from(rtf, 'utf8'));
});

/* --------------------------------------------------- threaded inference (SSE) */

/**
 * Stream one assistant turn over SSE.
 *
 * The user message is always persisted by the caller before this runs, which is
 * what makes retrying cheap: a failed turn leaves the question in the thread, so
 * the retry route replays it instead of asking the user to type it again.
 */
async function streamTurn(res, { threadId, userMsg, history, taskId, chosenModel, version, source = null }) {
  const question = userMsg.content;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (type, v) => res.write(`data: ${JSON.stringify({ type, v })}\n\n`);
  const abort = new AbortController();
  // Must be on `res`, not `req`: the request stream emits 'close' as soon as
  // express.json() has consumed the body, which would abort us immediately.
  res.on('close', () => abort.abort());

  send('user', userMsg);

  // Normally the context is the thread's own document. A turn sent from a graph
  // supplies its own instead: the points upstream of it, already assembled into
  // one body of source text. Everything downstream — the budget check, the
  // map-reduce split, the traces — is identical either way.
  const { text: docText, filename } = source ?? db.getThreadDocText(threadId, version);
  const started = Date.now();
  const traceIds = [];
  let answer = '';
  let reasoning = '';

  const onToken = (t) => { answer += t; send('token', t); };
  const onThinking = (t) => { reasoning += t; send('thinking', t); };
  // Only the streamed call that writes the answer can truncate it; the map
  // stage is summarised again downstream, so its cap does not end the turn.
  let finishReason = null;
  let effectiveCap = Number(process.env.MAX_TOKENS ?? 4096);

  // The model that ends up on the saved message is the one that answered, not
  // the one that was asked for: a fallback provider serves its own model, and a
  // bubble labelled with a model that never ran is a lie the traces disagree with.
  let usedModel = chosenModel;
  const fallbackNotices = [];
  const onFallback = ({ failed, error, next }) => {
    fallbackNotices.push(`${failed.label} failed (${error})`);
    send('fallback', { failed: failed.label, error, next: next.label, model: next.model });
    send('stage', `${failed.label} unavailable — falling back to ${next.label}`);
  };
  const noteProvider = (result) => {
    if (result?.model) usedModel = result.model;
  };

  try {
    if (docText.length <= CONTEXT_BUDGET) {
      const messages = buildThreadMessages({ docText, filename, history, question, taskId });
      send('stage', docText
        ? `single pass · ~${estimateTokens(docText).toLocaleString()} doc tokens · turn ${history.length / 2 + 1}`
        : 'no document · plain chat');

      const result = await llm.stream(messages, {
        model: chosenModel, onToken, onThinking, signal: abort.signal, onFallback,
      });
      traceIds.push(trace(traceRow({
        threadId, kind: 'chat', task: taskId, model: chosenModel, result, messages,
      })));
      noteProvider(result);
      finishReason = result.finishReason;
      effectiveCap = result.maxTokens ?? effectiveCap;
      send('usage', usagePayload(result));
    } else {
      const chunks = chunkText(docText, CHUNK, OVERLAP);
      send('stage', `map-reduce · ${chunks.length} sections`);

      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        if (abort.signal.aborted) return;
        send('stage', `analysing section ${i + 1}/${chunks.length}`);

        const messages = buildThreadMapMessages({
          chunk: chunks[i], question, filename, taskId, part: { i: i + 1, n: chunks.length },
        });
        const result = await llm.complete(messages, {
          signal: abort.signal, model: chosenModel, onFallback,
        });
        traceIds.push(trace(traceRow({
          threadId, kind: 'map', task: taskId, model: chosenModel, result, messages,
        })));
        noteProvider(result);
        send('usage', usagePayload(result));

        if (!/NOTHING RELEVANT IN THIS SECTION/i.test(result.text)) parts.push(result.text);
      }

      if (!parts.length) {
        onToken('No section of the document contains anything relevant to that question.');
      } else {
        send('stage', `merging ${parts.length} relevant sections`);
        const messages = buildThreadReduceMessages({ parts, question, history, filename, taskId });
        const result = await llm.stream(messages, {
          model: chosenModel, onToken, onThinking, signal: abort.signal, onFallback,
        });
        traceIds.push(trace(traceRow({
          threadId, kind: 'reduce', task: taskId, model: chosenModel, result, messages,
        })));
        noteProvider(result);
        finishReason = result.finishReason;
        effectiveCap = result.maxTokens ?? effectiveCap;
        send('usage', usagePayload(result));
      }
    }

    const saved = db.addMessage({
      threadId, role: 'assistant', content: answer, reasoning: reasoning || null,
      model: usedModel, task: taskId, ms: Date.now() - started,
      error: truncationError(finishReason, answer, usedModel, effectiveCap),
    });
    db.linkTracesToMessage(traceIds.filter(Boolean), saved.id);
    send('done', {
      ...saved,
      usage: db.threadUsage(threadId),
      // Empty on the normal path. Non-empty means the main provider was down and
      // something else answered — the UI says so instead of quietly swapping models.
      fallbacks: fallbackNotices,
    });
  } catch (err) {
    const aborted = abort.signal.aborted;
    trace({
      threadId, kind: 'chat', task: taskId, model: chosenModel,
      baseUrl: llm.config().baseUrl,
      responseText: answer, reasoningText: reasoning || null,
      durationMs: Date.now() - started,
      status: aborted ? 'aborted' : 'error',
      error: aborted ? 'stopped by user' : err.message,
    });

    if (answer || !aborted) {
      const saved = db.addMessage({
        threadId, role: 'assistant', content: answer, reasoning: reasoning || null,
        model: usedModel, task: taskId, ms: Date.now() - started,
        error: aborted ? 'stopped by user' : err.message,
      });
      db.linkTracesToMessage(traceIds.filter(Boolean), saved.id);
    }
    if (!aborted) send('error', err.message);
  } finally {
    res.end();
  }
}

app.post('/api/threads/:id/messages', asyncRoute(async (req, res) => {
  const threadId = Number(req.params.id);
  const thread = db.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'No such thread.' });

  const { content, taskId = 'chat', model, version } = req.body || {};
  const question = (content ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Empty message.' });

  const chosenModel = model || thread.model || llm.config().model;
  if (model && model !== thread.model) db.setThreadModel(threadId, model);

  // Persist the user turn before inference, so a crash mid-answer still leaves
  // the question in the thread rather than losing it.
  // Only from the message the user marked as the start — everything above it
  // stays in the transcript and stops being paid for.
  const history = db.contextMessages(threadId).map((m) => ({ role: m.role, content: m.content }));
  const userMsg = db.addMessage({ threadId, role: 'user', content: question, task: taskId });

  // First user message names the thread.
  if (history.length === 0 && (thread.title === 'New thread' || !thread.title)) {
    db.renameThread(threadId, question.slice(0, 60));
  }

  // A conversation with nothing attached is answered from its own book, which
  // `streamTurn` fetches for itself. Attach anything — another conversation, a
  // whole graph — and the context is assembled here instead, book first.
  await streamTurn(res, {
    threadId, userMsg, history, taskId, chosenModel, version,
    source: attachedThreadSource(threadId, { version }),
  });
}));

/**
 * Re-run a turn that failed, without retyping the question. `messageId` is the
 * failed assistant reply, or the user message whose reply never arrived.
 *
 * Only the tail of a thread can be retried: regenerating a turn in the middle
 * would leave every later message answering a reply that no longer exists.
 */
app.post('/api/threads/:id/messages/:messageId/retry', asyncRoute(async (req, res) => {
  const threadId = Number(req.params.id);
  const thread = db.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'No such thread.' });

  const messages = db.getMessages(threadId);
  const last = messages[messages.length - 1];
  const target = messages.find((m) => m.id === Number(req.params.messageId));

  if (!target) return res.status(404).json({ error: 'No such message.' });
  if (target.id !== last.id) {
    return res.status(409).json({ error: 'Only the last turn can be retried.' });
  }
  if (target.role === 'assistant' && !target.error) {
    return res.status(409).json({ error: 'That turn succeeded — send a new message instead.' });
  }

  const userIdx = target.role === 'user' ? messages.length - 1 : messages.length - 2;
  const userMsg = messages[userIdx];
  if (!userMsg || userMsg.role !== 'user') {
    return res.status(409).json({ error: 'No question to retry.' });
  }

  // Drop the failed reply so the retry does not stack a second answer under the
  // same question. Its traces stay behind, unlinked, for the trace sheet.
  if (target.role === 'assistant') db.deleteMessage(target.id);

  const { model } = req.body || {};
  const chosenModel = model || thread.model || llm.config().model;
  if (model && model !== thread.model) db.setThreadModel(threadId, model);

  await streamTurn(res, {
    threadId,
    userMsg,
    history: messages.slice(db.contextStartIndex(threadId, messages), userIdx)
      .map((m) => ({ role: m.role, content: m.content })),
    taskId: userMsg.task || 'chat',
    chosenModel,
    source: attachedThreadSource(threadId),
  });
}));

/**
 * Rewrite a question and answer it again. Unlike retry this works anywhere in
 * the thread — but every message after the edited one is discarded first, since
 * they answer a question that no longer exists.
 */
app.post('/api/threads/:id/messages/:messageId/edit', asyncRoute(async (req, res) => {
  const threadId = Number(req.params.id);
  const thread = db.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'No such thread.' });

  const messages = db.getMessages(threadId);
  const idx = messages.findIndex((m) => m.id === Number(req.params.messageId));
  if (idx === -1) return res.status(404).json({ error: 'No such message.' });
  if (messages[idx].role !== 'user') {
    return res.status(409).json({ error: 'Only your own messages can be edited.' });
  }

  const { content, model } = req.body || {};
  const question = (content ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Empty message.' });

  const chosenModel = model || thread.model || llm.config().model;
  if (model && model !== thread.model) db.setThreadModel(threadId, model);

  const userMsg = db.editMessage(messages[idx].id, question);
  db.deleteMessagesAfter(threadId, userMsg.id);

  // The thread was named after this message, so the rename follows the edit.
  if (idx === 0) db.renameThread(threadId, question.slice(0, 60));

  await streamTurn(res, {
    threadId,
    userMsg,
    history: messages.slice(db.contextStartIndex(threadId, messages), idx)
      .map((m) => ({ role: m.role, content: m.content })),
    taskId: userMsg.task || 'chat',
    chosenModel,
    source: attachedThreadSource(threadId),
  });
}));

/* -------------------------------------------------------------------- traces */

function usagePayload(result) {
  return {
    promptTokens: result.usage?.prompt_tokens ?? null,
    completionTokens: result.usage?.completion_tokens ?? null,
    totalTokens: result.usage?.total_tokens ?? null,
    ttftMs: result.ttftMs,
    durationMs: result.durationMs,
  };
}

app.get('/api/traces', (req, res) => {
  const threadId = req.query.threadId ? Number(req.query.threadId) : undefined;
  res.json(db.listTraces({ threadId, limit: Number(req.query.limit) || 100 }));
});

app.get('/api/traces/:id', (req, res) => {
  const t = db.getTrace(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'No such trace.' });
  res.json({
    ...t,
    request: safeParse(t.request_json),
    params: safeParse(t.request_params),
  });
});

app.get('/api/usage', (req, res) => {
  res.json(req.query.threadId
    ? db.threadUsage(Number(req.query.threadId))
    : db.usageSummary());
});

app.get('/api/threads/:id/usage', (req, res) => {
  const id = Number(req.params.id);
  res.json({ thread: db.threadUsage(id), perMessage: db.messageUsage(id) });
});

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* -------------------------------------------------------------------- misc */

function withoutText(doc) {
  const { text, data, ...rest } = doc;
  return { ...rest, estTokens: estimateTokens(doc.chars) };
}

app.use((err, _req, res, _next) => {
  const tooBig = err?.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 500).json({
    error: tooBig ? `File exceeds the ${(MAX_UPLOAD / 1048576).toFixed(0)} MB limit.` : err.message,
  });
});

app.listen(PORT, () => {
  const { baseUrl, model, source, fallbacks } = llm.config();
  const s = db.stats();
  console.log(`\n  spark-doc-lab  →  http://localhost:${PORT}`);
  console.log(`  inference      →  ${baseUrl}  (${source === 'db' ? 'from LLM settings' : 'from .env — not saved yet'})`);
  console.log(`  model          →  ${model}`);
  if (fallbacks.length) {
    console.log(`  fallbacks      →  ${fallbacks.map((f) => `${f.label} (${f.model || 'default model'})`).join(' → ')}`);
  }
  console.log(`  store          →  ${s.path}`);
  console.log(`                    ${s.documents} documents · ${s.threads} threads · ${s.messages} messages`);
  console.log(`  grimoire       →  http://localhost:${PORT}/grimoire`);
  console.log(`  graphs         →  http://localhost:${PORT}/grimoire-graphs`);
  console.log(`  mixed console  →  http://localhost:${PORT}/grimoire-mix\n`);
});
