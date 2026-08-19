/* ===========================================================================
   Naming — what a conversation or a graph should be called.

   Everything in the archive is created before it is understood: a record is
   opened on a book and named after the file, a graph is named "New graph"
   because the work in it has not happened yet. The name is the handle the
   deck, the atlas and every picker offer it by, so a stale one costs more
   the longer the archive gets.

   Two halves, and they are deliberately separate:

     · renaming is a plain write, offered wherever the thing is listed;
     · *suggesting* a name is a read of what is actually in it, run through
       the model — and it is only ever a suggestion. The route returns a
       string. Nothing is written until the user accepts it, which is why
       there is no "auto-rename" endpoint here: the model proposes, the user
       disposes.
   =========================================================================== */

import * as db from './db.js';
import * as llm from './llm.js';

const SYSTEM = `You name things in a personal writing archive, running locally on a DGX Spark
cluster. Given what is inside a conversation or a graph of conversations, reply with a short
title for it.

Rules:
- Reply with ONLY the title. No preamble, no quotation marks, no markdown, no trailing period.
- Two to six words. It has to fit a narrow list in a sidebar.
- Name the actual subject and the work being done on it — not the format. Never answer
  "Conversation about a document", "Chat", "Discussion" or "Untitled".
- Write it in the same language as the material you were given.`;

/** How much of any one message is worth reading to name the whole thing. */
const SNIP = 700;

const clip = (s, n = SNIP) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

/**
 * The model is asked for a bare title and mostly gives one. This is the
 * hedge against the times it does not: a fence, a "Title:" prefix, quotes it
 * put around the words, or a second line explaining its choice.
 */
export function cleanTitle(raw, { max = 70 } = {}) {
  let title = String(raw ?? '')
    .replace(/```[a-z]*\n?/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

  title = title.replace(/^(?:title|name|suggested title)\s*[:—-]\s*/i, '').replace(/\s+/g, ' ').trim();

  // Wrappers and end punctuation come off in any order the model put them in:
  // `**Bold name**.` has to lose the stop before the asterisks are the edge.
  let trimmed = true;
  while (trimmed) {
    const before = title;
    title = title.replace(/[.。!]+$/, '').replace(/^["'“”‘’*`_]+|["'“”‘’*`_]+$/g, '').trim();
    trimmed = title !== before;
  }

  if (title.length > max) {
    // Cut on a word so the suggestion never arrives visibly truncated.
    const cut = title.slice(0, max);
    const space = cut.lastIndexOf(' ');
    title = (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
  }
  return title;
}

/* ------------------------------------------------------------- what to read */

/**
 * A conversation, as much of it as naming needs: the book it stands on, the
 * question that opened it, and the last exchange. The middle of a long
 * transcript is the least useful part to a title — the subject is set at the
 * top and the current state of the work is at the bottom.
 */
export function buildThreadTitleMessages(thread, messages) {
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const first = turns.filter((m) => m.role === 'user').slice(0, 2);
  const tail = turns.slice(-3).filter((m) => !first.includes(m));

  const body = [...first, ...tail]
    .map((m) => `${m.role === 'user' ? 'ASKED' : 'ANSWERED'}: ${clip(m.content)}`)
    .join('\n\n');

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Name this conversation.

${thread.filename ? `It is about the document: ${thread.filename}\n` : ''}Its current name is "${thread.title}"${
        turns.length ? '' : ' and nothing has been asked in it yet'}.

${body || '(The conversation is empty — name it after the document it stands on.)'}

Reply with the title only.`,
    },
  ];
}

/**
 * A graph, as its points: which books it stands on and what was asked of each
 * conversation growing out of them. A graph is one line of work, so the shape
 * of the questions is the thing being named — not any single answer.
 */
export function buildGraphTitleMessages(graph, nodes) {
  const books = nodes
    .filter((n) => n.kind === 'document')
    .map((n) => `SOURCE BOOK: ${n.doc_filename ?? 'missing'}`);

  const threads = nodes
    .filter((n) => n.kind === 'thread')
    .map((n) => {
      const asked = clip(n.last_user, 300);
      const said = clip(n.last_answer, 300);
      return `CONVERSATION: ${n.label || n.thread_title || 'untitled'}${
        asked ? `\n  asked: ${asked}` : ''}${said ? `\n  answered: ${said}` : ''}`;
    });

  const body = [...books, ...threads].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Name this graph. A graph is one line of work: a source, and everything grown out of it.

Its current name is "${graph.title}". It holds ${nodes.length} point${nodes.length === 1 ? '' : 's'}:

${body || '(The graph is empty.)'}

Reply with the title only.`,
    },
  ];
}

/* -------------------------------------------------------------- the routes */

/** Gather a thread and the prompt that names it, or throw a 404-shaped error. */
export function threadTitlePrompt(id) {
  const thread = db.getThread(id);
  if (!thread) return null;
  return { subject: thread, messages: buildThreadTitleMessages(thread, db.getMessages(id)) };
}

/** The same for a graph, read as its points. */
export function graphTitlePrompt(id) {
  const graph = db.getGraph(id);
  if (!graph) return null;
  return { subject: graph, messages: buildGraphTitleMessages(graph, db.listGraphNodes(id)) };
}

/**
 * Ask the model, and insist on something usable. An empty or unchanged answer
 * is reported as a failure rather than handed back as a suggestion — a dialog
 * that offers the name it already has is worse than one that says it could
 * not think of a better one.
 */
export async function suggestTitle(messages, { model } = {}) {
  const chosenModel = model || llm.config().model;
  const result = await llm.complete(messages, { model: chosenModel });
  const title = cleanTitle(result.text);
  if (!title) throw new Error('The model returned an empty name. Try again.');
  return { title, model: result.servedModel || chosenModel, result, chosenModel };
}
