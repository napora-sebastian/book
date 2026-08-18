/**
 * Full-text search over everything that was ever said in a thread.
 *
 * The archive is the only thing the Grimoire view and the Oracle have to work
 * with: neither of them re-reads a document, they read what was *asked* and
 * what was *answered*. A LIKE scan over `messages` would be fine at a hundred
 * rows and hopeless at the size this store reaches after a book — so the text
 * is mirrored into an FTS5 index, kept in sync by triggers rather than by
 * anything the write paths in db.js have to remember to call.
 *
 * The index is standalone (not `content='messages'`) on purpose: it also holds
 * the thread title and the document filename, which live in other tables, and
 * that is what lets "the chapter three rewrite" find a thread whose messages
 * never say "chapter three".
 */
import rawDb from './db.js';

const FTS = 'message_search';
const DOCS = 'document_search';

// The archive here is written in Polish, so folding matters more than usual.
// `remove_diacritics 2` handles ą ć ę ó ś ź ż — everything that decomposes into
// a base letter plus a combining mark. It does NOT handle ł, which is its own
// codepoint with no decomposition, so "rozdzial" would miss "rozdział" even
// though every other unaccented spelling works. Hence the fourth column: the
// same text with ł folded to l, indexed alongside the real one. It costs a copy
// of the message text and buys a search box that works from a US keyboard.
const FOLD = (col) => `replace(replace(${col}, 'ł', 'l'), 'Ł', 'L')`;

// The index is derived data, so a schema change is a rebuild, not a migration:
// drop it and let ensureIndex() below notice the count is wrong.
const columns = () => rawDb.prepare(`PRAGMA table_info(${FTS})`).all().map((c) => c.name);
if (columns().length && !columns().includes('folded')) {
  for (const t of ['ai', 'ad', 'au', 'title']) rawDb.exec(`DROP TRIGGER IF EXISTS ${FTS}_${t}`);
  rawDb.exec(`DROP TABLE ${FTS}`);
}

rawDb.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(
    content,
    title,
    filename,
    folded,
    tokenize = "unicode61 remove_diacritics 2"
  );
`);

// One row per message, rowid = messages.id, so a hit joins straight back.
rawDb.exec(`
  CREATE TRIGGER IF NOT EXISTS ${FTS}_ai AFTER INSERT ON messages BEGIN
    INSERT INTO ${FTS}(rowid, content, title, filename, folded)
    SELECT new.id, new.content, t.title, COALESCE(d.filename, ''), ${FOLD('new.content')}
      FROM threads t LEFT JOIN documents d ON d.id = t.document_id
     WHERE t.id = new.thread_id;
  END;

  CREATE TRIGGER IF NOT EXISTS ${FTS}_ad AFTER DELETE ON messages BEGIN
    DELETE FROM ${FTS} WHERE rowid = old.id;
  END;

  -- Editing a question rewrites its answer too, so the index has to follow the
  -- content column and not just insert/delete.
  CREATE TRIGGER IF NOT EXISTS ${FTS}_au AFTER UPDATE OF content ON messages BEGIN
    UPDATE ${FTS} SET content = new.content, folded = ${FOLD('new.content')} WHERE rowid = new.id;
  END;

  -- A thread is renamed by its first question; without this the title column
  -- would keep saying "New thread" for every message written before the rename.
  CREATE TRIGGER IF NOT EXISTS ${FTS}_title AFTER UPDATE OF title ON threads BEGIN
    UPDATE ${FTS} SET title = new.title
     WHERE rowid IN (SELECT id FROM messages WHERE thread_id = new.id);
  END;
`);

/* ------------------------------------------------------------------- docs */

/**
 * The documents themselves, indexed separately.
 *
 * A thread whose document holds the answer often never says the words: "find me
 * the long poem" matches nothing in any message, because the poem is in an .rtf
 * that only the filename hints at. Worse, a thread with no messages at all is
 * invisible to a message index while being one of the most findable things in
 * the archive. Keeping this as its own table rather than more rows in the
 * message index keeps the rowids meaning one thing each.
 */
rawDb.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS ${DOCS} USING fts5(
    text,
    filename,
    folded,
    tokenize = "unicode61 remove_diacritics 2"
  );

  CREATE TRIGGER IF NOT EXISTS ${DOCS}_ai AFTER INSERT ON documents BEGIN
    INSERT INTO ${DOCS}(rowid, text, filename, folded)
    VALUES (new.id, new.text, new.filename, ${FOLD('new.text')});
  END;

  CREATE TRIGGER IF NOT EXISTS ${DOCS}_ad AFTER DELETE ON documents BEGIN
    DELETE FROM ${DOCS} WHERE rowid = old.id;
  END;

  -- A re-upload replaces a document's text in place, so the index has to follow
  -- the content column and not only insert/delete.
  CREATE TRIGGER IF NOT EXISTS ${DOCS}_au AFTER UPDATE OF text ON documents BEGIN
    UPDATE ${DOCS} SET text = new.text, folded = ${FOLD('new.text')} WHERE rowid = new.id;
  END;
`);

/**
 * Rebuild from scratch. Runs at boot when the counts disagree, which covers the
 * only two cases that matter: the first start after this file was added (an
 * archive full of messages, an empty index) and a store edited by something
 * that bypassed the triggers.
 */
export function reindex() {
  rawDb.exec(`DELETE FROM ${FTS}`);
  rawDb.exec(`
    INSERT INTO ${FTS}(rowid, content, title, filename, folded)
    SELECT m.id, m.content, t.title, COALESCE(d.filename, ''), ${FOLD('m.content')}
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      LEFT JOIN documents d ON d.id = t.document_id
  `);
  return indexed();
}

export function reindexDocuments() {
  rawDb.exec(`DELETE FROM ${DOCS}`);
  rawDb.exec(`
    INSERT INTO ${DOCS}(rowid, text, filename, folded)
    SELECT id, text, filename, ${FOLD('text')} FROM documents
  `);
  return indexedDocs();
}

const indexed = () => rawDb.prepare(`SELECT COUNT(*) AS n FROM ${FTS}`).get().n;
const indexedDocs = () => rawDb.prepare(`SELECT COUNT(*) AS n FROM ${DOCS}`).get().n;

export function ensureIndex() {
  const messages = rawDb.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const documents = rawDb.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
  const out = { rebuilt: false, indexed: messages, documents };
  if (indexed() !== messages) { out.rebuilt = true; out.indexed = reindex(); }
  if (indexedDocs() !== documents) { out.rebuilt = true; out.documents = reindexDocuments(); }
  return out;
}

/**
 * Turn whatever the user typed into an FTS5 MATCH expression.
 *
 * Free text goes straight into MATCH at your peril: a stray `"`, a bare `AND`
 * or a lone `-` is a syntax error, and an error here would surface as a broken
 * search box rather than as no results. So the query is taken apart and put
 * back together from quoted phrases and quoted terms only — no operator the
 * user typed survives, except the phrase quoting they meant.
 *
 * `mode` is which of the three passes this is: 'all' ANDs the terms, 'any' ORs
 * them, 'loose' ORs truncated prefixes of them. `prefix` lets the last word
 * match as-you-type, which is for the search box, not for the Oracle.
 */
export function toMatchQuery(q, { mode = 'all', prefix = false } = {}) {
  const raw = String(q ?? '').trim();
  if (!raw) return null;

  const phrases = [];
  // Pull out "quoted phrases" first so their spaces survive tokenisation.
  const rest = raw.replace(/"([^"]+)"/g, (_, phrase) => {
    const clean = phrase.replace(/["*]/g, ' ').trim();
    if (clean) phrases.push(`"${clean}"`);
    return ' ';
  });

  const words = rest.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2);

  // Quoting every term is what keeps AND / OR / NOT / NEAR — and a stray
  // hyphen — from being read as operators the user never meant to type.
  const terms = words.map((w) => (mode === 'loose' ? `"${stem(w)}"*` : `"${w}"`));

  if (prefix && mode !== 'loose' && terms.length && /[\p{L}\p{N}_]$/u.test(raw)) {
    terms[terms.length - 1] = `${terms[terms.length - 1].slice(0, -1)}"*`;
  }

  const all = [...phrases, ...terms];
  if (!all.length) return null;
  return all.join(mode === 'all' ? ' AND ' : ' OR ');
}

/**
 * Crude stemming by truncation, for the loose pass only.
 *
 * Polish inflects the words people search by: "bomba" is written "bomby",
 * "bombami", "bomb" in the very thread you are looking for, and FTS5 has no
 * Polish stemmer to fold them together. Cutting the last two characters off a
 * long word and matching it as a prefix reunites those forms. It also matches
 * more than it should, which is exactly why this runs only after the exact and
 * any-word passes have both come back empty.
 */
function stem(word) {
  if (word.length >= 6) return word.slice(0, word.length - 2);
  if (word.length >= 4) return word.slice(0, word.length - 1);
  return word;
}

/**
 * Ranked messages. The bm25 weights order the four columns: a hit in the
 * message body outranks the ł-folded copy of it, which outranks the thread
 * title, which outranks the filename — otherwise every thread on a book would
 * match every query containing the book's name.
 */
const MESSAGE_HITS = `
  SELECT m.id, m.thread_id, m.role, m.model, m.created_at,
         t.title, t.document_id, d.filename,
         snippet(${FTS}, 0, '⟦', '⟧', ' … ', 24) AS snippet,
         bm25(${FTS}, 10.0, 3.0, 1.0, 6.0) AS score
    FROM ${FTS}
    JOIN messages m ON m.id = ${FTS}.rowid
    JOIN threads t ON t.id = m.thread_id
    LEFT JOIN documents d ON d.id = t.document_id
   WHERE ${FTS} MATCH ?`;

/**
 * `q` is free text. Returns [] rather than throwing on a query that reduces to
 * nothing — an empty search box is not an error.
 */
export function searchMessages(q, { limit = 40, threadId = null, prefix = false } = {}) {
  const run = (mode) => {
    const match = toMatchQuery(q, { mode, prefix });
    if (!match) return null;
    const where = threadId ? ' AND m.thread_id = ?' : '';
    const sql = `${MESSAGE_HITS}${where} ORDER BY score LIMIT ?`;
    const args = threadId ? [match, threadId, limit] : [match, limit];
    // bm25 returns negative numbers where more negative is a better match;
    // ORDER BY score (ascending) is therefore best-first.
    // Which pass found a row travels with it: a hit from the loose pass is a
    // guess and must never outrank an exact one from another source.
    const rows = rawDb.prepare(sql).all(...args).map((r) => ({ ...r, pass: mode }));
    return rows.length ? rows : null;
  };

  try {
    // Every word present is the better answer when there is one; "any word"
    // beats showing nothing for a question typed as a sentence; and the loose
    // pass is the last resort for a word the archive only ever inflected.
    return run('all') || run('any') || run('loose') || [];
  } catch (err) {
    console.error('search failed:', err.message);
    return [];
  }
}

// How much a hit counts for, by the pass that produced it. The loose pass
// truncates words to prefixes, so it finds "wierzchu" for "wiersz" — useful
// only when nothing exact exists anywhere, never as a reason to outrank one.
const WEIGHT = { all: 1, any: 0.9, loose: 0.28 };

/**
 * The same search collapsed to one row per thread — what the gallery and the
 * Oracle both want, since a conversation is the unit a person browses, not an
 * individual message.
 */
export function searchThreads(q, { limit = 12, perThread = 3 } = {}) {
  const messageHits = searchMessages(q, { limit: limit * 8 });
  const docHits = searchDocuments(q, { limit });

  // The loose pass is a fallback for the whole query, not for one source of it:
  // if anything matched exactly — in a message OR in a document — the truncated
  // guesses are dropped rather than blended in, because three weak hits summed
  // together would otherwise outrank one exact one.
  const exact = (rows) => rows.some((r) => r.pass !== 'loose');
  const anyExact = exact(messageHits) || exact(docHits);
  const keep = (rows) => (anyExact ? rows.filter((r) => r.pass !== 'loose') : rows);

  const hits = keep(messageHits);
  const byThread = new Map();

  const entryFor = (row) => {
    let entry = byThread.get(row.thread_id);
    if (!entry) {
      entry = {
        threadId: row.thread_id,
        title: row.title,
        documentId: row.document_id,
        filename: row.filename,
        hits: 0,
        score: 0,
        matches: [],
      };
      byThread.set(row.thread_id, entry);
    }
    return entry;
  };

  for (const hit of hits) {
    let entry = byThread.get(hit.thread_id);
    if (!entry) {
      entry = {
        threadId: hit.thread_id,
        title: hit.title,
        documentId: hit.document_id,
        filename: hit.filename,
        hits: 0,
        score: 0,
        matches: [],
      };
      byThread.set(hit.thread_id, entry);
    }
    entry.hits += 1;
    // Sum of the per-message scores: a thread that answers the question in five
    // places is a better destination than one that mentions it once. bm25 is
    // negative with more-negative meaning better, so scaling a hit toward zero
    // is how a weaker source of evidence is demoted.
    entry.score += hit.score * WEIGHT[hit.pass];
    if (entry.matches.length < perThread) {
      entry.matches.push({
        messageId: hit.id,
        role: hit.role,
        createdAt: hit.created_at,
        snippet: hit.snippet,
      });
    }
  }

  // Now the same query against the documents, folded into the same list. A
  // thread that only matches through its file still ranks below one whose
  // messages matched — the weighting is deliberate, not incidental.
  for (const doc of keep(docHits)) {
    const rows = rawDb.prepare(
      `SELECT t.id AS thread_id, t.title, t.document_id, d.filename
         FROM threads t JOIN documents d ON d.id = t.document_id
        WHERE t.document_id = ?`,
    ).all(doc.id);

    for (const row of rows) {
      const entry = entryFor(row);
      entry.hits += 1;
      // Slightly below a message hit of the same quality — what was said about
      // a document is a better answer than the document merely containing the
      // word — but an exact file hit still beats a loose guess in a message.
      entry.score += doc.score * WEIGHT[doc.pass] * 0.8;
      if (entry.matches.length < perThread) {
        entry.matches.push({
          messageId: null,
          role: 'document',
          createdAt: null,
          snippet: doc.snippet,
        });
      }
    }
  }

  return [...byThread.values()].sort((a, b) => a.score - b.score).slice(0, limit);
}

/**
 * Documents matching `q`, resolved to the threads that use them. A document is
 * not a destination in this UI — a conversation is — so a hit on a file surfaces
 * as a hit on every thread bound to it, including the ones with no messages.
 */
export function searchDocuments(q, { limit = 12 } = {}) {
  const run = (mode) => {
    const match = toMatchQuery(q, { mode });
    if (!match) return null;
    const rows = rawDb.prepare(`
      SELECT d.id, d.filename, d.chars,
             snippet(${DOCS}, 0, '⟦', '⟧', ' … ', 24) AS snippet,
             bm25(${DOCS}, 10.0, 3.0, 6.0) AS score
        FROM ${DOCS}
        JOIN documents d ON d.id = ${DOCS}.rowid
       WHERE ${DOCS} MATCH ?
       ORDER BY score LIMIT ?`).all(match, limit).map((r) => ({ ...r, pass: mode }));
    return rows.length ? rows : null;
  };

  try {
    return run('all') || run('any') || run('loose') || [];
  } catch (err) {
    console.error('document search failed:', err.message);
    return [];
  }
}

export function indexStats() {
  return { rows: indexed(), table: FTS };
}
