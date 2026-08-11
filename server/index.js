import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

import { extractText } from './extract.js';
import { chunkText, estimateTokens } from './chunk.js';
import {
  buildThreadMessages,
  buildThreadMapMessages,
  buildThreadReduceMessages,
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
  });

  res.json({ ...withoutText(doc), reused, warnings: extracted.warnings ?? [] });
}));

app.get('/api/documents', (_req, res) => {
  res.json(db.listDocuments().map((d) => ({ ...d, estTokens: estimateTokens(d.chars) })));
});

app.get('/api/documents/:id', (req, res) => {
  const doc = db.getDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'No such document.' });
  res.json(doc);
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
  const { text, ...rest } = doc;
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
