/**
 * One-time migration: re-parse RTF documents that were stored as raw markup.
 *
 * Before the RTF parser existed, `.rtf` files were read as plain UTF-8, so the
 * library held the raw `\rtf1\ansi…` control words and `\uc0\u322` escapes
 * instead of the prose. This walks every document whose text still starts with
 * RTF control words, re-parses it, and rewrites both the `documents` row and
 * the newest `document_versions` row (which mirrors the current text).
 *
 * Run:  node scripts/migrate-rtf.mjs
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import rtf from 'rtf-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'threads.db');
const db = new DatabaseSync(DB_PATH);

function extractRtfText(buffer) {
  return new Promise((resolve, reject) => {
    rtf.string(buffer.toString('utf8'), (err, doc) => {
      if (err) return reject(err);
      const parts = [];
      const walk = (items) => {
        for (const it of items) {
          if (typeof it.value === 'string') parts.push(it.value);
          else if (Array.isArray(it.content)) { walk(it.content); parts.push('\n'); }
        }
      };
      walk(doc.content);
      resolve(parts.join('').replace(/\n{3,}/g, '\n\n').trim());
    });
  });
}

const looksLikeRtf = (text) => /^\s*\{\\rtf/.test(text || '');

const docs = db.prepare('SELECT id, filename, text FROM documents').all()
  .filter((d) => looksLikeRtf(d.text));

if (!docs.length) {
  console.log('No RTF documents to migrate.');
  process.exit(0);
}

let migrated = 0;
for (const doc of docs) {
  try {
    const text = await extractRtfText(Buffer.from(doc.text));
    if (!text) { console.log(`  skip #${doc.id} ${doc.filename} — no text after parse`); continue; }

    const words = text.split(/\s+/).filter(Boolean).length;
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');

    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE documents SET text = ?, chars = ?, words = ?, sha256 = ? WHERE id = ?`,
      ).run(text, text.length, words, sha256, doc.id);

      // The newest version row mirrors documents.text; keep them in sync.
      db.prepare(
        `UPDATE document_versions SET text = ?, chars = ?, words = ?, sha256 = ?
          WHERE document_id = ? AND version = (SELECT COALESCE(MAX(version), 1)
            FROM document_versions WHERE document_id = ?)`,
      ).run(text, text.length, words, sha256, doc.id, doc.id);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    console.log(`  migrated #${doc.id} ${doc.filename} → ${text.length.toLocaleString()} chars`);
    migrated++;
  } catch (err) {
    console.error(`  FAILED #${doc.id} ${doc.filename}: ${err.message}`);
  }
}

console.log(`\nDone — ${migrated} of ${docs.length} RTF document(s) re-parsed.`);
