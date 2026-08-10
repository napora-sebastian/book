<!-- agent-workflow:start -->
# Repository Agent Instructions

Use this file as the common bootstrap for Codex, GitHub Copilot, Cursor agents, and GitNexus. Keep detailed implementation rules in the Cursor rule files and GitNexus index; do not duplicate those source files here.

## Before Starting Any Task

1. Identify the repository you are actually changing.
   - In this repository (`/Users/sna/Desktop/projects/integration`), use GitNexus repo `ai-managing`.
   - In the ADEO frontend repository (`/Users/sna/Desktop/adeo-projects/frontend`), use GitNexus repo `frontend`.
   - If an instruction block was copied from another repository, update the GitNexus repo name and paths before using it.
2. Read the base Cursor rules when they exist:
   - Prefer `.cursor/rules/basic.mdc` and `.cursor/rules/technical.mdc`.
   - If those files are not present, use `cursor/rules/basic.mdc` and `cursor/rules/technical.mdc`.
3. If the user provides labels, read the matching rule file before planning or implementing:
   - `[COMPONENT]` -> `component.mdc`
   - `[API]` -> `api.mdc`
   - `[FORM]` -> `form.mdc`
   - `[LANG]` -> `translations.mdc`
   - `[E2E]` -> `e2e.mdc`
   - `[E2E_ENERGO]` -> `e2e-energo.mdc`
   - `[E2E_ADMIN]` -> `e2e-admin.mdc`
   - `[ENERGO]` -> `energo.mdc`
   - `[GRAPH]` -> `graph.mdc`
   - `[WCAG]` -> `wcag.mdc`
   - `[CODE]` -> `code.mdc`
   - `[BUMP]` -> `bump-packages.mdc`
   - `[FIGMA]` -> `figma.mdc`
   - `[JIRA]` -> `jira.mdc`
4. If selected rules contain `ASK` or `VERIFY`, follow those instructions before implementation.
5. For code changes, prepare the task list requested by the repository rules and wait for user approval when those rules require it.
6. Follow the target repository's existing Nx, Nuxt, Vue, TypeScript, FSD, Pinia, Vuetify/Mozaic, Vitest, and Playwright conventions when working in the frontend codebase.

## Agent Cooperation Workflow

- Start with the repository rules, then use GitNexus for code intelligence.
- For unfamiliar code, run a GitNexus query before broad text search so work starts from execution flows instead of isolated files.
- Before editing a function, class, method, API route handler, or shared contract, run GitNexus impact analysis for the correct repo and report the blast radius to the user.
- If impact analysis is `HIGH` or `CRITICAL`, warn the user and wait for confirmation before editing.
- Prefer GitNexus rename/refactor tooling for symbol renames; do not use plain find-and-replace for code symbols.
- Before committing, run GitNexus change detection and confirm the affected symbols and execution flows match the intended scope.
- When handing work between Codex, GitHub Copilot, or Cursor, include: rules read, labels used, GitNexus repo queried, impact result, files changed, tests run, and remaining risks.

## Dev Brain Memory Loop

Use Dev Brain when it is running locally to reuse developer feedback and preferences across LLM iterations. The default local service is `http://0.0.0.0:8795` and uses Ollama `qwen3-embedding:4b` by default.

### Required Pattern Gate

Agents must use Dev Brain as a pattern-matching gate around implementation work.

Before implementing, reviewing, planning, or transforming code:

1. Call the MCP tool `dev_brain_context` when available, or call `/context` by HTTP.
2. Include the current user input, target repository, module, and file path when known.
3. Inspect `contextBlock`, `similarFeedback`, and `codePatterns` before choosing an implementation.
4. Reuse matching existing patterns when they fit the task.
5. If Dev Brain is unavailable, continue without blocking, but state that pattern retrieval was skipped.

After implementing:

1. Inspect the final diff and identify any reusable pattern, convention, gotcha, or developer preference that could help future work.
2. Check whether the same or similar pattern already appeared in Dev Brain context for this task.
3. Always ask the user whether the candidate pattern should be saved before calling `/feedback` or `dev_brain_feedback`.
4. Save only after explicit user approval. Do not silently write memories.
5. If no useful reusable pattern exists, say so in the final response.

Final responses after implementation must include:

- Dev Brain lookup status: used MCP tool, used HTTP endpoint, unavailable, or skipped with reason.
- Matching rules or patterns applied from `contextBlock` / `codePatterns`, or "none".
- Candidate pattern(s) suggested for saving, or "none".

### Before LLM/Development Iteration

Before asking an LLM to produce code, review, plan, or transform implementation details, request relevant memory context:

```bash
curl -s http://0.0.0.0:8795/context \
  -H 'content-type: application/json' \
  -d '{
    "developerId": "sna",
    "projectId": "ai-managing",
    "repository": "ai-managing",
    "module": "workflow",
    "filePath": "optional/path/to/file.js",
    "prompt": "Describe the current task or LLM prompt here",
    "limit": 8
  }'
```

Inject only the returned `contextBlock` into the downstream LLM prompt. Do not forward full feedback history, raw event lists, unrelated memories, session logs, tool logs, or recursive `chat_messages`.

Recommended prompt wrapper:

```text
Developer memory context:
<contextBlock>

Current task:
<latest user request or workflow input>
```

If Dev Brain is not reachable, continue without blocking the task and mention that memory retrieval was skipped.

### After Developer Feedback

After the developer corrects, rejects, accepts, or explains a preference about agent output, record the feedback:

```bash
curl -s http://0.0.0.0:8795/feedback \
  -H 'content-type: application/json' \
  -d '{
    "developerId": "sna",
    "projectId": "ai-managing",
    "repository": "ai-managing",
    "module": "workflow",
    "filePath": "optional/path/to/file.js",
    "comment": "Developer preference or correction",
    "reaction": "accepted",
    "category": "architecture",
    "diff": "optional diff",
    "finalCode": "optional final code"
  }'
```

Use `reaction: "accepted"` when the developer confirms the preference, `reaction: "rejected"` when the LLM suggestion was wrong, `reaction: "modified"` when the developer changed it, and `reaction: "noted"` for weak signals.

### Consolidation

Periodically consolidate preferences, especially after a session with several feedback entries:

```bash
curl -s http://0.0.0.0:8795/consolidate \
  -H 'content-type: application/json' \
  -d '{
    "developerId": "sna",
    "projectId": "ai-managing",
    "repository": "ai-managing"
  }'
```

### Chat Verification

When verifying Dev Brain behavior in chat with an LLM, ask the LLM to explicitly list which memory rules it applied and why. Compare that list against the `contextBlock`. If the LLM claims a rule that was not present in `contextBlock` or current repository rules, treat it as unsupported and ask it to revise.

Expected verification prompt:

```text
Use only the developer memory context below and the current task. After answering, list the exact memory rules you applied. Do not invent preferences.

Developer memory context:
<contextBlock>

Current task:
<task>
```

Record useful verification outcomes back through `/feedback` so repeated confirmations increase preference confidence and bad matches become contested.

## AIConnector MCP AI Sessions

- Use `MCP.md` as the detailed ai-session contract for `flow_runner_mcp`.
- Every LLM call to AIConnector MCP, ai-session tools, workflow runs, chain runs, remote runs, and graph processing should keep `chat_messages` minimal whenever the tool accepts a body/input/options object.
- When an AIConnector AI session exists, also treat `ai_session_connection_event_append` as the special MCP logging tool for standalone transcript logging. Use it to append `llm_chat_messages` / `llm_transcript` events only when the transcript must be audited separately from the runtime prompt.
- `chat_messages` is the canonical LLM prompt context field. It should contain only user input and workflow output: user requests, `user_answer` data, queued task input, and workflow/chain outputs that are needed by the next LLM call.
- Do not forward session logs, timeline bookkeeping, status changes, MCP/tool call logs, reasoning notes, summaries, or full historical transcripts to downstream LLM calls.
- When a workflow, chain, graph node, or session process continues separately from the original LLM turn, pass only the latest relevant input/output messages forward.
- Do not nest full `chat_messages` arrays inside generated transcript entries, because that causes recursive payload growth.
- Use aliases such as `chatMessages` or `messages` only for compatibility with older callers. New agent instructions and examples should use `chat_messages`.
- Preferred standalone logging event:

```json
{
  "sessionId": "wfs_...",
  "type": "llm_chat_messages",
  "title": "LLM transcript update",
  "status": "ok",
  "body": {
    "chat_messages": [
      {
        "role": "assistant",
        "content": "Summarized the next MCP action and prepared the workflow payload.",
        "type": "summary"
      }
    ]
  },
  "metadata": {
    "tool": "codex",
    "purpose": "mcp_transcript_log"
  }
}
```

- When a session needs human data or approval, do not finish the agent turn with only a note. Create a visible Ask log entry with `ai_session_connection_ask_user` or `ai_session_connection_request_user_input`.
- Ask payloads should include `question`, `requiredFields`, and `optionalFields` when known. The browser user answers from the session timeline by clicking **Answer question**, filling the prepared body, and appending it as `user_answer`.
- When any workflow, chain, graph node, or MCP response returns `status: "paused"`, `paused: true`, `session.status: "waiting-for-user"`, or a `user_question`/`askLog`, stop advancing downstream workflows. Treat it as a coordinated pause, not a failed run.
- Do not start the next workflow in a chain while the active session is `waiting-for-user` or `waiting-for-llm`. Resume only after a browser user answer or an LLM-generated fill is recorded as `user_answer` or `task_enqueued`.
- After creating an Ask log, keep a stable wait open with `ai_session_connection_wait_for_user_answer` and `processNext: true`, or give the operator the returned `session.terminalWait.command` curl and tell them to keep it running.
- Use the latest known `session.eventCount` as `cursor` so old answers are not replayed.
- Preferred MCP wait payload:

```json
{
  "sessionId": "wfs_...",
  "cursor": 52,
  "timeoutSeconds": 1800,
  "processNext": true,
  "autopilot": true,
  "parallel": false,
  "chat_messages": [
    {
      "role": "user",
      "content": "Latest browser answer or task input."
    }
  ]
}
```

- Equivalent curl pattern for a terminal wait:

```bash
curl -sS -N -X POST 'http://0.0.0.0:8790/api/ai-sessions/wfs_.../wait-for-user-answer' \
  -H 'content-type: application/json' \
  --data '{"cursor":52,"timeoutMs":1800000,"processNext":true,"autopilot":true,"parallel":false}'
```

- If the wait times out and the user did not ask to stop, repeat the same wait with the returned cursor. If the processed result returns `waiting-for-user` again, start another Ask/wait loop.
- If an LLM model can answer the gap itself, append that answer to the same session as `user_answer` with the requested fields and then call `ai_session_connection_process_next` or the wait endpoint with `processNext: true`. Keep the event body explicit so the browser timeline shows what was filled.

## AIConnector Session Queues

When the user asks to process an AI session queue ("call queue X with id q_… and proceed it"),
read `queue-resolver.instruction.md` in this repository before doing anything else, or call the
`queue_setup` MCP tool which returns the same protocol plus the queue's live state.

### Pipeline Contract (MANDATORY)

- **A queue is a pipeline, not a menu.** Naming a queue authorises resolving **EVERY** session in
  it, one after another. You MUST resolve ALL sessions. Never finish a session and ask "should I
  continue with the next one?" — the answer was already given when the user pointed you at the queue.
- **`queue_setup({queueId})` first, then loop `queue_run({queueId})`.** `queue_run` is the whole
  pipeline: each response either hands back the next agent step (`action: "resolve_step"`, with
  `processTask` and `executionTarget`) or reports the queue is finished (`action: "done"`).
  Resolve the step, call `queue_run` again with `stepResult`, repeat until `done`.
- **`action: "done"` is not the end of the turn — call `waiting_for_session_in_queue({queueId})`
  as the LAST action.** It is the queue-level twin of
  `workflow_session_wait_for_user_answer`: it keeps an open connection on the queue until a new
  session is added, then resumes the pipeline and hands back the next step (`processNext: true`
  by default, 30 min per wait). On `action: "keep_waiting"` (timeout) call it again with the same
  `queueId`; on `action: "resolve_step"` go back to the `queue_run` loop. Stop reopening it only
  when the user says to stop serving the queue.
- **Stop only on `action: "ask_user"`** (a step needs runtime input — ask that one question, then
  resume with `input`/`stepInput`) **or `action: "blocked"`** (an error the queue will not skip).
  `action: "continue"` means the call ran out of budget: call `queue_run` again immediately.
  **Never stop between sessions.**
- **`pipeline.remainingSessions`** tells you how many sessions are still queued. If > 0, keep going.
- **Honour `executionTarget` on every step.** `"ide"` = you edit the real files in the local
  checkout with your own tools before submitting; a plan or code block does not complete the step.
  `"aiconnector"` = the cloned server-side workspace edits; do not touch local files. It is set
  per agent by the **Execution target** field on the session's team cooperation page, and steps
  inside one session can differ.
- **Resolve each step as the agent role it declares** (`processTask.processStep.agentRole`). A
  `backend` step writes backend code, a `critic` step reviews the previous output, a `researcher`
  step gathers context.
- **Context boundary between entries.** Each `wfs_*` entry is unrelated work: drop the previous
  session's payloads and keep the one-line summary from `pipeline.sessionsDone`. Prefer a fresh
  sub-agent per session on long queues. Dropping context is not a reason to stop the pipeline.
  Sessions sharing a business Process id (`PRO-…`) are not duplicates.
- **Manual control only when needed.** `queue_process_next` does not finish a session — with
  `runner: "ide"` it materializes one step per call, and only `processed.status: "completed"`
  means the session is done.

## Local Rule Paths

This integration repository stores reusable Cursor content under `cursor/`. Some target repositories store the same content under `.cursor/`. Agents should prefer the target repository's own files and only fall back to this repository's templates when explicitly preparing or updating shared agent instructions.

## Update docker images after updating repository code, that is needed for tracking proper code
- needs to be updated proper docker image after changes made
- needs to be suggested for a user how to use the new funcionality

<!-- agent-workflow:end -->

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ai-managing** (20709 symbols, 39355 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/ai-managing/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ai-managing/clusters` | All functional areas |
| `gitnexus://repo/ai-managing/processes` | All execution flows |
| `gitnexus://repo/ai-managing/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

@RTK.md

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
