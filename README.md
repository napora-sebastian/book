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
  extract.js  pdfjs + mammoth → text
  llm.js      OpenAI-compatible client (streaming + one-shot)
  tasks.js    prompt templates, conversation and map/reduce builders
  chunk.js    paragraph-aware chunking
public/       single-page frontend, no build step
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

SSE event types: `user`, `stage`, `thinking`, `token`, `usage`, `done`, `error`.
