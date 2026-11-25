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

/** A one-page form: text fields (name, email), a checkbox (agree), a combo box (country), a radio group (size). */
export function makeFormPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const helv = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const content = [
    "BT /F1 12 Tf 72 720 Td (Name) Tj ET",
    "BT /F1 12 Tf 72 680 Td (Email) Tj ET",
    "BT /F1 12 Tf 72 640 Td (I agree) Tj ET",
    "BT /F1 12 Tf 72 600 Td (Country) Tj ET",
    "BT /F1 12 Tf 72 560 Td (Size: S / M / L) Tj ET",
  ].join("\n");
  const pageObj = doc.addPage([0, 0, 612, 792], 0, { Font: { F1: helv } }, content);
  doc.insertPage(-1, pageObj);
  const page = doc.findPage(0);
  const annots = doc.newArray();
  const fields = doc.newArray();
  const base = (rect: number[]) => {
    const d = doc.newDictionary();
    d.put("Type", doc.newName("Annot"));
    d.put("Subtype", doc.newName("Widget"));
    const r = doc.newArray();
    rect.forEach((v) => r.push(v));
    d.put("Rect", r);
    d.put("F", 4);
    d.put("P", page);
    d.put("DA", doc.newString("/Helv 11 Tf 0 g"));
    return d;
  };
  const onOff = (on: string) => {
    const n = doc.newDictionary();
    n.put(on, doc.addStream("q 0 0 1 rg 2 2 10 10 re f Q", { BBox: [0, 0, 14, 14], Subtype: doc.newName("Form") } as never));
    n.put("Off", doc.addStream("", { BBox: [0, 0, 14, 14], Subtype: doc.newName("Form") } as never));
    const ap = doc.newDictionary();
    ap.put("N", n);
    return ap;
  };
  const add = (d: mupdf.PDFObject, isField = true) => {
    const ref = doc.addObject(d);
    annots.push(ref);
    if (isField) fields.push(ref);
    return ref;
  };
  for (const [name, y] of [["name", 715], ["email", 675]] as const) {
    const d = base([160, y - 4, 400, y + 14]);
    d.put("FT", doc.newName("Tx"));
    d.put("T", doc.newString(name));
    add(d);
  }
  const cb = base([160, 636, 174, 650]);
  cb.put("FT", doc.newName("Btn"));
  cb.put("T", doc.newString("agree"));
  cb.put("V", doc.newName("Off"));
  cb.put("AS", doc.newName("Off"));
  cb.put("AP", onOff("Yes"));
  add(cb);
  const ch = base([160, 596, 300, 614]);
  ch.put("FT", doc.newName("Ch"));
  ch.put("T", doc.newString("country"));
  ch.put("Ff", 1 << 17);
  const opts = doc.newArray();
  for (const c of ["Canada", "Ireland", "United States"]) opts.push(doc.newString(c));
  ch.put("Opt", opts);
  add(ch);
  const radio = doc.newDictionary();
  radio.put("FT", doc.newName("Btn"));
  radio.put("T", doc.newString("size"));
  radio.put("Ff", (1 << 15) | (1 << 14));
  radio.put("V", doc.newName("Off"));
  const kids = doc.newArray();
  const radioRef = doc.addObject(radio);
  ["S", "M", "L"].forEach((s, i) => {
    const w = base([180 + i * 30, 556, 194 + i * 30, 570]);
    w.put("Parent", radioRef);
    w.put("AS", doc.newName("Off"));
    w.put("AP", onOff(s));
    kids.push(add(w, false));
  });
  radio.put("Kids", kids);
  fields.push(radioRef);
  page.put("Annots", annots);
  const form = doc.newDictionary();
  form.put("Fields", fields);
  form.put("DA", doc.newString("/Helv 11 Tf 0 g"));
  const dr = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("Helv", helv);
  dr.put("Font", fonts);
  form.put("DR", dr);
  doc.getTrailer().get("Root").put("AcroForm", form);
  return new Uint8Array(doc.saveToBuffer("").asUint8Array());
}
