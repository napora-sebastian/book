/**
 * Rough token estimate — good enough for budgeting, never billed on.
 * Accepts the text itself or a character count.
 *
 * The default of 2.9 is measured against real usage on this cluster: a
 * 269,448-char Polish manuscript tokenised to 93,538 tokens, i.e. 2.88
 * chars/token. The usual English rule of thumb (~3.6) under-reports Polish by
 * a quarter, which matters when the number is what tells you whether a book
 * still fits. Override with CHARS_PER_TOKEN for a different language.
 */
const CHARS_PER_TOKEN = Number(process.env.CHARS_PER_TOKEN || 2.9);

export function estimateTokens(textOrChars) {
  const chars = typeof textOrChars === 'number' ? textOrChars : textOrChars.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Split on paragraph boundaries, packing paragraphs into chunks of at most
 * `size` characters. Oversized single paragraphs are hard-split. Each chunk
 * repeats `overlap` characters of the previous one so a sentence spanning a
 * boundary is still readable in context.
 */
export function chunkText(text, size, overlap = 0) {
  if (text.length <= size) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  const push = () => {
    if (!current.trim()) return;
    const tail = chunks.length && overlap ? chunks[chunks.length - 1].slice(-overlap) : '';
    chunks.push(tail ? `${tail}\n\n${current}` : current);
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > size) {
      push();
      for (let i = 0; i < para.length; i += size) {
        current = para.slice(i, i + size);
        push();
      }
      continue;
    }
    if (current.length + para.length + 2 > size) push();
    current = current ? `${current}\n\n${para}` : para;
  }
  push();

  return chunks;
}
