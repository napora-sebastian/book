import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'threads.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL survives a crash mid-write and lets reads proceed during a write, which
// matters because a single insert can carry 600k chars of document text.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
  -- A document is stored once and can back any number of threads.
  CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    NOT NULL,
    kind        TEXT,
    text        TEXT    NOT NULL,
    chars       INTEGER NOT NULL,
    words       INTEGER,
    pages       INTEGER,
    bytes       INTEGER,
    sha256      TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS threads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    model       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK (role IN ('user','assistant')),
    content     TEXT    NOT NULL,
    reasoning   TEXT,
    model       TEXT,
    task        TEXT,
    ms          INTEGER,
    error       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per call to the cluster. A single user turn produces one trace on
  -- the single-pass path, or N+1 (map sections + reduce) on the map-reduce path.
  CREATE TABLE IF NOT EXISTS traces (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id         INTEGER REFERENCES threads(id) ON DELETE CASCADE,
    message_id        INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    kind              TEXT    NOT NULL,          -- chat | map | reduce
    task              TEXT,
    model             TEXT    NOT NULL,          -- what we asked for
    served_model      TEXT,                      -- what the server said it used
    base_url          TEXT,
    fingerprint       TEXT,                      -- vllm build + tp topology
    request_json      TEXT,                      -- messages as sent (doc elided)
    request_params    TEXT,                      -- temperature, max_tokens, …
    prompt_chars      INTEGER,                   -- true size incl. document
    prompt_messages   INTEGER,
    response_text     TEXT,
    reasoning_text    TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    ttft_ms           INTEGER,
    duration_ms       INTEGER,
    status            TEXT    NOT NULL DEFAULT 'ok',   -- ok | error | aborted
    error             TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- A response saved for reuse. The text is snapshotted (not just a
  -- message_id pointer) so it survives edits or deletion of its source
  -- thread, the same way a document's text outlives any one thread.
  CREATE TABLE IF NOT EXISTS saved_responses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    content     TEXT    NOT NULL,
    model       TEXT,
    task        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Many-to-many: a saved response can be assigned to more than one thread.
  CREATE TABLE IF NOT EXISTS saved_response_threads (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_response_id  INTEGER NOT NULL REFERENCES saved_responses(id) ON DELETE CASCADE,
    thread_id          INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    assigned_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(saved_response_id, thread_id)
  );

  -- One row per message, holding the model's own old/new line comparison
  -- against the source document. Re-running a check replaces it (UNIQUE).
  CREATE TABLE IF NOT EXISTS ground_truth_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    diff_json   TEXT    NOT NULL,
    model       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_traces_thread ON traces(thread_id, id);
  CREATE INDEX IF NOT EXISTS idx_traces_message ON traces(message_id);
  CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
  CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_response_threads_thread ON saved_response_threads(thread_id);
  CREATE INDEX IF NOT EXISTS idx_saved_response_threads_saved ON saved_response_threads(saved_response_id);
`);

// Columns added after the first release. Existing stores are migrated in place
// rather than rebuilt, so a book's threads survive an upgrade.
for (const [table, column, type] of [['traces', 'finish_reason', 'TEXT']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/* ---------------------------------------------------------------- documents */

/**
 * Store a document, or return the existing row if the identical text was saved
 * before. Hashing the text (not the file bytes) means the same report exported
 * twice from Word still resolves to one library entry.
 */
export function saveDocument({ filename, kind, text, words, pages, bytes }) {
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  const existing = db.prepare('SELECT * FROM documents WHERE sha256 = ?').get(sha256);
  if (existing) return { doc: existing, reused: true };

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO documents (filename, kind, text, chars, words, pages, bytes, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(filename, kind ?? null, text, text.length, words ?? null, pages ?? null, bytes ?? null, sha256);

  return { doc: getDocument(Number(lastInsertRowid)), reused: false };
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) ?? null;
}

/** Library list for the "saved files" dropdown — excludes the text column. */
export function listDocuments(limit = 200) {
  return db
    .prepare(
      `SELECT d.id, d.filename, d.kind, d.chars, d.words, d.pages, d.bytes, d.created_at,
              (SELECT COUNT(*) FROM threads t WHERE t.document_id = d.id) AS thread_count
         FROM documents d
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function deleteDocument(id) {
  // Threads keep their history; document_id goes NULL via ON DELETE SET NULL.
  return db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
}

export function renameDocument(id, filename) {
  db.prepare('UPDATE documents SET filename = ? WHERE id = ?').run(filename, id);
  return getDocument(id);
}

/* ------------------------------------------------------------------ threads */

export function createThread({ title, documentId, model }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO threads (title, document_id, model) VALUES (?, ?, ?)')
    .run(title || 'New thread', documentId ?? null, model ?? null);
  return getThread(Number(lastInsertRowid));
}

/** Thread list for the sidebar — joins the document name, never its text. */
export function listThreads(limit = 200) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.model, t.created_at, t.updated_at,
              t.document_id, d.filename, d.chars AS doc_chars, d.pages AS doc_pages,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT m.content FROM messages m
                WHERE m.thread_id = t.id AND m.role = 'user'
                ORDER BY m.id DESC LIMIT 1) AS last_user
         FROM threads t
         LEFT JOIN documents d ON d.id = t.document_id
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function getThread(id) {
  return (
    db
      .prepare(
        `SELECT t.*, d.filename, d.kind AS doc_kind, d.chars AS doc_chars,
                d.pages AS doc_pages, d.words AS doc_words
           FROM threads t
           LEFT JOIN documents d ON d.id = t.document_id
          WHERE t.id = ?`,
      )
      .get(id) ?? null
  );
}

/** Only the inference path needs the full text, so it is fetched separately. */
export function getThreadDocText(threadId) {
  const row = db
    .prepare(
      `SELECT d.text, d.filename FROM threads t
         JOIN documents d ON d.id = t.document_id
        WHERE t.id = ?`,
    )
    .get(threadId);
  return row ?? { text: '', filename: null };
}

export function getMessages(threadId) {
  return db
    .prepare(
      `SELECT m.*, EXISTS(SELECT 1 FROM ground_truth_checks g WHERE g.message_id = m.id) AS has_ground_truth
         FROM messages m WHERE m.thread_id = ? ORDER BY m.id ASC`,
    )
    .all(threadId);
}

export function getMessage(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? null;
}

export function renameThread(id, title) {
  db.prepare("UPDATE threads SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
  return getThread(id);
}

export function setThreadModel(id, model) {
  db.prepare("UPDATE threads SET model = ?, updated_at = datetime('now') WHERE id = ?").run(model, id);
}

/** Attach a document to an existing thread, or pass null to detach it. */
export function setThreadDocument(id, documentId) {
  db.prepare("UPDATE threads SET document_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(documentId ?? null, id);
  return getThread(id);
}

export function deleteThread(id) {
  return db.prepare('DELETE FROM threads WHERE id = ?').run(id).changes > 0;
}

/* --------------------------------------------------------- saved responses */

export function saveResponse({ messageId, content, model, task }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO saved_responses (message_id, content, model, task) VALUES (?, ?, ?, ?)')
    .run(messageId ?? null, content, model ?? null, task ?? null);
  return db.prepare('SELECT * FROM saved_responses WHERE id = ?').get(Number(lastInsertRowid));
}

export function listSavedResponses() {
  return db.prepare('SELECT * FROM saved_responses ORDER BY created_at DESC, id DESC').all();
}

/** Idempotent — re-assigning an id already on the thread is a no-op via UNIQUE. */
export function assignSavedResponsesToThread(threadId, savedResponseIds) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO saved_response_threads (saved_response_id, thread_id) VALUES (?, ?)',
  );
  for (const id of savedResponseIds) insert.run(id, threadId);
  return listAssignedSavedResponseIds(threadId);
}

export function listAssignedSavedResponseIds(threadId) {
  return db
    .prepare('SELECT saved_response_id FROM saved_response_threads WHERE thread_id = ?')
    .all(threadId)
    .map((r) => r.saved_response_id);
}

/* ----------------------------------------------------------- ground truth */

export function getGroundTruthCheck(messageId) {
  const row = db.prepare('SELECT * FROM ground_truth_checks WHERE message_id = ?').get(messageId);
  return row ? { ...row, diff: JSON.parse(row.diff_json) } : null;
}

/** Re-running a check overwrites the previous result for that message. */
export function saveGroundTruthCheck({ messageId, diff, model }) {
  db.prepare(
    `INSERT INTO ground_truth_checks (message_id, diff_json, model) VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET diff_json = excluded.diff_json, model = excluded.model,
       created_at = datetime('now')`,
  ).run(messageId, JSON.stringify(diff), model ?? null);
  return getGroundTruthCheck(messageId);
}

/* ----------------------------------------------------------------- messages */

export function addMessage({ threadId, role, content, reasoning, model, task, ms, error }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages (thread_id, role, content, reasoning, model, task, ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(threadId, role, content, reasoning ?? null, model ?? null, task ?? null, ms ?? null, error ?? null);

  db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(lastInsertRowid));
}

/**
 * Drop a single message — used when a failed turn is retried. The traces it
 * produced survive with message_id set to NULL (ON DELETE SET NULL), so the
 * failed attempt is still visible in the trace sheet and in the token totals.
 */
export function deleteMessage(id) {
  const row = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(row.thread_id);
  return true;
}

/* ------------------------------------------------------------------- traces */

export function addTrace(t) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO traces (
         thread_id, message_id, kind, task, model, served_model, base_url, fingerprint,
         request_json, request_params, prompt_chars, prompt_messages,
         response_text, reasoning_text,
         prompt_tokens, completion_tokens, total_tokens,
         ttft_ms, duration_ms, status, error, finish_reason
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      t.threadId ?? null, t.messageId ?? null, t.kind, t.task ?? null,
      t.model, t.servedModel ?? null, t.baseUrl ?? null, t.fingerprint ?? null,
      t.requestJson ?? null, t.requestParams ?? null,
      t.promptChars ?? null, t.promptMessages ?? null,
      t.responseText ?? null, t.reasoningText ?? null,
      t.usage?.prompt_tokens ?? null,
      t.usage?.completion_tokens ?? null,
      t.usage?.total_tokens ?? null,
      t.ttftMs ?? null, t.durationMs ?? null,
      t.status ?? 'ok', t.error ?? null, t.finishReason ?? null,
    );
  return Number(lastInsertRowid);
}

/** Attach traces to the assistant message once it has been written. */
export function linkTracesToMessage(traceIds, messageId) {
  const stmt = db.prepare('UPDATE traces SET message_id = ? WHERE id = ?');
  for (const id of traceIds) stmt.run(messageId, id);
}

/**
 * Rewrite a question in place. The id is kept so the client's view of the
 * thread stays valid across the edit; only the text and timestamp move.
 */
export function editMessage(id, content) {
  const changed = db
    .prepare("UPDATE messages SET content = ?, created_at = datetime('now') WHERE id = ?")
    .run(content, id).changes;
  if (!changed) return null;
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

/**
 * Discard everything that followed a message. Editing a question invalidates
 * every reply built on it, so those rows go rather than lingering as answers to
 * a question nobody asked.
 */
export function deleteMessagesAfter(threadId, id) {
  const n = db.prepare('DELETE FROM messages WHERE thread_id = ? AND id > ?').run(threadId, id).changes;
  db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
  return n;
}

/** Trace list — omits the bulky request/response bodies. */
export function listTraces({ threadId, limit = 100 } = {}) {
  const where = threadId ? 'WHERE t.thread_id = ?' : '';
  const args = threadId ? [threadId, limit] : [limit];
  return db
    .prepare(
      `SELECT t.id, t.thread_id, t.message_id, t.kind, t.task, t.model, t.served_model,
              t.prompt_chars, t.prompt_messages, t.prompt_tokens, t.completion_tokens,
              t.total_tokens, t.ttft_ms, t.duration_ms, t.status, t.error, t.created_at,
              length(t.response_text) AS response_chars,
              length(t.reasoning_text) AS reasoning_chars,
              th.title AS thread_title
         FROM traces t
         LEFT JOIN threads th ON th.id = t.thread_id
         ${where}
        ORDER BY t.id DESC
        LIMIT ?`,
    )
    .all(...args);
}

export function getTrace(id) {
  return db.prepare('SELECT * FROM traces WHERE id = ?').get(id) ?? null;
}

/** Per-thread token totals, shown in the thread header. */
export function threadUsage(threadId) {
  return db
    .prepare(
      `SELECT COUNT(*)                      AS calls,
              COALESCE(SUM(prompt_tokens),0)     AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0)      AS total_tokens,
              COALESCE(SUM(duration_ms),0)       AS duration_ms,
              SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS failures
         FROM traces WHERE thread_id = ?`,
    )
    .get(threadId);
}

/** Token totals per message, so each bubble can show its own cost. */
export function messageUsage(threadId) {
  return db
    .prepare(
      `SELECT message_id,
              SUM(prompt_tokens)     AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens)      AS total_tokens,
              MIN(ttft_ms)           AS ttft_ms,
              COUNT(*)               AS calls
         FROM traces
        WHERE thread_id = ? AND message_id IS NOT NULL
        GROUP BY message_id`,
    )
    .all(threadId);
}

/** Global rollup for the observability page. */
export function usageSummary() {
  return {
    byModel: db
      .prepare(
        `SELECT model,
                COUNT(*)                           AS calls,
                COALESCE(SUM(prompt_tokens),0)     AS prompt_tokens,
                COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                COALESCE(SUM(total_tokens),0)      AS total_tokens,
                CAST(AVG(ttft_ms) AS INTEGER)      AS avg_ttft_ms,
                CAST(AVG(duration_ms) AS INTEGER)  AS avg_duration_ms,
                SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS failures
           FROM traces GROUP BY model ORDER BY calls DESC`,
      )
      .all(),
    totals: db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens),0)     AS prompt_tokens,
                COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                COALESCE(SUM(total_tokens),0)      AS total_tokens
           FROM traces`,
      )
      .get(),
  };
}

export function stats() {
  const t = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS tok FROM traces').get();
  return {
    documents: db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,
    threads: db.prepare('SELECT COUNT(*) AS n FROM threads').get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    traces: t.n,
    tokens: t.tok,
    path: DB_PATH,
  };
}

export default db;
