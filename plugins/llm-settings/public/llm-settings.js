/**
 * llm-settings — client half of the plugin.
 *
 * A host page plugs it in with one import and one call:
 *
 *   import { mountLlmSettings } from '/plugins/llm-settings/llm-settings.js';
 *   mountLlmSettings({ mount: '#topActions' });
 *
 * It brings its own button, its own modal, its own stylesheet and its own API
 * calls; the host only decides where the button goes. When the chain is saved it
 * fires `llm-settings:saved` on `document`, which is how the host learns that
 * its model list may have changed.
 */

const CSS_ID = 'llm-settings-css';

/** Modals in this app close through their own buttons only — never Esc or backdrop. */
export function mountLlmSettings({
  mount = 'body',
  label = '⚙ LLM',
  title = 'LLM providers',
  apiPath = '/api/llm',
  assetPath = '/plugins/llm-settings',
  button = true,
} = {}) {
  injectCss(assetPath);

  const ui = buildModal(title, apiPath);
  document.body.appendChild(ui.overlay);

  let trigger = null;
  if (button) {
    const host = typeof mount === 'string' ? document.querySelector(mount) : mount;
    trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'llmset-trigger small';
    trigger.textContent = label;
    trigger.title = 'Main provider, fallback providers, API keys and models';
    trigger.addEventListener('click', () => ui.open());
    (host || document.body).appendChild(trigger);
  }

  return { open: ui.open, close: ui.close, refresh: ui.load, button: trigger, overlay: ui.overlay };
}

/** Everything the host might want without opening the screen. */
export async function getLlmConfig(apiPath = '/api/llm') {
  return request(`${apiPath}/config`);
}

export async function listProviders(apiPath = '/api/llm') {
  return request(`${apiPath}/providers`);
}

/* ------------------------------------------------------------------ plumbing */

function injectCss(assetPath) {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = `${assetPath}/llm-settings.css`;
  document.head.appendChild(link);
}

async function request(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

const post = (url, body) =>
  request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const elem = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/* -------------------------------------------------------------------- modal */

function buildModal(title, apiPath) {
  const overlay = elem('div', 'llmset-overlay hidden');
  const sheet = elem('div', 'llmset-sheet');

  const head = elem('header', 'llmset-head');
  const heading = elem('strong', null, title);
  const source = elem('span', 'llmset-source');
  const actions = elem('div', 'llmset-headActions');

  const addBtn = elem('button', 'small', '+ Add fallback');
  addBtn.type = 'button';
  addBtn.title = 'Tried in order, after the main provider, when a request fails';
  const saveBtn = elem('button', 'small primary', 'Save');
  saveBtn.type = 'button';
  const closeBtn = elem('button', 'small', 'Close');
  closeBtn.type = 'button';

  actions.append(addBtn, saveBtn, closeBtn);
  head.append(heading, source, actions);

  // Leaving with unsaved edits asks first, and asks inside the sheet: a native
  // confirm() would arrive in the OS's own styling and block the page.
  const discard = elem('div', 'llmset-discard hidden');
  const discardText = elem('span', null, 'Discard unsaved provider changes?');
  const discardYes = elem('button', 'small', 'Discard');
  discardYes.type = 'button';
  const discardNo = elem('button', 'small primary', 'Keep editing');
  discardNo.type = 'button';
  discard.append(discardText, discardYes, discardNo);

  const body = elem('div', 'llmset-body');
  const note = elem('div', 'llmset-note');
  const list = elem('div', 'llmset-list');
  const status = elem('div', 'llmset-status');
  body.append(note, list, status);

  sheet.append(head, discard, body);
  overlay.appendChild(sheet);

  // Live editor state. `apiKey === undefined` means "leave the stored secret
  // alone" — the screen is never given the real key to send back.
  let rows = [];
  let dirty = false;

  const setStatus = (text, kind = '') => {
    status.textContent = text || '';
    status.className = `llmset-status ${kind}`;
  };

  async function load() {
    setStatus('loading…');
    list.innerHTML = '';
    try {
      const data = await request(`${apiPath}/providers`);
      rows = (data.llm_providers || []).map((p) => ({
        id: data.stored ? p.id : null,           // the .env stand-in is not a stored row
        label: p.label || '',
        apiUrl: p.apiUrl || '',
        apiKey: undefined,
        keyMask: p.apiKey || '',
        hasApiKey: p.hasApiKey,
        model: p.model || '',
        enabled: p.enabled !== false,
        models: [],
        manual: false,
        probe: null,
      }));
      dirty = !data.stored && rows.length > 0; // .env values are unsaved by definition

      source.textContent = {
        db: 'saved in database',
        env: 'not configured yet — using .env',
        none: 'nothing configured',
      }[data.source] || '';
      source.className = `llmset-source ${data.source}`;

      note.textContent = data.stored
        ? 'First provider answers. If it fails, each fallback is tried in order, with its own model.'
        : 'These values come from .env and are not stored yet. Save to move them into the database — after that .env is ignored.';

      render();
      setStatus('');
    } catch (err) {
      setStatus(err.message, 'bad');
    }
  }

  function render() {
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(elem('div', 'llmset-empty', 'No providers. Add one — the first is the main provider.'));
    }
    rows.forEach((row, i) => list.appendChild(renderCard(row, i)));
    saveBtn.textContent = dirty ? 'Save •' : 'Save';
  }

  function renderCard(row, index) {
    // A disabled provider keeps its place in the list but is skipped when the
    // chain is resolved, so the badges count only the ones that can answer.
    const rank = rows.slice(0, index).filter((r) => r.enabled).length;
    const isMain = row.enabled && rank === 0;

    const card = elem('div', `llmset-card${isMain ? ' main' : ''}${row.enabled ? '' : ' off'}`);

    /* -- header: role, name, ordering -------------------------------------- */
    const cardHead = elem('div', 'llmset-cardHead');
    cardHead.appendChild(elem('span', 'llmset-badge',
      !row.enabled ? 'OFF' : isMain ? 'MAIN' : `FALLBACK ${rank}`));

    const labelInput = field('text', row.label, 'Name (optional)');
    labelInput.className = 'llmset-input llmset-label';
    labelInput.addEventListener('input', () => { row.label = labelInput.value; markDirty(); });
    cardHead.appendChild(labelInput);

    const power = iconBtn(row.enabled ? '◉' : '○',
      row.enabled ? 'Skip this provider without deleting it' : 'Put this provider back in the chain');
    power.addEventListener('click', () => {
      row.enabled = !row.enabled;
      markDirty();
      render();
    });
    cardHead.appendChild(power);

    const up = iconBtn('↑', 'Move earlier in the chain');
    up.disabled = index === 0;
    up.addEventListener('click', () => { swap(index, index - 1); });

    const down = iconBtn('↓', 'Move later in the chain');
    down.disabled = index === rows.length - 1;
    down.addEventListener('click', () => { swap(index, index + 1); });

    const drop = iconBtn('✕', 'Remove this provider');
    drop.classList.add('danger');
    drop.addEventListener('click', () => {
      rows.splice(index, 1);
      markDirty();
      render();
    });

    cardHead.append(up, down, drop);
    card.appendChild(cardHead);

    /* -- credentials ------------------------------------------------------- */
    const urlInput = field('text', row.apiUrl, 'https://host:port/v1');
    urlInput.addEventListener('input', () => {
      row.apiUrl = urlInput.value.trim();
      row.models = [];
      row.probe = null;
      markDirty();
    });
    card.appendChild(labelled('API URL', urlInput, 'OpenAI-compatible base — the part before /chat/completions'));

    // A re-render must not silently drop a key the user has already typed but
    // not yet saved, so the field is drawn from state, not left blank.
    const keyInput = field('password', row.apiKey ?? '',
      row.hasApiKey ? `${row.keyMask} (stored — leave blank to keep)` : 'API key');
    keyInput.autocomplete = 'new-password';
    keyInput.addEventListener('input', () => {
      // Blank means "unchanged", not "delete the key" — clearing a key on every
      // save would be a very expensive way to fix a typo in the label.
      row.apiKey = keyInput.value === '' ? undefined : keyInput.value;
      row.probe = null;
      markDirty();
    });
    card.appendChild(labelled('API key', keyInput, 'Stored in the database. Sent to this provider only.'));

    /* -- model ------------------------------------------------------------- */
    const modelWrap = elem('div', 'llmset-modelRow');

    let modelControl;
    if (row.manual || !row.models.length) {
      modelControl = field('text', row.model, 'model id');
      modelControl.addEventListener('input', () => { row.model = modelControl.value.trim(); markDirty(); });
    } else {
      modelControl = elem('select', 'llmset-input');
      const options = [...new Set([row.model, ...row.models].filter(Boolean))];
      for (const id of options) {
        const opt = elem('option', null, id);
        opt.value = id;
        if (id === row.model) opt.selected = true;
        modelControl.appendChild(opt);
      }
      modelControl.addEventListener('change', () => { row.model = modelControl.value; markDirty(); });
    }
    modelControl.classList.add('llmset-input');

    const fetchBtn = elem('button', 'small', 'Fetch models');
    fetchBtn.type = 'button';
    fetchBtn.addEventListener('click', () => loadModels(row, fetchBtn));

    const manualBtn = iconBtn(row.manual ? '☰' : '✎', row.manual ? 'Pick from the fetched list' : 'Type a model id by hand');
    manualBtn.disabled = !row.models.length;
    manualBtn.addEventListener('click', () => { row.manual = !row.manual; render(); });

    const testBtn = elem('button', 'small', 'Test');
    testBtn.type = 'button';
    testBtn.title = 'Check this endpoint answers and serves the chosen model';
    testBtn.addEventListener('click', () => testProvider(row, testBtn));

    modelWrap.append(modelControl, fetchBtn, manualBtn, testBtn);
    card.appendChild(labelled('Model', modelWrap,
      isMain
        ? 'What the app sends by default. The thread picker can override it.'
        : 'This fallback answers with its own model — the main model id usually does not exist here.'));

    if (row.probe) {
      const probe = elem('div', `llmset-probe ${row.probe.ok ? 'ok' : 'bad'}`, row.probe.text);
      card.appendChild(probe);
    }

    return card;
  }

  /* ------------------------------------------------------------- behaviours */

  const markDirty = () => { dirty = true; saveBtn.textContent = 'Save •'; };

  function swap(a, b) {
    if (b < 0 || b >= rows.length) return;
    [rows[a], rows[b]] = [rows[b], rows[a]];
    markDirty();
    render();
  }

  async function loadModels(row, btn) {
    if (!row.apiUrl) { row.probe = { ok: false, text: 'Set an API URL first.' }; render(); return; }
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const { models } = await post(`${apiPath}/models`, {
        apiUrl: row.apiUrl,
        apiKey: row.apiKey,          // undefined → the server uses the stored key
        id: row.id ?? undefined,
      });
      row.models = models;
      row.manual = false;
      if (!row.model && models.length) { row.model = models[0]; markDirty(); }
      row.probe = models.length
        ? { ok: true, text: `${models.length} model${models.length === 1 ? '' : 's'} available` }
        : { ok: false, text: 'Endpoint answered but advertises no models — type the id by hand.' };
    } catch (err) {
      row.models = [];
      row.probe = { ok: false, text: err.message };
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      render();
    }
  }

  async function testProvider(row, btn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try {
      // A saved provider is tested through its stored key; an unsaved one is
      // probed with what is on screen, so a chain can be verified before saving.
      const result = row.id != null
        ? await post(`${apiPath}/providers/${row.id}/test`, {})
        : await post(`${apiPath}/models`, { apiUrl: row.apiUrl, apiKey: row.apiKey }).then((r) => ({
          ok: true, models: r.models, modelServed: row.model ? r.models.includes(row.model) : null,
        })).catch((err) => ({ ok: false, error: err.message, models: [] }));

      if (!result.ok) {
        row.probe = { ok: false, text: result.error };
      } else if (row.model && result.modelServed === false) {
        row.probe = { ok: false, text: `Reachable, but it does not serve "${row.model}" — pick one it lists.` };
      } else {
        row.probe = { ok: true, text: `Reachable · ${result.models.length} models${result.ms ? ` · ${result.ms}ms` : ''}` };
      }
      if (result.models?.length) row.models = result.models;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      render();
    }
  }

  addBtn.addEventListener('click', () => {
    rows.push({
      id: null, label: '', apiUrl: '', apiKey: undefined, keyMask: '', hasApiKey: false,
      model: '', enabled: true, models: [], manual: true, probe: null,
    });
    markDirty();
    render();
  });

  saveBtn.addEventListener('click', async () => {
    const bad = rows.findIndex((r) => !r.apiUrl);
    if (bad !== -1) {
      setStatus(`Provider ${bad + 1} has no API URL.`, 'bad');
      return;
    }

    saveBtn.disabled = true;
    setStatus('saving…');
    try {
      const payload = {
        llm_providers: rows.map((r) => ({
          id: r.id ?? undefined,
          label: r.label || null,
          apiUrl: r.apiUrl,
          // Omitted entirely when unchanged, so the stored key survives a save.
          ...(r.apiKey === undefined ? {} : { apiKey: r.apiKey }),
          model: r.model || null,
          enabled: r.enabled,
        })),
      };
      const saved = await post(`${apiPath}/providers`, payload);
      dirty = false;
      setStatus(`Saved · ${saved.llm_providers.length} provider(s)`, 'ok');
      document.dispatchEvent(new CustomEvent('llm-settings:saved', { detail: saved }));
      await load();
    } catch (err) {
      setStatus(err.message, 'bad');
    } finally {
      saveBtn.disabled = false;
    }
  });

  closeBtn.addEventListener('click', () => {
    // Unsaved edits are easy to make here and expensive to redo, so leaving with
    // them pending asks first — this is the only prompt the screen shows.
    if (dirty) { discard.classList.remove('hidden'); discardNo.focus(); return; }
    close();
  });
  discardYes.addEventListener('click', () => { discard.classList.add('hidden'); close(); });
  discardNo.addEventListener('click', () => discard.classList.add('hidden'));

  function open() {
    overlay.classList.remove('hidden');
    discard.classList.add('hidden');
    load();
  }
  const close = () => overlay.classList.add('hidden');

  return { overlay, open, close, load };
}

/* ---------------------------------------------------------------- controls */

function field(type, value, placeholder) {
  const input = elem('input', 'llmset-input');
  input.type = type;
  input.value = value ?? '';
  input.placeholder = placeholder ?? '';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  return input;
}

function labelled(text, control, hint) {
  const wrap = elem('label', 'llmset-field');
  wrap.appendChild(elem('span', 'llmset-fieldLbl', text));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(elem('span', 'llmset-hint', hint));
  return wrap;
}

function iconBtn(glyph, title) {
  const btn = elem('button', 'llmset-icon', glyph);
  btn.type = 'button';
  btn.title = title;
  return btn;
}
