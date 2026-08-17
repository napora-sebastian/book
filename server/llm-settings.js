import db from './db.js';
import { createLlmSettings } from '../plugins/llm-settings/index.js';

/**
 * The app's single wiring point for the llm-settings plugin.
 *
 * Where inference goes is no longer read from the environment at call time: the
 * plugin owns the provider chain and stores it in this app's own SQLite file
 * (its `llm_providers` table lands next to `documents` and `threads`, so a
 * backup of the store carries the configuration with it).
 *
 * The .env values stay as a stand-in for a store that has never been configured
 * — an existing checkout keeps answering exactly as before until someone opens
 * the settings screen and saves. After that, .env is only offered as an import.
 */
export const llmSettings = createLlmSettings({
  db,
  envDefaults: () => ({
    label: 'from .env',
    apiUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:8000/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'ds4-non-thinking',
  }),
});

export default llmSettings;
