/**
 * Line diff in the shape GitHub renders: hunks with `@@` headers, both line
 * numbers, and context rows around each change.
 *
 * Myers' greedy algorithm, which costs O((N+M)·D) in the number of edits D —
 * fast for the case this app actually has (a chapter reworded in a 10k-line
 * book) and hopeless for the case where two unrelated documents get compared.
 * DIFF_MAX_EDITS is the line where we stop paying: past it the comparison comes
 * back as one wholesale rewrite rather than freezing the request.
 */

const MAX_EDITS = Number(process.env.DIFF_MAX_EDITS || 1500);
const CONTEXT = Number(process.env.DIFF_CONTEXT_LINES || 3);

// No text is zero lines, not one empty one — otherwise the original upload
// (compared against nothing) opens with a phantom deleted line.
const splitLines = (text) => {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  return s === '' ? [] : s.split('\n');
};

/**
 * Shortest edit script between two arrays, as a flat move list, or null when it
 * would take more than `maxEdits` edits to get there.
 *
 * Each iteration's frontier is snapshotted so the path can be walked back once
 * the end is reached; only the band the backtrack can reach (k ± 1) is kept, so
 * the trace costs O(D²) ints rather than O(D·(N+M)).
 */
function myers(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(maxEdits, n + m);
  const off = max + 1;
  const v = new Int32Array(2 * max + 4);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    // Only the band the backtrack can reach is kept, indexed so that band[0] is
    // diagonal −(d+1) — see `at` below.
    trace.push(v.slice(off - d - 1, off + d + 2));

    for (let k = -d; k <= d; k += 2) {
      // Extend whichever neighbouring path reaches further right; on the edges
      // of the band there is only one to come from.
      const x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
        ? v[off + k + 1]
        : v[off + k - 1] + 1;
      let y = x - k;

      let end = x;
      while (end < n && y < m && a[end] === b[y]) { end++; y++; }
      v[off + k] = end;

      if (end >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

/** Walk the snapshots back from (n, m) to (0, 0), emitting moves in reverse. */
function backtrack(trace, n, m) {
  const moves = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const band = trace[d];
    const at = (diag) => band[diag + d + 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) { moves.push({ type: 'ctx', x: --x, y: --y }); }
    if (d > 0) {
      moves.push(x === prevX ? { type: 'add', x: -1, y: prevY } : { type: 'del', x: prevX, y: -1 });
      x = prevX;
      y = prevY;
    }
  }
  return moves.reverse();
}

/**
 * Flat op list with 1-based line numbers on both sides. `truncated` marks the
 * fallback where the edit budget ran out and the middle is reported as a
 * straight replacement instead of a minimal script.
 */
export function diffLines(oldText, newText, { maxEdits = MAX_EDITS } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Identical heads and tails are the bulk of a document edit and cost the
  // algorithm nothing to skip — Myers only ever sees the part that moved.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const moves = myers(midA, midB, maxEdits);
  const truncated = moves === null;

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'ctx', oldLine: i + 1, newLine: i + 1, text: a[i] });

  if (truncated) {
    midA.forEach((text, i) => ops.push({ type: 'del', oldLine: pre + i + 1, newLine: null, text }));
    midB.forEach((text, i) => ops.push({ type: 'add', oldLine: null, newLine: pre + i + 1, text }));
  } else {
    for (const mv of moves) {
      if (mv.type === 'ctx') {
        ops.push({ type: 'ctx', oldLine: pre + mv.x + 1, newLine: pre + mv.y + 1, text: midA[mv.x] });
      } else if (mv.type === 'del') {
        ops.push({ type: 'del', oldLine: pre + mv.x + 1, newLine: null, text: midA[mv.x] });
      } else {
        ops.push({ type: 'add', oldLine: null, newLine: pre + mv.y + 1, text: midB[mv.y] });
      }
    }
  }

  for (let i = 0; i < suf; i++) {
    ops.push({
      type: 'ctx',
      oldLine: a.length - suf + i + 1,
      newLine: b.length - suf + i + 1,
      text: a[a.length - suf + i],
    });
  }

  return {
    ops,
    truncated,
    additions: ops.filter((o) => o.type === 'add').length,
    deletions: ops.filter((o) => o.type === 'del').length,
  };
}

/** Cheap enough to run on every save — the version list shows +N −M per entry. */
export function diffStat(oldText, newText) {
  const { additions, deletions, truncated } = diffLines(oldText, newText);
  return { additions, deletions, truncated };
}

/**
 * Group the ops into `@@` hunks: every changed run plus `context` unchanged
 * lines either side, with runs that would overlap merged into one hunk.
 */
export function toHunks(ops, context = CONTEXT) {
  const changedIdx = [];
  ops.forEach((o, i) => { if (o.type !== 'ctx') changedIdx.push(i); });
  if (!changedIdx.length) return [];

  // Two changes less than two context blocks apart belong to one hunk —
  // splitting them would print the same lines twice, once as each one's tail.
  const groups = [];
  let cur = [changedIdx[0], changedIdx[0]];
  for (const i of changedIdx.slice(1)) {
    if (i - cur[1] <= context * 2 + 1) cur[1] = i;
    else { groups.push(cur); cur = [i, i]; }
  }
  groups.push(cur);

  return groups.map(([first, last]) => {
    const lines = ops.slice(Math.max(0, first - context), Math.min(ops.length, last + context + 1));
    const oldLines = lines.filter((l) => l.oldLine != null);
    const newLines = lines.filter((l) => l.newLine != null);
    // An empty side still needs a start, and unified diffs write 0 there.
    const oldStart = oldLines.length ? oldLines[0].oldLine : 0;
    const newStart = newLines.length ? newLines[0].newLine : 0;

    return {
      oldStart,
      oldLines: oldLines.length,
      newStart,
      newLines: newLines.length,
      header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      lines: withWordDiffs(lines),
    };
  });
}

/* --------------------------------------------------------------- word level */

const tokenize = (s) => s.match(/\s+|[^\s]+/g) ?? [];

/**
 * Rewording one sentence reads as a wall of red and green unless the words that
 * actually moved are marked. Deleted and added runs of equal length are paired
 * line-for-line and given `parts` spans; anything else stays a plain line.
 */
function withWordDiffs(lines) {
  const out = lines.map((l) => ({ ...l }));

  for (let i = 0; i < out.length; i++) {
    if (out[i].type !== 'del') continue;
    let dels = 0;
    while (i + dels < out.length && out[i + dels].type === 'del') dels++;
    let adds = 0;
    while (i + dels + adds < out.length && out[i + dels + adds].type === 'add') adds++;

    if (dels === adds) {
      for (let j = 0; j < dels; j++) {
        const del = out[i + j];
        const add = out[i + dels + j];
        const pair = wordDiff(del.text, add.text);
        if (pair) { del.parts = pair.old; add.parts = pair.new; }
      }
    }
    i += dels + adds - 1;
  }
  return out;
}

/** null when the two lines share too little to be a rewrite of one another. */
function wordDiff(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (!a.length || !b.length) return null;

  const moves = myers(a, b, 200);
  if (!moves) return null;

  const kept = moves.filter((m) => m.type === 'ctx').reduce((n, m) => n + a[m.x].trim().length, 0);
  const total = Math.max(oldText.trim().length, newText.trim().length);
  // Two unrelated lines "share" their spaces and short words; marking those
  // helps nobody, so below a third in common the line is shown as a whole.
  if (!total || kept / total < 0.34) return null;

  const push = (parts, eq, text) => {
    const last = parts[parts.length - 1];
    if (last && last.eq === eq) last.text += text;
    else parts.push({ eq, text });
  };
  const oldParts = [];
  const newParts = [];
  for (const mv of moves) {
    if (mv.type === 'ctx') { push(oldParts, true, a[mv.x]); push(newParts, true, b[mv.y]); }
    else if (mv.type === 'del') push(oldParts, false, a[mv.x]);
    else push(newParts, false, b[mv.y]);
  }
  return { old: oldParts, new: newParts };
}

/** One document compared to one of its earlier versions, ready to render. */
export function buildDiff({ filename, oldText, newText, context = CONTEXT }) {
  const { ops, additions, deletions, truncated } = diffLines(oldText, newText);
  return { filename, additions, deletions, truncated, hunks: toHunks(ops, context) };
}
