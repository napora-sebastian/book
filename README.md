# Spark Doc Lab

Save a PDF or Word file to a local library, then hold a **threaded conversation**
about it with **DeepSeek-v4-Flash-DSpark-1M-NVFP4-KV-2x-DGX-Spark** running on
your DGX Spark GB10 cluster. Every thread is stored in SQLite, so you can close
the app and pick the conversation back up days later. Nothing leaves your network.

```
MacBook (192.168.0.247)                 DGX Spark "head" (192.168.0.80)
┌────────────────────────────┐          ┌────────────────────────────────┐
│ browser  → localhost:5173  │          │ LiteLLM proxy   :11111  ← used │
│ node server                │── /v1 ──▶│   ds4-max / ds4-high /         │
│  ├ pdfjs   (PDF → text)    │   LAN    │   ds4-non-thinking / ds4-max-0 │
│  └ mammoth (DOCX → text)   │          │ vLLM direct     :8890  (tp2)   │
└────────────────────────────┘          │   deepseek-v4-flash-0731       │
                                        └────────────────────────────────┘
```

Text extraction runs on the Mac — only plain text crosses to the cluster.

## Setup

```bash
npm install
cp .env.example .env     # already done
```

### 1. Reach the cluster

Already configured. The LiteLLM proxy on the **head** node listens on all
interfaces, so no tunnel is needed on this LAN:

```
LLM_BASE_URL=http://192.168.0.80:11111/v1
```

Your two Sparks, per NVIDIA Sync's ssh config:

| Alias | Hostname | IP | Serves |
| --- | --- | --- | --- |
| `head` | `aitopatom-4fc6.local` | **192.168.0.80** | LiteLLM :11111, vLLM :8890 |
| `asus` | `gx10-1419.local` | 192.168.0.52 | worker (no listener exposed) |

The IPs are DHCP — if they move, `npm run doctor` re-probes both hostnames.
If you ever move off this LAN, `npm run tunnel` forwards `head:11111` to
localhost instead.

### 2. Confirm the model answers

```bash
npm run doctor
```

**The model ids are not the checkpoint name.** The deployment is
`DeepSeek-v4-Flash-DSpark-1M-NVFP4-KV-2x-DGX-Spark`, but the APIs advertise:

| Endpoint | Model ids |
| --- | --- |
| LiteLLM :11111 | `ds4-max`, `ds4-high`, `ds4-non-thinking`, `ds4-max-0` |
| vLLM :8890 | `deepseek-v4-flash-0731` |

Use the LiteLLM ids — that proxy applies your `DSPARK_REASONING_MODE` handling.

### 3. Run

```bash
npm start             # http://localhost:5173
```

The header shows a green dot plus the model and host when the cluster is live,
red with the reason when it isn't.

## Using it

1. **Upload file…** extracts the text and saves the document to the library.
   Re-uploading the same file is deduped by SHA-256 of the extracted text, so
   the library never fills with copies.
2. Pick a document from the **saved files** dropdown (or `— no document —` for
   plain chat) and hit **New thread**.
3. Type and press Enter. Ask follow-ups — the model sees the whole conversation,
   so pronouns and back-references resolve:

   ```
   You  Who owns the load-test harness?
   →    Tomas owns the load-test harness.
   You  What is their deadline?                    ← "their" = Tomas
   →    "due end of quarter" — no exact date given.
   You  How does that compare to the other person's deadline?
   →    Maria's is 2026-09-15; Tomas's is only "end of quarter"…
   ```

4. **Stop** cancels the request on the cluster and keeps the partial answer in
   the thread rather than discarding it.

### Analysing a document vs. writing one

The task dropdown picks more than a wording preset — it picks which system
prompt the model runs under. There are three.

| Task | Runs as | Rule |
| --- | --- | --- |
| Summary, Key points, Action items, Entities, Ask a question, Translate, Custom | **document analyst** | Never invent; if it is not in the text, say so |
| **Rewrite / write** | **writing collaborator** | Produce finished prose in the manuscript's voice |
| **Chat** (the default) | both, per turn | Answer questions from the text only; write when asked to write |

The distinction is not cosmetic. The analyst prompt refuses authoring on
principle: asked to rewrite a chapter it answers, correctly by its own
instructions, *"I cannot make changes to the text or create new versions of
chapters"* — new prose is by definition not in the document. That single line is
why a 93k-token manuscript could come back with an apology instead of a chapter.

The no-invention rule properly applies to *claims about* the document, not to
prose the user explicitly asked for, so Chat keeps the first and drops the
second. If a model ever declines to write for you, that is the prompt talking,
not the model — check which task is selected.

### Retrying and editing a turn

Every message carries **Copy**; your own messages also carry **Edit**. They
appear on hover, so the transcript stays clean until you reach for them.

When a turn fails — the cluster went away mid-book-chapter, the tunnel dropped —
the question stays in the thread and the failed bubble grows a **Retry** button
that is always visible. One click replays the exact prompt; there is nothing to
retype. Retry only appears on the last turn, and it replaces the failed reply
rather than stacking a second answer under the same question. A turn you stopped
yourself offers the same button.

**Edit** opens the question in place, with its own model picker: re-running is
the natural moment to switch, since a disappointing answer is as often the
model's fault as the prompt's. Rewrite on `ds4-non-thinking`, then send the same
chapter to `ds4-max` without touching the top bar. Whatever you pick becomes the
thread's model, and the top bar follows once the turn lands.

Saving re-runs the thread from that point and discards every message after it —
the count is shown before you commit — because replies built on a question you
just rewrote no longer answer anything. The edited message keeps its id, and
editing the first message re-titles the thread.

Retry uses the top bar's model, so switching there before clicking it re-runs a
failed turn on a different model.

### Nothing is erased from tracing

Messages leaving a thread never remove the traces of the calls that produced
them. The transcript is the working copy; tracing is the record, and the two are
deliberately kept apart.

`traces.message_id` is `ON DELETE SET NULL`, so a discarded reply detaches its
traces rather than deleting them. They keep their prompt as sent, their
parameters, their response, their reasoning, their timings, and their tokens —
and they still count in the thread total, the per-model rollup, and the failure
counter. Retry a chapter four times and the sheet shows you all four attempts
and what they cost, whichever one you kept.

They are labelled **detached** in the trace sheet, meaning the message they
produced is no longer in the thread — retried over, edited away, or stopped
before it was ever saved.

One thing that *does* remove traces: deleting the whole thread, which cascades.
That is the one destructive action, and it asks first.

### Threads persist

Every thread is in SQLite at `data/threads.db`. Quit the app, reboot, come back
next week — click the thread in the sidebar and it reloads with the full
transcript, the attached document, the model used per message, timings, and the
saved reasoning traces. Then just keep typing; the new turn carries all of it.

Threads can be renamed (the first message auto-titles them) and deleted.
Deleting a document leaves its threads intact — they simply lose the attachment.

### Documents are stored once and shared

Upload a book once and it lives in `documents` forever; every thread points at
it by id, and the full text is pulled from SQLite on each turn. Ten threads on
the same book cost one copy of the text.

The **Document** dropdown binds the *open* thread: change it and the book is
attached to that thread from the next turn on, or pick `— no document —` to
detach. With no thread open it seeds the next **New thread** instead. The header
under the title always states what will actually be sent — `ksiazka.docx · 42,385
words · ~74,000 tokens`, or `no document attached`. Trust that line over the
dropdown; if a thread ever answers as though it never read the book, check it.

## The Archive Deck — every conversation, seen in depth (`/grimoire`)

The main view answers questions about *one document you have chosen*. The deck
answers the other kind: "where did we settle the ending of chapter one?" — a
question whose hard part is finding the conversation, not answering it. It is a
second, self-contained front end at `http://localhost:5173/grimoire` (the
✦ Grimoire link in the top bar) over the same database — and it is not a
read-only companion to the main view. Everything the lab can do, the deck can
do: hold a conversation, revise a document, check an answer against its source.
Nothing on it sends you back to the old view to finish a job.

It is built as a stack rather than a list. The record you are reading is the
window in front; every other conversation stands behind it, translucent, in
deck order — so what you are looking at always has the rest of the archive
visible through it. There is no "open" step and no dialog: travelling *is*
opening, and the front window loads its full transcript on arrival.

### Moving the deck

| | |
| --- | --- |
| `←` `→`, swipe, or scroll | travel one record forward or back |
| pinch (trackpad or touch), `+` `−` `0` | zoom the whole stack: pinching out shrinks each window **and** fans the deck, so the tail becomes visible instead of just smaller |
| click any window standing behind | brings it to the front |
| `↑` `↓` | scroll the record you are reading |
| `F` / `C`, or the window's own `⤢` `–` | expand the front record to fill the console, or collapse it to its title bar |
| `I` | flip to the flat index of every record and back |
| `/` | the query box |
| **ask the Oracle** | "go forward", "back two", "przejdź do trzeciego", "show me record 12", "back to the start" |

That last row is the point of the Oracle sitting on the same screen: a movement
instruction is answered by *moving*, not by retrieval. The planner is shown the
deck as you currently see it — which window is in front, in what order, filtered
or not — so "the third one" means the third window on screen. It costs one call
and no search.

Each front window also carries `◈ ASK`, which aims a question at that record
without leaving the deck. The `◀ LAB` link in the corner is a route switch, not
a feature: it exists because two front ends over one database should each be
reachable from the other, and nothing on the deck needs it.

### What a record shows

A conversation is not only its messages, so the front window has four faces and
travelling keeps whichever one you were reading:

| Face | What is on it |
| --- | --- |
| `TRANSCRIPT` | every turn, with model, duration and any error |
| `DOCUMENT` | the extracted text of the document this thread is about, plus copy and DOCX/RTF export |
| `VERSIONS` | every saved state of that document with `+N −M`, and a word-level diff between any two of them |
| `TRACES` | every call this thread made to the cluster — model served, tokens, TTFT, duration, failures — and the thread's totals |

### Working on the content

The deck is not a viewer. Everything the lab does to a document can be done from
the record window, through the lab's own endpoints:

| | |
| --- | --- |
| `+ UPLOAD` (top bar) | store a document and open a record for it in one step — a document no record points at would be invisible on a deck of conversations |
| `⌘`/`Ctrl` + select in `DOCUMENT` | mark a passage, give an instruction, and it is rewritten in place — **filed as a new version**, never written over the document, so the change is reviewable as a diff and the text the threads were answered from survives |
| `⇄ REPLACE` | re-upload into the same slot; the outgoing text is kept as its own version and the snackbar offers `REVIEW CHANGES` |
| `⇪ FILE AS VERSION` (on any model answer) | file that answer as the next version of the document it rewrote |
| `✎ RENAME` / `✕ REMOVE` | on the document, and on the record itself (`✎` `✕` in the window chrome) |
| `⧉ COPY`, `⤓ DOCX`, `⤓ RTF` | the current text, any version, or a single model answer |
| `✕` on a version | drop one saved state; the rest stay |

Anything that cannot be undone is gated the same way the lab gates it: a dialog
naming exactly what will go, with the button dead until you type `REMOVE`.

### Talking to a record

The composer is the foot of the front window rather than a bar across the
console, because what you type goes into *that* conversation and no other. It
carries the same task presets as the lab and its own model picker, which writes
to the thread — a record remembers which model answered in it.

| | |
| --- | --- |
| type + `Enter` (or `SEND`) | a new turn in the record in front, streamed as it arrives; the status line reports the stage, the reasoning, then the token count |
| `HALT` | stop mid-answer. What already arrived is kept and marked, so the next question can build on it |
| `↻ RETRY` | re-run the tail of a record after a failure or a halt — the failed reply is dropped, not stacked under a second one |
| `✎ EDIT` (on your own turn) | rewrite the question and answer it again; everything after it is discarded, because it answers a question that no longer exists |
| `☆ SAVE` → `★ SAVED` (top bar) | keep an answer and attach it to any other record as context |
| `⌕ CHECK` | ask the model to compare that answer against the source document; every difference it names is listed under the turn as a diff. The result is stored, so opening it again costs nothing |
| `⊞ RECORD` (top bar) | a second conversation on a document already in the library — the same text read twice, without uploading it twice |
| `⚙ LINK` (top bar) | providers, keys, models and the fallback chain — the same settings screen the lab mounts |

The composer stays on every face of the record, not just its transcript: a
record with nothing said in it opens on its `DOCUMENT`, and hiding the composer
there would leave the one window you most want to talk to with no way in.
Sending turns the record to its transcript by itself.

A turn is not tied to the front of the deck. Walk away from a record mid-answer
and it keeps running: the server keeps writing it down, and the record has it
when you come back.

A thread with no messages opens on `DOCUMENT` rather than on an empty page.
That case is common and used to look broken: uploading a file creates a thread
whose whole content is the document, and a deck that only rendered messages
showed nothing at all — while the Oracle, reading the same transcripts, would
correctly but uselessly report that the archive did not hold the text.

Actions that leave no visible trace — a copy, an export, a search that matched
nothing, a failed fetch, a deck move the Oracle made — report in a snackbar. On
a console where every window is translucent and half-lit, silence is
indistinguishable from breakage. A change filed somewhere you cannot see carries
the way there: filing a version offers `REVIEW CHANGES`, which lands on the diff
that change produced.

### Searching it

The query box (`/`) runs full-text search across every message ever written
**and every document ever uploaded**, not a substring scan: results come back
ranked, the matching passage quoted, and the deck reorders so the best match is
the window in front. It reads a Polish archive from a US keyboard — `rozdzial`
finds `rozdział`, and `bomba` finds `bomby`.

Documents are indexed because otherwise the archive's most findable content is
invisible: "the long poem" appears in no message, only in an `.rtf` — and the
thread holding it has no messages to match against at all. A document hit
surfaces as a hit on the threads bound to that document, ranked just below a
message hit of the same quality.

### The Oracle

A model that searches the archive on your behalf. It is given a catalogue of
records and a search tool, and works in rounds:

```
plan → search the archive → read what came back → plan again → answer
```

It shows its work while it does it: the queries it chose, the records it opened,
and, under the answer, the conversations it actually used. Every `[#12]` in an
answer is a button that flies the deck to that record, and the windows it cited
are marked in amber. A retrieval answer you cannot audit is just a confident
guess, so all of it stays on screen.

The rounds are a JSON protocol over plain completions rather than OpenAI
function calling — a local vLLM build is not guaranteed to have tool support
compiled in, and a JSON object is the one thing every endpoint can emit. Calls
are traced like any other (`kind` = `oracle-plan` / `oracle`, `task` = `oracle`),
so what the Oracle spent is visible in the same place as everything else.

### The search index

`server/search.js` mirrors every message into an FTS5 table kept in sync by
SQLite triggers, so nothing in the write paths has to remember to update it. It
indexes the message text, its thread title and its document filename — which is
what lets "the chapter three rewrite" find a thread whose messages never say
"chapter three". The index is derived data: if its row count ever disagrees
with `messages`, it is rebuilt at boot.

Three passes run in order, and the next only runs when the previous found
nothing: every word (`AND`), any word (`OR`), then a loose pass that truncates
each word and matches it as a prefix. That last one is what makes an
inflection-heavy language searchable without a stemmer — and why it runs last,
since it matches more than it should.

The pass that found a hit travels with it, because the loose pass is a fallback
for the *whole query* and not for one source of it. Searching `wiersz` finds
"wierzchu" in three messages by truncation and the actual poem in a document
exactly: without that rule the three weak hits would sum to more than the one
right answer and bury it.

Tuning, all optional:

| Variable | Default | What it caps |
| --- | --- | --- |
| `ORACLE_MAX_ROUNDS` | `3` | plan/search rounds before the answer is forced |
| `ORACLE_CATALOGUE` | `120` | threads listed to the planner |
| `ORACLE_MESSAGE_CHARS` | `1200` | one message inside a transcript |
| `ORACLE_THREAD_CHARS` | `12000` | one opened conversation |
| `ORACLE_EVIDENCE_CHARS` | `60000` | all transcripts in one answer |
| `ORACLE_DOC_CHARS` | `4000` | the document excerpt attached to a thread that has messages |
| `ORACLE_DOC_ONLY_CHARS` | `16000` | the document attached to a thread that has none — there, the document is the record |

## Constellation — the archive as a graph (`/grimoire-graphs`)

The deck answers "which conversations do I have?". The graph answers the one
that comes after it: **"what came from what?"**

The working model is a network instead of a list. You put down one *point* — a
book at a version you choose, or a conversation you have already had — and then
you pull a line out of it. Every line you pull is a new conversation that reads
what it came from. That conversation is a point too, so the next line comes off
it, and the work grows outward.

    ◆ book v9 ──┬──▶ ◈ "tighten chapter one"  ──▶ ◈ "now cut it by a third"
                ├──▶ ◈ "same chapter, darker" ──▶ ◈ "file that as v10"
                └──▶ ◈ "is the timeline consistent?"
    ◆ book v3 ──────▶ ◈ "what changed between the drafts?"  ◀── (also reads the
                                                                 conversation
                                                                 above)

Three branches off one book are three drafts being argued in parallel, from the
same source, at whatever version each one is pinned to. That is the feature:
one source, many threads, and the versions kept straight.

### The two rules

1. **Nothing on the canvas is a copy.** A point is a pointer at a thread or a
   document that already exists. A conversation opened here is an ordinary
   conversation — the deck lists it, the Oracle searches it, its answers file as
   document versions. The graph records only where it came from.
2. **Context is walked at send time, on the server.** Sending a turn assembles
   its sources by walking upstream *at that moment*. Re-pin a book to an older
   draft, or draw one more line into a point, and the very next turn reads the
   new arrangement. There is no cached context to invalidate.

### Working the canvas

| | |
| --- | --- |
| drag the background, or scroll | pan |
| pinch, `+` `−` `0` | zoom |
| **drag a card's `○` out-port onto empty canvas** | opens a new conversation there, reading that point |
| drag it **onto another conversation** | that conversation now reads this point too |
| click a point | opens it: its sources, its transcript, its composer |
| click a line | change what it carries, or cut it |
| `F` / `L` | frame everything / lay the graph out left to right |

`◆ BOOK` and `◈ THREAD` put an existing book or conversation down as a new root.
A chat with no document behind it can be the root of a graph — which is the
other half of what the view is for: a conversation becomes the source for the
threads that branch off it.

### What a line carries

Each line has a mode, changed by clicking it or from the `READS` panel:

| Mode | What arrives in the prompt |
| --- | --- |
| `WHOLE` | the entire book at its pinned version, or the parent's whole transcript (tail-truncated at `GRAPH_THREAD_SOURCE_CHARS`, whole turns only) |
| `LAST` | only the parent's final answer — the cheap branch, for when the parent produced a draft and the argument that led there is noise |
| `NONE` | the line stays drawn, recording where the work came from, but carries no text |

The mode applies at the first hop. Points further upstream contribute in full,
because they are what that parent was itself answered from — so a grandchild
still gets the book. The `READS` panel in the inspector lists exactly what will
go in, with the character count and a `PREVIEW` of the assembled text, before
you send anything. Indirect ancestors are marked `↳`.

Lines that would close a loop are refused, as is a book reading anything: a
source reads nothing, which is what makes it a source.

### Versioning one book across many threads

A book point carries a `READS` picker listing the versions that actually exist
(deleting a version in the middle leaves a gap; the picker never offers one that
is gone). `newest` follows the document as it is revised; a pinned number holds
still. Put the same book down twice, pin one to `v3` and leave the other on
newest, and two branches argue two drafts at once — then a third point reading
both is a diff conversation.

Any answer can be filed as the next version of the book behind it with
`⇪ FILE AS VERSION`, exactly as on the deck, and `⑂ BRANCH FROM THIS` opens a
child that reads that one answer alone.


## Storage

```
documents  id, filename, kind, text, chars, words, pages, bytes, sha256(unique)
threads    id, title, document_id → documents, model, created_at, updated_at
messages   id, thread_id → threads, role, content, reasoning, model, task, ms, error
```

Uses Node 26's built-in `node:sqlite` — no native module to compile. WAL mode is
on, which matters because one insert can carry 600k chars of document text.
A document is stored **once** no matter how many threads use it. Deleting a
thread cascades to its messages; deleting a document nulls `document_id` and
leaves the conversation readable.

Back up or inspect it with any SQLite tool:

```bash
sqlite3 data/threads.db 'SELECT id, title, updated_at FROM threads ORDER BY updated_at DESC'
```

### How a turn is sent to the cluster

The document goes in **once**, as the first user message, then every turn
appends to that same prefix:

```
system   → analyst instructions
user     → <document>…</document>  "Reply only with Ready."
assistant→ Ready.
user     → turn 1 question          ← history replayed from SQLite
assistant→ turn 1 answer
user     → turn 2 question          ← the new turn
```

Keeping that prefix byte-identical between turns is deliberate: vLLM's prefix
cache can then reuse the expensive document prefill, so follow-up questions on a
100-page book are far cheaper than the first one. Reordering these messages
would silently throw that away.

### Choosing a model

- **`ds4-non-thinking`** — default. Answers immediately, no reasoning pass.
  Right choice for extraction, summarisation and translation of long documents,
  where a chain of thought over 170k tokens costs a lot of time for little gain.
- **`ds4-high` / `ds4-max`** — reason before answering. Worth it for Q&A that
  needs inference across distant parts of a document, or arithmetic.

These stream chain-of-thought on a separate `reasoning_content` field. The app
shows it in a **collapsible reasoning panel** above the answer — it opens and
streams the thought live with an elapsed timer, then collapses itself to
`Thought for 3.9s · 966 chars` the moment the answer begins, same as GitHub
Copilot. Click it to re-read the reasoning. It never contaminates the answer,
and `copy` / `save .md` export the answer only.

Tasks: Summary · Key points · Action items · Entities & figures · Ask a question
· Translate · Custom prompt. Results copy to clipboard or save as `.md`.

## The 1M budget, and how to spend it

The cluster reports `max_model_len = max_total_tokens = 1048576`. That is **one
budget shared by prompt and completion**, not a 1M window with a separate output
allowance — ask for more output than the prompt leaves and the request is
rejected outright. The app measures the prompt conservatively and clamps
`max_tokens` to what remains, so a very large document shortens the answer
rather than failing the turn.

Two things follow, both counter-intuitive:

**Reasoning is billed to the output cap, and it goes first.** There is no
separate thinking budget, and no parameter that reserves room for the answer —
`reasoning_effort` and `chat_template_kwargs: {thinking: false}` are both
accepted by this proxy and both had no measurable effect when tested. A
reasoning model can therefore spend the entire cap thinking and stop before
writing a word. `MAX_TOKENS=4096` was not enough to rewrite a chapter with
`ds4-max`; 32768 is.

**A bigger cap is a wall-clock decision.** Measured output on this cluster is
~36 tok/s, so the ceiling you set is roughly the longest you are willing to wait:

| `MAX_TOKENS` | Prose produced | Worst-case wait |
| --- | --- | --- |
| 4,096 | ~12k chars | 2 min |
| 16,384 | ~47k chars | 8 min |
| 32,768 | ~94k chars | 15 min |
| 65,536 | ~189k chars | 30 min |

Filling all 955k remaining tokens would take about seven hours, which is why the
default is sized to a chapter and not to the machine.

## Long documents — what actually happens

**One decision, made by size.** If the extracted text is under
`CONTEXT_BUDGET_CHARS` (600,000 chars ≈ 170k tokens) it goes to the model
**whole, in a single request**. No chunking, no retrieval, no embeddings — the
model sees every page at once and can relate page 3 to page 90. Past that
ceiling the server falls back to map-reduce. The stage line always tells you
which path ran.

At ~350 words per page, that ceiling is roughly **280 pages**:

| Document | Chars | Tokens | Path |
| --- | --- | --- | --- |
| 10-page report | ~20k | ~5k | single pass |
| **100-page book** | **~195k** | **~54k** | **single pass** |
| 280-page book | ~600k | ~167k | single pass (at the limit) |
| 500-page book | ~1.05M | ~292k | map-reduce, 22 sections |

Measured on this cluster — a 100-page book (195k chars, 54k tokens) with a fact
planted on page 50, asked to retrieve it:

```
path: single pass · ~54,224 tokens
time to first token: 20.4s      ← prefill of 54k tokens
total: 21.2s
answer: correct, with the verbatim quote and the right page number
```

The long prefill is the cost of the single-pass approach: the model reads the
entire book before emitting a token. That is also why it can answer questions
spanning distant chapters, which a chunked pipeline cannot.

### When map-reduce kicks in

Chunk on paragraph boundaries at `CHUNK_CHARS` (48k) with `CHUNK_OVERLAP_CHARS`
(800) of carry-over so a sentence crossing a boundary stays readable, run the
task on each section, then merge the section results with a task-specific reduce
prompt. Each task defines its own reduce step — summaries get merged into one
summary, tables get concatenated and deduplicated.

Its weakness is inherent: a section is analysed without knowledge of the others,
so "which two chapters contradict each other?" degrades. Prefer single pass when
the document fits.

### Tuning

- Raising `CONTEXT_BUDGET_CHARS` toward the true 1M window trades latency and
  KV-cache memory for cross-document reasoning. On a 2×Spark NVFP4 deployment
  the KV cache is the binding constraint, not the window.
- Lowering it makes very long documents finish in bounded time at the cost of
  cross-section reasoning.
- The text pane is editable for a reason: deleting a 40-page appendix before
  running is the cheapest optimisation available.

## Providers and fallbacks (⚙ LLM)

Which endpoint answers is no longer a `.env` setting. The **⚙ LLM** button in the
top bar opens the [llm-settings plugin](plugins/llm-settings/README.md): a main
provider (API URL, key, and a model picked from what that server advertises),
plus any number of fallback providers below it.

If the main provider refuses a call — box down, connection refused, HTTP error —
the next provider in the list answers instead, with **its own** model, and the
turn says so in the transcript. Once tokens have started arriving no swap
happens: a half-streamed answer cannot be replaced.

The chain is stored in `data/threads.db` (table `llm_providers`), so it survives
restarts and is backed up with everything else. Until something is saved there,
the `LLM_*` values below are used exactly as before — the first save moves them
into the database, key included, and `.env` is ignored from then on.

```bash
# The same thing without the UI:
curl -X POST localhost:5173/api/llm/providers -H 'content-type: application/json' \
  -d '{"llm_providers":[{"apiUrl":"http://192.168.0.80:11111/v1","apiKey":"local","model":"ds4-non-thinking"},
                        {"apiUrl":"http://192.168.0.80:8890/v1","apiKey":"local","model":"deepseek-v4-flash-0731"}]}'
curl localhost:5173/api/llm/providers        # list, keys masked
curl localhost:5173/api/llm/providers/1      # one
curl localhost:5173/api/llm/config           # the chain actually in use
```

## Configuration (`.env`)

| Key | Meaning |
| --- | --- |
| `LLM_BASE_URL` | Default OpenAI-compatible base (must end in `/v1`) — used only until providers are saved in ⚙ LLM |
| `LLM_MODEL` | Default model id; overridden by the saved provider and by the UI picker |
| `LLM_API_KEY` | Default key — imported into the database on the first save |
| `CONTEXT_BUDGET_CHARS` | Single-pass ceiling before map-reduce |
| `CHUNK_CHARS` / `CHUNK_OVERLAP_CHARS` | Map-reduce chunking |
| `TEMPERATURE` | Sampling |
| `MAX_TOKENS` | Output cap — **reasoning and answer share it** |
| `MAX_TOTAL_TOKENS` | Cluster ceiling for prompt + completion combined (1,048,576) |
| `CHARS_PER_TOKEN` | Estimate used for the sizes shown in the UI (2.9, measured on Polish) |
| `MAX_UPLOAD_BYTES` | Upload cap (40 MB) |
| `PORT` | Local web app port |
| `DB_PATH` | SQLite file (default `data/threads.db`) |
| `TRACE_FULL_PROMPTS` | Store prompts verbatim incl. document body (default false) |

## Known limits

- **A reasoning model can run out of budget before it answers.** `ds4-max` on a
  90k-token book can spend all of `MAX_TOKENS` thinking and stop with an empty
  answer. The app detects this (`finish_reason: length`), says so, and offers
  Retry — raise `MAX_TOKENS`, or ask a lighter model. Reasoning tokens are billed
  against the *output* cap, so a big book needs a bigger cap, not just a bigger
  context.
- **Scanned PDFs** have no text layer. The app says so explicitly; run
  `ocrmypdf in.pdf out.pdf` first.
- **Legacy `.doc`** (Word 97 binary) is not supported —
  `soffice --headless --convert-to docx file.doc`.
- PDF tables flatten to lines; column structure is lost.
- The server binds to all interfaces via Express defaults — it has no auth, so
  don't expose port 5173 beyond your machine.
- Spark IPs come from DHCP; if the head node moves, re-run `npm run doctor`.

## Layout

```
server/
  index.js    REST + SSE routes for documents, threads and messages
  db.js       node:sqlite schema, queries and trace writes
  search.js   FTS5 index over every message, kept in sync by triggers
  oracle.js   the /grimoire deck: records, search and retrieval inference
  graph.js    the /grimoire-graphs canvas: points, lines, upstream context
  extract.js  pdfjs + mammoth → text
  llm.js      OpenAI-compatible client (streaming + one-shot)
  tasks.js    prompt templates, conversation and map/reduce builders
  chunk.js    paragraph-aware chunking
public/       single-page frontend, no build step
  grimoire/   the alternative view — deck + Oracle, same store
  grimoire-graphs/  the graph view — sources, branches and versions on a canvas
scripts/
  doctor.mjs  endpoint discovery + smoke test
  tunnel.sh   SSH port-forward to the Spark
data/
  threads.db  SQLite store (gitignored)
```

## Tracing

Every call to the cluster is recorded in the `traces` table. One user turn is
one trace on the single-pass path, or N+1 (map sections + reduce) on the
map-reduce path — so the cost of a chunked question is visible, not hidden.

Each trace records:

| Field | What it holds |
| --- | --- |
| `model` / `served_model` | what you asked for vs what the server reports using |
| `fingerprint` | e.g. `vllm-0.21.1rc1…-tp2-…` — build and tensor-parallel topology |
| `request_json` | the full message array as sent, in order |
| `request_params` | temperature, max_tokens, stream |
| `prompt_chars` / `prompt_messages` | true prompt size sent over the wire |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | **real counts from the server**, not estimates |
| `ttft_ms` | time to first token — the prefill cost |
| `duration_ms` | wall time for the call |
| `response_text` / `reasoning_text` | what came back, thinking kept separate |
| `status` / `error` | `ok` \| `error` \| `aborted`, with the upstream message |
| `finish_reason` | `stop` \| `length` — `length` means `MAX_TOKENS` cut the answer off |

Streaming turns get real token counts because the client sends
`stream_options: {include_usage: true}` — verified working on this cluster.
Without it, vLLM returns no usage on streamed responses at all.

### Where to see it

- **Per message** — a line under each answer: `394 in · 229 out · 623 total · 382ms to first token`.
- **Per thread** — running total in the header: `1,503 tok · 4 calls`.
- **Traces button** — a sheet with a per-model rollup (calls, tokens, avg TTFT,
  avg duration, failures) and every individual call. Expand one to see the exact
  prompt, the parameters, the reasoning and the response. Calls whose message
  was retried over or edited away are still listed, marked **detached** — see
  [Nothing is erased from tracing](#nothing-is-erased-from-tracing).

### What the prompt column stores

The document body is elided from `request_json` and replaced with
`<document elided chars="195204" />`. The text already lives once in
`documents`; storing it per turn would multiply a 100-page book by the number of
turns. `prompt_chars` still records the true size that went over the wire, so
nothing is misreported. Set `TRACE_FULL_PROMPTS=true` for byte-for-byte capture.

### Querying it

```bash
# tokens per day
sqlite3 data/threads.db "SELECT date(created_at) d, SUM(total_tokens) FROM traces GROUP BY d"

# slowest calls
sqlite3 data/threads.db "SELECT id, model, prompt_tokens, ttft_ms, duration_ms
                           FROM traces ORDER BY duration_ms DESC LIMIT 10"

# does the prefix cache help? TTFT by turn within one thread
sqlite3 data/threads.db "SELECT id, prompt_tokens, ttft_ms FROM traces
                          WHERE thread_id = 1 ORDER BY id"

# failures with the upstream message
sqlite3 data/threads.db "SELECT id, model, error FROM traces WHERE status <> 'ok'"
```

Note the cluster does not expose `prompt_tokens_details.cached_tokens`, so
prefix-cache hits cannot be read directly. `ttft_ms` is the usable proxy: on a
large document, a cache hit shows up as a dramatically lower TTFT on later turns.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | models, tasks, cluster reachability, store stats |
| `POST` | `/api/documents` | upload + extract + save (multipart `file`) |
| `GET` | `/api/documents` | library listing (no text) |
| `DELETE` | `/api/documents/:id` | remove from library |
| `GET` | `/api/threads` | sidebar listing |
| `POST` | `/api/threads` | create, optionally bound to `documentId` |
| `GET` | `/api/threads/:id` | thread + full message history |
| `PATCH` | `/api/threads/:id` | rename / change model / attach `documentId` (`null` detaches) |
| `DELETE` | `/api/threads/:id` | delete thread and messages |
| `POST` | `/api/threads/:id/messages` | send a turn, SSE stream back |
| `POST` | `/api/threads/:id/messages/:msgId/retry` | replay a failed tail turn, SSE stream back |
| `POST` | `/api/threads/:id/messages/:msgId/edit` | rewrite a question, drop what followed, re-run |
| `GET` | `/api/traces?threadId=&limit=` | trace list (no bodies) |
| `GET` | `/api/traces/:id` | one trace with full prompt and response |
| `GET` | `/api/usage` | per-model and global token rollup |
| `GET` | `/api/threads/:id/usage` | thread total + per-message breakdown |
| `GET` | `/grimoire` | the deck view |
| `GET` | `/api/oracle/gallery` | every thread with its stats, one per window |
| `GET` | `/api/oracle/search?q=&limit=` | full-text search, grouped by thread |
| `GET` | `/api/oracle/threads/:id` | one conversation to read |
| `POST` | `/api/oracle/ask` | ask the archive, SSE stream back |
| `GET` | `/grimoire-graphs` | the graph view |
| `GET` `POST` | `/api/graphs` | list / create a graph |
| `GET` `PATCH` `DELETE` | `/api/graphs/:id` | one canvas (points + lines) / rename / delete |
| `GET` | `/api/graph-library` | books and conversations a point can be seeded from |
| `POST` | `/api/graphs/:id/nodes` | put a point down (a book, or a conversation new or existing) |
| `PATCH` `DELETE` | `/api/graphs/:id/nodes/:nid` | move / pin a version / remove (`?withThread=1` also deletes it) |
| `POST` | `/api/graphs/:id/edges` | draw a line (refuses loops and self-links) |
| `PATCH` `DELETE` | `/api/graphs/:id/edges/:eid` | change what a line carries / cut it |
| `GET` | `/api/graphs/:id/nodes/:nid/source` | what the next turn will read, with a preview |
| `GET` | `/api/graphs/:id/nodes/:nid/thread` | the conversation on a point, plus its lines |
| `POST` | `/api/graphs/:id/nodes/:nid/messages` | send a turn with upstream context, SSE stream back |
| `POST` | `/api/graphs/:id/nodes/:nid/messages/:mid/retry` | replay a failed tail turn, same context |
| `POST` | `/api/graphs/:id/nodes/:nid/branch` | create the child, the point and the line in one write |

The graph reuses the lab's inference path verbatim: a graph turn is an ordinary
thread turn whose document was assembled from upstream points instead of read
off the thread. Everything downstream of that — the context budget, the
map-reduce split for a source that overflows it, the traces, the fallback chain
— is the same code.

The deck reads and writes through the lab's own endpoints — `/api/documents`
(upload, replace, rename, remove), `/versions` (list, file, remove), `/diff`,
`/api/rewrite`, `/api/threads/:id`, `/api/traces` — so the two views can never
drift apart, and neither can grow a rule the other does not enforce.

SSE event types: `user`, `stage`, `thinking`, `token`, `usage`, `done`, `error`.
`/api/oracle/ask` adds `thought`, `hits`, `opened` and `sources` — what the
Oracle searched, read and answered from — plus `navigate` when the instruction
was to move the deck rather than to ask it something. It accepts an optional
`deck` object (`position`, `total`, `records`) so relative movement resolves
against what is actually on screen.
