# llm-settings

A drop-in plugin that owns **where inference goes**: a main LLM provider, a
fallback provider, and as many further fallbacks as you like — each with its own
API URL, API key and model — stored in a database instead of `.env`.

It is self-contained: a store, an HTTP API and a settings screen. The host app
adds one line on the server and one on the page.

```
plugins/llm-settings/
  index.js              createLlmSettings(), resolve(), chain(), mount()
  store.js              the llm_providers table
  router.js             the JSON API
  provider-utils.js     url/key/model helpers shared by both halves
  public/
    llm-settings.js     mountLlmSettings() — button + modal, no dependencies
    llm-settings.css    styling, themed from the host's CSS variables
```

## Plugging it in

**Server** — pass an existing SQLite handle (the settings then live in the host's
own database) or nothing at all (the plugin opens `data/llm-settings.db`):

```js
import { createLlmSettings } from '../plugins/llm-settings/index.js';

export const llmSettings = createLlmSettings({
  db,                                    // optional: host's node:sqlite handle
  envDefaults: () => ({                  // optional: pre-plugin configuration
    apiUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  }),
});

llmSettings.mount(app);                  // /api/llm/* + /plugins/llm-settings/*
```

**Page** — one import, one call; the plugin brings its own button, modal and
stylesheet:

```html
<script type="module">
  import { mountLlmSettings } from '/plugins/llm-settings/llm-settings.js';
  mountLlmSettings({ mount: '#topActions', label: '⚙ LLM' });
</script>
```

**Inference** — ask for the chain instead of reading environment variables:

```js
const chain = llmSettings.chain(userPickedModel);   // [main, …fallbacks]
for (const provider of chain) {
  try { return await callProvider(provider, messages); }
  catch (err) { /* try the next one */ }
}
```

## The chain

Array order is priority. Position 0 is the main provider; every later entry is a
fallback, tried in order, only when the one before it failed to produce a
response at all — an unreachable host, a refused connection, an HTTP error.

Two rules make the chain behave predictably:

- **A fallback answers with its own model.** The model a user picked exists on
  the main provider; a different server almost certainly does not serve that same
  id. Carrying the id across would turn one failure into two.
- **Once a provider has started answering, its failure is the turn's failure.**
  Tokens already streamed to a browser cannot be taken back, so a second provider
  would append a second answer onto half of the first.

A provider can be switched off (`enabled: false`) to keep it in the list but out
of the chain.

## API

Mounted at `/api/llm` by default.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/providers` | Every provider, main first, keys masked |
| `GET` | `/providers/:id` | One provider |
| `POST` | `/providers` | Replace the whole chain |
| `PATCH` | `/providers/:id` | Change one field (`model`, `label`, `apiUrl`, `apiKey`, `enabled`, `position`) |
| `DELETE` | `/providers/:id` | Remove one |
| `GET` | `/providers/:id/models` | Model ids that provider advertises |
| `POST` | `/providers/:id/test` | Reachability + "does it serve the chosen model" |
| `POST` | `/models` | Models for a provider not saved yet: `{ apiUrl, apiKey }` |
| `GET` | `/config` | The resolved chain the app will actually use |

### Saving

```http
POST /api/llm/providers
Content-Type: application/json

{
  "llm_providers": [
    { "apiUrl": "http://192.168.0.80:11111/v1", "apiKey": "sk-…", "model": "ds4-non-thinking", "label": "Spark head" },
    { "apiUrl": "http://192.168.0.80:8890/v1",  "apiKey": "sk-…", "model": "deepseek-v4-flash-0731" },
    { "apiUrl": "https://api.openai.com/v1",    "apiKey": "sk-…", "model": "gpt-4.1-mini" }
  ]
}
```

`apiUrl` is the only required field. `label`, `model` and `enabled` are optional;
`apiKey` is optional and follows the rules below.

The POST **replaces** the list — entries you leave out are deleted, so the screen
needs no separate delete call. Entries carrying an `id` update that row; entries
without one are inserted. An `id` that no longer exists is rejected with `409`
rather than silently inserted as a new provider.

### Keys

Keys are stored in the database and never sent to a browser: every response
carries `apiKey` masked (`••••1234`) plus `hasApiKey`. On the way back:

- **key omitted** (or the mask echoed) → the stored key is kept,
- **a real string** → replaces the stored key,
- **an empty string** → clears it (for servers that need no key).

One special case makes migration off `.env` work: a *new* entry pointing at the
`envDefaults` URL with no key of its own adopts the `.env` key — the settings
screen has only ever seen it masked, and the first save must not leave the
credential behind.

### Source of truth

`GET /config` reports `source`:

- `db` — providers are stored; `.env` is ignored,
- `env` — nothing stored yet, so `envDefaults` is served as a read-only main
  provider and the app keeps working exactly as before,
- `none` — nothing configured anywhere; inference reports that instead of
  guessing an endpoint.

Deleting every provider returns the app to `env` rather than leaving it with no
way to answer at all.

## Events

The settings screen fires `llm-settings:saved` on `document` after a successful
save, with the saved payload as `detail`. Hosts use it to refresh anything
derived from the provider list (a model dropdown, a status pill).
