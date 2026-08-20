/* ===========================================================================
   The two pieces of tool UI that all three chats need.

   There are three places in this app where you talk to a model — the deck, a
   point on a canvas, and the Oracle — and each is written in its own idiom,
   against its own stylesheet, with its own idea of what a message looks like.
   What they should NOT each have is their own idea of what `/` does, or their
   own suggestion box that behaves a little differently from the other two.

   So the behaviour lives here and the appearance stays with each surface: this
   module writes semantic class names and nothing else, and each stylesheet
   dresses them. Nothing here reads a colour, a font or a layout.
   =========================================================================== */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------- slash menu

   Typing `/` at the START of an empty composer opens the tool list. Anywhere
   else a slash is just a slash — "/etc/hosts" and "and/or" must not summon a
   menu, and the server agrees: it only reads a command off the front.
   ------------------------------------------------------------------------- */

/**
 * Attach the `/` menu to one composer.
 *
 * `getTools` is a function rather than a list because every surface loads
 * /api/config asynchronously and mounts its composer before that lands.
 * Returns a teardown, which nothing currently needs and everything should have.
 */
export function attachSlashMenu(input, getTools, { mount = input.parentElement } = {}) {
  let menu = null;
  let items = [];
  let at = 0;

  const close = () => {
    menu?.remove();
    menu = null;
    items = [];
  };

  const typed = () => {
    // Only ever the first line, and only when the slash opens it.
    const m = /^\/([a-z_]*)$/.exec(input.value.split('\n')[0]);
    return m ? m[1] : null;
  };

  const pick = (id) => {
    input.value = `/${id} `;
    close();
    input.focus();
    // Put the caret after the space, which is where the user is about to type.
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const paint = () => {
    const q = typed();
    if (q === null) return close();

    const all = getTools() ?? [];
    items = all.filter((t) => t.id.startsWith(q));
    if (!items.length) return close();
    at = Math.min(at, items.length - 1);

    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'slashMenu';
      menu.setAttribute('role', 'listbox');
      // The composer is the thing being typed into; the menu belongs to it, so
      // a surface that moves its composer moves the menu with it for free.
      mount.appendChild(menu);
      menu.addEventListener('mousedown', (ev) => {
        // mousedown, not click: the input must not lose focus first, or the
        // blur handler below closes the menu out from under the click.
        const row = ev.target.closest('[data-tool]');
        if (!row) return;
        ev.preventDefault();
        pick(row.dataset.tool);
      });
    }

    menu.innerHTML = items.map((t, i) => `
      <div class="slashItem${i === at ? ' on' : ''}" data-tool="${esc(t.id)}" role="option">
        <span class="slashName">/${esc(t.id)}</span>
        <span class="slashHint" data-i18n-skip>${esc(t.hint ?? '')}</span>
      </div>`).join('');
    menu.querySelector('.slashItem.on')?.scrollIntoView({ block: 'nearest' });
  };

  // stopImmediatePropagation, not stopPropagation. Every one of these three
  // composers binds Enter-to-send on the input ITSELF, and stopPropagation only
  // stops other NODES — listeners on the same node still run. With the weaker
  // one, picking a tool with Enter also sends the half-typed command.
  const swallow = (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  const onKey = (ev) => {
    if (!menu) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      swallow(ev);
      at = (at + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      swallow(ev);
      pick(items[at].id);
      return;
    }
    if (ev.key === 'Escape') {
      swallow(ev);
      close();
    }
  };

  input.addEventListener('input', () => { at = 0; paint(); });
  // Capture phase, so this is registered ahead of the composer's own handler
  // and can swallow the key before it reaches it.
  input.addEventListener('keydown', onKey, true);
  input.addEventListener('blur', () => setTimeout(close, 120));

  return close;
}

/* --------------------------------------------------------- the ✦ popup

   "Suggest me another category." The user names one thing they want proposed
   about an answer that has already been given, and it is filed under that
   answer rather than becoming the next turn of the conversation.
   ------------------------------------------------------------------------- */

/**
 * Ask what should be suggested. Resolves with the text, or null on cancel.
 *
 * Anchored to the button that opened it so it appears where the user is
 * looking — under the answer they pressed ✦ on, not in the middle of a screen
 * they may have scrolled away from.
 */
export function askWhatToSuggest(anchor, { placeholder = 'another category, a counter-argument, a shorter title…' } = {}) {
  return new Promise((resolve) => {
    document.querySelector('.suggestPop')?.remove();

    const pop = document.createElement('div');
    pop.className = 'suggestPop';
    pop.innerHTML = `
      <label class="suggestLabel">What should the model suggest?</label>
      <textarea class="suggestInput" rows="2" placeholder="${esc(placeholder)}"></textarea>
      <div class="suggestActs">
        <button type="button" class="suggestCancel">Cancel</button>
        <button type="button" class="suggestSend">Send</button>
      </div>`;

    // Placed in the anchor's own offset parent so it scrolls with the message
    // rather than floating over a transcript that has moved on.
    const host = anchor.closest('.msg, .turn, .oracleTurn') ?? anchor.parentElement;
    host.style.position = host.style.position || 'relative';
    host.appendChild(pop);

    const field = pop.querySelector('.suggestInput');
    field.focus();

    const done = (value) => {
      // Both buttons close it. That is the whole contract of this popup.
      document.removeEventListener('keydown', onEsc, true);
      document.removeEventListener('mousedown', onOutside, true);
      pop.remove();
      resolve(value);
    };
    const submit = () => {
      const v = field.value.trim();
      done(v || null);
    };

    const onEsc = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(null); }
    };
    const onOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor) done(null); };

    pop.querySelector('.suggestSend').addEventListener('click', submit);
    pop.querySelector('.suggestCancel').addEventListener('click', () => done(null));
    field.addEventListener('keydown', (ev) => {
      // Enter sends, because this is one short line and not a document.
      // Shift-Enter is there for the rare case that it is two.
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
    });
    document.addEventListener('keydown', onEsc, true);
    document.addEventListener('mousedown', onOutside, true);
  });
}

/**
 * Run one suggestion and stream it into a block under the answer.
 *
 * The block is created before the first token so there is something on screen
 * for the length of a call that can take a minute, and it carries its own error
 * state — a suggestion that fails must not disturb the answer it hangs under.
 */
export async function streamSuggestion(box, target, ask, { onDone } = {}) {
  const row = document.createElement('div');
  row.className = 'suggestion pending';
  row.innerHTML = `<div class="suggestAsk">✦ ${esc(ask)}</div><div class="suggestBody" data-i18n-skip></div>`;
  box.appendChild(row);
  box.classList.remove('empty');

  const body = row.querySelector('.suggestBody');
  body.textContent = '…';
  let text = '';

  try {
    // An answer that was stored is extended in place and the suggestion is
    // kept; one that was never stored — the Oracle's — is extended for as long
    // as the page is open, which is exactly as long as the answer itself lasts.
    const saved = typeof target === 'number' || target?.messageId != null;
    const url = saved
      ? `/api/messages/${target?.messageId ?? target}/suggest`
      : '/api/suggest';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(saved ? { ask } : { ask, answer: target.answer, question: target.question }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

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
          if (!text) body.textContent = '';
          text += v;
          body.textContent = text;
        } else if (type === 'error') {
          throw new Error(v);
        } else if (type === 'done') {
          if (v.suggestion) row.dataset.suggestion = v.suggestion.id;
          if (!text && v.text) { text = v.text; body.textContent = text; }
          onDone?.(v.suggestion ?? { content: v.text });
        }
      }
    }
    row.classList.remove('pending');
    return text;
  } catch (err) {
    row.classList.remove('pending');
    row.classList.add('bad');
    body.textContent = `⚠ ${err.message}`;
    return null;
  }
}

/** The block that holds an answer's suggestions, made on demand. */
export function suggestionBox(wrap) {
  let box = wrap.querySelector(':scope > .suggestions');
  if (!box) {
    box = document.createElement('div');
    box.className = 'suggestions empty';
    wrap.appendChild(box);
  }
  return box;
}

/** Draw the suggestions an answer already carries, oldest first. */
export function renderSuggestions(box, rows, { onRemove } = {}) {
  box.innerHTML = '';
  box.classList.toggle('empty', !rows.length);
  for (const s of rows) {
    const row = document.createElement('div');
    row.className = 'suggestion';
    row.dataset.suggestion = s.id;
    row.innerHTML = `<div class="suggestAsk">✦ ${esc(s.ask)}</div>`
      + `<div class="suggestBody" data-i18n-skip>${esc(s.content)}</div>`;
    if (onRemove) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'suggestDrop';
      x.textContent = '✕';
      x.title = 'Remove this suggestion';
      x.addEventListener('click', async () => {
        await fetch(`/api/suggestions/${s.id}`, { method: 'DELETE' });
        row.remove();
        box.classList.toggle('empty', !box.children.length);
        onRemove(s.id);
      });
      row.querySelector('.suggestAsk').appendChild(x);
    }
    box.appendChild(row);
  }
}
