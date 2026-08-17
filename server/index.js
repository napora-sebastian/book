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
  TASKS,
} from './tasks.js';
import * as llm from './llm.js';
import * as db from './db.js';

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
app.use(express.static(path.join(__dirname, '..', 'public')));

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
    baseUrl: llm.config().baseUrl,
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
  const { baseUrl, model } = llm.config();
  const out = {
    baseUrl,
    model,
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
    unchanged: result.unchanged,
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

app.delete('/api/documents/:id', (req, res) => {
  res.json({ deleted: db.deleteDocument(Number(req.params.id)) });
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

/* --------------------------------------------------- threaded inference (SSE) */

/**
 * Stream one assistant turn over SSE.
 *
 * The user message is always persisted by the caller before this runs, which is
 * what makes retrying cheap: a failed turn leaves the question in the thread, so
 * the retry route replays it instead of asking the user to type it again.
 */
async function streamTurn(res, { threadId, userMsg, history, taskId, chosenModel }) {
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

  const { text: docText, filename } = db.getThreadDocText(threadId);
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

  try {
    if (docText.length <= CONTEXT_BUDGET) {
      const messages = buildThreadMessages({ docText, filename, history, question, taskId });
      send('stage', docText
        ? `single pass · ~${estimateTokens(docText).toLocaleString()} doc tokens · turn ${history.length / 2 + 1}`
        : 'no document · plain chat');

      const result = await llm.stream(messages, {
        model: chosenModel, onToken, onThinking, signal: abort.signal,
      });
      traceIds.push(trace(traceRow({
        threadId, kind: 'chat', task: taskId, model: chosenModel, result, messages,
      })));
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
        const result = await llm.complete(messages, { signal: abort.signal, model: chosenModel });
        traceIds.push(trace(traceRow({
          threadId, kind: 'map', task: taskId, model: chosenModel, result, messages,
        })));
        send('usage', usagePayload(result));

        if (!/NOTHING RELEVANT IN THIS SECTION/i.test(result.text)) parts.push(result.text);
      }

      if (!parts.length) {
        onToken('No section of the document contains anything relevant to that question.');
      } else {
        send('stage', `merging ${parts.length} relevant sections`);
        const messages = buildThreadReduceMessages({ parts, question, history, filename, taskId });
        const result = await llm.stream(messages, {
          model: chosenModel, onToken, onThinking, signal: abort.signal,
        });
        traceIds.push(trace(traceRow({
          threadId, kind: 'reduce', task: taskId, model: chosenModel, result, messages,
        })));
        finishReason = result.finishReason;
        effectiveCap = result.maxTokens ?? effectiveCap;
        send('usage', usagePayload(result));
      }
    }

    const saved = db.addMessage({
      threadId, role: 'assistant', content: answer, reasoning: reasoning || null,
      model: chosenModel, task: taskId, ms: Date.now() - started,
      error: truncationError(finishReason, answer, chosenModel, effectiveCap),
    });
    db.linkTracesToMessage(traceIds.filter(Boolean), saved.id);
    send('done', { ...saved, usage: db.threadUsage(threadId) });
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
        model: chosenModel, task: taskId, ms: Date.now() - started,
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

  const { content, taskId = 'chat', model } = req.body || {};
  const question = (content ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Empty message.' });

  const chosenModel = model || thread.model || llm.config().model;
  if (model && model !== thread.model) db.setThreadModel(threadId, model);

  // Persist the user turn before inference, so a crash mid-answer still leaves
  // the question in the thread rather than losing it.
  const history = db.getMessages(threadId).map((m) => ({ role: m.role, content: m.content }));
  const userMsg = db.addMessage({ threadId, role: 'user', content: question, task: taskId });

  // First user message names the thread.
  if (history.length === 0 && (thread.title === 'New thread' || !thread.title)) {
    db.renameThread(threadId, question.slice(0, 60));
  }

  await streamTurn(res, { threadId, userMsg, history, taskId, chosenModel });
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
    history: messages.slice(0, userIdx).map((m) => ({ role: m.role, content: m.content })),
    taskId: userMsg.task || 'chat',
    chosenModel,
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
    history: messages.slice(0, idx).map((m) => ({ role: m.role, content: m.content })),
    taskId: userMsg.task || 'chat',
    chosenModel,
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
  const { baseUrl, model } = llm.config();
  const s = db.stats();
  console.log(`\n  spark-doc-lab  →  http://localhost:${PORT}`);
  console.log(`  inference      →  ${baseUrl}`);
  console.log(`  model          →  ${model}`);
  console.log(`  store          →  ${s.path}`);
  console.log(`                    ${s.documents} documents · ${s.threads} threads · ${s.messages} messages\n`);
});
