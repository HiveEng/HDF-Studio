// Generates small sample PDFs for tests and manual QA.
import * as mupdf from "mupdf";

export function makeSamplePdf(pages = 3, label = "Sample"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 0; i < pages; i++) {
    const resources = { Font: { F1: font } };
    const lines = [`${label} page ${i + 1}`, "The quick brown fox jumps over the lazy dog.", `Invoice number QX-${1000 + i}`];
    const body = lines.map((t, j) => `BT /F1 ${j ? 14 : 24} Tf 72 ${720 - j * 40} Td (${t}) Tj ET`).join("\n");
    const page = doc.addPage([0, 0, 612, 792], 0, resources, body);
    doc.insertPage(-1, page);
  }
  const outline = doc.outlineIterator();
  for (let i = 0; i < pages; i++) {
    outline.insert({ title: `Chapter ${i + 1}`, uri: doc.formatLinkURI({ page: i, type: "Fit" } as never), open: true });
  }
  const buf = doc.saveToBuffer("compress");
  return new Uint8Array(buf.asUint8Array());
}
