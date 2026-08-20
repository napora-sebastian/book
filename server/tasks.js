// The model streams two separate channels, and the UI shows them as two separate
// blocks in the thread: a collapsible "Thought" panel (reasoning) and the answer
// body (response). The model must keep the deliverable in the response — it has
// repeatedly done the whole job in reasoning and left the response as "Ready."
// or empty, which the user cannot save as a version.
const CHANNELS = `You have two separate output channels, shown to the user as two separate blocks
in the conversation:

1. REASONING — your private chain-of-thought. Use it to plan, analyse and draft.
   It appears in a collapsible "Thought" panel, but it is NOT your answer.
2. RESPONSE — your actual answer. This is the block the user reads and can save.

The deliverable always goes in the RESPONSE. When the user asks for text — a
rewrite, a corrected passage, the whole document — put the ENTIRE requested text
in the RESPONSE, never in REASONING. Never leave the RESPONSE as "Ready." or
empty while the real content sits in REASONING. REASONING may hold notes and
drafts, but the final, complete deliverable must be in the RESPONSE.`;

// Extraction and analysis: inventing anything is a defect, so say so instead.
const ANALYST = `You are a careful document analyst running locally on a DGX Spark cluster.
Work only from the supplied document text. If something is not in the document, say so
rather than inventing it. Quote short spans verbatim when precision matters.
Answer in the language of the document unless told otherwise.

${CHANNELS}`;

// Authoring: the analyst prompt actively refuses this work — asked to rewrite a
// chapter it answers "I cannot create new versions of chapters", because new
// prose is by definition not in the document. Editing a manuscript needs a
// collaborator that is grounded in the text but allowed to add to it.
const AUTHOR = `You are a writing collaborator on the supplied manuscript, running locally on a
DGX Spark cluster.

Stay faithful to the manuscript: characters, names, places, established events, tone and
narrative voice all come from it. If asked about something the manuscript does not
contain, say so rather than inventing a fact about the story so far.

When asked to write, rewrite, continue or restructure, do it. Produce the actual prose,
in full, in the language of the manuscript. New text is the point of the request — never
refuse on the grounds that it is "not in the document", never describe what you would
write instead of writing it, and never ask for permission first. Match the existing style
closely enough that the new passage could sit beside the old one unnoticed.

When the user asks you to return, output, or give back a chapter, passage, or the whole
document with your changes applied, you MUST return the ENTIRE requested text — the full
chapter or passage from beginning to end, with every requested change woven in — not just
the paragraphs you changed. Never return only the edited fragments. If the requested
passage is long, still return all of it in one response. Do not truncate, do not say "the
rest is unchanged", do not summarise the parts you did not touch.

${CHANNELS}`;

// Plain chat is where people actually work, and it is asked both kinds of
// question — "is the plot consistent?" one turn, "rewrite this chapter" the
// next. The no-invention rule belongs on claims about the document; extending
// it to the prose itself is what made the app refuse to write. This keeps the
// first and drops the second.
const CHAT = `You are working with the user on the supplied document, running locally on a
DGX Spark cluster.

For questions about the document, answer only from its text: quote short spans verbatim
when precision matters, and if something is not in there, say so rather than inventing it.

When the user asks you to write, rewrite, continue or restructure part of it, do that
instead — produce the actual text, in full, in the language of the document, keeping its
established characters, facts, terminology and voice. Writing new text on request is not
inventing; refusing because the new text "is not in the document" is wrong. Do not
describe what you would write, and do not ask for permission first.

When the user asks you to return, output, or give back a chapter, passage, or the whole
document with your changes applied, you MUST return the ENTIRE requested text — the full
chapter or passage from beginning to end, with every requested change woven in — not just
the paragraphs you changed. Never return only the edited fragments. If the requested
passage is long, still return all of it in one response. Do not truncate, do not say "the
rest is unchanged", do not summarise the parts you did not touch.

${CHANNELS}`;

/**
 * Extraction presets must not invent, authoring must, and plain chat has to do
 * both depending on the turn.
 */
const systemFor = (taskId) => {
  if (taskId === 'rewrite') return AUTHOR;
  if (!taskId || taskId === 'chat') return CHAT;
  return ANALYST;
};

export const TASKS = {
  summary: {
    label: 'Summary',
    instruction:
      'Write a tight summary of the document: a two-sentence abstract, then the main points as a short bulleted list. Keep it under 400 words.',
    reduce:
      'You are given summaries of consecutive sections of one document. Merge them into a single coherent summary: a two-sentence abstract, then the main points as bullets. Remove repetition, keep the original ordering of ideas.',
  },
  keypoints: {
    label: 'Key points',
    instruction:
      'Extract the key points as a bulleted list. One idea per bullet, each self-contained, ordered as they appear in the document. No preamble.',
    reduce:
      'Merge these per-section bullet lists into one deduplicated list, preserving document order. No preamble.',
  },
  actions: {
    label: 'Action items',
    instruction:
      'List every action item, obligation, deadline and owner found in the document as a markdown table with columns: Action | Owner | Deadline | Source quote. If a column is unknown write "—".',
    reduce:
      'Merge these tables into one markdown table with the same columns, dropping duplicate rows.',
  },
  entities: {
    label: 'Entities & figures',
    instruction:
      'Extract named entities and numbers as a markdown table: Type (person/org/place/date/amount/other) | Value | Context. Do not include anything absent from the text.',
    reduce: 'Merge these tables into one, deduplicating identical Value rows.',
  },
  qa: {
    label: 'Ask a question',
    instruction:
      'Answer the user question using only the document. Cite the supporting passage(s) verbatim in a > quote block beneath your answer. If the document does not contain the answer, say exactly that.',
    reduce:
      'You are given per-section answers to the same question, some of which may say the section is irrelevant. Compose one final answer from the sections that did contain relevant material, keeping their quotes.',
    needsQuestion: true,
  },
  translate: {
    label: 'Translate',
    instruction:
      'Translate the document into the requested target language. Preserve structure, headings and lists. Output only the translation.',
    reduce: 'Concatenate these translated sections in order. Do not re-translate or add commentary.',
    needsQuestion: true,
    questionLabel: 'Target language',
  },
  rewrite: {
    label: 'Rewrite / write',
    instruction:
      'Write the requested passage in full, as finished prose in the language of the manuscript. '
      + 'Keep the established characters, names, places and narrative voice. Output only the prose '
      + 'itself — no preamble, no commentary, no notes on what you changed unless asked. '
      + 'When the user asks you to return a chapter or passage with your changes applied, return the '
      + 'ENTIRE requested text from beginning to end with every change woven in — never only the '
      + 'paragraphs you changed, never "the rest is unchanged", never a summary of the untouched parts.',
    reduce:
      'You are given passages written for consecutive sections of one manuscript. Join them into '
      + 'one continuous piece of prose, smoothing the seams. Do not summarise and do not comment.',
    needsQuestion: true,
    questionLabel: 'What to write',
  },
  custom: {
    label: 'Custom prompt',
    instruction: null, // supplied by the user
    reduce:
      'You are given per-section results produced by the same instruction. Merge them into one coherent result, removing repetition.',
    needsQuestion: true,
    questionLabel: 'Your instruction',
  },
};

function instructionFor(taskId, userInput) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);

  if (taskId === 'custom') {
    if (!userInput?.trim()) throw new Error('Custom task needs an instruction.');
    return userInput.trim();
  }
  if (taskId === 'qa') {
    if (!userInput?.trim()) throw new Error('Question is required.');
    return `${task.instruction}\n\nQuestion: ${userInput.trim()}`;
  }
  if (taskId === 'translate') {
    if (!userInput?.trim()) throw new Error('Target language is required.');
    return `${task.instruction}\n\nTarget language: ${userInput.trim()}`;
  }
  return task.instruction;
}

export function buildMessages({ taskId, userInput, text, filename, part }) {
  const instruction = instructionFor(taskId, userInput);
  const where = part ? ` (section ${part.i} of ${part.n})` : '';

  return [
    { role: 'system', content: systemFor(taskId) },
    {
      role: 'user',
      content: `Document: ${filename || 'untitled'}${where}
<document>
${text}
</document>

Task: ${instruction}`,
    },
  ];
}

export function buildReduceMessages({ taskId, userInput, parts, filename }) {
  const task = TASKS[taskId];
  const original = instructionFor(taskId, userInput);
  const joined = parts
    .map((p, i) => `<section index="${i + 1}">\n${p}\n</section>`)
    .join('\n\n');

  return [
    { role: 'system', content: systemFor(taskId) },
    {
      role: 'user',
      content: `Document: ${filename || 'untitled'} (processed in ${parts.length} sections)

The original task was: ${original}

${task.reduce}

${joined}`,
    },
  ];
}

/* --------------------------------------------------------------- threads */

/**
 * Build a multi-turn conversation. The document is sent exactly once, as the
 * first user message — every later turn appends to that same prefix, so vLLM's
 * prefix cache can reuse the (expensive) document prefill across the whole
 * thread. Reordering these messages between turns would defeat that.
 */
export function buildThreadMessages({ docText, filename, history, question, taskId, workspace = null }) {
  const messages = [{ role: 'system', content: systemFor(taskId) }];

  if (docText) {
    messages.push({
      role: 'user',
      content: `Here is the document we will be discussing.

Document: ${filename || 'untitled'}
<document>
${docText}
</document>

Read it. ${taskId === 'rewrite'
        ? 'I will ask you to write and rewrite parts of it in the messages that follow.'
        : 'I will ask questions about it in the messages that follow.'} Reply only with "Ready."`,
    });
    messages.push({ role: 'assistant', content: 'Ready.' });
  }

  // The priming exchange above is a prefix-cache trick, not a standing order.
  // Once the conversation has moved past the document handshake, "Reply only
  // with Ready." no longer applies — otherwise a reasoning model does the whole
  // job in its thinking stream and closes the response with "Ready." again.
  if (history.length > 0) {
    messages.push({
      role: 'system',
      content: 'The "Reply only with Ready." instruction above applied only to the document handshake. '
        + 'From now on, answer the user\'s actual request in full in the RESPONSE channel. '
        + 'Never end a response with "Ready." unless the user asks for it.',
    });
  }

  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  // What the tool layer did to the workspace before this turn was answered.
  // It goes AFTER the document handshake and the history, so the prefix the
  // cluster caches is unchanged by it — a turn that used tools and a turn that
  // did not share every token up to this point.
  if (workspace) messages.push({ role: 'system', content: workspace });

  // A task preset just prefixes the user's own words with the preset wording.
  const preset = taskId && taskId !== 'chat' ? TASKS[taskId] : null;
  const content = preset?.instruction ? `${preset.instruction}\n\n${question}`.trim() : question;
  messages.push({ role: 'user', content });

  return messages;
}

/** Reduce prompt for a threaded question over a document too big for one pass. */
export function buildThreadReduceMessages({ parts, question, history, filename, taskId, workspace = null }) {
  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content}`)
    .join('\n');

  return [
    { role: 'system', content: systemFor(taskId) },
    {
      role: 'user',
      content: `Document: ${filename || 'untitled'} (too large for one pass; analysed in ${parts.length} sections)
${recent ? `\nEarlier in this conversation:\n${recent}\n` : ''}
Current question: ${question}

Below are per-section answers, some of which may say their section is irrelevant.
Compose one final answer from the sections that did contain relevant material,
keeping their verbatim quotes. Do not mention the sectioning.

${parts.map((p, i) => `<section index="${i + 1}">\n${p}\n</section>`).join('\n\n')}`,
    },
    ...(workspace ? [{ role: 'system', content: workspace }] : []),
  ];
}

/** Per-section prompt for the map stage of a threaded question. */
export function buildThreadMapMessages({ chunk, question, filename, part, taskId }) {
  return [
    { role: 'system', content: systemFor(taskId) },
    {
      role: 'user',
      content: `Document: ${filename || 'untitled'} (section ${part.i} of ${part.n})
<document>
${chunk}
</document>

Question: ${question}

Answer using only this section. If this section contains nothing relevant, reply
exactly: NOTHING RELEVANT IN THIS SECTION.`,
    },
  ];
}

/**
 * Inline rewrite of a single selected passage (Ctrl+select in the preview).
 * The model rewrites just the marked text, in place, keeping the manuscript's
 * voice — the same collaborator prompt as the rewrite task, scoped to a span.
 */
export function buildRewriteMessages({ passage, instruction }) {
  return [
    { role: 'system', content: AUTHOR },
    {
      role: 'user',
      content: `Rewrite the following passage in the same language and style. Keep the meaning, characters, names, places and narrative voice. Output ONLY the rewritten passage — no preamble, no commentary, no quotation marks around it.\n\n${instruction ? `Instruction: ${instruction}\n\n` : ''}Passage:\n${passage}`,
    },
  ];
}

/** "Ground truth" check: does the response's wording actually match the document? */
export function buildGroundTruthMessages({ docText, filename, response }) {
  return [
    {
      role: 'system',
      content: `You verify an assistant's response against its source document, running locally on a
DGX Spark cluster. Compare the RESPONSE against the DOCUMENT and identify every place where the
response's wording differs from, adds to, or is not supported by the document.

Reply with ONLY a JSON array (no prose, no markdown fences). Each element is an object:
{"old": "<exact wording from the document, or null if this is new information not in the document>",
 "new": "<the wording used in the response, or null if the response omits something the document states>"}
Only include entries where old and new genuinely differ in meaning or wording — do not include
lines that are already an accurate match. If the response is fully grounded in the document with
nothing added or changed, reply with exactly: []`,
    },
    {
      role: 'user',
      content: `Document: ${filename || 'untitled'}
<document>
${docText}
</document>

Response to check:
<response>
${response}
</response>

Return the JSON array now.`,
    },
  ];
}
