import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { createStore } from './store.js';
import { createRouter } from './router.js';
import { fetchModels, hostOf, isMasked, maskKey, normalizeUrl } from './provider-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { fetchModels, isMasked, maskKey, normalizeUrl };

/**
 * The llm-settings plugin.
 *
 * Owns where inference goes: which provider is main, which ones back it up, and
 * with what credentials. The host app asks it for a provider chain instead of
 * reading LLM_BASE_URL / LLM_API_KEY / LLM_MODEL out of the environment itself.
 *
 *   const llmSettings = createLlmSettings({ db, envDefaults: () => ({ … }) });
 *   llmSettings.mount(app);                       // API + settings UI assets
 *   const chain = llmSettings.chain('some-model'); // [main, …fallbacks]
 *
 * `envDefaults` is the bridge for an app that used to be configured by .env:
 * while nothing is stored, those values are served as a read-only main provider,
 * so the app keeps working before anyone opens the settings screen. The moment a
 * provider is saved, the database wins and .env is only offered as an import.
 */
export function createLlmSettings({ db, dbPath, envDefaults = () => ({}) } = {}) {
  const store = createStore({ db, dbPath });

  // resolve() runs on every inference call; the read is cheap but this keeps it
  // off the hot path entirely. Every write clears it.
  let cache = null;
  const invalidate = () => { cache = null; };

  const fromRow = (row) => ({
    id: row.id,
    label: row.label || hostOf(row.api_url),
    apiUrl: normalizeUrl(row.api_url),
    apiKey: row.api_key || '',
    model: row.model || '',
    enabled: Boolean(row.enabled),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const envProvider = () => {
    const env = envDefaults() || {};
    if (!env.apiUrl) return null;
    return {
      id: null,
      label: env.label || 'from .env',
      apiUrl: normalizeUrl(env.apiUrl),
      apiKey: env.apiKey || '',
      model: env.model || '',
      enabled: true,
      position: 0,
      fromEnv: true,
    };
  };

  /**
   * The provider chain as configured: `main` plus `fallbacks` in the order they
   * are tried. `source` says whether that came from the database or from the
   * host's .env stand-in — the settings screen shows it, so nobody wonders why
   * their edits appear to do nothing.
   */
  function resolve() {
    if (cache) return cache;

    const rows = store.all().map(fromRow).filter((p) => p.enabled && p.apiUrl);
    if (rows.length) {
      cache = { source: 'db', providers: rows, main: rows[0], fallbacks: rows.slice(1) };
    } else {
      const env = envProvider();
      cache = env
        ? { source: 'env', providers: [env], main: env, fallbacks: [] }
        : { source: 'none', providers: [], main: null, fallbacks: [] };
    }
    return cache;
  }

  /**
   * The chain to try for one request, main first.
   *
   * `preferredModel` (the model the user picked in the host app) only applies to
   * the main provider: a fallback is a different server and will usually not
   * serve the same model id, so each fallback answers with the model it was
   * configured with. Falling back to a model the second provider has never heard
   * of would turn one failure into two.
   */
  function chain(preferredModel) {
    const { main, fallbacks, source } = resolve();
    if (!main) return [];
    return [
      { ...main, role: 'main', source, model: preferredModel || main.model },
      ...fallbacks.map((p) => ({ ...p, role: 'fallback', source, model: p.model || preferredModel || '' })),
    ].filter((p) => p.apiUrl);
  }

  /** Public shape: masked key, never the secret itself. */
  const publicView = (p) => ({
    id: p.id,
    label: p.label,
    apiUrl: p.apiUrl,
    apiKey: maskKey(p.apiKey),
    hasApiKey: Boolean(p.apiKey),
    model: p.model,
    enabled: p.enabled !== false,
    position: p.position,
    role: p.position === 0 ? 'main' : 'fallback',
    fromEnv: Boolean(p.fromEnv),
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
  });

  const api = {
    store,
    resolve,
    chain,
    invalidate,
    publicView,
    fromRow,
    envProvider,
    fetchModels,

    /** Every stored provider, masked — the GET list endpoint's payload. */
    list: () => store.all().map(fromRow).map(publicView),

    /** One stored provider, masked. */
    getOne: (id) => {
      const row = store.get(Number(id));
      return row ? publicView(fromRow(row)) : null;
    },

    /** Same lookup, but with the real key — for server-side calls only. */
    getSecret: (id) => {
      const row = store.get(Number(id));
      return row ? fromRow(row) : null;
    },

    save(entries) {
      const rows = store.replaceAll(entries);
      invalidate();
      return rows.map(fromRow).map(publicView);
    },

    update(id, patch) {
      const row = store.update(Number(id), patch);
      invalidate();
      return row ? publicView(fromRow(row)) : null;
    },

    remove(id) {
      const gone = store.remove(Number(id));
      invalidate();
      return gone;
    },
  };

  api.router = createRouter(api);
  api.assetsDir = path.join(__dirname, 'public');

  /**
   * Plug the whole thing into an Express app: JSON API plus the settings screen's
   * own assets. One call is all a host app needs.
   */
  api.mount = (app, { apiPath = '/api/llm', assetPath = '/plugins/llm-settings' } = {}) => {
    app.use(apiPath, api.router);
    app.use(assetPath, express.static(api.assetsDir));
    return api;
  };

  return api;
}
