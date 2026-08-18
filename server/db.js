import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// A version's +N −M is derived from the two texts being stored, so it is
// computed here at write time — the history list would otherwise have to diff
// every version pair on every open.
import { diffStat } from './diff.js';

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

  -- One row per saved state of a document's content, oldest first. Version 1 is
  -- the original upload and the newest row always mirrors documents.text, so a
  -- re-upload is a new version rather than a silent overwrite of the source the
  -- existing threads were answered from.
  CREATE TABLE IF NOT EXISTS document_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    filename    TEXT    NOT NULL,
    kind        TEXT,
    -- Extracted text only. The source bytes are deliberately not kept per
    -- version: a 40 MB book re-uploaded five times would be 200 MB of blob for
    -- something nothing reads, and the text is what the diff and the model use.
    text        TEXT    NOT NULL,
    chars       INTEGER NOT NULL,
    words       INTEGER,
    pages       INTEGER,
    bytes       INTEGER,
    sha256      TEXT    NOT NULL,
    additions   INTEGER,                    -- lines against the previous
    deletions   INTEGER,                    -- version; both NULL on version 1
    source_message_id INTEGER,              -- message whose model text created this version
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(document_id, version)
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
  CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, version DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_response_threads_thread ON saved_response_threads(thread_id);
  CREATE INDEX IF NOT EXISTS idx_saved_response_threads_saved ON saved_response_threads(saved_response_id);
`);

// Columns added after the first release. Existing stores are migrated in place
// rather than rebuilt, so a book's threads survive an upgrade.
for (const [table, column, type] of [
  ['traces', 'finish_reason', 'TEXT'],
  ['documents', 'data', 'BLOB'],
  ['document_versions', 'source_message_id', 'INTEGER'],
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Run `fn` as one unit. Writing a document and its version row has to be
 * all-or-nothing — a half-applied replace would leave the library showing text
 * that no version records.
 */
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------------------------------------------------------------- documents */

/**
 * Store a document, or return the existing row if the identical text was saved
 * before. Hashing the text (not the file bytes) means the same report exported
 * twice from Word still resolves to one library entry.
 */
export function saveDocument({ filename, kind, text, words, pages, bytes, data }) {
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  const existing = db.prepare('SELECT * FROM documents WHERE sha256 = ?').get(sha256);
  if (existing) return { doc: existing, reused: true };

  const id = inTransaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO documents (filename, kind, text, chars, words, pages, bytes, sha256, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(filename, kind ?? null, text, text.length, words ?? null, pages ?? null, bytes ?? null, sha256, data ?? null);

    const docId = Number(lastInsertRowid);
    insertVersion(docId, 1, { filename, kind, text, words, pages, bytes, sha256 }, null);
    return docId;
  });

  return { doc: getDocument(id), reused: false };
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) ?? null;
}

/** Raw bytes for the preview route — kept separate so the normal doc reads never touch the blob. */
export function getDocumentFile(id) {
  return db.prepare('SELECT filename, kind, data FROM documents WHERE id = ?').get(id) ?? null;
}

/**
 * Overwrite an existing library entry in place — same id and filename, new
 * text/bytes/hash. Used to let a re-uploaded file replace the one it matches
 * by name instead of piling up as a second entry.
 *
 * The outgoing content is not lost: it stays as its own version row, and the
 * incoming content is appended as the next one, so the change is reviewable as
 * a diff afterwards. Re-uploading a byte-identical file is reported as
 * `unchanged` rather than recorded as a version that changed nothing.
 */
export function replaceDocumentContent(id, { kind, text, words, pages, bytes, data }) {
  const current = getDocument(id);
  if (!current) return null;

  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  if (sha256 === current.sha256) {
    return { doc: current, version: latestVersionNumber(id), unchanged: true };
  }

  const version = inTransaction(() => {
    // Documents stored before versioning existed have no rows at all; their
    // current content becomes version 1 so the diff has a left-hand side.
    ensureInitialVersion(id, current);

    db.prepare(
      `UPDATE documents SET kind = ?, text = ?, chars = ?, words = ?, pages = ?, bytes = ?, sha256 = ?, data = ?
        WHERE id = ?`,
    ).run(kind ?? null, text, text.length, words ?? null, pages ?? null, bytes ?? null, sha256, data ?? null, id);

    const next = latestVersionNumber(id) + 1;
    const { additions, deletions } = diffStat(current.text, text);
    insertVersion(
      id,
      next,
      { filename: current.filename, kind, text, words, pages, bytes, sha256 },
      { additions, deletions },
    );
    return next;
  });

  return { doc: getDocument(id), version, unchanged: false };
}

function insertVersion(documentId, version, v, stat) {
  db.prepare(
    `INSERT INTO document_versions
       (document_id, version, filename, kind, text, chars, words, pages, bytes, sha256, additions, deletions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId, version, v.filename, v.kind ?? null, v.text, v.text.length,
    v.words ?? null, v.pages ?? null, v.bytes ?? null, v.sha256,
    stat?.additions ?? null, stat?.deletions ?? null,
  );
}

const latestVersionNumber = (documentId) =>
  db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM document_versions WHERE document_id = ?')
    .get(documentId).v;

/** Backfill version 1 for a document that predates the version table. */
function ensureInitialVersion(id, doc) {
  if (latestVersionNumber(id) > 0) return;
  insertVersion(id, 1, doc, null);
}

/**
 * Replace a document's text with hand-edited content — same id, filename, kind
 * and stored bytes, new text. This is the third way a document's content can
 * change (upload replace, model rewrite, hand edit) and it files a version like
 * the other two, so a typo fixed by hand is as reviewable as a model's draft.
 *
 * The uploaded bytes are deliberately left alone. A PDF cannot be re-rendered
 * from edited text, and discarding the original to keep the two in step would
 * throw away the only copy of what arrived. `documents.text` is what the models
 * read and what the versions record; `documents.data` stays what was uploaded.
 *
 * Returns `unchanged` rather than filing a version that changed nothing.
 */
export function editDocumentText(id, { text }) {
  const current = getDocument(id);
  if (!current) return null;

  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  if (sha256 === current.sha256) {
    return { doc: current, version: latestVersionNumber(id), unchanged: true, additions: 0, deletions: 0 };
  }

  let stat;
  const version = inTransaction(() => {
    // Same reason as replaceDocumentContent: a document stored before
    // versioning existed needs its current text on the rail as version 1,
    // or the edit would be the first version and the original unrecorded.
    ensureInitialVersion(id, current);

    const words = text.split(/\s+/).filter(Boolean).length;
    db.prepare('UPDATE documents SET text = ?, chars = ?, words = ?, sha256 = ? WHERE id = ?')
      .run(text, text.length, words, sha256, id);

    const next = latestVersionNumber(id) + 1;
    stat = diffStat(current.text, text);
    insertVersion(
      id,
      next,
      { filename: current.filename, kind: current.kind, text, words, pages: current.pages, bytes: current.bytes, sha256 },
      stat,
    );
    return next;
  });

  return { doc: getDocument(id), version, unchanged: false, additions: stat.additions, deletions: stat.deletions };
}

/**
 * File a model's rewritten text as the next version of a document, without
 * touching the stored document itself. The model's answer is a candidate
 * revision, not the new source of truth — the user reviews it in the diff
 * first, and only a manual "Replace…" upload promotes it to the live text.
 * Returns null when the text is identical to the current version.
 */
export function saveModelVersion(documentId, { text, sourceMessageId, model }) {
  const current = getDocument(documentId);
  if (!current) return null;

  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  if (sha256 === current.sha256) return null;

  let stat;
  const version = inTransaction(() => {
    ensureInitialVersion(documentId, current);
    const next = latestVersionNumber(documentId) + 1;
    stat = diffStat(current.text, text);
    insertVersion(
      documentId,
      next,
      { filename: current.filename, kind: current.kind, text, words: text.split(/\s+/).filter(Boolean).length, pages: current.pages, bytes: current.bytes, sha256 },
      stat,
    );
    if (sourceMessageId != null) {
      db.prepare('UPDATE document_versions SET source_message_id = ? WHERE document_id = ? AND version = ?')
        .run(sourceMessageId, documentId, next);
    }
    return next;
  });

  return { version, additions: stat.additions, deletions: stat.deletions };
}

/** Version list for the history rail — text excluded, it is only needed to diff. */
export function listDocumentVersions(documentId) {
  return db
    .prepare(
      `SELECT id, document_id, version, filename, kind, chars, words, pages, bytes,
              sha256, additions, deletions, source_message_id, created_at
         FROM document_versions WHERE document_id = ? ORDER BY version DESC`,
    )
    .all(documentId);
}

export function getDocumentVersion(documentId, version) {
  return db
    .prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?')
    .get(documentId, version) ?? null;
}

/**
 * Remove one saved version of a document. The last remaining version cannot be
 * removed — a document must always keep at least one. If the removed version is
 * the newest (the one mirroring documents.text), the document rolls back to the
 * previous version's content so the live text and the version rail stay in sync.
 * Returns the removed version number, or null when the version does not exist.
 */
export function deleteDocumentVersion(documentId, version) {
  const row = getDocumentVersion(documentId, version);
  if (!row) return null;

  const versions = listDocumentVersions(documentId);
  if (versions.length <= 1) return null; // never remove the last version

  inTransaction(() => {
    db.prepare('DELETE FROM document_versions WHERE document_id = ? AND version = ?')
      .run(documentId, version);

    // If we removed the newest version, roll the live document back to the
    // version that is now newest, so documents.text still mirrors the rail.
    // listDocumentVersions omits the text column, so fetch the row with
    // getDocumentVersion (SELECT *) to read the rollback text.
    if (version === versions[0].version) {
      const prev = getDocumentVersion(documentId, versions[1]?.version);
      if (prev) {
        db.prepare(
          `UPDATE documents SET kind = ?, text = ?, chars = ?, words = ?, pages = ?, bytes = ?, sha256 = ?
            WHERE id = ?`,
        ).run(
          prev.kind ?? null, prev.text, prev.text.length,
          prev.words ?? null, prev.pages ?? null, prev.bytes ?? null, prev.sha256, documentId,
        );
      }
    }
  });

  return version;
}

/** Library list for the "saved files" dropdown — excludes the text column. */
export function listDocuments(limit = 200) {
  return db
    .prepare(
      `SELECT d.id, d.filename, d.kind, d.chars, d.words, d.pages, d.bytes, d.created_at,
              (SELECT COUNT(*) FROM threads t WHERE t.document_id = d.id) AS thread_count,
              (SELECT COALESCE(MAX(dv.version), 1) FROM document_versions dv
                WHERE dv.document_id = d.id) AS version
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

/** Only the inference path needs the full text, so it is fetched separately.
 *  When `version` is given, the text of that saved version is returned instead
 *  of the document's live text — the user can point a turn at any version. */
export function getThreadDocText(threadId, version) {
  const row = db
    .prepare(
      `SELECT d.id AS document_id, d.text, d.filename FROM threads t
         JOIN documents d ON d.id = t.document_id
        WHERE t.id = ?`,
    )
    .get(threadId);
  if (!row) return { text: '', filename: null };

  if (version != null) {
    const v = getDocumentVersion(row.document_id, Number(version));
    if (v) return { text: v.text, filename: v.filename ?? row.filename };
  }
  return row;
}

export function getMessages(threadId) {
  return db
    .prepare(
      `SELECT m.*,
              EXISTS(SELECT 1 FROM saved_responses sr WHERE sr.message_id = m.id) AS saved,
              EXISTS(SELECT 1 FROM ground_truth_checks g WHERE g.message_id = m.id) AS has_ground_truth
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

export function deleteSavedResponse(id) {
  return db.prepare('DELETE FROM saved_responses WHERE id = ?').run(id).changes > 0;
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

/* ============================================================== graphs =====

   A graph is the archive seen as a network instead of a list: one point stands
   for a source you already have — a book at a chosen version, or a conversation
   you have already had — and every line out of it is a new conversation that
   was opened *from* that point and inherits it as context.

   Nothing here duplicates a thread or a document. A node is a pointer plus a
   position on the canvas, so a conversation opened on a graph is an ordinary
   thread: it shows up in the deck, the Oracle searches it, its answers can be
   filed as document versions. The graph only records where it came from.
   ========================================================================= */

db.exec(`
  CREATE TABLE IF NOT EXISTS graphs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- One point on the canvas. Exactly one of document_id / thread_id is set,
  -- and both are ON DELETE CASCADE: a node pointing at a deleted thread would
  -- be a line to nowhere, so it goes with it.
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    graph_id    INTEGER NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('document','thread')),
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    thread_id   INTEGER REFERENCES threads(id)   ON DELETE CASCADE,
    -- Which version of the book this point *is*. NULL follows the newest, a
    -- number pins it — so two branches off one book can be answered from two
    -- different drafts of it at the same time.
    doc_version INTEGER,
    label       TEXT,
    x           REAL    NOT NULL DEFAULT 0,
    y           REAL    NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- A line: "target was opened from source, and reads it".
  --   mode  full → the whole source (book text, or the parent's whole transcript)
  --         last → only the parent's final answer
  --         none → the line is drawn but carries no context
  CREATE TABLE IF NOT EXISTS graph_edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    graph_id    INTEGER NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    source_id   INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    mode        TEXT    NOT NULL DEFAULT 'full' CHECK (mode IN ('full','last','none')),
    label       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_graph_nodes_graph ON graph_nodes(graph_id);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_thread ON graph_nodes(thread_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_graph ON graph_edges(graph_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
`);

const touchGraph = (id) =>
  db.prepare("UPDATE graphs SET updated_at = datetime('now') WHERE id = ?").run(id);

export function createGraph(title) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO graphs (title) VALUES (?)')
    .run(title?.trim() || 'New graph');
  return getGraph(Number(lastInsertRowid));
}

export function listGraphs() {
  return db
    .prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM graph_nodes n WHERE n.graph_id = g.id) AS node_count,
              (SELECT COUNT(*) FROM graph_edges e WHERE e.graph_id = g.id) AS edge_count
         FROM graphs g
        ORDER BY g.updated_at DESC, g.id DESC`,
    )
    .all();
}

export function getGraph(id) {
  return db.prepare('SELECT * FROM graphs WHERE id = ?').get(id) ?? null;
}

export function renameGraph(id, title) {
  db.prepare("UPDATE graphs SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
  return getGraph(id);
}

export function deleteGraph(id) {
  return db.prepare('DELETE FROM graphs WHERE id = ?').run(id).changes > 0;
}

/**
 * Every node of one graph, carrying enough of what it points at to draw the
 * card without a request per node — the filename and version count for a book,
 * the title, turn count and last question for a conversation.
 */
export function listGraphNodes(graphId) {
  return db
    .prepare(
      `SELECT n.*,
              d.filename       AS doc_filename,
              d.kind           AS doc_kind,
              d.chars          AS doc_chars,
              d.pages          AS doc_pages,
              d.words          AS doc_words,
              (SELECT COALESCE(MAX(dv.version), 1) FROM document_versions dv
                WHERE dv.document_id = d.id)               AS doc_newest,
              -- The versions that actually EXIST, not a range. Deleting a
              -- version in the middle leaves a gap, and a picker built from
              -- 1..newest would offer a draft that is no longer there.
              (SELECT group_concat(dv.version) FROM document_versions dv
                WHERE dv.document_id = d.id)               AS doc_versions,
              t.title          AS thread_title,
              t.model          AS thread_model,
              t.document_id    AS thread_document_id,
              t.updated_at     AS thread_updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT m.content FROM messages m
                WHERE m.thread_id = t.id AND m.role = 'user'
                ORDER BY m.id DESC LIMIT 1)                AS last_user,
              (SELECT m.content FROM messages m
                WHERE m.thread_id = t.id AND m.role = 'assistant'
                ORDER BY m.id DESC LIMIT 1)                AS last_answer
         FROM graph_nodes n
         LEFT JOIN documents d ON d.id = n.document_id
         LEFT JOIN threads   t ON t.id = n.thread_id
        WHERE n.graph_id = ?
        ORDER BY n.id ASC`,
    )
    .all(graphId);
}

export function getGraphNode(id) {
  return db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) ?? null;
}

export function addGraphNode({ graphId, kind, documentId, threadId, docVersion, label, x, y }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO graph_nodes (graph_id, kind, document_id, thread_id, doc_version, label, x, y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      graphId, kind, documentId ?? null, threadId ?? null,
      docVersion ?? null, label ?? null, x ?? 0, y ?? 0,
    );
  touchGraph(graphId);
  return getGraphNode(Number(lastInsertRowid));
}

/** Position, pinned version and label are the only mutable parts of a node. */
export function updateGraphNode(id, { x, y, docVersion, label } = {}) {
  const node = getGraphNode(id);
  if (!node) return null;

  const sets = [];
  const args = [];
  if (x != null) { sets.push('x = ?'); args.push(x); }
  if (y != null) { sets.push('y = ?'); args.push(y); }
  if (docVersion !== undefined) { sets.push('doc_version = ?'); args.push(docVersion ?? null); }
  if (label !== undefined) { sets.push('label = ?'); args.push(label ?? null); }
  if (!sets.length) return node;

  db.prepare(`UPDATE graph_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  touchGraph(node.graph_id);
  return getGraphNode(id);
}

/** Drops the node only. What it points at — the thread, the book — is left in
 *  the archive; removing a point from a canvas is not deleting the work. */
export function deleteGraphNode(id) {
  const node = getGraphNode(id);
  if (!node) return false;
  db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(id);
  touchGraph(node.graph_id);
  return true;
}

export function listGraphEdges(graphId) {
  return db.prepare('SELECT * FROM graph_edges WHERE graph_id = ? ORDER BY id ASC').all(graphId);
}

/**
 * Draw a line. Refuses a self-link and any link that would close a cycle —
 * context is assembled by walking upstream, and a loop would never terminate.
 */
export function addGraphEdge({ graphId, sourceId, targetId, mode = 'full', label = null }) {
  if (sourceId === targetId) throw new Error('A point cannot feed itself.');
  const source = getGraphNode(sourceId);
  const target = getGraphNode(targetId);
  if (!source || !target) throw new Error('No such point.');
  if (source.graph_id !== graphId || target.graph_id !== graphId) {
    throw new Error('Both points must be on the same graph.');
  }
  if (target.kind !== 'thread') throw new Error('Only a conversation can read a source.');
  if (ancestorIds(sourceId).includes(targetId)) {
    throw new Error('That line would close a loop.');
  }

  db.prepare(
    `INSERT INTO graph_edges (graph_id, source_id, target_id, mode, label)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id) DO UPDATE SET mode = excluded.mode, label = excluded.label`,
  ).run(graphId, sourceId, targetId, mode, label);
  touchGraph(graphId);

  return db.prepare('SELECT * FROM graph_edges WHERE source_id = ? AND target_id = ?')
    .get(sourceId, targetId);
}

export function updateGraphEdge(id, { mode, label } = {}) {
  const edge = db.prepare('SELECT * FROM graph_edges WHERE id = ?').get(id);
  if (!edge) return null;
  db.prepare('UPDATE graph_edges SET mode = COALESCE(?, mode), label = COALESCE(?, label) WHERE id = ?')
    .run(mode ?? null, label ?? null, id);
  touchGraph(edge.graph_id);
  return db.prepare('SELECT * FROM graph_edges WHERE id = ?').get(id);
}

export function deleteGraphEdge(id) {
  const edge = db.prepare('SELECT * FROM graph_edges WHERE id = ?').get(id);
  if (!edge) return false;
  db.prepare('DELETE FROM graph_edges WHERE id = ?').run(id);
  touchGraph(edge.graph_id);
  return true;
}

/** The points feeding this one directly, with the mode each line carries. */
export function parentEdges(nodeId) {
  return db
    .prepare(
      `SELECT e.*, n.kind, n.document_id, n.thread_id, n.doc_version, n.label
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.source_id
        WHERE e.target_id = ?
        ORDER BY e.id ASC`,
    )
    .all(nodeId);
}

/**
 * Every point upstream of this one, farthest first — the order the model should
 * read them in, so the book arrives before the conversations that discuss it.
 * Depth-first post-order, with a visited set: `addGraphEdge` already refuses
 * cycles, but a store edited by hand must not hang the server.
 */
export function ancestorIds(nodeId) {
  const seen = new Set();
  const out = [];
  const parentsOf = db.prepare('SELECT source_id FROM graph_edges WHERE target_id = ? ORDER BY id ASC');

  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const { source_id } of parentsOf.all(id)) {
      walk(source_id);
      if (!out.includes(source_id)) out.push(source_id);
    }
  };
  walk(nodeId);
  return out;
}

/** The node a thread sits on, if any — so a thread opened on a graph can find
 *  its way back to the canvas it belongs to. */
export function graphNodeForThread(threadId) {
  return db
    .prepare('SELECT * FROM graph_nodes WHERE thread_id = ? ORDER BY id ASC LIMIT 1')
    .get(threadId) ?? null;
}

/* ------------------------------------------------- what the archive already knows

   A graph does not have to be drawn from nothing. An archive that has been used
   for a while already records where work came from — it just records it in
   three different places, none of which look like a graph:

     · a conversation's document      — every chat on one book shares a source
     · document_versions.source_message_id
                                      — which conversation actually rewrote it
     · saved_response_threads         — an answer from one conversation that was
                                        deliberately carried into another

   These read that back out, so an import can lay down lines that were true
   before the graph existed instead of inventing a shape.
   ------------------------------------------------------------------------- */

/** Threads that already stand on some graph, so an import can skip them. */
export function placedThreadIds() {
  return db.prepare('SELECT DISTINCT thread_id FROM graph_nodes WHERE thread_id IS NOT NULL')
    .all().map((r) => r.thread_id);
}

/** Documents already on some graph, and which graph, so an import can reuse the
 *  point instead of putting a second copy of the same book beside it. */
export function placedDocumentNodes() {
  return db.prepare(
    `SELECT id, graph_id, document_id FROM graph_nodes
      WHERE document_id IS NOT NULL ORDER BY id ASC`,
  ).all();
}

/**
 * Which conversation produced which draft. `source_message_id` is set whenever
 * an answer was filed as a version, so this is authorship, not a guess — and it
 * is the difference between a conversation that discussed the book and one that
 * changed it.
 */
export function versionAuthors() {
  return db.prepare(
    `SELECT dv.document_id, dv.version, m.thread_id
       FROM document_versions dv
       JOIN messages m ON m.id = dv.source_message_id
      WHERE dv.source_message_id IS NOT NULL
      ORDER BY dv.document_id ASC, dv.version ASC`,
  ).all();
}

/**
 * An answer from one conversation that was attached to another. The archive's
 * only record of a human deciding "this reads that", which is exactly the
 * relationship a line on the canvas stands for.
 */
export function answerReuseLinks() {
  return db.prepare(
    `SELECT m.thread_id AS from_thread, srt.thread_id AS to_thread, COUNT(*) AS uses
       FROM saved_response_threads srt
       JOIN saved_responses sr ON sr.id = srt.saved_response_id
       JOIN messages m         ON m.id = sr.message_id
      WHERE m.thread_id <> srt.thread_id
      GROUP BY m.thread_id, srt.thread_id`,
  ).all();
}
