/**
 * Helpers shared by the plugin's store, router and host bindings. They live in
 * their own module so the router and the factory never have to import each
 * other, which would make the plugin's own load order matter.
 */

/** Trailing slashes make `${base}/models` produce `//models` on some proxies. */
export const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

/** Never hand a stored secret back to a browser — only enough to recognise it. */
export const maskKey = (key) => {
  if (!key) return '';
  const s = String(key);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
};

/** True when a client sent back the mask instead of a real key (i.e. "unchanged"). */
export const isMasked = (key) => typeof key === 'string' && /^•+/.test(key.trim());

export const hostOf = (url) => {
  try { return new URL(url).host; } catch { return String(url || 'provider'); }
};

/**
 * List the models an OpenAI-compatible endpoint advertises. Used by the settings
 * screen's dropdown, by the reachability test, and by the host app's own model
 * picker.
 */
export async function fetchModels({ apiUrl, apiKey, timeoutMs = 10_000 }) {
  const base = normalizeUrl(apiUrl);
  if (!base) throw new Error('apiUrl is required.');

  let res;
  try {
    res = await fetch(`${base}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Node collapses every connection-level failure into "fetch failed", which
    // tells the person configuring a provider nothing about what went wrong.
    if (err.name === 'TimeoutError') throw new Error(`${base} did not answer within ${timeoutMs / 1000}s`);
    throw new Error(`cannot reach ${base} — ${err.cause?.code || err.cause?.message || err.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${base}/models → ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const json = await res.json().catch(() => ({}));
  return (json.data || []).map((m) => m.id).filter(Boolean);
}
