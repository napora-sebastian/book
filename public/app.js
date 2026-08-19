const $ = (id) => document.getElementById(id);
const el = {
  docPick: $('docPick'), file: $('file'), upload: $('upload'), newThread: $('newThread'),
  renameDoc: $('renameDoc'), docMeta: $('docMeta'), threads: $('threads'), dbStats: $('dbStats'),
  threadTitle: $('threadTitle'), threadDoc: $('threadDoc'), model: $('model'),
  renameThread: $('renameThread'), deleteThread: $('deleteThread'), status: $('status'),
  transcript: $('transcript'), stage: $('stage'), composer: $('composer'),
  task: $('task'), input: $('input'), send: $('send'), stop: $('stop'),
  threadUsage: $('threadUsage'), traces: $('traces'), overlay: $('overlay'),
  sheetTitle: $('sheetTitle'), traceScope: $('traceScope'), closeSheet: $('closeSheet'),
  totals: $('totals'), traceList: $('traceList'),
  savedResponses: $('savedResponses'), savedOverlay: $('savedOverlay'), savedList: $('savedList'),
  useSavedResponses: $('useSavedResponses'), closeSavedSheet: $('closeSavedSheet'),
  sourcesBtn: $('sourcesBtn'), sourcesOverlay: $('sourcesOverlay'), sourcesTitle: $('sourcesTitle'),
  sourceList: $('sourceList'), saveSources: $('saveSources'), previewSources: $('previewSources'),
  closeSourcesSheet: $('closeSourcesSheet'), sourcesCost: $('sourcesCost'),
  groundTruthOverlay: $('groundTruthOverlay'), groundTruthList: $('groundTruthList'),
  closeGroundTruthSheet: $('closeGroundTruthSheet'),
  replaceDoc: $('replaceDoc'), replaceFile: $('replaceFile'), docVersions: $('docVersions'),
  versionsOverlay: $('versionsOverlay'), versionsTitle: $('versionsTitle'),
  closeVersionsSheet: $('closeVersionsSheet'), versionList: $('versionList'),
  diffFrom: $('diffFrom'), diffTo: $('diffTo'), diffStat: $('diffStat'), diffView: $('diffView'),
  backToPreview: $('backToPreview'), versionsEdit: $('versionsEdit'),
  copyOldVersion: $('copyOldVersion'), copyNewVersion: $('copyNewVersion'),
  dlOldPdf: $('dlOldPdf'), dlNewPdf: $('dlNewPdf'),
  dlOldDocx: $('dlOldDocx'), dlNewDocx: $('dlNewDocx'),
  dlOldRtf: $('dlOldRtf'), dlNewRtf: $('dlNewRtf'),
  exportOldLabel: $('exportOldLabel'), exportNewLabel: $('exportNewLabel'),
  exportOldHint: $('exportOldHint'), exportNewHint: $('exportNewHint'),
  previewDoc: $('previewDoc'), previewOverlay: $('previewOverlay'), previewTitle: $('previewTitle'),
  previewBody: $('previewBody'), closePreviewSheet: $('closePreviewSheet'),
  previewEdit: $('previewEdit'), previewSave: $('previewSave'),
  previewCancel: $('previewCancel'), previewDirty: $('previewDirty'),
  removeDoc: $('removeDoc'), removeOverlay: $('removeOverlay'), removeWhat: $('removeWhat'),
  removeConfirm: $('removeConfirm'), removeError: $('removeError'),
  confirmRemove: $('confirmRemove'), cancelRemove: $('cancelRemove'),
  closeRemoveSheet: $('closeRemoveSheet'),
  promptOverlay: $('promptOverlay'), promptTitle: $('promptTitle'), promptLbl: $('promptLbl'),
  promptInput: $('promptInput'), confirmPrompt: $('confirmPrompt'), cancelPrompt: $('cancelPrompt'),
  closePromptSheet: $('closePromptSheet'),
  askOverlay: $('askOverlay'), askTitle: $('askTitle'), askWhat: $('askWhat'),
  confirmAsk: $('confirmAsk'), cancelAsk: $('cancelAsk'), closeAskSheet: $('closeAskSheet'),
  versionRemoveOverlay: $('versionRemoveOverlay'), versionRemoveWhat: $('versionRemoveWhat'),
  versionRemoveConfirm: $('versionRemoveConfirm'), versionRemoveError: $('versionRemoveError'),
  confirmVersionRemove: $('confirmVersionRemove'), cancelVersionRemove: $('cancelVersionRemove'),
  closeVersionRemoveSheet: $('closeVersionRemoveSheet'),
};

const fmtTok = (n) => (n == null ? '—' : n.toLocaleString());

let cfg = null;
let currentThreadId = null;
let controller = null;
let docCache = [];

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};
const jsonPost = (url, body, method = 'POST') => api(url, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const fmtBytes = (n) =>
  !n ? '' : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const fmtWhen = (iso) => {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const mins = (Date.now() - d) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString();
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------- snackbars */

let snackbarTimer = null;

/**
 * Show a transient toast at the bottom-center of the viewport.
 *
 * `action` — `{ label, onClick }` — turns the toast into the one place the user
 * can act on what just happened ("Rewrite saved as v5" → "See the version").
 * A toast carrying an action stays up longer, because it is now something to
 * read *and* decide about rather than a notice to glance at.
 */
function showSnackbar(message, type = 'success', action = null) {
  document.querySelectorAll('.snackbar').forEach((n) => n.remove());
  clearTimeout(snackbarTimer);

  const bar = document.createElement('div');
  bar.className = `snackbar ${type}${action ? ' withAction' : ''}`;

  const text = document.createElement('span');
  text.className = 'snackText';
  text.textContent = message;
  bar.appendChild(text);

  const dismiss = () => {
    clearTimeout(snackbarTimer);
    bar.classList.remove('show');
    setTimeout(() => bar.remove(), 250);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'snackAction';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { dismiss(); action.onClick(); });
    bar.appendChild(btn);
  }

  document.body.appendChild(bar);

  // Force a reflow so the enter transition plays.
  requestAnimationFrame(() => bar.classList.add('show'));

  snackbarTimer = setTimeout(dismiss, action ? 9000 : 3200);
}

/* --------------------------------------------------------------- ask dialogs */

/**
 * Styled stands-in for prompt() and confirm(). A browser dialog is the one
 * surface no stylesheet can reach — it arrives in the OS's font, ignores the
 * app's colours, and blocks the page while it sits there.
 *
 * Both follow the app's modal convention: they close through their own buttons
 * only, never on Esc or a backdrop click.
 */
function askText({ title, label, value = '', confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    el.promptTitle.textContent = title;
    el.promptLbl.textContent = label;
    el.confirmPrompt.textContent = confirmLabel;
    el.promptInput.value = value;
    el.confirmPrompt.disabled = !value.trim();
    el.promptOverlay.classList.remove('hidden');
    el.promptInput.focus();
    el.promptInput.select();

    const done = (result) => {
      el.promptOverlay.classList.add('hidden');
      el.confirmPrompt.removeEventListener('click', ok);
      el.cancelPrompt.removeEventListener('click', no);
      el.closePromptSheet.removeEventListener('click', no);
      el.promptInput.removeEventListener('keydown', key);
      el.promptInput.removeEventListener('input', typed);
      resolve(result);
    };
    const ok = () => { const v = el.promptInput.value.trim(); if (v) done(v); };
    const no = () => done(null);
    const key = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    const typed = () => { el.confirmPrompt.disabled = !el.promptInput.value.trim(); };

    el.confirmPrompt.addEventListener('click', ok);
    el.cancelPrompt.addEventListener('click', no);
    el.closePromptSheet.addEventListener('click', no);
    el.promptInput.addEventListener('keydown', key);
    el.promptInput.addEventListener('input', typed);
  });
}

function askConfirm({ title, body, confirmLabel = 'Delete', destructive = true }) {
  return new Promise((resolve) => {
    el.askTitle.textContent = title;
    el.askWhat.textContent = body;
    el.confirmAsk.textContent = confirmLabel;
    el.confirmAsk.className = destructive ? 'destructive' : 'primary';
    el.askOverlay.classList.remove('hidden');
    el.confirmAsk.focus();

    const done = (result) => {
      el.askOverlay.classList.add('hidden');
      el.confirmAsk.removeEventListener('click', ok);
      el.cancelAsk.removeEventListener('click', no);
      el.closeAskSheet.removeEventListener('click', no);
      resolve(result);
    };
    const ok = () => done(true);
    const no = () => done(false);

    el.confirmAsk.addEventListener('click', ok);
    el.cancelAsk.addEventListener('click', no);
    el.closeAskSheet.addEventListener('click', no);
  });
}

/* ----------------------------------------------------------------- bootstrap */

cfg = await api('/api/config');

el.task.innerHTML =
  '<option value="chat">Chat</option>' +
  cfg.tasks.filter((t) => t.instruction).map((t) => `<option value="${t.id}">${t.label}</option>`).join('');

/** Model list, also used by the picker the edit box carries. */
const modelOptions = (selected) => (cfg.models.length ? cfg.models : [cfg.model])
  .map((m) => `<option value="${m}"${m === selected ? ' selected' : ''}>${m}</option>`).join('');

el.model.innerHTML = modelOptions(cfg.model);

showProviderStatus();

/**
 * The status pill names the provider that will answer. With the main one down
 * but a fallback reachable, it says so rather than reading as "nothing works" —
 * the app is still usable in that state, which is the whole point of the chain.
 */
function showProviderStatus() {
  if (cfg.reachable) {
    el.status.className = 'status ok';
    el.status.textContent = new URL(cfg.baseUrl).host
      + (cfg.fallbacks?.length ? ` +${cfg.fallbacks.length}` : '')
      + (cfg.providerSource === 'env' ? ' · .env' : '');
    el.status.title = [
      `main: ${cfg.provider?.label || cfg.baseUrl} · ${cfg.model}`,
      ...(cfg.fallbacks || []).map((f, i) => `fallback ${i + 1}: ${f.label} · ${f.model || 'default model'}`),
      cfg.providerSource === 'env' ? 'from .env — open ⚙ LLM to save providers in the database' : '',
    ].filter(Boolean).join('\n');
    return;
  }

  el.status.className = 'status bad';
  el.status.textContent = cfg.providerSource === 'none'
    ? 'no provider — open ⚙ LLM'
    : cfg.fallbackReady
      ? `main down — ${cfg.fallbackReady.label} answering`
      : `unreachable — ${cfg.baseUrl}`;
  el.status.title = cfg.error || '';
}

// The plugin fires this after the provider chain is saved. Everything the app
// shows about models comes from /api/config, so it simply re-reads it.
document.addEventListener('llm-settings:saved', async () => {
  cfg = await api('/api/config');
  el.model.innerHTML = modelOptions(cfg.model);
  showProviderStatus();
  el.stage.classList.remove('error');
  el.stage.textContent = `LLM providers saved — ${cfg.provider?.label || cfg.baseUrl} is now the main provider`;
});

renderStats(cfg.stats);
await refreshDocuments();
await refreshThreads();

// Deep link from the Grimoire view: /#thread=12 opens that conversation here.
const deepLink = /^#thread=(\d+)$/.exec(location.hash);
if (deepLink) await openThread(Number(deepLink[1])).catch(() => { location.hash = ''; });

/* ----------------------------------------------------------------- documents */

async function refreshDocuments(selectId) {
  docCache = await api('/api/documents');
  el.docPick.innerHTML =
    '<option value="">— no document (plain chat) —</option>' +
    docCache.map((d) => {
      const bits = [d.pages ? `${d.pages}p` : null, `~${d.estTokens.toLocaleString()} tok`]
        .filter(Boolean).join(' · ');
      return `<option value="${d.id}">${escapeHtml(d.filename)} (${bits})</option>`;
    }).join('');

  if (selectId) el.docPick.value = String(selectId);
  showDocMeta(docCache.find((d) => String(d.id) === el.docPick.value));
}

function showDocMeta(doc) {
  el.renameDoc.disabled = !doc;
  el.replaceDoc.disabled = !doc;
  el.docVersions.disabled = !doc;
  el.previewDoc.disabled = !doc;
  el.removeDoc.disabled = !doc;
  el.docMeta.classList.remove('error');
  if (!doc) { el.docMeta.textContent = ''; return; }
  el.docMeta.textContent = [
    doc.kind?.toUpperCase(),
    doc.pages ? `${doc.pages} pages` : null,
    `${doc.words?.toLocaleString() ?? '?'} words`,
    `~${doc.estTokens.toLocaleString()} tokens`,
    fmtBytes(doc.bytes),
    doc.version > 1 ? `v${doc.version}` : null,
    doc.thread_count ? `${doc.thread_count} thread(s)` : null,
  ].filter(Boolean).join(' · ');
}

/** Header line: what the open thread will actually send to the cluster. */
function showThreadDoc(thread) {
  el.threadDoc.textContent = thread.filename
    ? `${thread.filename} · ${thread.doc_pages ? thread.doc_pages + ' pages · ' : ''}~${Math.ceil(thread.doc_chars / 3.6).toLocaleString()} tokens`
    : 'no document attached';
}

// With a thread open the picker rebinds that thread, rather than silently
// seeding only the next one — picking your book and getting answers that never
// saw it was the single most confusing thing this app did.
el.docPick.addEventListener('change', async () => {
  showDocMeta(docCache.find((d) => String(d.id) === el.docPick.value));
  if (!currentThreadId) return;

  const documentId = el.docPick.value ? Number(el.docPick.value) : null;
  const thread = await jsonPost(`/api/threads/${currentThreadId}`, { documentId }, 'PATCH');
  showThreadDoc(thread);
  el.stage.classList.remove('error');
  el.stage.textContent = thread.filename
    ? `${thread.filename} attached — the next turn sends it in full`
    : 'document detached — following turns are plain chat';
  await refreshThreads();
});

el.renameDoc.addEventListener('click', async () => {
  const doc = docCache.find((d) => String(d.id) === el.docPick.value);
  if (!doc) return;

  const filename = await askText({
    title: 'Rename document',
    label: 'Document name',
    value: doc.filename,
    confirmLabel: 'Rename',
  });
  if (!filename) return;

  try {
    await jsonPost(`/api/documents/${doc.id}`, { filename }, 'PATCH');
    await refreshDocuments(doc.id);
    await refreshThreads();
  } catch (err) {
    showSnackbar(err.message, 'error');
  }
});

el.upload.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', async () => {
  const file = el.file.files[0];
  if (!file) return;
  el.docMeta.classList.remove('error');
  el.docMeta.textContent = `extracting ${file.name}…`;

  const body = new FormData();
  body.append('file', file);
  try {
    const doc = await api('/api/documents', { method: 'POST', body });
    await refreshDocuments(doc.id);
    if (doc.reused) el.docMeta.textContent += ' · already in library, reused';
    if (doc.warnings?.length) el.docMeta.textContent += ` · ⚠ ${doc.warnings.join('; ')}`;
  } catch (err) {
    el.docMeta.classList.add('error');
    el.docMeta.textContent = err.message;
  } finally {
    el.file.value = '';
  }
});

/* ------------------------------------------- replacing a document's content */

// A re-upload keeps the library entry and its threads, and files the outgoing
// text as a version — so "I fixed chapter 3 and re-exported the PDF" stays one
// document with a history, not two entries with the same name.
el.replaceDoc.addEventListener('click', () => el.replaceFile.click());
el.replaceFile.addEventListener('change', async () => {
  const file = el.replaceFile.files[0];
  const doc = docCache.find((d) => String(d.id) === el.docPick.value);
  if (!file || !doc) return;

  el.docMeta.classList.remove('error');
  el.docMeta.textContent = `replacing with ${file.name}…`;

  const body = new FormData();
  body.append('file', file);
  try {
    const updated = await api(`/api/documents/${doc.id}/replace`, { method: 'POST', body });
    await refreshDocuments(doc.id);
    await refreshThreads();

    if (updated.warnings?.length) el.docMeta.textContent += ` · ⚠ ${updated.warnings.join('; ')}`;
    if (updated.identical) {
      // The file was still taken — new bytes, maybe a new kind — so the version
      // is real; there is just nothing to look at in the diff.
      el.docMeta.textContent += ` · filed as v${updated.version}, text identical to the previous version`;
      return;
    }
    // The point of replacing is seeing what moved, so go straight to the diff.
    openVersions(doc.id);
  } catch (err) {
    el.docMeta.classList.add('error');
    el.docMeta.textContent = err.message;
  } finally {
    el.replaceFile.value = '';
  }
});

/* ---------------------------------------------------------- version history */

el.docVersions.addEventListener('click', () => {
  const doc = docCache.find((d) => String(d.id) === el.docPick.value);
  if (doc) openVersions(doc.id);
});
el.closeVersionsSheet.addEventListener('click', closeVersions);
el.diffFrom.addEventListener('change', loadDiff);
el.diffTo.addEventListener('change', loadDiff);
document.querySelectorAll('input[name="diffMode"]').forEach((r) =>
  r.addEventListener('change', loadDiff));
// Ctrl+select a passage in the diff → rewrite it in the changed version.
el.diffView.addEventListener('mouseup', onSelectRewrite);

let versionsDocId = null;
let versionsCache = [];   // version rows for the open document
let diffFromV = 0;        // currently compared versions, for the toolbar
let diffToV = 1;

const versionsOpen = () => !el.versionsOverlay.classList.contains('hidden');

async function openVersions(documentId) {
  versionsDocId = documentId;
  el.versionsOverlay.classList.remove('hidden');
  el.diffView.innerHTML = '<div class="diffEmpty">loading…</div>';
  el.diffStat.textContent = '';
  await loadVersions();
}

function closeVersions() {
  el.versionsOverlay.classList.add('hidden');
  setPreviewReturn(null);
}

/**
 * (Re)build the history rail and the two pickers from the server's list.
 *
 * Called on open and again every time a version is filed or deleted while the
 * modal stays open: the rail is the record of what just happened, so it has to
 * show it without a close-and-reopen. `focus` decides where that leaves the
 * comparison — 'newest' jumps to the change that just landed, 'keep' holds the
 * pair the user was reading (falling back to the newest if it has gone).
 */
async function loadVersions({ focus = 'newest' } = {}) {
  if (versionsDocId == null) return;

  const held = { from: el.diffFrom.value, to: el.diffTo.value };

  const { filename, versions } = await api(`/api/documents/${versionsDocId}/versions`);
  versionsCache = versions;
  el.versionsTitle.textContent = `Versions · ${filename}`;

  const newest = versions[0].version;
  el.versionList.innerHTML = versions.map((v) => `
    <div class="versionRow${v.version === newest ? ' active' : ''}" data-version="${v.version}">
      <div class="v">v${v.version}${v.version === newest ? '<span class="tag">current</span>' : ''}</div>
      <div class="s">${versionStat(v)}</div>
      <div class="s">${v.pages ? `${v.pages}p · ` : ''}${(v.words ?? 0).toLocaleString()} words · ${fmtWhen(v.created_at)}</div>
      <button class="versionTrash" title="Remove version v${v.version}" aria-label="Remove version v${v.version}" data-version="${v.version}">🗑</button>
    </div>`).join('');

  el.versionList.querySelectorAll('.versionRow').forEach((row) => {
    // Picking a version shows what that save changed — the diff against the
    // one before it, which is the question anyone clicking a history asks.
    row.addEventListener('click', (e) => {
      if (e.target.closest('.versionTrash')) return;
      const v = Number(row.dataset.version);
      el.diffTo.value = String(v);
      el.diffFrom.value = String(v - 1);
      loadDiff();
    });
  });

  el.versionList.querySelectorAll('.versionTrash').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openVersionRemove(Number(btn.dataset.version));
    });
  });

  const label = (v) => `v${v.version} · ${fmtWhen(v.created_at)}`;
  const options = versions.map((v) => `<option value="${v.version}">${label(v)}</option>`).join('');
  el.diffFrom.innerHTML = options + '<option value="0">nothing (before the first version)</option>';
  el.diffTo.innerHTML = options;

  const has = (sel, value) => [...sel.options].some((o) => o.value === value);
  const keep = focus === 'keep' && has(el.diffTo, held.to) && has(el.diffFrom, held.from);
  el.diffTo.value = keep ? held.to : String(newest);
  el.diffFrom.value = keep ? held.from : String(newest - 1);

  await loadDiff();
}

/**
 * A version was just filed for `documentId`. If its history is on screen, the
 * new entry belongs there now — the user filed it seconds ago and is looking
 * straight at the list it is missing from.
 */
async function versionFiled(documentId) {
  if (!versionsOpen() || versionsDocId !== documentId) return;
  await loadVersions({ focus: 'newest' });
}

/* --------------------------------------------- preview ⇄ versions round trip */

// Set while the versions modal was reached from an open preview, so the way
// back is one click rather than close-reopen-scroll-to-where-I-was.
let previewReturn = null;

function setPreviewReturn(state) {
  previewReturn = state;
  el.backToPreview.classList.toggle('hidden', !state);
}

/** Leave the preview for the version that was just filed from it. */
async function openVersionsFromPreview(documentId) {
  // Both are full-screen overlays; the preview has to stand down or it paints
  // over the diff it just sent the user to.
  el.previewOverlay.classList.add('hidden');
  setPreviewReturn({ docId: documentId });
  await openVersions(documentId);
}

el.backToPreview.addEventListener('click', async () => {
  const back = previewReturn;
  setPreviewReturn(null);
  el.versionsOverlay.classList.add('hidden');
  if (!back) return;

  // The preview still holds the text as the rewrite left it — including the
  // patched passage — so restoring it beats re-fetching the stored document.
  if (previewDocId === back.docId) {
    el.previewOverlay.classList.remove('hidden');
    return;
  }
  const doc = docCache.find((d) => d.id === back.docId);
  if (doc) await openPreview(doc);
});

const versionStat = (v) => v.additions == null && v.deletions == null
  ? 'original upload'
  : `<span class="add">+${v.additions ?? 0}</span> <span class="del">−${v.deletions ?? 0}</span>`;

async function loadDiff() {
  if (versionsDocId == null) return;
  const from = Number(el.diffFrom.value);
  const to = Number(el.diffTo.value);
  diffFromV = from;
  diffToV = to;

  el.versionList.querySelectorAll('.versionRow').forEach((row) =>
    row.classList.toggle('active', row.dataset.version === String(to)));

  el.diffView.innerHTML = '<div class="diffEmpty">loading…</div>';
  try {
    const diff = await api(`/api/documents/${versionsDocId}/diff?from=${from}&to=${to}`);
    el.diffStat.innerHTML = `<span class="add">+${diff.additions}</span> <span class="del">−${diff.deletions}</span>`;
    const mode = document.querySelector('input[name="diffMode"]:checked')?.value || 'split';
    el.diffView.innerHTML = mode === 'split' ? renderSplitDiff(diff) : renderDiff(diff);
  } catch (err) {
    el.diffStat.textContent = '';
    el.diffView.innerHTML = `<div class="diffEmpty">${escapeHtml(err.message)}</div>`;
  } finally {
    syncExportLabels();
  }
}

/* ------------------------------------------------------- version toolbar */

/**
 * Every export button names the version it produces and sits on the side of
 * the bar whose column it belongs to — "⇩ DOCX" twice over is a coin toss, and
 * a download is the wrong place to find out you guessed wrong.
 */
function syncExportLabels() {
  const newest = versionsCache[0]?.version;
  const split = (document.querySelector('input[name="diffMode"]:checked')?.value || 'split') === 'split';

  const label = (v) => v === 0
    ? 'nothing'
    : `v${v}${v === newest ? ' · current' : ''}`;

  el.exportOldLabel.textContent = label(diffFromV);
  el.exportNewLabel.textContent = label(diffToV);
  el.exportOldHint.textContent = split ? 'left column' : 'before';
  el.exportNewHint.textContent = split ? 'right column' : 'after';

  const wire = (btn, version, what) => {
    // from = 0 is the state before the first version: an empty side, with
    // nothing to copy or download. Say so rather than serve an empty file.
    const empty = version === 0;
    btn.disabled = empty;
    btn.title = empty
      ? 'Nothing to export — this side is the state before the first version'
      : what(label(version));
  };

  wire(el.copyOldVersion, diffFromV, (v) => `Copy the full text of ${v} to the clipboard`);
  wire(el.copyNewVersion, diffToV, (v) => `Copy the full text of ${v} to the clipboard`);
  wire(el.dlOldPdf, diffFromV, (v) => `Print ${v} as a PDF`);
  wire(el.dlNewPdf, diffToV, (v) => `Print ${v} as a PDF`);
  wire(el.dlOldDocx, diffFromV, (v) => `Download ${v} as a Word document`);
  wire(el.dlNewDocx, diffToV, (v) => `Download ${v} as a Word document`);
  wire(el.dlOldRtf, diffFromV, (v) => `Download ${v} as RTF`);
  wire(el.dlNewRtf, diffToV, (v) => `Download ${v} as RTF`);
}

/** The version text for the toolbar's copy/download buttons. */
async function versionText(version) {
  // Version 0 is "before the first version" — an empty document, which is how
  // the diff renders it too. Its buttons are disabled; this is the backstop.
  if (version === 0) return '';
  const res = await fetch(`/api/documents/${versionsDocId}/versions/${version}/text`);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.text();
}

const versionLabel = (v) => v === 0 ? 'nothing' : `v${v}`;

el.copyOldVersion.addEventListener('click', async () => {
  try {
    await copyText(await versionText(diffFromV));
    flashBtn(el.copyOldVersion, '✓ Copied');
  } catch (err) { showSnackbar(err.message, 'error'); }
});
el.copyNewVersion.addEventListener('click', async () => {
  try {
    await copyText(await versionText(diffToV));
    flashBtn(el.copyNewVersion, '✓ Copied');
  } catch (err) { showSnackbar(err.message, 'error'); }
});

const flashBtn = (btn, text) => {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
};

/** Open a version's text in a print dialog (browser-native PDF export). */
async function downloadVersionPdf(version) {
  try {
    const text = await versionText(version);
    const win = window.open('', '_blank');
    if (!win) return;
    const title = `${el.versionsTitle.textContent.replace('Versions · ', '')} — ${versionLabel(version)}`;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.6 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif; color: #14171c; padding: 32px; max-width: 720px; margin: 0 auto; }
  .who { color: #6b7280; font-size: 12px; margin-bottom: 12px; }
  .body { white-space: pre-wrap; word-wrap: break-word; }
</style></head><body>
<div class="who">${escapeHtml(title)}</div>
<div class="body">${escapeHtml(text)}</div>
</body></html>`);
    win.document.close();
    win.focus();
    win.print();
  } catch (err) { showSnackbar(err.message, 'error'); }
}

const dlVersion = (version, ext) => {
  const a = document.createElement('a');
  a.href = `/api/documents/${versionsDocId}/versions/${version}/${ext}`;
  a.click();
};

el.dlOldPdf.addEventListener('click', () => downloadVersionPdf(diffFromV));
el.dlNewPdf.addEventListener('click', () => downloadVersionPdf(diffToV));
el.dlOldDocx.addEventListener('click', () => dlVersion(diffFromV, 'docx'));
el.dlNewDocx.addEventListener('click', () => dlVersion(diffToV, 'docx'));
el.dlOldRtf.addEventListener('click', () => dlVersion(diffFromV, 'rtf'));
el.dlNewRtf.addEventListener('click', () => dlVersion(diffToV, 'rtf'));

/* ---------------------------------------------------------------- preview */

el.previewDoc.addEventListener('click', () => {
  const doc = docCache.find((d) => String(d.id) === el.docPick.value);
  if (doc) openPreview(doc);
});
el.closePreviewSheet.addEventListener('click', async () => {
  if (!(await confirmLeavingEdit())) return;
  el.previewOverlay.classList.add('hidden');
  exitPreviewEdit();
  previewDocId = null;
});

// Which document the preview currently holds, so a return trip from the
// versions modal can restore it instead of rebuilding it.
let previewDocId = null;

/**
 * Show the document's content in a modal. PDFs embed the stored bytes in an
 * <iframe> (the browser's own viewer); docx and text render the extracted text
 * as a scrollable pre. The preview button is enabled whenever a doc is picked.
 */
async function openPreview(doc) {
  previewDocId = doc.id;
  previewKind = doc.kind;
  el.previewOverlay.classList.remove('hidden');
  el.previewTitle.textContent = `Preview · ${doc.filename}`;
  el.previewBody.innerHTML = '<div class="diffEmpty">loading…</div>';
  exitPreviewEdit();

  if (doc.kind === 'pdf') {
    // The raw file route serves the exact bytes; the iframe hands off to the
    // browser's built-in PDF viewer, which is the only sane way to page a book.
    el.previewBody.innerHTML = `<iframe class="previewFrame" src="/api/documents/${doc.id}/file"></iframe>`;
    return;
  }

  try {
    const { text } = await api(`/api/documents/${doc.id}/text`);
    el.previewBody.innerHTML = `<pre class="previewText">${escapeHtml(text)}</pre>`;
    // Ctrl+select a passage → offer to have the model rewrite it in place.
    el.previewBody.querySelector('.previewText').addEventListener('mouseup', onSelectRewrite);
  } catch (err) {
    el.previewBody.innerHTML = `<div class="diffEmpty">${escapeHtml(err.message)}</div>`;
  }
}

/* ------------------------------------------------------- editing a document */

/*
 * Reading and correcting are two modes of one sheet rather than two dialogs.
 * The text the models answer from is the text on screen, so the place you
 * noticed the typo is the place you fix it — and the fix is filed as a version
 * like a re-upload or a model rewrite, so nothing changes silently underneath
 * the threads already reading this document.
 */

// The kind of the document the preview holds, so the editor knows whether it
// is correcting a text layer (pdf) or the document itself.
let previewKind = null;
let previewEditing = false;

function setPreviewEditing(on) {
  previewEditing = on;
  el.previewEdit.classList.toggle('hidden', on);
  el.previewSave.classList.toggle('hidden', !on);
  el.previewCancel.classList.toggle('hidden', !on);
  if (!on) el.previewDirty.classList.add('hidden');
}

/** Drop out of edit mode without touching what is on screen. */
function exitPreviewEdit() {
  if (previewEditing) setPreviewEditing(false);
  else el.previewDirty.classList.add('hidden');
}

const previewTextarea = () => el.previewBody.querySelector('.previewEdit');

/** True to continue — asks first when an unsaved edit would be thrown away. */
async function confirmLeavingEdit() {
  const box = previewTextarea();
  if (!previewEditing || !box || box.value === previewEditOriginal) return true;
  return askConfirm({
    title: 'Discard the edit?',
    body: 'The changes typed into this document have not been saved. They will be lost.',
    confirmLabel: 'Discard',
  });
}

// The text as it was when editing began, so "did anything change" is a
// comparison rather than a guess, and Cancel can put it back.
let previewEditOriginal = '';

/**
 * Put the preview into edit mode. `seed` is the text to start from — the stored
 * document by default, or an older version when the editor was opened from the
 * history rail, which makes "go back to v2 with these three fixes" one pass.
 */
async function beginPreviewEdit({ seed = null, seedLabel = null } = {}) {
  if (previewDocId == null) return;
  el.previewEdit.disabled = true;
  try {
    // With no seed, the stored text is re-read rather than lifted off the page:
    // a PDF's preview never held it, and a rewrite may have moved on from what
    // the preview was last drawn from.
    const text = seed ?? (await api(`/api/documents/${previewDocId}/text`)).text;
    previewEditOriginal = text;

    // Two things the editor must not let the user assume: that a PDF's pages
    // change with its text layer, and that editing an old version edits it in
    // place. Both are said here rather than discovered from the result.
    const notes = [];
    if (previewKind === 'pdf') {
      notes.push(`Editing the extracted text — the stored PDF pages stay as they were uploaded.
        This text is what every thread on this document is answered from.`);
    }
    if (seedLabel) notes.push(`Starting from ${seedLabel}. Saving files the result as the newest version.`);
    const note = notes.length ? `<p class="previewNote">${notes.map(escapeHtml).join(' ')}</p>` : '';

    el.previewBody.innerHTML =
      `${note}<textarea class="previewEdit" spellcheck="false"></textarea>`;
    const box = previewTextarea();
    box.value = text;
    box.addEventListener('input', () => {
      el.previewDirty.classList.toggle('hidden', box.value === previewEditOriginal);
    });
    box.focus();
    setPreviewEditing(true);
  } catch (err) {
    showSnackbar(err.message, 'error');
  } finally {
    el.previewEdit.disabled = false;
  }
}

el.previewEdit.addEventListener('click', () => beginPreviewEdit());

// The history rail's own way in: the version you are looking at, opened in the
// editor over the preview, so a diff is never a dead end you have to re-upload
// a file to act on.
el.versionsEdit.addEventListener('click', async () => {
  if (versionsDocId == null) return;
  const docId = versionsDocId;
  const version = diffToV;
  const newest = versionsCache[0]?.version;

  el.versionsEdit.disabled = true;
  try {
    const doc = docCache.find((d) => d.id === docId);
    if (!doc) return showSnackbar('That document is no longer in the library.', 'error');

    const seed = version && version !== newest ? await versionText(version) : null;
    setPreviewReturn({ docId });
    el.versionsOverlay.classList.add('hidden');
    await openPreview(doc);
    await beginPreviewEdit({ seed, seedLabel: seed ? `v${version}` : null });
  } catch (err) {
    showSnackbar(err.message, 'error');
  } finally {
    el.versionsEdit.disabled = false;
  }
});

el.previewCancel.addEventListener('click', async () => {
  if (!(await confirmLeavingEdit())) return;
  setPreviewEditing(false);
  const doc = docCache.find((d) => d.id === previewDocId);
  if (doc) await openPreview(doc);
});

el.previewSave.addEventListener('click', async () => {
  const box = previewTextarea();
  if (!box || previewDocId == null) return;
  const docId = previewDocId;

  el.previewSave.disabled = true;
  el.previewSave.textContent = 'Saving…';
  try {
    const saved = await saveDocumentText(docId, box.value);
    setPreviewEditing(false);
    const doc = docCache.find((d) => d.id === docId);
    if (doc) await openPreview(doc);

    if (saved.identical) {
      return showSnackbar(`Saved as v${saved.version} — the text is identical to the previous version.`);
    }
    showSnackbar(`Saved as v${saved.version} · +${saved.additions} −${saved.deletions}`, 'success', {
      label: 'See the diff',
      onClick: () => openVersionsFromPreview(docId),
    });
  } catch (err) {
    showSnackbar(err.message, 'error');
  } finally {
    el.previewSave.disabled = false;
    el.previewSave.textContent = 'Save as new version';
  }
});

/**
 * Commit edited text and put the rest of the console back in step: the library
 * row's char count, the thread list, and the version rail if it is open behind.
 */
async function saveDocumentText(docId, text) {
  const saved = await jsonPost(`/api/documents/${docId}/text`, { text }, 'PUT');
  await refreshDocuments(docId);
  await refreshThreads();
  await versionFiled(docId);
  return saved;
}

/* ------------------------------------------- Ctrl+select inline rewrite */

let rewritePopup = null;
// Where the current rewrite applies: { kind: 'preview', docId } or
// { kind: 'version', docId, version, root } — root is the element whose text
// the selection offsets are measured against.
let rewriteTarget = null;

/**
 * Ctrl+select: when the mouse button is released over a selection made while
 * Ctrl was held, offer to rewrite that exact passage. Works in the preview and
 * in the versions diff — the model's rewrite is spliced back at the same place
 * and filed as a new version.
 */
function onSelectRewrite(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text) return;

  // Determine the target: preview text, or a version's diff content.
  const pre = el.previewBody.querySelector('.previewText');
  const inPreview = pre && pre.contains(sel.anchorNode) && pre.contains(sel.focusNode);
  const inDiff = el.diffView.contains(sel.anchorNode) && el.diffView.contains(sel.focusNode);

  let target = null;
  if (inPreview) {
    target = {
      kind: 'preview',
      docId: docCache.find((d) => String(d.id) === el.docPick.value)?.id ?? null,
      root: pre,
    };
  } else if (inDiff && versionsDocId != null) {
    // Rewrite applies to the changed (to) version's text.
    target = {
      kind: 'version',
      docId: versionsDocId,
      version: diffToV,
      root: el.diffView,
    };
  }
  if (!target) return;

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  showRewritePopup(rect, text, target);
}

/** Small floating bar above the selection: rewrite, or cancel. */
function showRewritePopup(rect, passage, target) {
  hideRewritePopup();
  rewriteTarget = target;

  rewritePopup = document.createElement('div');
  rewritePopup.className = 'rewritePopup';

  const label = document.createElement('span');
  label.className = 'rewriteLbl';
  label.textContent = `Rewrite ${passage.length.toLocaleString()} chars?`;

  const input = document.createElement('input');
  input.className = 'rewriteInstr';
  input.placeholder = 'Optional instruction (e.g. "make it more dramatic")';
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); runRewrite(passage); }
  });

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'small primary';
  go.textContent = 'Rewrite';
  go.addEventListener('click', () => runRewrite(passage));

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'small dismiss';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', hideRewritePopup);

  rewritePopup.append(label, input, go, cancel);
  document.body.appendChild(rewritePopup);

  const r = rewritePopup.getBoundingClientRect();
  rewritePopup.style.left = `${Math.min(rect.left, window.innerWidth - r.width - 12)}px`;
  rewritePopup.style.top = `${Math.max(8, rect.top - r.height - 8)}px`;
  input.focus();
}

function hideRewritePopup() {
  rewritePopup?.remove();
  rewritePopup = null;
  rewriteTarget = null;
}

/** Call the model, then splice the rewritten passage back into the document. */
async function runRewrite(passage) {
  if (!rewritePopup || !rewriteTarget) return;
  // hideRewritePopup() clears rewriteTarget below, so hold on to it here —
  // everything after the splice needs to know which surface it came from.
  const target = rewriteTarget;
  const instr = rewritePopup.querySelector('.rewriteInstr')?.value.trim() || '';
  const go = rewritePopup.querySelector('button.primary');
  go.disabled = true;
  go.textContent = 'Rewriting…';

  try {
    const { rewritten } = await jsonPost('/api/rewrite', {
      passage,
      instruction: instr,
      model: el.model.value,
    });

    const { docId } = target;
    let next;

    if (target.kind === 'preview') {
      // Splice by DOM offset into the preview's raw text.
      const root = target.root;
      const sel = window.getSelection();
      const range = sel?.getRangeAt(0);
      if (!root || !range) return;
      const start = offsetOf(root, range.startContainer, range.startOffset);
      const end = offsetOf(root, range.endContainer, range.endOffset);
      const full = root.textContent;
      next = full.slice(0, start) + rewritten + full.slice(end);
      root.textContent = next;
      hideRewritePopup();
      sel.removeAllRanges();
      const r = document.createRange();
      r.setStart(root.firstChild, start);
      r.setEnd(root.firstChild, start + rewritten.length);
      sel.addRange(r);
    } else {
      // Version diff: the rendered table carries line numbers and marks, so
      // DOM offsets don't map to the raw text. Instead, replace the selected
      // passage string in the version's raw text and file a new version.
      const raw = await versionText(target.version);
      // The diff renders a leading +/− mark and line numbers; strip any that
      // leaked into the selection so it matches the raw version text.
      const clean = passage.replace(/^[+−]\s*/, '').trim();
      const idx = raw.indexOf(clean);
      if (idx === -1) {
        showSnackbar('Could not locate the selected passage in the version text.', 'error');
        return;
      }
      next = raw.slice(0, idx) + rewritten + raw.slice(idx + clean.length);
      hideRewritePopup();
    }

    // Persist as a new version so the change is reviewable in the diff.
    let saved = null;
    if (docId != null) {
      try {
        saved = await jsonPost(`/api/documents/${docId}/versions`, { text: next });
        await refreshDocuments(docId);
        await refreshThreads();
        // The rail is on screen for a diff rewrite, and may be behind the
        // preview for the other kind — either way it now has an entry missing.
        await versionFiled(docId);
      } catch { /* identical text — nothing to file */ }
    }

    const filed = saved ? `Rewrite saved as v${saved.version}.` : 'Rewrite saved as a new version.';

    // Rewriting from the preview leaves the change reviewable somewhere the
    // user cannot see, so the toast carries the way there.
    if (target.kind === 'preview' && saved && !versionsOpen()) {
      showSnackbar(filed, 'success', {
        label: 'See the version',
        onClick: () => openVersionsFromPreview(docId),
      });
    } else {
      showSnackbar(filed);
    }
  } catch (err) {
    showSnackbar(err.message, 'error');
  } finally {
    if (rewritePopup) {
      go.disabled = false;
      go.textContent = 'Rewrite';
    }
  }
}

/** Character offset of a text node/offset pair within a parent element. */
function offsetOf(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let cur;
  while ((cur = walker.nextNode())) {
    if (cur === node) return total + offset;
    total += cur.textContent.length;
  }
  return total;
}

/* --------------------------------------------------------- removing a document */

/** Typed exactly, the way AWS gates a bucket delete. Case matters. */
const REMOVE_WORD = 'REMOVE';

let removeDocId = null;

// Removal takes the document, its stored bytes and every filed version with it,
// and no other screen in the app can bring any of that back — so a one-key
// confirm() would be too cheap a gate. The word has to be typed out.
el.removeDoc.addEventListener('click', () => {
  const doc = docCache.find((d) => String(d.id) === el.docPick.value);
  if (!doc) return;
  removeDocId = doc.id;

  const alsoGone = doc.version > 1
    ? `, along with all ${doc.version} of its saved versions`
    : ', along with its extracted text and the uploaded file';
  const threads = doc.thread_count
    ? ` ${doc.thread_count} thread${doc.thread_count === 1 ? '' : 's'} built on it keep their messages but lose the document — every later turn there answers as plain chat.`
    : '';

  el.removeWhat.innerHTML =
    `<strong>${escapeHtml(doc.filename)}</strong> will be deleted permanently${alsoGone}.${threads}`;

  el.removeError.textContent = '';
  el.removeConfirm.value = '';
  el.confirmRemove.disabled = true;
  el.confirmRemove.textContent = 'Remove document';
  el.removeOverlay.classList.remove('hidden');
  el.removeConfirm.focus();
});

const closeRemove = () => {
  el.removeOverlay.classList.add('hidden');
  removeDocId = null;
};

el.closeRemoveSheet.addEventListener('click', closeRemove);
el.cancelRemove.addEventListener('click', closeRemove);

// Trailing whitespace is a typo, not a refusal to confirm; the wrong case is.
const removeArmed = () => el.removeConfirm.value.trim() === REMOVE_WORD;

el.removeConfirm.addEventListener('input', () => {
  el.confirmRemove.disabled = !removeArmed();
});
el.removeConfirm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && removeArmed()) el.confirmRemove.click();
});

el.confirmRemove.addEventListener('click', async () => {
  if (removeDocId == null || !removeArmed()) return;

  const id = removeDocId;
  const name = docCache.find((d) => d.id === id)?.filename ?? 'Document';

  el.removeError.textContent = '';
  el.confirmRemove.disabled = true;
  el.confirmRemove.textContent = 'Removing…';

  try {
    await api(`/api/documents/${id}`, { method: 'DELETE' });
  } catch (err) {
    el.removeError.textContent = err.message;
    el.confirmRemove.disabled = false;
    el.confirmRemove.textContent = 'Remove document';
    return;
  }

  closeRemove();
  await refreshDocuments();
  // The open thread may have just lost its document — reload it so the header
  // and the picker say so, instead of naming a file that no longer exists.
  if (currentThreadId) await openThread(currentThreadId);
  else await refreshThreads();
  renderStats((await api('/api/config')).stats);
  el.docMeta.textContent = `${name} removed from the library`;
});

/* --------------------------------------------------------- removing a version */

let versionRemoveDocId = null;
let versionRemoveNum = null;

function openVersionRemove(version) {
  if (versionsDocId == null) return;
  const v = versionsCache.find((x) => x.version === version);
  if (!v) return;

  versionRemoveDocId = versionsDocId;
  versionRemoveNum = version;

  const isCurrent = version === versionsCache[0].version;
  const rollback = isCurrent && versionsCache.length > 1
    ? ` The document will roll back to v${versionsCache[1].version}.`
    : '';

  el.versionRemoveWhat.innerHTML =
    `<strong>v${version}</strong> of <strong>${escapeHtml(el.versionsTitle.textContent.replace('Versions · ', ''))}</strong> will be deleted permanently.${rollback}`;

  el.versionRemoveError.textContent = '';
  el.versionRemoveConfirm.value = '';
  el.confirmVersionRemove.disabled = true;
  el.confirmVersionRemove.textContent = 'Remove version';
  el.versionRemoveOverlay.classList.remove('hidden');
  el.versionRemoveConfirm.focus();
}

const closeVersionRemove = () => {
  el.versionRemoveOverlay.classList.add('hidden');
  versionRemoveDocId = null;
  versionRemoveNum = null;
};

el.closeVersionRemoveSheet.addEventListener('click', closeVersionRemove);
el.cancelVersionRemove.addEventListener('click', closeVersionRemove);

const versionRemoveArmed = () => el.versionRemoveConfirm.value.trim() === REMOVE_WORD;

el.versionRemoveConfirm.addEventListener('input', () => {
  el.confirmVersionRemove.disabled = !versionRemoveArmed();
});
el.versionRemoveConfirm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && versionRemoveArmed()) el.confirmVersionRemove.click();
});

el.confirmVersionRemove.addEventListener('click', async () => {
  if (versionRemoveDocId == null || versionRemoveNum == null || !versionRemoveArmed()) return;

  const docId = versionRemoveDocId;
  const version = versionRemoveNum;

  el.versionRemoveError.textContent = '';
  el.confirmVersionRemove.disabled = true;
  el.confirmVersionRemove.textContent = 'Removing…';

  try {
    await api(`/api/documents/${docId}/versions/${version}`, { method: 'DELETE' });
  } catch (err) {
    el.versionRemoveError.textContent = err.message;
    el.confirmVersionRemove.disabled = false;
    el.confirmVersionRemove.textContent = 'Remove version';
    return;
  }

  closeVersionRemove();
  await openVersions(docId);
  await refreshDocuments();
  showSnackbar(`v${version} removed`);
});

/* ---------------------------------------------------------------- diff view */

/**
 * One diff, rendered the way GitHub renders one: a file header carrying the
 * +/− totals, `@@` hunk headers, both line numbers in their own gutters, and
 * the changed words marked inside otherwise-similar lines.
 *
 * Shared with the ground-truth sheet, which passes findings as hunks and turns
 * the gutters off — same visual grammar, one implementation.
 */
function renderDiff({ filename, additions, deletions, truncated, hunks, gutters = true, empty }) {
  if (!hunks.length) return `<div class="diffEmpty">${escapeHtml(empty || 'No changes between these versions.')}</div>`;

  const rows = hunks.map((h) => {
    const head = h.header
      ? `<tr class="dHunkHead"><td colspan="${gutters ? 3 : 1}">${escapeHtml(h.header)}</td></tr>`
      : '';
    return head + h.lines.map((l) => {
      const cls = l.type === 'add' ? 'dAdd' : l.type === 'del' ? 'dDel' : 'dCtx';
      const mark = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
      const gut = gutters
        ? `<td class="dLn">${l.oldLine ?? ''}</td><td class="dLn">${l.newLine ?? ''}</td>`
        : '';
      return `<tr class="${cls}">${gut}<td class="dCode"><span class="dMark">${mark}</span>${lineHtml(l)}</td></tr>`;
    }).join('');
  }).join('');

  return `
    <div class="diffFile">
      <div class="diffFileHead">
        <span class="diffFileName">${escapeHtml(filename ?? '')}</span>
        <span class="diffStat"><span class="add">+${additions ?? 0}</span> <span class="del">−${deletions ?? 0}</span></span>
      </div>
      ${truncated
        ? '<div class="diffNote">Too many changes to line up precisely — shown as a full replacement.</div>'
        : ''}
      <table class="diffTable${gutters ? '' : ' noGutter'}">${rows}</table>
    </div>`;
}

/** Word-level spans when the server paired the line with its counterpart. */
const lineHtml = (l) => (l.parts
  ? l.parts.map((p) => (p.eq ? escapeHtml(p.text) : `<span class="wch">${escapeHtml(p.text)}</span>`)).join('')
  : escapeHtml(l.text));

/**
 * GitHub-style split view: original on the left, changed on the right, one row
 * per line pair. Deleted lines show red on the left with a blank right cell;
 * added lines show green on the right with a blank left cell; unchanged lines
 * span both sides. Word-level changes are highlighted inside each side.
 */
function renderSplitDiff({ filename, additions, deletions, truncated, hunks, empty }) {
  if (!hunks.length) return `<div class="diffEmpty">${escapeHtml(empty || 'No changes between these versions.')}</div>`;

  const rows = hunks.map((h) => {
    const head = h.header
      ? `<tr class="dHunkHead"><td colspan="4">${escapeHtml(h.header)}</td></tr>`
      : '';
    const body = h.lines.map((l) => {
      if (l.type === 'ctx') {
        return `<tr class="dCtx">
          <td class="dLn">${l.oldLine ?? ''}</td>
          <td class="dCode">${lineHtml(l)}</td>
          <td class="dLn">${l.newLine ?? ''}</td>
          <td class="dCode">${lineHtml(l)}</td>
        </tr>`;
      }
      if (l.type === 'del') {
        return `<tr class="dDel">
          <td class="dLn">${l.oldLine ?? ''}</td>
          <td class="dCode"><span class="dMark">−</span>${lineHtml(l)}</td>
          <td class="dLn"></td>
          <td class="dCode"></td>
        </tr>`;
      }
      // add
      return `<tr class="dAdd">
        <td class="dLn"></td>
        <td class="dCode"></td>
        <td class="dLn">${l.newLine ?? ''}</td>
        <td class="dCode"><span class="dMark">+</span>${lineHtml(l)}</td>
      </tr>`;
    }).join('');
    return head + body;
  }).join('');

  return `
    <div class="diffFile">
      <div class="diffFileHead">
        <span class="diffFileName">${escapeHtml(filename ?? '')}</span>
        <span class="diffStat"><span class="add">+${additions ?? 0}</span> <span class="del">−${deletions ?? 0}</span></span>
      </div>
      ${truncated
        ? '<div class="diffNote">Too many changes to line up precisely — shown as a full replacement.</div>'
        : ''}
      <table class="diffTable split">${rows}</table>
    </div>`;
}

/* ------------------------------------------------------------------- threads */

async function refreshThreads() {
  const threads = await api('/api/threads');
  el.threads.innerHTML = threads.length
    ? threads.map((t) => `
        <div class="thread${t.id === currentThreadId ? ' active' : ''}" data-id="${t.id}">
          <div class="t">${escapeHtml(t.title)}</div>
          <div class="s">${t.filename ? escapeHtml(t.filename) + ' · ' : ''}${t.message_count} msg · ${fmtWhen(t.updated_at)}</div>
        </div>`).join('')
    : '<div class="none">No threads yet.</div>';

  el.threads.querySelectorAll('.thread').forEach((node) =>
    node.addEventListener('click', () => openThread(Number(node.dataset.id))));
}

el.newThread.addEventListener('click', async () => {
  const documentId = el.docPick.value ? Number(el.docPick.value) : null;
  const thread = await jsonPost('/api/threads', { documentId, model: el.model.value });
  await openThread(thread.id);
  el.input.focus();
});

async function openThread(id) {
  const { thread, messages } = await api(`/api/threads/${id}`);
  currentThreadId = id;

  el.threadTitle.textContent = thread.title;
  showThreadDoc(thread);
  if (thread.model) el.model.value = thread.model;
  // Always sync, including back to "no document". Leaving a stale filename in
  // the picker made it look like the book was attached when it was not.
  el.docPick.value = thread.document_id ? String(thread.document_id) : '';
  showDocMeta(docCache.find((d) => d.id === thread.document_id));

  el.renameThread.disabled = false;
  el.deleteThread.disabled = false;
  el.send.disabled = !el.input.value.trim() || Boolean(controller);

  const usage = await api(`/api/threads/${id}/usage`).catch(() => null);
  const byMsg = new Map((usage?.perMessage ?? []).map((u) => [u.message_id, u]));
  renderThreadUsage(usage?.thread);

  el.transcript.innerHTML = '';
  const nodes = messages.map((m) => renderMessage(m, byMsg.get(m.id)));

  // A turn that never produced a clean answer — an error, a stop, or a question
  // whose reply never arrived — offers a retry on the last bubble.
  const last = messages[messages.length - 1];
  if (last && (last.error || last.role === 'user')) addRetry(nodes[nodes.length - 1], last);

  if (!messages.length) {
    el.transcript.innerHTML =
      '<div class="empty"><h2>Thread ready</h2><p>Ask anything about the document. The whole conversation is saved as you go.</p></div>';
  }
  scrollDown();
  await refreshThreads();
  refreshSourceCount(thread.source_count ?? 0);
}

el.renameThread.addEventListener('click', async () => {
  const title = await askText({
    title: 'Rename thread',
    label: 'Thread title',
    value: el.threadTitle.textContent,
    confirmLabel: 'Rename',
  });
  if (!title) return;

  try {
    await jsonPost(`/api/threads/${currentThreadId}`, { title }, 'PATCH');
    el.threadTitle.textContent = title;
    await refreshThreads();
  } catch (err) {
    showSnackbar(err.message, 'error');
  }
});

el.deleteThread.addEventListener('click', async () => {
  const ok = await askConfirm({
    title: 'Delete thread',
    body: `"${el.threadTitle.textContent}" and all of its messages will be deleted. The document itself is not touched.`,
    confirmLabel: 'Delete thread',
  });
  if (!ok) return;
  await api(`/api/threads/${currentThreadId}`, { method: 'DELETE' });
  currentThreadId = null;
  el.threadTitle.textContent = 'No thread open';
  el.threadDoc.textContent = '';
  el.transcript.innerHTML = '<div class="empty"><h2>Thread deleted</h2><p>Pick a document and start another.</p></div>';
  el.renameThread.disabled = true;
  el.deleteThread.disabled = true;
  el.send.disabled = true;
  await refreshThreads();
  await refreshSourceCount(0);
});

el.model.addEventListener('change', async () => {
  if (currentThreadId) await jsonPost(`/api/threads/${currentThreadId}`, { model: el.model.value }, 'PATCH');
});

/* ------------------------------------------------------------------ messages */

function renderThreadUsage(u) {
  el.threadUsage.textContent = u && u.calls
    ? `${fmtTok(u.total_tokens)} tok · ${u.calls} call${u.calls === 1 ? '' : 's'}${u.failures ? ` · ${u.failures} failed` : ''}`
    : '';
}

function renderMessage(m, usage) {
  el.transcript.querySelector('.empty')?.remove();

  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  if (m.id) wrap.dataset.id = String(m.id);

  const meta = [m.role === 'user' ? 'You' : m.model || 'assistant'];
  if (m.ms) meta.push(`${(m.ms / 1000).toFixed(1)}s`);
  if (m.task && m.task !== 'chat') meta.push(m.task);

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = meta.join(' · ');
  wrap.appendChild(who);

  if (m.reasoning) {
    const d = document.createElement('details');
    d.className = 'think';
    const sum = document.createElement('summary');
    sum.textContent = `Thought · ${m.reasoning.length.toLocaleString()} chars`;
    const pre = document.createElement('pre');
    pre.className = 'thinkBody';
    pre.textContent = m.reasoning;
    d.append(sum, pre);
    wrap.appendChild(d);
  }

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = m.content;
  wrap.appendChild(body);

  if (usage?.total_tokens) {
    const c = document.createElement('div');
    c.className = 'cost';
    c.textContent = [
      `${fmtTok(usage.prompt_tokens)} in`,
      `${fmtTok(usage.completion_tokens)} out`,
      `${fmtTok(usage.total_tokens)} total`,
      usage.ttft_ms != null ? `${usage.ttft_ms}ms to first token` : null,
      usage.calls > 1 ? `${usage.calls} calls` : null,
    ].filter(Boolean).join(' · ');
    wrap.appendChild(c);
  }

  if (m.error) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = `⚠ ${m.error}`;
    wrap.appendChild(e);
  }

  // Controls go last so Retry reads as the answer to the error above it. Only
  // stored messages get them — a live bubble has no id until the turn settles.
  if (m.id) wrap.appendChild(messageActions(wrap, m));

  el.transcript.appendChild(wrap);
  return wrap;
}

const scrollDown = () => { el.transcript.scrollTop = el.transcript.scrollHeight; };

/* ----------------------------------------------------------- message actions */

const actBtn = (label, title, onClick) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'act';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};

/** Copy, plus Edit on the questions. Retry is bolted on separately by openThread. */
function messageActions(wrap, m) {
  const acts = document.createElement('div');
  acts.className = 'acts';

  const copy = actBtn('⧉ Copy', 'Copy this message', async () => {
    await copyText(m.content);
    copy.textContent = '✓ Copied';
    setTimeout(() => { copy.textContent = '⧉ Copy'; }, 1200);
  });
  acts.appendChild(copy);

  if (m.role === 'user') {
    acts.appendChild(actBtn('✎ Edit', 'Edit and re-run from here', () => beginEdit(wrap, m)));
  } else {
    // The model's rewritten text becomes a reviewable version of the attached
    // document — the diff shows exactly what changed, GitHub-style.
    if (currentThreadId && docCache.some((d) => d.id === threadDocId())) {
      const saveVer = actBtn('⤓ Save as version', 'File this response as a new version of the attached document', () => saveAsVersion(m, saveVer));
      acts.appendChild(saveVer);
    }
    acts.appendChild(actBtn('⇩ PDF', 'Save this response as a PDF', () => saveMessageAsPdf(m)));
    acts.appendChild(actBtn('⇩ DOCX', 'Save this response as a Word document', () => downloadMessageAsDocx(m)));
    const save = actBtn('☆ Save', 'Save this response for reuse in other threads', async () => {
      if (save.classList.contains('saved')) return;
      await jsonPost('/api/saved-responses', { messageId: m.id });
      save.textContent = '★ Saved';
      save.classList.add('saved');
    });
    if (m.saved) { save.textContent = '★ Saved'; save.classList.add('saved'); }
    acts.appendChild(save);

    const gt = actBtn(
      m.has_ground_truth ? '🔍 Ground truth' : '🔍 Check ground truth',
      m.has_ground_truth
        ? 'View how this response compares to the source document'
        : 'Ask the model to compare this response against the source document',
      async () => {
        if (gt.classList.contains('checked')) return openGroundTruth(m.id);

        gt.disabled = true;
        gt.textContent = '🔍 Checking…';
        try {
          await jsonPost(`/api/threads/${currentThreadId}/messages/${m.id}/ground-truth`);
          gt.textContent = '🔍 Ground truth';
          gt.classList.add('checked');
          gt.disabled = false;
          openGroundTruth(m.id);
        } catch (err) {
          gt.textContent = '🔍 Check ground truth';
          gt.title = err.message;
          gt.disabled = false;
        }
      },
    );
    if (m.has_ground_truth) gt.classList.add('checked');
    acts.appendChild(gt);
  }
  return acts;
}

/** The document id bound to the open thread, or null when none is attached. */
const threadDocId = () => {
  const thread = docCache.find((d) => String(d.id) === el.docPick.value);
  return thread ? thread.id : null;
};

/**
 * File the model's answer as a new version of the attached document. The
 * stored document is not touched — the version is a candidate revision, and
 * the diff modal opens so the user can review exactly what changed.
 */
async function saveAsVersion(m, btn) {
  const docId = threadDocId();
  if (docId == null) return;

  btn.disabled = true;
  btn.textContent = '⤓ Saving…';

  try {
    await jsonPost(`/api/documents/${docId}/versions`, {
      text: m.content,
      messageId: m.id,
      threadId: currentThreadId,
      model: m.model,
    });
    await refreshDocuments(docId);
    await refreshThreads();
    btn.textContent = '✓ Saved';
    btn.classList.add('saved');
    openVersions(docId);
  } catch (err) {
    btn.textContent = '⤓ Save as version';
    btn.disabled = false;
    showSnackbar(err.message, 'error');
  }
}

/**
 * No PDF-generation library is bundled (LAN-only app, no CDN scripts), so this
 * opens the response alone in a fresh tab and hands off to the browser's own
 * print dialog — "Save as PDF" there produces the file with zero dependencies.
 */
function saveMessageAsPdf(m) {
  const win = window.open('', '_blank');
  if (!win) return;

  const title = `${el.threadTitle.textContent} — response`;
  const meta = [m.model || 'assistant', m.ms ? `${(m.ms / 1000).toFixed(1)}s` : null, m.task && m.task !== 'chat' ? m.task : null]
    .filter(Boolean).join(' · ');

  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.6 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif; color: #14171c; padding: 32px; max-width: 720px; margin: 0 auto; }
  .who { color: #6b7280; font-size: 12px; margin-bottom: 12px; }
  .body { white-space: pre-wrap; word-wrap: break-word; }
</style></head><body>
<div class="who">${escapeHtml(meta)}</div>
<div class="body">${escapeHtml(m.content)}</div>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

/** The server builds the actual .docx (no browser-native way to produce one); this just triggers the download. */
function downloadMessageAsDocx(m) {
  const a = document.createElement('a');
  a.href = `/api/messages/${m.id}/docx`;
  a.click();
}

/** clipboard API is unavailable over plain http on the LAN, hence the fallback. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/**
 * Swap a question for a textarea. Saving re-runs the thread from that point —
 * the edited message and everything after it is replaced, because replies to a
 * question that no longer exists would be nonsense.
 */
function beginEdit(wrap, m) {
  if (controller || wrap.querySelector('.editWrap')) return;

  const body = wrap.querySelector('.body');
  const acts = wrap.querySelector('.acts');
  body.classList.add('hidden');
  acts.classList.add('hidden');

  const box = document.createElement('div');
  box.className = 'editWrap';

  const ta = document.createElement('textarea');
  ta.className = 'editBox';
  ta.value = m.content;

  const bar = document.createElement('div');
  bar.className = 'editBar';

  // Re-running is the natural moment to switch models — the answer that
  // disappointed you may have been the model's fault, not the prompt's.
  const model = document.createElement('select');
  model.className = 'editModel';
  model.title = 'Model to answer the edited question with';
  model.innerHTML = modelOptions(el.model.value);

  const dropped = countAfter(m.id);
  const note = document.createElement('span');
  note.className = 'editNote';
  note.textContent = dropped
    ? `re-runs the thread · discards ${dropped} later message${dropped === 1 ? '' : 's'}`
    : 're-runs the thread from here';

  const cancel = actBtn('Cancel', 'Leave the message as it was', () => {
    box.remove();
    body.classList.remove('hidden');
    acts.classList.remove('hidden');
  });

  const save = actBtn('Save & re-run', 'Replace the question and answer it again', () => {
    const text = ta.value.trim();
    if (!text) return;
    body.textContent = text;
    box.remove();
    body.classList.remove('hidden');
    acts.classList.remove('hidden');
    // Show the outcome before the server confirms it — the discarded replies go.
    while (wrap.nextElementSibling) wrap.nextElementSibling.remove();
    // The route switches the thread to this model, and openThread syncs the
    // top bar once the turn settles, so the two pickers never disagree.
    el.model.value = model.value;
    streamTurn(`/api/threads/${currentThreadId}/messages/${m.id}/edit`, {
      content: text, model: model.value,
    });
  });
  save.classList.add('primary');
  cancel.classList.add('dismiss');

  bar.append(save, cancel, model, note);
  box.append(ta, bar);
  wrap.insertBefore(box, acts);

  ta.style.height = Math.min(ta.scrollHeight + 4, 320) + 'px';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel.click();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.click();
  });
}

const countAfter = (id) => {
  const nodes = [...el.transcript.querySelectorAll('.msg')];
  const i = nodes.findIndex((n) => n.dataset.id === String(id));
  return i === -1 ? 0 : nodes.length - i - 1;
};

/**
 * A failed turn keeps its question in the thread, so retrying costs one click
 * instead of retyping a long prompt. Only the tail is retryable — see the
 * matching guard on the server.
 */
function addRetry(wrap, m) {
  const acts = wrap.querySelector('.acts');
  if (!acts) return;

  const btn = actBtn(
    m.role === 'user' ? '↻ Send again' : '↻ Retry',
    'Run this question again — nothing to retype',
    () => {
      if (controller) return;
      btn.remove();
      if (m.role === 'assistant') wrap.remove();
      streamTurn(`/api/threads/${currentThreadId}/messages/${m.id}/retry`, {
        model: el.model.value,
      });
    },
  );
  btn.classList.add('retry');
  acts.insertBefore(btn, acts.firstChild);
}

el.input.addEventListener('input', () => {
  // `controller` guards the Enter path: Send is hidden while a turn streams,
  // but typing would otherwise re-enable it and let Enter start a second turn.
  el.send.disabled = !el.input.value.trim() || !currentThreadId || Boolean(controller);
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!el.send.disabled) el.composer.requestSubmit();
  }
});

/**
 * Drive one assistant turn against `url`. Shared by the composer and by Retry,
 * which posts to the retry route instead — the question is already in the
 * thread there, so the body only carries the model.
 */
async function streamTurn(url, payload) {
  controller?.abort();
  controller = new AbortController();
  el.send.classList.add('hidden');
  el.stop.classList.remove('hidden');
  el.stage.classList.remove('error');
  el.stage.textContent = 'sending…';

  // Placeholder assistant bubble that fills in as tokens arrive.
  const bubble = renderMessage({ role: 'assistant', content: '', model: el.model.value });
  bubble.classList.add('streaming');
  const body = bubble.querySelector('.body');

  let think = null, thinkBody = null, thinkChars = 0, thinkStart = 0, thinkDone = false;
  const started = performance.now();
  let chars = 0;
  const turnUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, ttftMs: null };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const { type, v } = JSON.parse(line.slice(5));

        if (type === 'token') {
          // Reasoning panel collapses the moment the answer starts — Copilot rhythm.
          if (thinkChars && !thinkDone) {
            thinkDone = true;
            think.classList.remove('active');
            think.open = false;
            think.querySelector('summary').textContent =
              `Thought for ${((performance.now() - thinkStart) / 1000).toFixed(1)}s · ${thinkChars.toLocaleString()} chars`;
          }
          chars += v.length;
          body.textContent += v;
          const secs = (performance.now() - started) / 1000;
          el.stage.textContent = `streaming · ${(chars / 3.6 / secs).toFixed(1)} tok/s est`;
          scrollDown();
        } else if (type === 'thinking') {
          if (!thinkChars) {
            thinkStart = performance.now();
            think = document.createElement('details');
            think.className = 'think active';
            think.open = true;
            const sum = document.createElement('summary');
            sum.textContent = 'Thinking…';
            thinkBody = document.createElement('pre');
            thinkBody.className = 'thinkBody';
            think.append(sum, thinkBody);
            bubble.insertBefore(think, body);
          }
          thinkChars += v.length;
          thinkBody.textContent += v;
          thinkBody.scrollTop = thinkBody.scrollHeight;
          think.querySelector('summary').textContent =
            `Thinking… ${((performance.now() - thinkStart) / 1000).toFixed(1)}s`;
          el.stage.textContent = 'reasoning';
          scrollDown();
        } else if (type === 'stage') {
          el.stage.textContent = v;
        } else if (type === 'fallback') {
          // The main provider refused the call. The turn is still going, on
          // another provider and usually another model — say so in the bubble,
          // because the answer's label is about to change under the reader.
          const line = document.createElement('div');
          line.className = 'fallbackNote';
          line.textContent = `⇢ ${v.failed} unavailable (${v.error}) — answering with ${v.next}${v.model ? ` · ${v.model}` : ''}`;
          bubble.insertBefore(line, bubble.querySelector('.body'));
          showSnackbar(`${v.failed} down — falling back to ${v.next}`, 'error');
        } else if (type === 'usage') {
          turnUsage.promptTokens += v.promptTokens ?? 0;
          turnUsage.completionTokens += v.completionTokens ?? 0;
          turnUsage.totalTokens += v.totalTokens ?? 0;
          if (turnUsage.ttftMs == null) turnUsage.ttftMs = v.ttftMs;
        } else if (type === 'error') {
          throw new Error(v);
        } else if (type === 'done') {
          think?.classList.remove('active');
          bubble.querySelector('.who').textContent =
            `${v.model} · ${(v.ms / 1000).toFixed(1)}s${v.task && v.task !== 'chat' ? ' · ' + v.task : ''}`;
          if (turnUsage.totalTokens) {
            const c = document.createElement('div');
            c.className = 'cost';
            c.textContent = [
              `${fmtTok(turnUsage.promptTokens)} in`,
              `${fmtTok(turnUsage.completionTokens)} out`,
              `${fmtTok(turnUsage.totalTokens)} total`,
              turnUsage.ttftMs != null ? `${turnUsage.ttftMs}ms to first token` : null,
            ].filter(Boolean).join(' · ');
            bubble.appendChild(c);
          }
          renderThreadUsage(v.usage);
          // A truncated turn returns "done" but is a failure — the reload in
          // the finally then draws the ⚠ line and its Retry button.
          if (v.error) {
            el.stage.classList.add('error');
            el.stage.textContent = v.error;
          } else {
            el.stage.textContent = `done in ${(v.ms / 1000).toFixed(1)}s · ${fmtTok(turnUsage.totalTokens)} tokens`;
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      el.stage.classList.add('error');
      el.stage.textContent = err.message;
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = `⚠ ${err.message}`;
      bubble.appendChild(e);
    }
  } finally {
    think?.classList.remove('active');
    bubble.classList.remove('streaming');
    el.send.classList.remove('hidden');
    el.stop.classList.add('hidden');
    controller = null;
    // Re-render from the store: live bubbles have no message id, and the id is
    // what the copy / edit / retry controls hang off.
    await openThread(currentThreadId);
    renderStats((await api('/api/config')).stats);
    el.input.focus();
  }
}

el.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThreadId || !el.input.value.trim() || controller) return;

  const question = el.input.value.trim();
  const taskId = el.task.value;
  el.input.value = '';
  el.input.style.height = 'auto';
  el.send.disabled = true;

  renderMessage({ role: 'user', content: question, task: taskId });
  scrollDown();

  await streamTurn(`/api/threads/${currentThreadId}/messages`, {
    content: question, taskId, model: el.model.value,
  });
});

el.stop.addEventListener('click', () => {
  controller?.abort();
  el.stage.textContent = 'stopped — partial answer kept in the thread';
});

/* --------------------------------------------------------------------- misc */

function renderStats(s) {
  el.dbStats.textContent = `${s.documents} docs · ${s.threads} threads · ${s.messages} msgs`;
}

/* ------------------------------------------------------------------- traces */

el.traces.addEventListener('click', openTraces);
el.closeSheet.addEventListener('click', () => el.overlay.classList.add('hidden'));
el.traceScope.addEventListener('change', openTraces);

async function openTraces() {
  const scoped = el.traceScope.checked && currentThreadId;
  el.overlay.classList.remove('hidden');
  el.sheetTitle.textContent = scoped ? `Traces · ${el.threadTitle.textContent}` : 'Traces · all threads';
  el.traceList.innerHTML = '<div class="d">loading…</div>';

  const [rows, summary] = await Promise.all([
    api(`/api/traces${scoped ? `?threadId=${currentThreadId}` : ''}`),
    api('/api/usage'),
  ]);

  el.totals.innerHTML = `
    <table>
      <tr><th>Model</th><th>Calls</th><th>Prompt</th><th>Completion</th><th>Total</th><th>Avg TTFT</th><th>Avg time</th><th>Failed</th></tr>
      ${summary.byModel.map((m) => `<tr>
        <td>${escapeHtml(m.model)}</td><td>${m.calls}</td>
        <td>${fmtTok(m.prompt_tokens)}</td><td>${fmtTok(m.completion_tokens)}</td>
        <td>${fmtTok(m.total_tokens)}</td>
        <td>${m.avg_ttft_ms ?? '—'}ms</td><td>${m.avg_duration_ms ?? '—'}ms</td>
        <td>${m.failures || ''}</td></tr>`).join('')}
      <tr><th>All</th><th>${summary.totals.calls}</th>
        <th>${fmtTok(summary.totals.prompt_tokens)}</th>
        <th>${fmtTok(summary.totals.completion_tokens)}</th>
        <th>${fmtTok(summary.totals.total_tokens)}</th><th></th><th></th><th></th></tr>
    </table>`;

  el.traceList.innerHTML = rows.length
    ? rows.map((t) => `
      <details class="traceRow${t.status !== 'ok' ? ' bad' : ''}" data-id="${t.id}">
        <summary>
          <span class="k">#${t.id} ${t.kind}</span>
          <span>${escapeHtml(t.model)}</span>
          <span class="d">${fmtTok(t.prompt_tokens)} in · ${fmtTok(t.completion_tokens)} out · ${fmtTok(t.total_tokens)} total</span>
          <span class="d">ttft ${t.ttft_ms ?? '—'}ms · ${t.duration_ms ?? '—'}ms</span>
          ${t.reasoning_chars ? `<span class="d">${fmtTok(t.reasoning_chars)} thought</span>` : ''}
          ${t.status !== 'ok' ? `<span class="k">${t.status}</span>` : ''}
          ${t.message_id === null
            ? '<span class="k detached" title="The message this produced is no longer in the thread — retried, edited away, or stopped before it was saved. The call still happened and still counts.">detached</span>'
            : ''}
          <span class="d">${fmtWhen(t.created_at)}</span>
        </summary>
        <div class="traceDetail"><div class="d">loading…</div></div>
      </details>`).join('')
    : '<div class="d">No traces yet.</div>';

  el.traceList.querySelectorAll('.traceRow').forEach((row) => {
    row.addEventListener('toggle', async () => {
      if (!row.open || row.dataset.loaded) return;
      row.dataset.loaded = '1';
      const t = await api(`/api/traces/${row.dataset.id}`);
      row.querySelector('.traceDetail').innerHTML = `
        <h4>Request · ${t.prompt_messages} messages · ${fmtTok(t.prompt_chars)} chars sent</h4>
        <pre>${(t.request || []).map((m) =>
          `<span class="role">${m.role}:</span> ${escapeHtml(m.content)}`).join('\n\n')}</pre>
        <h4>Parameters</h4>
        <pre>${escapeHtml(JSON.stringify({ ...t.params, model: t.model, served_model: t.served_model, endpoint: t.base_url, fingerprint: t.fingerprint }, null, 2))}</pre>
        ${t.reasoning_text ? `<h4>Reasoning</h4><pre>${escapeHtml(t.reasoning_text)}</pre>` : ''}
        <h4>Response</h4>
        <pre>${escapeHtml(t.response_text || '')}</pre>
        ${t.error ? `<h4>Error</h4><pre>${escapeHtml(t.error)}</pre>` : ''}`;
    });
  });
}

/* ---------------------------------------------------------- saved responses */

el.savedResponses.addEventListener('click', openSavedResponses);
el.closeSavedSheet.addEventListener('click', () => el.savedOverlay.classList.add('hidden'));
el.useSavedResponses.addEventListener('click', useSavedResponses);

async function openSavedResponses() {
  el.savedOverlay.classList.remove('hidden');
  el.savedList.innerHTML = '<div class="d">loading…</div>';

  const [rows, assignedIds] = await Promise.all([
    api('/api/saved-responses'),
    currentThreadId ? api(`/api/threads/${currentThreadId}/saved-responses`) : Promise.resolve([]),
  ]);

  el.savedList.innerHTML = rows.length
    ? rows.map((r) => `
      <details class="traceRow" data-id="${r.id}">
        <summary>
          <input type="checkbox" class="savedCheck" data-id="${r.id}"${assignedIds.includes(r.id) ? ' checked' : ''} />
          <span class="savedFirstLine">${escapeHtml(r.content.split('\n')[0])}</span>
          <span class="d">${fmtWhen(r.created_at)}</span>
          <button type="button" class="small danger savedRemove" data-id="${r.id}">Remove</button>
        </summary>
        <div class="savedBody">${escapeHtml(r.content)}</div>
      </details>`).join('')
    : '<div class="d">No saved responses yet.</div>';

  el.savedList.querySelectorAll('.savedCheck').forEach((box) => {
    // Clicking the checkbox must toggle it, not also expand/collapse the
    // enclosing <summary> — stop the click before it bubbles there.
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', updateUseSavedResponsesState);
  });
  el.savedList.querySelectorAll('.savedRemove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // same reason as the checkbox — don't toggle the row.
      await api(`/api/saved-responses/${btn.dataset.id}`, { method: 'DELETE' });
      btn.closest('.traceRow').remove();
      if (!el.savedList.querySelector('.traceRow')) {
        el.savedOverlay.classList.add('hidden');
      } else {
        updateUseSavedResponsesState();
      }
    });
  });
  updateUseSavedResponsesState();
}

function updateUseSavedResponsesState() {
  const any = !!el.savedList.querySelector('.savedCheck:checked');
  el.useSavedResponses.disabled = !any || !currentThreadId;
}

async function useSavedResponses() {
  if (!currentThreadId) return;
  const ids = [...el.savedList.querySelectorAll('.savedCheck:checked')].map((box) => Number(box.dataset.id));
  if (!ids.length) return;

  await jsonPost(`/api/threads/${currentThreadId}/saved-responses`, { savedResponseIds: ids });
  el.savedOverlay.classList.add('hidden');
}

/* -------------------------------------------------------------- ground truth */

el.closeGroundTruthSheet.addEventListener('click', () => el.groundTruthOverlay.classList.add('hidden'));

async function openGroundTruth(messageId) {
  el.groundTruthOverlay.classList.remove('hidden');
  el.groundTruthList.innerHTML = '<div class="d">loading…</div>';

  const check = await api(`/api/messages/${messageId}/ground-truth`);

  // The model returns findings, not line numbers, so each one becomes its own
  // hunk and the gutters go — otherwise it is the same diff view as the
  // document history, which is the point: one way to read a change here.
  el.groundTruthList.innerHTML = renderDiff({
    filename: `${check.diff.length} finding${check.diff.length === 1 ? '' : 's'} against the source document`,
    additions: check.diff.filter((d) => d.new != null).length,
    deletions: check.diff.filter((d) => d.old != null).length,
    gutters: false,
    empty: 'Fully grounded in the document — nothing added or changed.',
    hunks: check.diff.map((d, i) => ({
      header: `@@ finding ${i + 1} @@`,
      lines: [
        d.old != null ? { type: 'del', text: d.old } : null,
        d.new != null ? { type: 'add', text: d.new } : null,
      ].filter(Boolean),
    })),
  });
}

/* --------------------------------------------------------------- extra sources

   A thread reads its own document. This is where it is given more to read:
   other conversations, and whole graphs, ticked from one list. The list belongs
   to the thread, so a source attached here is still attached on the deck and on
   the canvas — and it is assembled at send time, which means an answer added to
   a source after it was attached is read by the very next question.
   -------------------------------------------------------------------------- */

el.sourcesBtn.addEventListener('click', openSources);
el.closeSourcesSheet.addEventListener('click', () => el.sourcesOverlay.classList.add('hidden'));
el.saveSources.addEventListener('click', saveSources);
el.previewSources.addEventListener('click', previewSources);

/** The count on the composer button, so the thread never reads something silently. */
function refreshSourceCount(count) {
  const n = currentThreadId ? Number(count) || 0 : 0;
  el.sourcesBtn.textContent = n ? `⁂ Sources · ${n}` : '⁂ Sources';
  el.sourcesBtn.classList.toggle('on', n > 0);
}

async function openSources() {
  if (!currentThreadId) return showSnackbar('Open a thread first.', 'error');

  el.sourcesOverlay.classList.remove('hidden');
  el.sourceList.innerHTML = '<div class="d">loading…</div>';
  el.sourcesTitle.textContent = 'Extra sources';
  el.sourcesCost.textContent = '';

  const [catalog, mine] = await Promise.all([
    api(`/api/source-catalog?thread=${currentThreadId}`),
    api(`/api/threads/${currentThreadId}/sources`),
  ]);

  const on = new Map(mine.items.map((i) => [`${i.kind}:${i.ref_id}`, i]));
  // Attached first, in the order they are read; everything else after it. The
  // list is long, and what this thread already reads is what you came to see.
  const rank = (kind, id) => (on.has(`${kind}:${id}`) ? on.get(`${kind}:${id}`).position : Infinity);
  const threads = [...catalog.threads].sort((a, b) => rank('thread', a.id) - rank('thread', b.id));
  const graphs = [...catalog.graphs].sort((a, b) => rank('graph', a.id) - rank('graph', b.id));

  const row = (kind, id, name, meta, extra = '') => {
    const cur = on.get(`${kind}:${id}`);
    return `
      <label class="sourceRow${cur ? ' on' : ''}">
        <input type="checkbox" class="sourceBox" data-kind="${kind}" data-id="${id}"${cur ? ' checked' : ''} />
        <span class="sourceMain">
          <span class="sourceName">${escapeHtml(name)}</span>
          <span class="sourceMeta">${meta}</span>
        </span>
        ${extra}
      </label>`;
  };

  const threadRows = threads.map((t) => row(
    'thread', t.id, t.title,
    `${t.messages} msg${t.filename ? ` · ${escapeHtml(t.filename)}` : ''} · ${fmtWhen(t.updated_at)}${
      t.messages ? '' : ' · empty, contributes nothing'}`,
    `<select class="sourceMode" data-id="${t.id}" title="How much of that conversation is read">
       <option value="full"${on.get(`thread:${t.id}`)?.mode === 'last' ? '' : ' selected'}>Whole transcript</option>
       <option value="last"${on.get(`thread:${t.id}`)?.mode === 'last' ? ' selected' : ''}>Final answer only</option>
     </select>`,
  )).join('');

  const graphRows = graphs.map((g) => row(
    'graph', g.id, g.title,
    `${g.points} point${g.points === 1 ? '' : 's'} · ${g.lines} line${g.lines === 1 ? '' : 's'} · ${
      g.books} book${g.books === 1 ? '' : 's'} · ${fmtWhen(g.updated_at)}${
      g.points ? '' : ' · empty, contributes nothing'}`,
  )).join('');

  el.sourceList.innerHTML = `
    <p class="sourceIntro">Tick anything this thread should read alongside its own document.
       A conversation is read as its transcript, a graph as all of its points and the lines
       between them. Nothing is copied — every question re-reads them as they are now.</p>
    <h4 class="sourceHead">Conversations</h4>
    ${threadRows || '<div class="d">No other conversations yet.</div>'}
    <h4 class="sourceHead">Graphs</h4>
    ${graphRows || '<div class="d">No graphs yet — build one in the Grimoire.</div>'}`;

  // Clicking the mode picker must not toggle the row it sits in.
  el.sourceList.querySelectorAll('.sourceMode').forEach((sel) =>
    sel.addEventListener('click', (e) => e.preventDefault()));
  el.sourceList.querySelectorAll('.sourceBox').forEach((box) =>
    box.addEventListener('change', () => {
      box.closest('.sourceRow').classList.toggle('on', box.checked);
      showSourceCost(null);
    }));

  showSourceCost(mine.summary);
  refreshSourceCount(mine.items.length);
  // Back from the preview, which replaced this list with the assembled text.
  el.saveSources.disabled = false;
  el.previewSources.textContent = 'Preview';
}

/** What the attached set costs, from the server — blanked while it is stale. */
function showSourceCost(summary) {
  const ticked = el.sourceList.querySelectorAll('.sourceBox:checked').length;
  el.sourcesTitle.textContent = `Extra sources · ${ticked} selected`;
  el.sourcesCost.textContent = summary
    ? (summary.chars ? `${summary.chars.toLocaleString()} chars sent with every question` : '')
    : 'unsaved — press Save sources';
}

function tickedSources() {
  return [...el.sourceList.querySelectorAll('.sourceBox:checked')].map((box) => {
    const kind = box.dataset.kind;
    const id = Number(box.dataset.id);
    const mode = kind === 'thread'
      ? el.sourceList.querySelector(`.sourceMode[data-id="${id}"]`)?.value ?? 'full'
      : 'full';
    return { kind, id, mode };
  });
}

async function saveSources() {
  if (!currentThreadId) return;
  const items = tickedSources();
  try {
    const saved = await jsonPost(`/api/threads/${currentThreadId}/sources`, { items }, 'PUT');
    const { summary } = await api(`/api/threads/${currentThreadId}/sources`);
    showSourceCost(summary);
    refreshSourceCount(saved.items.length);
    showSnackbar(saved.items.length
      ? `${saved.items.length} source${saved.items.length === 1 ? '' : 's'} attached — every question in this thread reads them`
      : 'Sources cleared — this thread reads only its own document');
  } catch (err) {
    showSnackbar(err.message, 'error');
  }
}

async function previewSources() {
  if (!currentThreadId) return;
  // The preview replaces the tick list, so Save would have nothing to read and
  // would file an empty set. It goes out until the list comes back.
  if (el.saveSources.disabled) return openSources();

  const { preview, summary } = await api(`/api/threads/${currentThreadId}/sources`);
  if (!summary.chars) return showSnackbar('Nothing attached yet — tick something and save.', 'error');

  el.saveSources.disabled = true;
  el.previewSources.textContent = 'Back to the list';
  el.sourceList.innerHTML = `
    <p class="sourceIntro">The first 4,000 characters of exactly what the next question in this
       thread is sent with, assembled from ${summary.parts.length} source${summary.parts.length === 1 ? '' : 's'}
       in reading order. Press <b>Back to the list</b> to change what goes in.</p>
    <pre class="sourcePreview">${escapeHtml(preview)}${summary.chars > 4000 ? '\n\n…' : ''}</pre>`;
}
