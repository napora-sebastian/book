/* Translations.

   The app builds almost all of its UI as HTML strings pushed through innerHTML,
   across four routes and ~8,000 lines. Threading a t('key') call through every
   one of those would have touched every render function in the codebase, so the
   translation happens one step later instead: at the DOM.

   A phrase table maps the English source text — the text that is already in the
   markup — to its Polish. A MutationObserver watches for nodes being added and
   rewrites the text nodes and the visible attributes (title, placeholder,
   aria-label, alt) whose whole content is a phrase the table knows. Every
   rewrite stashes the original, so switching language back is a restore rather
   than a reverse-lookup, and switching happens live — no reload, no lost draft.

   Consequences worth knowing:
   · A string only translates if the table has it whole. Half-matches never
     happen, so an untranslated phrase shows in English rather than in pieces.
   · Text the user or the model wrote must never be touched. Containers holding
     it carry data-i18n-skip, and the walker refuses to descend into those.
   · Code strings ('Escape', 'POST', a model id) are invisible to this. It only
     ever reads the DOM. */

import { pl } from './i18n.pl.js';

export const LANGS = {
  en: { flag: '🇬🇧', name: 'English', label: 'EN' },
  pl: { flag: '🇵🇱', name: 'Polski', label: 'PL' },
};

const TABLES = { en: null, pl };
const KEY = 'spark.lang';
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
/* Their content is a value, not a label: a textarea's text is what the user
   typed, and script/style are not language at all. */
const OPAQUE = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

/* Everything the user or the model wrote, named once here rather than tagged at
   several hundred render sites. A document called "Preview" is the collision
   this prevents: without the list its title would turn into "Podgląd" the
   moment it was drawn. Anything else can opt out with data-i18n-skip. */
export const SKIP_SEL = [
  '[data-i18n-skip]',
  '.body', '.bubble', '.thinkBody', '.said', '.docText', '.previewText',        // messages and documents
  '.previewEdit', '.oracleTurn.you', '.oracleAns',
  '.noteRead', '.toolSay', '.toolList',                                         // notes, and the tool log
  '.srcMeta', '.srcWhy', '.srcFindSay',                                         // the source picker's own text
  /* .srcTag is deliberately NOT here: it names a kind of thing — CHAT, NOTE,
     GRAPH — which is a label like any other and should be translated. */
  '.suggestBody', '.suggestAsk', '.slashHint',                                  // suggestions, and the tool menu
  '.diffView', '.dText', '.dLine', '.hunk',                                     // diffs are document text
  '.nodeTitle', '.nodePreview', '.nodeLive', '.nodeStage',                      // graph cards
  /* .threadTitle is deliberately NOT here: the one string it holds that is not
     a conversation's name — "No thread open" — is a label, and a title that
     happened to read exactly like a button is a curiosity, not a loss. */
  '.winTitle', '.thread .t', '.thread .s',                                      // titles from the database
  '.pickText', '.pickName', '.srcPickName', '.srcName', '.sourceName',          // pickers listing records
  '.atlasName', '.diffFileName',
].join(', ');

let current = read();
const listeners = new Set();
/* Set while we are the ones writing, so the observer does not answer its own
   mutations. */
let applying = false;

function read() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved in LANGS) return saved;
  } catch { /* private mode: fall through to the browser's own preference */ }
  return String(navigator.language || 'en').toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

export function lang() { return current; }

/* ---- the lookup ---------------------------------------------------------- */

const sentenceCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

/* The text coming out of the DOM has had its whitespace collapsed, so the table
   has to be looked at the same way — a key written with the two spaces the
   markup uses would otherwise never be found. Built once per table. */
const collapsed = new WeakMap();
function flat(table) {
  let map = collapsed.get(table);
  if (!map) {
    map = new Map();
    for (const [k, v] of Object.entries(table)) {
      if (k === '@patterns') continue;
      map.set(k.replace(/\s+/g, ' ').trim(), v);
    }
    collapsed.set(table, map);
  }
  return map;
}

function direct(table, s) {
  const map = flat(table);
  if (map.has(s)) return map.get(s);
  /* Half the HUD is the same word shouted: SAVE SOURCES beside Save sources.
     One entry serves both — find the sentence the caps came from, then shout
     the answer back. */
  if (s === s.toUpperCase() && /\p{Lu}/u.test(s)) {
    for (const form of [sentenceCase(s), titleCase(s), s.toLowerCase()]) {
      if (map.has(form)) return map.get(form).toUpperCase();
    }
  }
  return null;
}

/* Button labels carry a glyph and the word: "⁂ SOURCES", "← Back to preview".
   The glyph is not language, so it is set aside and put back afterwards. Only a
   LEADING run is split off — a trailing "." or "…" belongs to the sentence and
   stays part of the key. */
const GLYPH = /^([^\p{L}\p{N}]+)(.+)$/u;

/* Patterns are for text with a number in it, which can never be a fixed key —
   "6 msg · draft.rtf · 58m ago" is three of them in one line, so they chain
   rather than stopping at the first hit. */
function patterned(table, raw) {
  let out = raw;
  for (const [re, rep] of table['@patterns'] ?? []) {
    if (re.test(out)) out = out.replace(re, rep);   // rep may be a function
  }
  return out === raw ? null : out;
}

function lookup(table, raw) {
  const whole = direct(table, raw) ?? patterned(table, raw);
  if (whole != null) return whole;
  const m = raw.match(GLYPH);
  if (m) {
    const inner = m[2].trim();
    const hit = direct(table, inner) ?? patterned(table, inner);
    if (hit != null) return m[1] + hit;
  }
  return null;
}

/** Translate one string. Unknown text comes back unchanged, so a missing entry
    shows English rather than a key. */
export function t(text) {
  const table = TABLES[current];
  if (!table || text == null) return text;
  /* Markup wraps: a paragraph in the HTML is one phrase with a newline and ten
     spaces in the middle of it, and the table holds it as one line. */
  const raw = String(text).trim().replace(/\s+/g, ' ');
  if (!raw) return text;
  const hit = lookup(table, raw);
  if (hit == null) return text;
  /* Put the surrounding whitespace back — markup indentation is load-bearing
     for inline layout. */
  const [, before, , after] = String(text).match(/^(\s*)([\s\S]*?)(\s*)$/);
  return before + hit + after;
}

/* ---- applying it to the page --------------------------------------------- */

/* Originals live off to the side rather than in the DOM: a data-* attribute
   holding the English of every button would be shipped to the user and would
   show up in anything that reads outerHTML. */
const textSrc = new WeakMap();   // text node  -> English
const attrSrc = new WeakMap();   // element    -> { attr: English }

function english(node) {
  if (!textSrc.has(node)) textSrc.set(node, node.nodeValue);
  return textSrc.get(node);
}

function translateNode(node) {
  const src = english(node);
  const next = t(src);
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttrs(el) {
  let store = attrSrc.get(el);
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr) && !store?.[attr]) continue;
    if (!store) { store = {}; attrSrc.set(el, store); }
    if (!(attr in store)) store[attr] = el.getAttribute(attr);
    const next = t(store[attr]);
    if (next != null && el.getAttribute(attr) !== next) el.setAttribute(attr, next);
  }
}

/** Walk a subtree and translate everything in it that is a label. */
export function translateTree(root) {
  if (!root || applying) return;
  applying = true;
  try {
    /* A bare text node arrives whenever code does el.textContent = …, which is
       exactly how the streaming answer is written — so its parent decides. */
    if (root.nodeType === Node.TEXT_NODE) {
      if (!root.parentElement?.closest(SKIP_SEL)) translateNode(root);
      return;
    }
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of root.children) walk(child);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.closest(SKIP_SEL)) return;
    walk(root);
  } finally {
    applying = false;
    observer?.takeRecords();     // our own writes are not news
  }
}

function walk(el) {
  /* Attributes first, and for an opaque element they are the only thing worth
     having: a textarea's placeholder is a label, its contents are what the user
     typed. */
  translateAttrs(el);
  if (OPAQUE.has(el.tagName)) return;
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.trim()) translateNode(node);
    } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches(SKIP_SEL)) {
      walk(node);
    }
  }
}

let observer = null;

function watch() {
  observer = new MutationObserver((records) => {
    if (applying) return;
    for (const r of records) {
      if (r.type === 'attributes') { applying = true; try { translateAttrs(r.target); } finally { applying = false; } }
      else for (const node of r.addedNodes) translateTree(node);
    }
    /* Views that build their own bar — the constellation writes its HUD from a
       template after this module has already booted — get their switch here. */
    if (document.querySelector('[data-lang-mount]:empty')) mountLangSwitch();
    observer.takeRecords();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ATTRS,
  });
}

/* ---- switching ----------------------------------------------------------- */

/** Run fn whenever the language changes — for views that must be rebuilt rather
    than retranslated (a canvas draws its own text; a chart re-lays out). */
export function onLang(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setLang(next) {
  if (!(next in LANGS) || next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* nothing to do about it */ }
  document.documentElement.lang = next;
  /* Everything already on the page still holds its English original, so this is
     a re-application and not a translation of a translation. */
  translateTree(document.documentElement);
  paintSwitches();
  for (const fn of listeners) { try { fn(next); } catch (err) { console.error(err); } }
}

/* ---- the switch itself --------------------------------------------------- */

const STYLE = `
.langSwitch { display: inline-flex; gap: 2px; align-items: center; vertical-align: middle; }
.langSwitch button {
  font: inherit; font-size: 15px; line-height: 1;
  padding: 4px 6px; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  filter: grayscale(1) opacity(.55); transition: filter .15s, border-color .15s, background .15s;
}
.langSwitch button:hover { filter: grayscale(.3) opacity(.9); }
.langSwitch button[aria-pressed="true"] { filter: none; border-color: currentColor; background: rgba(127,127,127,.14); }
`;

function paintSwitches() {
  for (const btn of document.querySelectorAll('.langSwitch button[data-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === current));
  }
}

/** Put a flag pair into every [data-lang-mount] on the page. Called on import,
    and again by any view that builds its bar late. */
export function mountLangSwitch(root = document) {
  for (const host of root.querySelectorAll?.('[data-lang-mount]') ?? []) {
    if (host.querySelector('.langSwitch')) continue;
    const box = document.createElement('div');
    /* The flags are not text to be translated, and the labels inside are the
       language's own name in that language — never the current one's. */
    box.className = 'langSwitch';
    box.setAttribute('data-i18n-skip', '');
    box.innerHTML = Object.entries(LANGS).map(([code, l]) =>
      `<button type="button" data-lang="${code}" title="${l.name}" aria-label="${l.name}">${l.flag}</button>`).join('');
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-lang]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();      // the bars around it hand clicks to other things
      setLang(btn.dataset.lang);
    });
    host.appendChild(box);
  }
  paintSwitches();
}

/* ---- boot ---------------------------------------------------------------- */

function boot() {
  if (!document.getElementById('i18nStyle')) {
    const style = document.createElement('style');
    style.id = 'i18nStyle';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  document.documentElement.lang = current;
  translateTree(document.documentElement);
  document.title = t(document.title);
  mountLangSwitch();
  watch();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
