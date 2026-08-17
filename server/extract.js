import path from 'node:path';
import mammoth from 'mammoth';
import rtf from 'rtf-parser';

// pdfjs legacy build runs on the main thread under Node (no worker needed).
const pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * Reassemble a page's text items into lines. pdfjs hands back positioned
 * fragments; joining them blindly glues words together and loses paragraphs,
 * so we group by baseline (transform[5]) and insert breaks between groups.
 */
function itemsToText(items) {
  const lines = [];
  let currentY = null;
  let current = [];

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform ? Math.round(item.transform[5]) : currentY;

    if (currentY !== null && Math.abs(y - currentY) > 2) {
      lines.push(current.join(''));
      current = [];
    }
    currentY = y;
    current.push(item.str);
    if (item.hasEOL) {
      lines.push(current.join(''));
      current = [];
      currentY = null;
    }
  }
  if (current.length) lines.push(current.join(''));

  return lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n');
}

async function extractPdf(buffer) {
  const pdfjs = await pdfjsPromise;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToText(content.items));
    page.cleanup();
  }
  await doc.destroy();

  const text = pages
    .map((p, i) => `\n\n--- page ${i + 1} ---\n${p}`)
    .join('')
    .trim();

  return { text, pages: doc.numPages };
}

async function extractDocx(buffer) {
  const { value, messages } = await mammoth.extractRawText({ buffer });
  const warnings = messages
    .filter((m) => m.type === 'warning')
    .map((m) => m.message)
    .slice(0, 5);
  return { text: value.trim(), warnings };
}

/**
 * RTF is a markup format, not plain text — reading the bytes verbatim dumps
 * `\rtf1\ansi…` control words and `\uc0\u322` escapes into the library. Parse
 * it so the stored text is the actual prose. The parser hands back a tree of
 * text runs and paragraph groups; we walk it, joining runs and breaking on
 * paragraph groups, then collapse the run of blank lines a paragraph break
 * leaves behind.
 */
function extractRtf(buffer) {
  return new Promise((resolve, reject) => {
    rtf.string(buffer.toString('utf8'), (err, doc) => {
      if (err) return reject(err);
      const parts = [];
      const walk = (items) => {
        for (const it of items) {
          if (typeof it.value === 'string') {
            parts.push(it.value);
          } else if (Array.isArray(it.content)) {
            walk(it.content);
            parts.push('\n');
          }
        }
      };
      walk(doc.content);
      resolve(parts.join('').replace(/\n{3,}/g, '\n\n').trim());
    });
  });
}

export async function extractText(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = file.mimetype || '';

  if (ext === '.pdf' || mime === 'application/pdf') {
    const { text, pages } = await extractPdf(file.buffer);
    if (!text) {
      throw new Error(
        'No text layer found in this PDF — it is probably a scan. Run it through OCR first (e.g. `ocrmypdf in.pdf out.pdf`).',
      );
    }
    return { kind: 'pdf', text, pages };
  }

  if (ext === '.docx' || mime.includes('wordprocessingml')) {
    const { text, warnings } = await extractDocx(file.buffer);
    if (!text) throw new Error('The .docx contained no extractable text.');
    return { kind: 'docx', text, warnings };
  }

  if (ext === '.doc' || mime === 'application/msword') {
    throw new Error(
      'Legacy .doc (binary Word 97) is not supported. Save as .docx or convert: `soffice --headless --convert-to docx file.doc`',
    );
  }

  if (ext === '.rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    const text = await extractRtf(file.buffer);
    if (!text) throw new Error('The .rtf contained no extractable text.');
    return { kind: 'text', text };
  }

  if (['.txt', '.md', '.markdown', '.csv'].includes(ext) || mime.startsWith('text/')) {
    return { kind: 'text', text: file.buffer.toString('utf8').trim() };
  }

  throw new Error(`Unsupported file type: ${ext || mime || 'unknown'}. Use PDF, DOCX, TXT or MD.`);
}
