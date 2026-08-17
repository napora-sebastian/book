#!/usr/bin/env node
/**
 * Finds the Spark's inference endpoint and verifies the model answers.
 * Run after starting the cluster:  npm run doctor
 */
import 'dotenv/config';

import { llmSettings } from '../server/llm-settings.js';

// The app answers from the provider chain stored by the llm-settings plugin, so
// the doctor probes those first — checking only .env would happily report a
// healthy endpoint the app no longer uses.
const CONFIGURED = llmSettings.resolve().providers.map((p) => p.apiUrl);

const CANDIDATES = [
  ...CONFIGURED,
  process.env.LLM_BASE_URL,
  'http://aitopatom-4fc6.local:11111/v1', // "head" node, LiteLLM proxy
  'http://aitopatom-4fc6.local:8890/v1',  // "head" node, vLLM direct (tp2)
  'http://gx10-1419.local:11111/v1',      // "asus" node
  'http://gx10-1419.local:8890/v1',
  'http://127.0.0.1:11111/v1',            // LiteLLM proxy over SSH tunnel
  'http://127.0.0.1:8890/v1',             // vLLM over SSH tunnel
].filter(Boolean).map((u) => u.replace(/\/+$/, ''));

const main = llmSettings.resolve().main;
const KEY = main?.apiKey || process.env.LLM_API_KEY || 'local';
const WANT = main?.model || process.env.LLM_MODEL || '';
const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

const probe = async (base) => {
  const ctl = AbortSignal.timeout(4000);
  const res = await fetch(`${base}/models`, { headers, signal: ctl });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()).data?.map((m) => m.id) ?? [];
};

console.log('\nProbing for the DGX Spark inference endpoint…\n');

const seen = new Set();
let hit = null;

for (const base of CANDIDATES) {
  if (seen.has(base)) continue;
  seen.add(base);
  try {
    const models = await probe(base);
    console.log(`  ✅  ${base}`);
    models.forEach((m) => console.log(`        · ${m}`));
    if (!hit) hit = { base, models };
  } catch (err) {
    console.log(`  ✖   ${base}  (${err.message})`);
  }
}

if (!hit) {
  console.log(`
No endpoint answered. Checklist:
  1. Is the cluster's start script finished and the server listening?
     On the Spark:  ss -tlnp | grep -E '8000|11434'
  2. Is it bound to 0.0.0.0 rather than 127.0.0.1? If it is loopback-only,
     you must use the SSH tunnel:  npm run tunnel
  3. Can the Mac reach the box at all?  ssh head 'echo ok'   (NVIDIA Sync alias)
`);
  process.exit(1);
}

console.log(`\nUsing ${hit.base}`);

if (WANT && !hit.models.includes(WANT)) {
  console.log(`\n⚠  The configured model is "${WANT}" but the server advertises:`);
  hit.models.forEach((m) => console.log(`     ${m}`));
  console.log('   Pick the exact id above in ⚙ LLM — ids must match verbatim.');
}

const model = hit.models.includes(WANT) ? WANT : hit.models[0];
if (!model) process.exit(1);

console.log(`\nTest completion against "${model}"…`);
const t0 = Date.now();
const res = await fetch(`${hit.base}/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: SPARK OK' }],
    max_tokens: 16,
    temperature: 0,
  }),
});

if (!res.ok) {
  console.log(`  ✖  ${res.status} ${res.statusText}\n${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

const json = await res.json();
console.log(`  ✅  "${json.choices?.[0]?.message?.content?.trim()}"  (${Date.now() - t0} ms)`);

const ctx = json.usage ? `prompt ${json.usage.prompt_tokens} / completion ${json.usage.completion_tokens}` : '';
if (ctx) console.log(`      usage: ${ctx}`);

console.log(`
Set this as the main provider in the app's ⚙ LLM screen:
  API URL   ${hit.base}
  Model     ${model}

(Or, before anything is saved there, as .env defaults:
  LLM_BASE_URL=${hit.base}
  LLM_MODEL=${model})
`);
