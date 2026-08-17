import express from 'express';

import { fetchModels, isMasked, normalizeUrl } from './provider-utils.js';

/**
 * HTTP surface of the llm-settings plugin. Mounted by the host at some base
 * path (the book app uses `/api/llm`):
 *
 *   GET    /providers            every provider, main first, keys masked
 *   GET    /providers/:id        one provider
 *   POST   /providers            { llm_providers: [{ apiUrl, apiKey, … }] } — replaces the chain
 *   PATCH  /providers/:id        change one field (model, label, position, enabled)
 *   DELETE /providers/:id        drop one
 *   GET    /providers/:id/models model ids that provider advertises
 *   POST   /providers/:id/test   reachability check
 *   POST   /models               models for a not-yet-saved provider { apiUrl, apiKey }
 *   GET    /config               the resolved chain the app will actually use
 */
export function createRouter(api) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /* ------------------------------------------------------------- validation */

  /**
   * A provider entry as the API accepts it. The documented contract is the
   * minimum — `{ apiUrl, apiKey }` — and everything else is optional, so a
   * caller that only knows about endpoints and keys still produces a usable
   * chain (models are then whatever each server defaults to).
   */
  function normalizeEntry(entry, index) {
    if (!entry || typeof entry !== 'object') {
      throw new HttpError(400, `llm_providers[${index}] must be an object.`);
    }

    const apiUrl = normalizeUrl(entry.apiUrl ?? entry.api_url ?? entry.baseUrl);
    if (!apiUrl) throw new HttpError(400, `llm_providers[${index}].apiUrl is required.`);

    let parsed;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new HttpError(400, `llm_providers[${index}].apiUrl is not a valid URL: ${apiUrl}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new HttpError(400, `llm_providers[${index}].apiUrl must be http or https.`);
    }

    // A masked key is the client saying "leave the stored one alone"; undefined
    // says the same thing. Only a real string replaces the secret.
    const rawKey = entry.apiKey ?? entry.api_key;
    const apiKey = rawKey === undefined || rawKey === null || isMasked(rawKey) ? undefined : String(rawKey);

    return {
      id: entry.id != null ? Number(entry.id) : undefined,
      label: entry.label != null ? String(entry.label).trim() || null : null,
      apiUrl,
      apiKey,
      model: entry.model != null ? String(entry.model).trim() || null : null,
      enabled: entry.enabled !== false,
    };
  }

  /* -------------------------------------------------------------- providers */

  router.get('/providers', (_req, res) => {
    const { source } = api.resolve();
    // With nothing stored, show the host's .env stand-in so the screen explains
    // where the app is currently pointing instead of looking empty and broken.
    const stored = api.list();
    const env = api.envProvider();
    res.json({
      source,
      llm_providers: stored.length ? stored : (env ? [api.publicView(env)] : []),
      stored: stored.length,
      env: env ? api.publicView(env) : null,
    });
  });

  router.get('/providers/:id', (req, res) => {
    const provider = api.getOne(req.params.id);
    if (!provider) return res.status(404).json({ error: 'No such provider.' });
    res.json(provider);
  });

  /**
   * Replace the whole chain. Array order is priority: index 0 is the main
   * provider, the rest are the fallbacks in the order they will be tried.
   */
  router.post('/providers', (req, res) => {
    const body = req.body || {};
    const list = body.llm_providers ?? body.providers ?? (Array.isArray(body) ? body : null);
    if (!Array.isArray(list)) {
      return res.status(400).json({ error: 'Body must be { llm_providers: [{ apiUrl, apiKey }] }.' });
    }

    const entries = list.map(normalizeEntry);

    // A stale id would otherwise be inserted as a brand new provider — an entry
    // that looks saved, carries no key, and quietly joins the fallback chain.
    const known = new Set(api.list().map((p) => p.id));
    const unknown = entries.filter((e) => e.id != null && !known.has(e.id)).map((e) => e.id);
    if (unknown.length) {
      return res.status(409).json({
        error: `No provider with id ${unknown.join(', ')} — reload the settings before saving. `
          + 'Omit `id` to add a new provider.',
      });
    }

    // Saving the .env stand-in is how a host app migrates off its environment
    // variables, and the screen doing the saving has only ever seen that key
    // masked. A new entry pointing at the .env endpoint with no key of its own
    // therefore adopts the .env key — otherwise the first save would move the
    // endpoint into the database and leave the credential behind.
    const env = api.envProvider();
    const withEnvKey = entries.map((e) =>
      e.id == null && e.apiKey === undefined && env && e.apiUrl === env.apiUrl && env.apiKey
        ? { ...e, apiKey: env.apiKey }
        : e);

    const saved = api.save(withEnvKey);
    res.json({ source: api.resolve().source, llm_providers: saved });
  });

  router.patch('/providers/:id', (req, res) => {
    if (!api.getOne(req.params.id)) return res.status(404).json({ error: 'No such provider.' });

    const body = req.body || {};
    const patch = {};
    if (body.label !== undefined) patch.label = body.label == null ? null : String(body.label).trim() || null;
    if (body.model !== undefined) patch.model = body.model == null ? null : String(body.model).trim() || null;
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.position !== undefined) patch.position = Number(body.position);
    if (body.apiUrl !== undefined || body.api_url !== undefined) {
      patch.apiUrl = normalizeEntry({ ...body, apiKey: undefined }, 0).apiUrl;
    }
    const rawKey = body.apiKey ?? body.api_key;
    if (rawKey !== undefined && rawKey !== null && !isMasked(rawKey)) patch.apiKey = String(rawKey);

    res.json(api.update(req.params.id, patch));
  });

  router.delete('/providers/:id', (req, res) => {
    if (!api.getOne(req.params.id)) return res.status(404).json({ error: 'No such provider.' });
    res.json({ deleted: api.remove(req.params.id) });
  });

  /* ----------------------------------------------------------------- models */

  router.get('/providers/:id/models', wrap(async (req, res) => {
    const provider = api.getSecret(req.params.id);
    if (!provider) return res.status(404).json({ error: 'No such provider.' });

    try {
      res.json({ models: await fetchModels(provider), apiUrl: provider.apiUrl });
    } catch (err) {
      res.status(502).json({ error: err.message, models: [] });
    }
  }));

  /**
   * Models for a provider being typed in, before it is saved — which is the
   * order the settings screen works in: paste a URL and key, pick a model, then
   * save. `id` lets the screen probe with the stored key it never sees.
   */
  router.post('/models', wrap(async (req, res) => {
    const { apiUrl, apiKey, id } = req.body || {};
    const stored = id != null ? api.getSecret(id) : null;

    const target = {
      apiUrl: normalizeUrl(apiUrl) || stored?.apiUrl,
      apiKey: apiKey && !isMasked(apiKey) ? apiKey : stored?.apiKey,
    };
    if (!target.apiUrl) return res.status(400).json({ error: 'apiUrl is required.' });

    try {
      res.json({ models: await fetchModels(target), apiUrl: target.apiUrl });
    } catch (err) {
      res.status(502).json({ error: err.message, models: [] });
    }
  }));

  router.post('/providers/:id/test', wrap(async (req, res) => {
    const provider = api.getSecret(req.params.id);
    if (!provider) return res.status(404).json({ error: 'No such provider.' });

    const started = Date.now();
    try {
      const models = await fetchModels(provider);
      res.json({
        ok: true,
        ms: Date.now() - started,
        models,
        // A provider whose configured model the server does not list still
        // answers — but usually with a 404 on the first real request, so say it.
        modelServed: provider.model ? models.includes(provider.model) : null,
      });
    } catch (err) {
      res.json({ ok: false, ms: Date.now() - started, error: err.message, models: [] });
    }
  }));

  /* ----------------------------------------------------------------- config */

  /** What inference will actually do right now, keys masked. */
  router.get('/config', (_req, res) => {
    const { source, main, fallbacks } = api.resolve();
    res.json({
      source,
      main: main ? api.publicView(main) : null,
      fallbacks: fallbacks.map(api.publicView),
      env: api.envProvider() ? api.publicView(api.envProvider()) : null,
    });
  });

  router.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return router;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
