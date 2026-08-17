import { llmSettings } from './llm-settings.js';

// Sampling and budget stay in .env: they describe how this app talks to a model,
// not which model it talks to. Endpoints, keys and model ids come from the
// llm-settings plugin, which stores them in the database.
const params = () => ({
  temperature: Number(process.env.TEMPERATURE ?? 0.2),
  maxTokens: Number(process.env.MAX_TOKENS ?? 4096),
  // The cluster reports max_model_len = max_total_tokens = 1,048,576. That is
  // one budget shared by prompt AND completion, not a context window with a
  // separate output allowance: ask for more than what the prompt leaves and
  // the request is rejected outright.
  maxTotalTokens: Number(process.env.MAX_TOTAL_TOKENS ?? 1_048_576),
});

/**
 * How much output the prompt still leaves room for.
 *
 * The prompt is measured conservatively — 2.5 chars/token against a measured
 * 2.88 — because over-estimating the prompt costs a few output tokens, while
 * under-estimating it costs the whole request.
 */
function outputRoom(messages, maxTotalTokens) {
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  return maxTotalTokens - Math.ceil(promptChars / 2.5) - 512;
}

const headers = (provider) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${provider.apiKey || 'local'}`,
});

/** Where the app currently points — the main provider of the configured chain. */
export function config() {
  const { main, fallbacks, source } = llmSettings.resolve();
  return {
    baseUrl: main?.apiUrl ?? '',
    model: main?.model ?? '',
    source,
    provider: main ? { id: main.id, label: main.label } : null,
    fallbacks: fallbacks.map((p) => ({ id: p.id, label: p.label, apiUrl: p.apiUrl, model: p.model })),
  };
}

/** Models the main provider advertises. */
export async function listModels() {
  const { main } = llmSettings.resolve();
  if (!main) throw new Error('No LLM provider configured — open the LLM settings and add one.');
  return llmSettings.fetchModels(main);
}

/** Models any configured provider advertises, keyed by position in the chain. */
export function providerChain(model) {
  return llmSettings.chain(model);
}

/** One attempt against one provider. Throws on connection or HTTP failure. */
async function postTo(provider, messages, { stream, signal }) {
  const { temperature, maxTokens, maxTotalTokens } = params();

  // Yield to the prompt rather than letting the server reject the turn. A book
  // that leaves less room than MAX_TOKENS asks for still gets answered, just
  // more briefly — and the caller is told, so it can say why.
  const room = outputRoom(messages, maxTotalTokens);
  const effectiveMaxTokens = Math.max(256, Math.min(maxTokens, room));

  const body = {
    model: provider.model,
    messages,
    temperature,
    max_tokens: effectiveMaxTokens,
    stream: Boolean(stream),
  };
  // Verified against this cluster: vLLM reports real usage on the final SSE
  // frame when asked. Without this, streamed turns have no token counts at all.
  if (stream) body.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(`${provider.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(provider),
      signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Node reports every connection-level problem as a bare "fetch failed",
    // which tells the user nothing about which box stopped answering.
    throw new Error(
      `cannot reach ${provider.apiUrl} — ${err.cause?.code || err.cause?.message || err.message}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} from ${provider.apiUrl}: ${text.slice(0, 400)}`);
  }
  return { res, body, maxTokens: effectiveMaxTokens, requestedMaxTokens: maxTokens };
}

/**
 * Try the configured chain in order: main provider first, then each fallback.
 *
 * A fallback only replaces a provider that failed to produce a response at all —
 * unreachable host, refused connection, HTTP error. Once a provider has started
 * answering, its failure is the turn's failure: tokens already streamed to the
 * browser cannot be taken back, so a second provider would append a second
 * answer to half of the first one.
 *
 * `onFallback({ failed, error, next })` is how the caller tells the user that a
 * different provider is about to answer.
 */
async function post(messages, { stream, signal, model, onFallback }) {
  const chain = llmSettings.chain(model);
  if (!chain.length) {
    throw new Error('No LLM provider configured — open the LLM settings and add one.');
  }

  const failures = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      const attempt = await postTo(provider, messages, { stream, signal });
      return { ...attempt, provider, attempts: failures };
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err;

      failures.push({ provider, error: err.message });
      const next = chain[i + 1];
      if (!next) {
        // Every provider is down. One combined message beats the last error
        // alone, which would name only the least important server in the chain.
        throw new Error(
          `every configured provider failed — ${failures
            .map((f) => `${f.provider.label} (${f.provider.role}): ${f.error}`)
            .join(' · ')}`,
        );
      }
      onFallback?.({ failed: provider, error: err.message, next, attempt: i + 1 });
    }
  }
  throw new Error('No LLM provider configured.');
}

/** Everything the tracer and the caller need about which provider answered. */
const served = (provider, attempts) => ({
  provider: { id: provider.id, label: provider.label, role: provider.role },
  baseUrl: provider.apiUrl,
  model: provider.model,
  // Empty unless the main provider failed — the caller records it on the turn.
  fellBackFrom: attempts.map((a) => ({ label: a.provider.label, error: a.error })),
});

/**
 * One-shot completion, used for the map stage of long documents.
 * Returns the text plus everything the tracer needs.
 */
export async function complete(messages, { signal, model, onFallback } = {}) {
  const started = Date.now();
  const { res, body: request, maxTokens, provider, attempts } =
    await post(messages, { stream: false, signal, model, onFallback });
  const json = await res.json();
  return {
    ...served(provider, attempts),
    maxTokens,
    text: json.choices?.[0]?.message?.content ?? '',
    reasoning: json.choices?.[0]?.message?.reasoning_content ?? '',
    // "length" means max_tokens cut the answer off. Without this the caller
    // cannot tell a finished answer from a truncated one.
    finishReason: json.choices?.[0]?.finish_reason ?? null,
    usage: json.usage ?? null,
    request,
    servedModel: json.model ?? null,
    fingerprint: json.system_fingerprint ?? null,
    ttftMs: null, // meaningless without streaming
    durationMs: Date.now() - started,
  };
}

/**
 * Streaming completion. onToken(delta) receives answer text; onThinking(delta)
 * receives the reasoning stream that ds4-high/ds4-max emit on a separate
 * `reasoning_content` field before the answer starts.
 */
export async function stream(messages, { onToken, onThinking, signal, model, onFallback } = {}) {
  const started = Date.now();
  const { res, body: request, maxTokens, provider, attempts } =
    await post(messages, { stream: true, signal, model, onFallback });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let servedModel = null;
  let fingerprint = null;
  let ttftMs = null;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);

          // The usage frame arrives last and carries no choices.
          if (json.usage) usage = json.usage;
          if (json.model) servedModel = json.model;
          if (json.system_fingerprint) fingerprint = json.system_fingerprint;

          // Arrives on the final content frame. "length" means max_tokens ran
          // out — on a reasoning model that can happen before the answer even
          // starts, leaving an empty response and an HTTP 200.
          if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;

          const delta = json.choices?.[0]?.delta ?? {};
          // ds4-high / ds4-max stream chain-of-thought on `reasoning_content`
          // first. Keep it out of the answer, but report it so the UI can show
          // progress instead of sitting blank.
          if (delta.reasoning_content) {
            if (ttftMs === null) ttftMs = Date.now() - started;
            reasoning += delta.reasoning_content;
            onThinking?.(delta.reasoning_content);
          }
          if (delta.content) {
            if (ttftMs === null) ttftMs = Date.now() - started;
            text += delta.content;
            onToken?.(delta.content);
          }
        } catch {
          /* keep going — a partial frame will arrive with the next chunk */
        }
      }
    }
  }

  return {
    ...served(provider, attempts),
    text,
    reasoning,
    finishReason,
    maxTokens,
    usage,
    request,
    servedModel,
    fingerprint,
    ttftMs,
    durationMs: Date.now() - started,
  };
}
