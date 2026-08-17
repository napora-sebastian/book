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
  groundTruthOverlay: $('groundTruthOverlay'), groundTruthList: $('groundTruthList'),
  closeGroundTruthSheet: $('closeGroundTruthSheet'),
  replaceDoc: $('replaceDoc'), replaceFile: $('replaceFile'), docVersions: $('docVersions'),
  versionsOverlay: $('versionsOverlay'), versionsTitle: $('versionsTitle'),
  closeVersionsSheet: $('closeVersionsSheet'), versionList: $('versionList'),
  diffFrom: $('diffFrom'), diffTo: $('diffTo'), diffStat: $('diffStat'), diffView: $('diffView'),
  previewDoc: $('previewDoc'), previewOverlay: $('previewOverlay'), previewTitle: $('previewTitle'),
  previewBody: $('previewBody'), closePreviewSheet: $('closePreviewSheet'),
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

/* ----------------------------------------------------------------- bootstrap */

cfg = await api('/api/config');

el.task.innerHTML =
  '<option value="chat">Chat</option>' +
  cfg.tasks.filter((t) => t.instruction).map((t) => `<option value="${t.id}">${t.label}</option>`).join('');

/** Model list, also used by the picker the edit box carries. */
const modelOptions = (selected) => (cfg.models.length ? cfg.models : [cfg.model])
  .map((m) => `<option value="${m}"${m === selected ? ' selected' : ''}>${m}</option>`).join('');

el.model.innerHTML = modelOptions(cfg.model);

if (cfg.reachable) {
  el.status.className = 'status ok';
  el.status.textContent = new URL(cfg.baseUrl).host;
} else {
  el.status.className = 'status bad';
  el.status.textContent = `unreachable — ${cfg.baseUrl}`;
}

renderStats(cfg.stats);
await refreshDocuments();
await refreshThreads();

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

  const filename = prompt('Document name:', doc.filename);
  if (!filename?.trim()) return;

  await jsonPost(`/api/documents/${doc.id}`, { filename: filename.trim() }, 'PATCH');
  await refreshDocuments(doc.id);
  await refreshThreads();
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

    if (updated.unchanged) {
      el.docMeta.textContent += ' · identical to the current version, nothing changed';
      return;
    }
    if (updated.warnings?.length) el.docMeta.textContent += ` · ⚠ ${updated.warnings.join('; ')}`;
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
el.closeVersionsSheet.addEventListener('click', () => el.versionsOverlay.classList.add('hidden'));
el.versionsOverlay.addEventListener('click', (e) => {
  if (e.target === el.versionsOverlay) el.versionsOverlay.classList.add('hidden');
});
el.diffFrom.addEventListener('change', loadDiff);
el.diffTo.addEventListener('change', loadDiff);

let versionsDocId = null;

async function openVersions(documentId) {
  versionsDocId = documentId;
  el.versionsOverlay.classList.remove('hidden');
  el.diffView.innerHTML = '<div class="diffEmpty">loading…</div>';
  el.diffStat.textContent = '';

  const { filename, versions } = await api(`/api/documents/${documentId}/versions`);
  el.versionsTitle.textContent = `Versions · ${filename}`;

  const newest = versions[0].version;
  el.versionList.innerHTML = versions.map((v) => `
    <div class="versionRow${v.version === newest ? ' active' : ''}" data-version="${v.version}">
      <div class="v">v${v.version}${v.version === newest ? '<span class="tag">current</span>' : ''}</div>
      <div class="s">${versionStat(v)}</div>
      <div class="s">${v.pages ? `${v.pages}p · ` : ''}${(v.words ?? 0).toLocaleString()} words · ${fmtWhen(v.created_at)}</div>
    </div>`).join('');

  el.versionList.querySelectorAll('.versionRow').forEach((row) => {
    // Picking a version shows what that save changed — the diff against the
    // one before it, which is the question anyone clicking a history asks.
    row.addEventListener('click', () => {
      const v = Number(row.dataset.version);
      el.diffTo.value = String(v);
      el.diffFrom.value = String(v - 1);
      loadDiff();
    });
  });

  const label = (v) => `v${v.version} · ${fmtWhen(v.created_at)}`;
  const options = versions.map((v) => `<option value="${v.version}">${label(v)}</option>`).join('');
  el.diffFrom.innerHTML = options + '<option value="0">nothing (original upload)</option>';
  el.diffTo.innerHTML = options;
  el.diffTo.value = String(newest);
  el.diffFrom.value = String(newest - 1);

  await loadDiff();
}

const versionStat = (v) => v.additions == null && v.deletions == null
  ? 'original upload'
  : `<span class="add">+${v.additions ?? 0}</span> <span class="del">−${v.deletions ?? 0}</span>`;

async function loadDiff() {
  if (versionsDocId == null) return;
  const from = el.diffFrom.value;
  const to = el.diffTo.value;

  el.versionList.querySelectorAll('.versionRow').forEach((row) =>
    row.classList.toggle('active', row.dataset.version === to));

  el.diffView.innerHTML = '<div class="diffEmpty">loading…</div>';
  try {
    const diff = await api(`/api/documents/${versionsDocId}/diff?from=${from}&to=${to}`);
    el.diffStat.innerHTML = `<span class="add">+${diff.additions}</span> <span class="del">−${diff.deletions}</span>`;
    el.diffView.innerHTML = renderDiff(diff);
  } catch (err) {
    el.diffStat.textContent = '';
    el.diffView.innerHTML = `<div class="diffEmpty">${escapeHtml(err.message)}</div>`;
  }
}

/* ---------------------------------------------------------------- preview */

el.previewDoc.addEventListener('click', () => {
  const doc = docCache.find((d) => String(d.id) === el.docPick.value);
  if (doc) openPreview(doc);
});
el.closePreviewSheet.addEventListener('click', () => el.previewOverlay.classList.add('hidden'));
el.previewOverlay.addEventListener('click', (e) => {
  if (e.target === el.previewOverlay) el.previewOverlay.classList.add('hidden');
});

/**
 * Show the document's content in a modal. PDFs embed the stored bytes in an
 * <iframe> (the browser's own viewer); docx and text render the extracted text
 * as a scrollable pre. The preview button is enabled whenever a doc is picked.
 */
async function openPreview(doc) {
  el.previewOverlay.classList.remove('hidden');
  el.previewTitle.textContent = `Preview · ${doc.filename}`;
  el.previewBody.innerHTML = '<div class="diffEmpty">loading…</div>';

  if (doc.kind === 'pdf') {
    // The raw file route serves the exact bytes; the iframe hands off to the
    // browser's built-in PDF viewer, which is the only sane way to page a book.
    el.previewBody.innerHTML = `<iframe class="previewFrame" src="/api/documents/${doc.id}/file"></iframe>`;
    return;
  }

  try {
    const { text } = await api(`/api/documents/${doc.id}/text`);
    el.previewBody.innerHTML = `<pre class="previewText">${escapeHtml(text)}</pre>`;
  } catch (err) {
    el.previewBody.innerHTML = `<div class="diffEmpty">${escapeHtml(err.message)}</div>`;
  }
}

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
}

el.renameThread.addEventListener('click', async () => {
  const title = prompt('Thread title:', el.threadTitle.textContent);
  if (!title?.trim()) return;
  await jsonPost(`/api/threads/${currentThreadId}`, { title: title.trim() }, 'PATCH');
  el.threadTitle.textContent = title.trim();
  await refreshThreads();
});

el.deleteThread.addEventListener('click', async () => {
  if (!confirm('Delete this thread and all its messages?')) return;
  await api(`/api/threads/${currentThreadId}`, { method: 'DELETE' });
  currentThreadId = null;
  el.threadTitle.textContent = 'No thread open';
  el.threadDoc.textContent = '';
  el.transcript.innerHTML = '<div class="empty"><h2>Thread deleted</h2><p>Pick a document and start another.</p></div>';
  el.renameThread.disabled = true;
  el.deleteThread.disabled = true;
  el.send.disabled = true;
  await refreshThreads();
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
el.overlay.addEventListener('click', (e) => {
  if (e.target === el.overlay) el.overlay.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  el.overlay.classList.add('hidden');
  el.savedOverlay.classList.add('hidden');
  el.groundTruthOverlay.classList.add('hidden');
  el.versionsOverlay.classList.add('hidden');
  el.previewOverlay.classList.add('hidden');
});

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
el.savedOverlay.addEventListener('click', (e) => {
  if (e.target === el.savedOverlay) el.savedOverlay.classList.add('hidden');
});
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
el.groundTruthOverlay.addEventListener('click', (e) => {
  if (e.target === el.groundTruthOverlay) el.groundTruthOverlay.classList.add('hidden');
});

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
