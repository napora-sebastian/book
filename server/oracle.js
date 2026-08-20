/**
 * The Oracle — inference *over the archive* rather than over a document.
 *
 * Every other inference path in this app answers from one document that the
 * caller already chose. The Oracle is asked things like "where did we settle
 * the ending of chapter one?" — a question whose hard part is finding the
 * conversation, not answering it. So the model gets no text up front. It gets
 * a catalogue of threads and a search tool, and it works in rounds:
 *
 *   plan  → search the archive → read what came back → plan again → answer
 *
 * The rounds are a JSON protocol over plain completions, not OpenAI function
 * calling: llm.js speaks to whatever endpoint the settings plugin points at,
 * and a local vLLM build is not guaranteed to have tool support compiled in.
 * A JSON object is the one thing every one of them can emit.
 *
 * Mounting is two lines in server/index.js; deleting them removes the feature
 * whole, the same contract the llm-settings plugin has.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rawDb from './db.js';
import * as db from './db.js';
import { threadPart, graphPart, wrapParts } from './sources.js';
import * as llm from './llm.js';
import { ensureIndex, searchThreads, searchMessages } from './search.js';
import { runCalls, toolCatalogue, toolsRunBlock, parseSlash, TOOLS } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ budgets */

// A round trip per search round, so the loop has to stop somewhere. Three is
// enough for "search → nothing useful → search differently → read → answer"
// and cheap enough that a miss costs seconds, not a minute.
const MAX_ROUNDS = Number(process.env.ORACLE_MAX_ROUNDS || 3);
const MAX_THREADS_IN_CATALOGUE = Number(process.env.ORACLE_CATALOGUE || 120);
// What one opened conversation may contribute, and what all of them may
// contribute together. The cluster's budget is shared between prompt and
// completion — evidence that fills the window leaves no room for the answer.
const PER_MESSAGE_CHARS = Number(process.env.ORACLE_MESSAGE_CHARS || 1_200);
const PER_THREAD_CHARS = Number(process.env.ORACLE_THREAD_CHARS || 12_000);
const TOTAL_EVIDENCE_CHARS = Number(process.env.ORACLE_EVIDENCE_CHARS || 60_000);
// What the user pins to a question, all of it together. Separate from the
// evidence budget: retrieval is the Oracle's own choice and can be trimmed,
// a pin is an instruction — but it still cannot be unbounded.
const GIVEN_SOURCE_CHARS = Number(process.env.ORACLE_GIVEN_CHARS || 80_000);
// A thread's document is not part of its transcript, but it is what half the
// threads are actually about — and a thread with no messages at all IS its
// document. Without this the Oracle answers "the archive does not hold its
// text" about a file the archive is holding right there.
const DOC_EXCERPT_CHARS = Number(process.env.ORACLE_DOC_CHARS || 4_000);
const DOC_ONLY_CHARS = Number(process.env.ORACLE_DOC_ONLY_CHARS || 16_000);

/* ------------------------------------------------------------------ prompts */

const PLANNER = `You are the archivist of a local document lab. The user is looking at a deck of
past conversations, one in front and the rest standing behind it, and talks to you both to
find things in them and to steer the deck itself.

Reply with ONE JSON object and nothing else. No prose, no markdown fence.

FIRST decide which kind of instruction this is.

(1) The user wants the DECK MOVED — "go forward", "next one", "back two", "przejdź do
trzeciego", "show me record 12", "back to the start", "last one". Then reply ONLY with:

  {"navigate": {"to": "next"|"prev"|"first"|"last", "steps": 1},
   "say": "<one short line confirming it, in the user's language>"}

  or {"navigate": {"position": 3}, "say": "…"}   — the 3rd window in the deck as numbered
                                                   in the deck state below (03/07)
  or {"navigate": {"record": 12}, "say": "…"}    — the window whose id is REC 12

  Use "position" when the user counts windows ("the third one"), "record" when they name an
  id, and "to" + "steps" when they move relative to where they are. Never search here.

(2) The user is ASKING SOMETHING about what is in the archive. Then plan retrieval:

  {"thought": "<one short sentence, in the user's language>",
   "search": ["query", "another query"],
   "open": [12, 7],
   "answer": false}

  search  — up to 4 short keyword queries run against the full text of every message.
            Use the words that would actually appear in the conversation, not a question.
            Search in the language the archive is written in. Omit or leave empty when
            you have searched enough.
  open    — thread ids whose full transcript you want to read. Only ids that exist in the
            catalogue or in the search results. This is how you get evidence to answer from.
  answer  — true when what you have already opened is enough to answer. Then search and
            open are ignored.

Prefer opening one or two promising threads over searching a fourth time. If the catalogue
alone already identifies the thread by its title, open it immediately.

A question about the conversation currently in front of the deck ("what is this about?",
"o czym tu mówiliśmy?") is case (2) — open that record and answer from it.

(3) The user wants the WORKSPACE READ OR CHANGED — a graph laid out, material broken into
items and connected, a point moved. Then add calls to the same object:

  {"thought": "…", "calls": [{"tool": "graph_create", "args": {"title": "…"}}], "answer": false}

Calls run in order, and their results come back in <results> next round, so read before you
write and never invent an id. You are not standing on any graph here: a write needs a graphId,
or a graph_create earlier in the same list. Retrieval and calls can go in one object — search
finds the conversation, calls put it on a canvas.

Do NOT set "answer": true on a round whose calls have not run yet. A round that only read
something has not done the work — look at the results first, then write on the next round.

TOOLS

${toolCatalogue()}`;

const ANSWERER = `You are the archivist of a local document lab, talking to the user about their
own archive of past conversations with a model.

Answer from the transcripts supplied below and from nothing else. They are what was really
said; if they do not contain the answer, say plainly that the archive does not have it
rather than inventing what the user probably meant.

Cite the conversations you used as [#<thread id>] right where you use them, e.g.
"you settled on the bomb opening [#1]". Cite every thread you rely on.

Be concrete: name the thread, say when it happened, quote the short span that settles the
question. Answer in the language the user asked in, even when the archive is in another one.

If a <tools-run> block is present you also changed something. Say what you did in one or two
sentences, naming what you created or moved. Do not list the calls back to the user, and never
claim a call that came back ERROR took effect.`;

/* ------------------------------------------------------------------ helpers */

const clip = (s, n) => {
  const text = String(s ?? '');
  return text.length <= n ? text : `${text.slice(0, n)}… [${text.length - n} more chars]`;
};

/**
 * Gallery/catalogue row. `opening` and `latest` are what the shard shows on its
 * face, so they are cut here — a gallery of 200 threads must not ship 200 full
 * transcripts to the browser.
 */
const GALLERY_SQL = `
  SELECT t.id, t.title, t.model, t.created_at, t.updated_at, t.document_id,
         d.filename, d.kind AS doc_kind, d.chars AS doc_chars, d.pages AS doc_pages,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.error IS NOT NULL) AS error_count,
         (SELECT m.content FROM messages m
           WHERE m.thread_id = t.id AND m.role = 'user' ORDER BY m.id ASC LIMIT 1) AS opening,
         (SELECT m.content FROM messages m
           WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS latest,
         (SELECT m.created_at FROM messages m
           WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_at,
         (SELECT COALESCE(SUM(tr.total_tokens), 0) FROM traces tr WHERE tr.thread_id = t.id) AS tokens
    FROM threads t
    LEFT JOIN documents d ON d.id = t.document_id
   ORDER BY t.updated_at DESC, t.id DESC`;

function gallery() {
  return rawDb.prepare(GALLERY_SQL).all().map((row) => ({
    ...row,
    opening: clip(row.opening, 320),
    latest: clip(row.latest, 320),
  }));
}

/**
 * The deck as the user currently sees it: which window is in front, and what
 * order the rest stand in. Positions are 1-based because that is what the
 * console prints ("03 / 07") and therefore what the user counts.
 */
function deckText(deck) {
  const records = Array.isArray(deck?.records) ? deck.records.slice(0, 60) : [];
  if (!records.length) return '';
  const at = Number(deck.position) || 1;
  const lines = records
    .map((r, i) => `  ${String(i + 1).padStart(2, '0')}. REC ${r.id} — ${String(r.title ?? '').slice(0, 70)}${
      i + 1 === at ? '   ← IN FRONT' : ''}`)
    .join('\n');
  return `<deck position="${at}" total="${records.length}">\n${lines}\n</deck>`;
}

/** One line per thread — everything the planner knows before it searches. */
function catalogueText(rows) {
  return rows
    .slice(0, MAX_THREADS_IN_CATALOGUE)
    .map((r) => {
      const doc = r.filename ? ` · doc: ${r.filename}` : ' · no document';
      return `#${r.id} · ${r.title}${doc} · ${r.message_count} messages · updated ${r.updated_at}`;
    })
    .join('\n');
}

/**
 * Full transcript of one thread, trimmed to fit a shared budget.
 *
 * Middle-out: the first and last turns of a conversation are what identify it
 * and what conclude it, so a long thread loses its middle rather than its end.
 */
function transcriptFor(threadId, budget) {
  const thread = db.getThread(threadId);
  if (!thread) return null;

  const messages = db.getMessages(threadId);
  const lines = messages.map((m) => {
    const who = m.role === 'user' ? 'USER' : 'MODEL';
    return `[msg ${m.id} · ${m.created_at}] ${who}: ${clip(m.content, PER_MESSAGE_CHARS)}`;
  });

  // How much of the document comes along: a slice for context when there is a
  // conversation to read, and much more when the document is all there is.
  let docBlock = '';
  if (thread.document_id) {
    const doc = db.getDocument(thread.document_id);
    if (doc?.text) {
      const room = messages.length ? DOC_EXCERPT_CHARS : DOC_ONLY_CHARS;
      docBlock = `<document filename="${doc.filename}" chars="${doc.chars}">\n${
        clip(doc.text, Math.min(room, budget))}\n</document>\n\n`;
    }
  }

  let body = lines.join('\n\n');
  const room = Math.max(600, budget - docBlock.length);
  if (body.length > room) {
    const head = Math.ceil(room * 0.6);
    const tail = Math.floor(room * 0.4);
    body = `${body.slice(0, head)}\n\n[… middle of this conversation elided …]\n\n${body.slice(-tail)}`;
  }

  const doc = thread.filename ? `document: ${thread.filename}` : 'no document';
  return {
    threadId,
    title: thread.title,
    text: `<conversation id="${threadId}" title="${thread.title}" ${doc} started="${thread.created_at}">\n${
      docBlock}${body || 'This conversation has no messages — the document above is all it holds.'}\n</conversation>`,
  };
}

/** Strip a fence, take the outermost object. Models add prose no matter what. */
function parsePlan(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function traceOracle({ kind, model, messages, result, status, error, started }) {
  try {
    return db.addTrace({
      threadId: null,
      kind,
      task: 'oracle',
      model,
      servedModel: result?.servedModel,
      baseUrl: result?.baseUrl ?? llm.config().baseUrl,
      fingerprint: result?.fingerprint,
      requestJson: JSON.stringify(messages),
      requestParams: JSON.stringify({ oracle: true, rounds: MAX_ROUNDS }),
      promptChars: messages.reduce((n, m) => n + m.content.length, 0),
      promptMessages: messages.length,
      responseText: result?.text ?? '',
      reasoningText: result?.reasoning || null,
      usage: result?.usage ?? null,
      ttftMs: result?.ttftMs ?? null,
      durationMs: result?.durationMs ?? (started ? Date.now() - started : null),
      status: status ?? 'ok',
      error: error ?? null,
      finishReason: result?.finishReason ?? null,
    });
  } catch (err) {
    console.error('oracle trace failed:', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------- mount */

export function mountOracle(app) {
  const index = ensureIndex();
  if (index.rebuilt) console.log(`  archive index  →  built for ${index.indexed} messages`);

  const publicDir = path.join(__dirname, '..', 'public', 'grimoire');

  // The view itself. Static already serves /grimoire/, this is the clean URL.
  app.get('/grimoire', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.get('/api/oracle/gallery', (_req, res) => {
    const threads = gallery();
    res.json({
      threads,
      documents: db.listDocuments().map(({ text, data, ...rest }) => rest),
      stats: db.stats(),
    });
  });

  /** Plain (non-AI) search — what the gallery's own search box runs. */
  app.get('/api/oracle/search', (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Number(req.query.limit) || 20, 60);
    if (!q.trim()) return res.json({ q, threads: [], messages: [] });
    res.json({
      q,
      threads: searchThreads(q, { limit }),
      messages: searchMessages(q, { limit: limit * 2, prefix: true }).slice(0, limit * 2),
    });
  });

  app.get('/api/oracle/threads/:id', (req, res) => {
    const id = Number(req.params.id);
    const thread = db.getThread(id);
    if (!thread) return res.status(404).json({ error: 'No such thread.' });
    const { text, data, ...rest } = thread;

    // The window needs to know a document is there before it offers to show it
    // — and how many versions there are, so the tab can say so without a
    // second round trip on every record you pass through.
    let document = null;
    if (thread.document_id) {
      const doc = db.getDocument(thread.document_id);
      if (doc) {
        const versions = db.listDocumentVersions(doc.id);
        document = {
          id: doc.id,
          filename: doc.filename,
          kind: doc.kind,
          chars: doc.chars,
          words: doc.words,
          pages: doc.pages,
          created_at: doc.created_at,
          versions: versions.length || 1,
          // The newest version NUMBER, which is not the count once a version in
          // the middle has been removed — an export link built from the count
          // would ask for a version that no longer exists.
          newest: versions[0]?.version ?? 1,
        };
      }
    }

    // Shipped with the transcript rather than fetched per answer: a record
    // window is redrawn as one string, and a fetch landing mid-render would
    // wipe whichever suggestions had arrived.
    res.json({
      thread: rest,
      messages: db.getMessages(id),
      suggestions: db.listThreadSuggestions(id),
      document,
    });
  });

  /**
   * Ask the archive. SSE, same event shape as the main chat stream so the
   * client-side reader is the same shape too.
   *
   * body: { question, history?: [{role, content}], model? }
   */
  app.post('/api/oracle/ask', async (req, res) => {
    const { question, history = [], model, deck, sources: pinned } = req.body || {};
    const raw = String(question ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'Empty question.' });
    // `/toolname …` names the tool instead of leaving the choice to the planner.
    // The command comes off the front so the archivist answers what was meant.
    const slash = parseSlash(raw);
    const ask = slash ? (slash.rest || raw) : raw;

    const chosenModel = model || llm.config().model;
    if (!chosenModel) return res.status(400).json({ error: 'No model configured — open the LLM settings.' });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (type, v) => res.write(`data: ${JSON.stringify({ type, v })}\n\n`);

    const abort = new AbortController();
    // On `res`, not `req` — express.json() closes the request stream as soon as
    // it has read the body, which would abort the turn before it starts.
    res.on('close', () => abort.abort());

    // The chat so far, so "and the one before that?" resolves. Capped: the
    // Oracle's own history is not the point of its context budget.
    const priorChat = asArray(history)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-8)
      .map((m) => ({ role: m.role, content: clip(m.content, 2_000) }));

    const rows = gallery();
    const catalogue = catalogueText(rows);

    // Sources the user pinned to this question: conversations, and whole graphs
    // — which retrieval cannot reach at all, since it searches transcripts and
    // a graph is a shape over them. Pinned means given: they are in front of the
    // planner from round one and in front of the answerer at the end, whether or
    // not any search would have found them.
    const givenParts = [];
    let givenLeft = GIVEN_SOURCE_CHARS;
    for (const raw of asArray(pinned)) {
      const id = Number(raw?.id);
      if (!Number.isInteger(id) || givenLeft <= 0) continue;
      const part = raw?.kind === 'graph'
        ? graphPart(id)
        : threadPart({ threadId: id, mode: raw?.mode === 'last' ? 'last' : 'full' });
      if (!part?.text?.trim()) continue;
      // A pinned graph can be very large, and the Oracle has no map-reduce to
      // fall back on: the pins share one ceiling, and a source that overruns it
      // is cut rather than allowed to end the turn with a context error.
      if (part.text.length > givenLeft) {
        part.text = `${part.text.slice(0, givenLeft)}\n\n[cut — too large to give in full]`;
        part.detail = `${part.detail ?? ''}${part.detail ? ', ' : ''}cut to fit`;
      }
      givenLeft -= part.text.length;
      givenParts.push(part);
    }
    const given = givenParts.length
      ? `<given-sources>\nThe user pinned these to the question. They are given, not retrieved — read them first.\n\n${
        wrapParts(givenParts, { header: false, unwrapLoneBook: false }).text}\n</given-sources>`
      : '';
    // Where the user is standing in the deck. Without it "the third one" and
    // "the next" have nothing to resolve against.
    const deckState = deckText(deck);
    const findings = [];              // what search returned, as text for the planner
    const opened = new Map();         // threadId → transcript, deduped across rounds
    const searched = [];              // every query issued, for the UI
    let budget = TOTAL_EVIDENCE_CHARS;
    // The Oracle stands on no graph: a write has to name one, or make one. The
    // context object is shared across rounds so that a graph_create in round one
    // is where round two writes without the model repeating the id.
    const toolCtx = { threadId: null, graphId: null };
    const toolLines = [];
    let touched = false;

    const openThread = (id) => {
      if (opened.has(id) || budget <= 0) return null;
      const t = transcriptFor(id, Math.min(PER_THREAD_CHARS, budget));
      if (!t) return null;
      opened.set(id, t);
      budget -= t.text.length;
      return t;
    };

    try {
      send('stage', 'consulting the archive…');

      /* ------------------------------------------------- retrieval rounds */
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (abort.signal.aborted) return;

        const planMessages = [
          { role: 'system', content: PLANNER },
          {
            role: 'user',
            content: [
              `<archive-catalogue count="${rows.length}">\n${catalogue}\n</archive-catalogue>`,
              deckState,
              given,
              slash ? `<chosen-tool>\nThe user typed /${slash.tool}. They have ALREADY CHOSEN `
                + `that tool — put it in "calls" with arguments filled in from what they wrote, `
                + `and do not substitute another.\n\n  ${slash.tool} ${TOOLS[slash.tool].args}\n`
                + `      ${TOOLS[slash.tool].describe}\n</chosen-tool>` : '',
              findings.length ? `<findings>\n${findings.join('\n\n')}\n</findings>` : '',
              opened.size ? `<already-open>${[...opened.keys()].map((id) => `#${id}`).join(', ')}</already-open>` : '',
              priorChat.length
                ? `<chat-so-far>\n${priorChat.map((m) => `${m.role}: ${m.content}`).join('\n')}\n</chat-so-far>`
                : '',
              `<question>${ask}</question>`,
              `Round ${round} of ${MAX_ROUNDS}. JSON only.`,
            ].filter(Boolean).join('\n\n'),
          },
        ];

        const started = Date.now();
        const result = await llm.complete(planMessages, { model: chosenModel, signal: abort.signal });
        traceOracle({ kind: 'oracle-plan', model: chosenModel, messages: planMessages, result, started });

        const plan = parsePlan(result.text);
        // A model that will not emit JSON must not deadlock the loop: take
        // whatever was opened so far (or the top text hits) and answer.
        if (!plan) {
          send('stage', 'planner returned no plan — answering from the best text matches');
          for (const hit of searchThreads(ask, { limit: 3 })) openThread(hit.threadId);
          break;
        }

        // A movement instruction is answered by moving, not by retrieval: no
        // search, no transcripts, one call and done.
        if (plan.navigate && typeof plan.navigate === 'object') {
          const say = String(plan.say || 'Moving the deck.').slice(0, 200);
          send('navigate', plan.navigate);
          send('token', say);
          send('done', {
            text: say,
            model: chosenModel,
            searched: [],
            sources: [],
            navigated: plan.navigate,
            usage: result.usage ?? null,
            ms: Date.now() - started,
          });
          return;
        }

        if (plan.thought) send('thought', String(plan.thought).slice(0, 300));

        const queries = asArray(plan.search).map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
        for (const q of queries) {
          if (abort.signal.aborted) return;
          searched.push(q);
          send('stage', `searching: ${q}`);

          const hits = searchThreads(q, { limit: 6 });
          send('hits', { query: q, hits });
          findings.push(
            hits.length
              ? `search "${q}":\n${hits
                  .map((h) => `  #${h.threadId} "${h.title}" (${h.hits} hits) — ${clip(h.matches[0]?.snippet, 200)}`)
                  .join('\n')}`
              : `search "${q}": nothing in the archive matches.`,
          );
        }

        for (const id of asArray(plan.open).map(Number).filter(Number.isInteger)) {
          const t = openThread(id);
          if (t) {
            send('stage', `reading #${id} — ${t.title}`);
            send('opened', { threadId: id, title: t.title });
          }
        }

        // Reading the archive and rearranging it are the same instruction as
        // often as not — "find where we settled the ending and put it on a
        // canvas with the chapter" — so calls run in the same round as the
        // search that found what they act on.
        const calls = asArray(plan.calls);
        if (calls.length) {
          send('stage', `running ${calls.length} tool call${calls.length > 1 ? 's' : ''}`);
          try {
            const ran = runCalls(calls, toolCtx, { send, signal: abort.signal });
            toolLines.push(...ran.lines);
            findings.push(...ran.lines);
            touched = touched || ran.canvasTouched;

            // A tool the user named after a slash has one job, and it just did
            // it. Without this the next round is free to call it AGAIN — and
            // for a write like graph_create that is not a wasted call, it is a
            // second graph appearing on the shelf that nobody asked for.
            if (slash && ran.entries.some((c) => c.ok && c.tool === slash.tool)) break;
          } catch (err) {
            // runCalls turns a failing tool into a result; anything that still
            // escapes it is a bug, and the archive question is still answerable.
            send('stage', `tools failed (${err.message}) — answering from the archive`);
            findings.push(`tool calls failed: ${err.message}`);
          }
        }

        if (plan.answer === true) break;
        // Nothing left to try: no new queries, nothing new opened, nothing run,
        // and the model did not say it was ready. Another identical round would
        // only burn a call.
        if (!queries.length && !asArray(plan.open).length && !calls.length) break;
      }

      if (abort.signal.aborted) return;

      // Nothing was opened: either the planner searched and never opened what it
      // found, or it declared itself ready on the first round without looking at
      // anything. Both end with a model answering from an empty archive, which
      // is how a retrieval system invents things — so retrieve something first,
      // from its own queries if it made any and from the question if it did not.
      if (!opened.size && !toolLines.length) {
        const lastResort = searched.length ? searched.join(' ') : ask;
        for (const hit of searchThreads(lastResort, { limit: 3 })) openThread(hit.threadId);
      }

      /* -------------------------------------------------------- the answer */
      const evidence = [...opened.values()];
      send('sources', evidence.map((t) => ({ threadId: t.threadId, title: t.title })));
      send('stage', evidence.length
        ? `answering from ${evidence.length} conversation${evidence.length > 1 ? 's' : ''}`
        : 'nothing in the archive matches — answering anyway');

      const answerMessages = [
        { role: 'system', content: ANSWERER },
        ...priorChat,
        {
          role: 'user',
          content: [
            `<archive-catalogue count="${rows.length}">\n${catalogue}\n</archive-catalogue>`,
            given,
            evidence.length
              ? `<transcripts>\n${evidence.map((t) => t.text).join('\n\n')}\n</transcripts>`
              : toolLines.length
                ? ''
                : '<transcripts>Nothing in the archive matched this question.</transcripts>',
            toolLines.length ? toolsRunBlock(toolLines) : '',
            ask,
          ].filter(Boolean).join('\n\n'),
        },
      ];

      let answer = '';
      const started = Date.now();
      const result = await llm.stream(answerMessages, {
        model: chosenModel,
        signal: abort.signal,
        onToken: (t) => { answer += t; send('token', t); },
        onThinking: (t) => send('thinking', t),
        onFallback: ({ failed, error, next }) =>
          send('stage', `${failed.label} unavailable (${error}) — falling back to ${next.label}`),
      });
      traceOracle({ kind: 'oracle', model: chosenModel, messages: answerMessages, result, started });

      send('done', {
        text: result.text || answer,
        model: result.model || chosenModel,
        searched,
        sources: evidence.map((t) => ({ threadId: t.threadId, title: t.title })),
        usage: result.usage ?? null,
        ms: Date.now() - started,
        // A graph view open elsewhere is now stale — say so rather than letting
        // the user wonder why their canvas has not changed.
        touched,
      });
    } catch (err) {
      if (!abort.signal.aborted) {
        traceOracle({ kind: 'oracle', model: chosenModel, messages: [], status: 'error', error: err.message });
        send('error', err.message);
      }
    } finally {
      res.end();
    }
  });
}
