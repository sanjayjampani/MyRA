/**
 * Pulls literal strings from a simple PDF. Compressed streams and image-only
 * PDFs stay empty; there is no PDF library in this repo.
 */
export function extractPdfText(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes || "");
  const pieces = [];
  const pattern = /\(((?:\\\)|\\.|[^)]){1,500})\)\s*Tj/g;
  for (const match of raw.matchAll(pattern)) {
    pieces.push(match[1].replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"));
  }
  return pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, 8000);
}
