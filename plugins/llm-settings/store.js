import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Provider storage for the llm-settings plugin.
 *
 * The plugin owns exactly one table, `llm_providers`, and nothing else — that is
 * what makes it droppable into a host app: pass the host's own database handle
 * and the settings live alongside its data, or pass nothing and the plugin opens
 * its own SQLite file.
 *
 * Order is priority. Position 0 is the main provider, 1..n are the fallback
 * chain in the order they are tried. There is no separate "role" column: a role
 * that can disagree with the ordering is a bug waiting to happen.
 */

const DEFAULT_DB = path.join(process.cwd(), 'data', 'llm-settings.db');

export function createStore({ db, dbPath = DEFAULT_DB } = {}) {
  let handle = db;
  if (!handle) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    handle = new DatabaseSync(dbPath);
    handle.exec('PRAGMA journal_mode = WAL');
  }

  handle.exec(`
    CREATE TABLE IF NOT EXISTS llm_providers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT,
      api_url    TEXT    NOT NULL,
      api_key    TEXT,
      model      TEXT,
      -- 0 = main, 1.. = fallback chain, in the order they are tried.
      position   INTEGER NOT NULL DEFAULT 0,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_llm_providers_position ON llm_providers(position);
  `);

  const inTransaction = (fn) => {
    handle.exec('BEGIN');
    try {
      const out = fn();
      handle.exec('COMMIT');
      return out;
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  };

  const selectAll = () =>
    handle.prepare('SELECT * FROM llm_providers ORDER BY position ASC, id ASC').all();

  const selectOne = (id) =>
    handle.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) ?? null;

  /**
   * Renumber positions to 0..n-1 in their current order. Called after every
   * write so "position 0 is the main provider" stays true even when the row
   * that held it was deleted.
   */
  const normalize = () => {
    const rows = selectAll();
    const stmt = handle.prepare('UPDATE llm_providers SET position = ? WHERE id = ?');
    rows.forEach((row, i) => {
      if (row.position !== i) stmt.run(i, row.id);
    });
  };

  return {
    all: selectAll,
    get: selectOne,

    /**
     * Replace the whole chain in one transaction — the POST contract.
     *
     * Entries carrying an `id` that still exists keep their stored API key when
     * the incoming key is empty or masked, so a settings screen that never sees
     * the real secret can still re-save the list without wiping it.
     */
    replaceAll(entries) {
      return inTransaction(() => {
        const existing = new Map(selectAll().map((r) => [r.id, r]));
        const kept = new Set();

        const update = handle.prepare(
          `UPDATE llm_providers
              SET label = ?, api_url = ?, api_key = ?, model = ?, position = ?, enabled = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        );
        const insert = handle.prepare(
          `INSERT INTO llm_providers (label, api_url, api_key, model, position, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        entries.forEach((e, i) => {
          const prev = e.id != null ? existing.get(Number(e.id)) : null;
          const apiKey = e.apiKey === undefined || e.apiKey === null ? (prev?.api_key ?? null) : e.apiKey;
          const enabled = e.enabled === false ? 0 : 1;

          if (prev) {
            update.run(e.label ?? null, e.apiUrl, apiKey, e.model ?? null, i, enabled, prev.id);
            kept.add(prev.id);
          } else {
            const { lastInsertRowid } = insert.run(
              e.label ?? null, e.apiUrl, apiKey, e.model ?? null, i, enabled,
            );
            kept.add(Number(lastInsertRowid));
          }
        });

        // Anything the caller left out of the array is gone — the POST is a
        // replace, not a merge, so the UI's "Remove" needs no second call.
        const remove = handle.prepare('DELETE FROM llm_providers WHERE id = ?');
        for (const id of existing.keys()) if (!kept.has(id)) remove.run(id);

        normalize();
        return selectAll();
      });
    },

    /** Partial update of one provider. `position` moves it in the chain. */
    update(id, patch) {
      const row = selectOne(id);
      if (!row) return null;

      const next = {
        label: patch.label !== undefined ? patch.label : row.label,
        api_url: patch.apiUrl !== undefined ? patch.apiUrl : row.api_url,
        api_key: patch.apiKey !== undefined && patch.apiKey !== null ? patch.apiKey : row.api_key,
        model: patch.model !== undefined ? patch.model : row.model,
        enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
      };

      return inTransaction(() => {
        handle.prepare(
          `UPDATE llm_providers
              SET label = ?, api_url = ?, api_key = ?, model = ?, enabled = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(next.label, next.api_url, next.api_key, next.model, next.enabled, id);

        if (patch.position !== undefined) move(id, Number(patch.position));
        normalize();
        return selectOne(id);
      });
    },

    remove(id) {
      return inTransaction(() => {
        const gone = handle.prepare('DELETE FROM llm_providers WHERE id = ?').run(id).changes > 0;
        normalize();
        return gone;
      });
    },

    count: () => handle.prepare('SELECT COUNT(*) AS n FROM llm_providers').get().n,
  };

  /**
   * Slide a row to `to`, pushing the rest along. Positions are rewritten from
   * the resulting order rather than swapped, so a move can never leave two rows
   * claiming to be the main provider.
   */
  function move(id, to) {
    const rows = selectAll().filter((r) => r.id !== id);
    const target = Math.max(0, Math.min(to, rows.length));
    rows.splice(target, 0, selectOne(id));
    const stmt = handle.prepare('UPDATE llm_providers SET position = ? WHERE id = ?');
    rows.forEach((row, i) => stmt.run(i, row.id));
  }
}
