// Document check (preflight): PDF/A archiving rules, accessibility basics and security findings,
// each with a plain-language explanation and, where possible, a one-click fix.
import * as mupdf from "mupdf";
import { listFigures } from "./autotag";
import { pagesWithoutText } from "./ocr";

export type Area = "PDF/A" | "Accessibility" | "Security";
export type Fix = "title" | "lang" | "displayTitle" | "tabs" | "ocr" | "sanitize" | "unprotect" | "pdfa" | "tag" | "alt";
export interface Issue {
  id: string;
  area: Area;
  level: "error" | "warning";
  text: string;
  /** 1-based pages, when the issue is page-specific. */
  pages?: number[];
  fix?: Fix;
}
export interface CheckReport {
  issues: Issue[];
  /** Claimed PDF/A conformance from the XMP metadata, e.g. "2B". */
  pdfaClaim: string | null;
  tagged: boolean;
  passes: Record<Area, boolean>;
}

/** Follow a path of keys/indexes; stops (returning a null object) at anything that isn't a container. */
function at(o: mupdf.PDFObject, ...path: (string | number)[]): mupdf.PDFObject {
  for (const k of path) {
    if (!(o.isDictionary() || o.isArray())) return o.isNull() ? o : mupdf.PDFObject.Null;
    o = o.get(k as string);
  }
  return o;
}

const listPages = (p: number[]) => (p.length > 8 ? `${p.slice(0, 8).join(", ")}…` : p.join(", "));

function fontsOf(res: mupdf.PDFObject, seen: Set<string>, out: { name: string; embedded: boolean }[], depth = 0) {
  if (res.isNull() || depth > 4) return;
  const fonts = res.get("Font");
  if (fonts.isDictionary())
    fonts.forEach((f) => {
      const key = f.isIndirect() ? `o${f.asIndirect()}` : `d${out.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sub = f.get("Subtype").asName();
      if (sub === "Type3") return;
      const desc = sub === "Type0" ? at(f, "DescendantFonts", 0, "FontDescriptor") : f.get("FontDescriptor");
      const embedded = !desc.isNull() && ["FontFile", "FontFile2", "FontFile3"].some((k) => !desc.get(k).isNull());
      out.push({ name: f.get("BaseFont").asName() || "(unnamed)", embedded });
    });
  const xo = res.get("XObject");
  if (xo.isDictionary())
    xo.forEach((x) => {
      if (x.get("Subtype").asName() !== "Form") return;
      const key = x.isIndirect() ? `x${x.asIndirect()}` : "";
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      fontsOf(x.get("Resources"), seen, out, depth + 1);
    });
}

export function checkDocument(doc: mupdf.PDFDocument, encrypted: boolean): CheckReport {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);
  const trailer = doc.getTrailer();
  const root = trailer.get("Root");
  const pages = doc.countPages();

  // --- PDF/A identification ---
  let xmp = "";
  const meta = root.get("Metadata");
  if (meta.isStream()) {
    try {
      xmp = meta.readStream().asString();
    } catch { /* unreadable */ }
  }
  const part = xmp.match(/pdfaid:part\s*=\s*["'](\d)["']|<pdfaid:part>(\d)</);
  const conf = xmp.match(/pdfaid:conformance\s*=\s*["']([ABU])["']|<pdfaid:conformance>([ABU])</i);
  const pdfaClaim = part ? `${part[1] ?? part[2]}${(conf?.[1] ?? conf?.[2] ?? "").toUpperCase()}` : null;
  if (!pdfaClaim) add({ id: "pdfa-claim", area: "PDF/A", level: "error", text: "Not marked as PDF/A, the ISO format for long-term archiving.", fix: "pdfa" });
  if (root.get("OutputIntents").isNull()) add({ id: "pdfa-intent", area: "PDF/A", level: "error", text: "No output intent (colour profile), so colours can't be reproduced reliably later.", fix: "pdfa" });
  if (encrypted) add({ id: "pdfa-encrypt", area: "PDF/A", level: "error", text: "Password protection or encryption isn't allowed in PDF/A.", fix: "unprotect" });

  // Fonts
  const fonts: { name: string; embedded: boolean }[] = [];
  const seen = new Set<string>();
  const missingFontPages: number[] = [];
  for (let i = 0; i < pages; i++) {
    const before = fonts.filter((f) => !f.embedded).length;
    fontsOf((doc.findPage(i) as mupdf.PDFObject).getInheritable("Resources"), seen, fonts);
    if (fonts.filter((f) => !f.embedded).length > before) missingFontPages.push(i + 1);
  }
  const unembedded = [...new Set(fonts.filter((f) => !f.embedded).map((f) => f.name.replace(/^[A-Z]{6}\+/, "")))];
  if (unembedded.length)
    add({ id: "pdfa-fonts", area: "PDF/A", level: "error", text: `Fonts not embedded: ${unembedded.slice(0, 6).join(", ")}${unembedded.length > 6 ? "…" : ""}. Other computers may show the text differently.`, pages: missingFontPages, fix: "pdfa" });

  // JavaScript, attachments, actions
  const names = root.get("Names");
  const hasJs = !at(names, "JavaScript").isNull() || !at(root, "OpenAction", "JS").isNull() || !root.get("AA").isNull();
  if (hasJs) add({ id: "js", area: "Security", level: "warning", text: "Contains JavaScript, which can run when the file is opened. Not allowed in PDF/A.", fix: "sanitize" });
  if (!at(names, "EmbeddedFiles").isNull()) add({ id: "attach", area: "Security", level: "warning", text: "Contains attached files. Check them before sharing; PDF/A-2 doesn't allow them.", fix: "sanitize" });

  // Annotations: must be printable and have appearances in PDF/A.
  const hiddenAnnots: number[] = [];
  let annotsOnPages = 0;
  const noTabs: number[] = [];
  for (let i = 0; i < pages; i++) {
    const pageObj = doc.findPage(i) as mupdf.PDFObject;
    const annots = pageObj.get("Annots");
    if (!annots.isArray() || !annots.length) continue;
    annotsOnPages++;
    if (pageObj.get("Tabs").asName() !== "S") noTabs.push(i + 1);
    for (let k = 0; k < annots.length; k++) {
      const a = annots.get(k);
      const sub = a.get("Subtype").asName();
      if (sub === "Popup" || sub === "Link") continue;
      const flags = a.get("F").isNumber() ? a.get("F").asNumber() : 0;
      if (!(flags & 4) || a.get("AP").isNull()) {
        hiddenAnnots.push(i + 1);
        break;
      }
    }
  }
  if (hiddenAnnots.length) add({ id: "pdfa-annots", area: "PDF/A", level: "warning", text: "Some comments or fields won't print or have no fixed appearance.", pages: hiddenAnnots, fix: "pdfa" });

  // --- Accessibility ---
  const marked = at(root, "MarkInfo", "Marked");
  const tagged = !root.get("StructTreeRoot").isNull() && marked.isBoolean() && marked.asBoolean();
  if (!tagged) add({ id: "ua-tags", area: "Accessibility", level: "error", text: "Not tagged: screen readers can't tell headings, paragraphs, lists and tables apart.", fix: "tag" });
  else {
    const noAlt = listFigures(doc).filter((f) => !f.alt.trim());
    if (noAlt.length) add({ id: "ua-alt", area: "Accessibility", level: "error", text: `${noAlt.length} image${noAlt.length === 1 ? " has" : "s have"} no description (alt text).`, pages: [...new Set(noAlt.map((f) => f.page + 1))], fix: "alt" });
  }
  const title = doc.getMetaData("info:Title") ?? "";
  if (!title.trim()) add({ id: "ua-title", area: "Accessibility", level: "error", text: "No document title.", fix: "title" });
  const vp = at(root, "ViewerPreferences", "DisplayDocTitle");
  if (!(vp.isBoolean() && vp.asBoolean())) add({ id: "ua-display-title", area: "Accessibility", level: "warning", text: "Window shows the file name instead of the document title.", fix: "displayTitle" });
  if (!root.get("Lang").isString() || !root.get("Lang").asString().trim()) add({ id: "ua-lang", area: "Accessibility", level: "error", text: "No document language, so screen readers may mispronounce the text.", fix: "lang" });
  if (noTabs.length) add({ id: "ua-tabs", area: "Accessibility", level: "warning", text: "Tab order doesn't follow the document structure on pages with links, fields or comments.", pages: noTabs, fix: "tabs" });
  const scanned = pagesWithoutText(doc);
  if (scanned.length) add({ id: "ua-scanned", area: "Accessibility", level: "error", text: `${scanned.length} page${scanned.length === 1 ? " has" : "s have"} no real text (scans), so they can't be read aloud or searched.`, pages: scanned.map((p) => p + 1), fix: "ocr" });
  if (pages > 20 && !doc.loadOutline()?.length) add({ id: "ua-bookmarks", area: "Accessibility", level: "warning", text: "Long document without bookmarks; readers can't jump to sections." });
  if (encrypted) add({ id: "sec-encrypt", area: "Security", level: "warning", text: "Encrypted: some assistive technology can't read protected files.", fix: "unprotect" });

  for (const i of issues) if (i.pages) i.text += ` (page${i.pages.length === 1 ? "" : "s"} ${listPages(i.pages)})`;
  const passes = { "PDF/A": !issues.some((i) => i.area === "PDF/A" && i.level === "error"), Accessibility: !issues.some((i) => i.area === "Accessibility" && i.level === "error"), Security: !issues.some((i) => i.area === "Security") };
  return { issues, pdfaClaim, tagged, passes };
}

/** Apply the simple metadata fixes in place. */
export function applyFixes(doc: mupdf.PDFDocument, f: { title?: string; lang?: string; displayTitle?: boolean; tabs?: boolean }) {
  const root = doc.getTrailer().get("Root");
  if (f.title !== undefined) doc.setMetaData("info:Title", f.title);
  if (f.lang) root.put("Lang", doc.newString(f.lang));
  if (f.displayTitle) {
    let vp = root.get("ViewerPreferences");
    if (vp.isNull()) {
      vp = doc.newDictionary();
      root.put("ViewerPreferences", vp);
    }
    vp.put("DisplayDocTitle", true);
  }
  if (f.tabs)
    for (let i = 0; i < doc.countPages(); i++) {
      const p = doc.findPage(i) as mupdf.PDFObject;
      if (p.get("Annots").isArray()) p.put("Tabs", doc.newName("S"));
    }
}

/**
 * Finish a Ghostscript PDF/A conversion: add the sRGB output intent and carry over the document
 * language, title display and tab order that Ghostscript drops.
 */
export function finishPdfa(doc: mupdf.PDFDocument, original: mupdf.PDFDocument | null, icc: Uint8Array) {
  const root = doc.getTrailer().get("Root");
  if (root.get("OutputIntents").isNull()) {
    const profile = doc.addStream(icc, { N: 3 });
    const intent = doc.addObject(
      doc.newDictionary(),
    );
    intent.put("Type", doc.newName("OutputIntent"));
    intent.put("S", doc.newName("GTS_PDFA1"));
    intent.put("OutputConditionIdentifier", doc.newString("sRGB"));
    intent.put("Info", doc.newString("sRGB display profile"));
    intent.put("DestOutputProfile", profile);
    const arr = doc.newArray();
    arr.push(intent);
    root.put("OutputIntents", arr);
  }
  if (original) {
    const o = original.getTrailer().get("Root");
    const lang = o.get("Lang");
    if (lang.isString() && root.get("Lang").isNull()) root.put("Lang", doc.newString(lang.asString()));
    const dt = at(o, "ViewerPreferences", "DisplayDocTitle");
    if (dt.isBoolean() && dt.asBoolean()) applyFixes(doc, { displayTitle: true });
    const t = original.getMetaData("info:Title");
    if (t && !doc.getMetaData("info:Title")) doc.setMetaData("info:Title", t);
  }
}
