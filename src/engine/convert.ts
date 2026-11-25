// Create and convert: anything MuPDF opens -> PDF, images -> PDF, PDF -> images / text / HTML / SVG / Word.
import * as mupdf from "mupdf";
import { zipSync, strToU8 } from "fflate";
import { textBlocks } from "./edit";

export const PAGE_SIZES: Record<string, [number, number]> = { letter: [612, 792], legal: [612, 1008], a4: [595.28, 841.89], a3: [841.89, 1190.55], a5: [419.53, 595.28] };

const INPUT_EXT = ["pdf", "xps", "oxps", "epub", "fb2", "cbz", "mobi", "html", "htm", "xhtml", "txt", "png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff", "jxr", "pnm", "pbm", "pgm", "ppm", "psd", "svg"];
export const OFFICE_EXT = ["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"];
export const canOpen = (name: string) => INPUT_EXT.includes(ext(name));
export const needsOffice = (name: string) => OFFICE_EXT.includes(ext(name));
const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

function writer(): { buf: mupdf.Buffer; w: mupdf.DocumentWriter } {
  const buf = new mupdf.Buffer();
  return { buf, w: new mupdf.DocumentWriter(buf, "pdf", "compress,garbage") };
}
function finish(buf: mupdf.Buffer, w: mupdf.DocumentWriter): Uint8Array {
  w.close();
  const out = new Uint8Array(buf.asUint8Array());
  buf.destroy();
  return out;
}

export interface ToPdfOptions {
  /** Page size for reflowable documents (HTML, text, EPUB) and for fitting images. "auto" keeps image size. */
  pageSize?: keyof typeof PAGE_SIZES | "auto";
  margin?: number;
  /** Base font size for reflowable documents. */
  fontSize?: number;
}

/** Convert one or more documents/images into a single PDF, in order. */
export function toPdf(files: { name: string; data: Uint8Array }[], o: ToPdfOptions = {}): Uint8Array {
  const { buf, w } = writer();
  const size = o.pageSize && o.pageSize !== "auto" ? PAGE_SIZES[o.pageSize] : null;
  const margin = o.margin ?? 36;
  for (const f of files) {
    const e = ext(f.name);
    if (!canOpen(f.name)) throw new Error(`${f.name}: this format needs ${needsOffice(f.name) ? "LibreOffice (Office files)" : "a converter that isn't available"}`);
    const doc = mupdf.Document.openDocument(f.data, e === "htm" ? "html" : e);
    if (["html", "htm", "xhtml", "txt", "epub", "fb2", "mobi"].includes(e)) {
      const [pw, ph] = size ?? PAGE_SIZES.letter;
      doc.layout(pw, ph, o.fontSize ?? 11);
    }
    const isImage = !["pdf", "xps", "oxps", "epub", "fb2", "cbz", "mobi", "html", "htm", "xhtml", "txt"].includes(e);
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      const bw = b[2] - b[0], bh = b[3] - b[1];
      if (isImage && size) {
        // Fit the image inside the chosen paper size, centred, with margins; rotate paper to match orientation.
        const [sw, sh] = bw > bh ? [size[1], size[0]] : size;
        const s = Math.min((sw - 2 * margin) / bw, (sh - 2 * margin) / bh, 1e9);
        const dev = w.beginPage([0, 0, sw, sh]);
        page.run(dev, [s, 0, 0, s, (sw - bw * s) / 2 - b[0] * s, (sh - bh * s) / 2 - b[1] * s]);
        w.endPage();
      } else {
        const dev = w.beginPage(b);
        page.run(dev, mupdf.Matrix.identity);
        w.endPage();
      }
      page.destroy();
    }
    doc.destroy();
  }
  return finish(buf, w);
}

/** New blank PDF. */
export function blankPdf(pages = 1, size: keyof typeof PAGE_SIZES = "letter", landscape = false): Uint8Array {
  const { buf, w } = writer();
  const [a, b] = PAGE_SIZES[size];
  for (let i = 0; i < pages; i++) {
    w.beginPage(landscape ? [0, 0, b, a] : [0, 0, a, b]);
    w.endPage();
  }
  return finish(buf, w);
}

export type ImageFormat = "png" | "jpg";

/** Render pages to images. */
export function toImages(doc: mupdf.Document, pages: number[], dpi = 150, format: ImageFormat = "png", quality = 85): { page: number; data: Uint8Array }[] {
  const s = dpi / 72;
  return pages.map((i) => {
    const page = doc.loadPage(i);
    const pix = page.toPixmap([s, 0, 0, s, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    const data = new Uint8Array(format === "jpg" ? pix.asJPEG(quality) : pix.asPNG());
    pix.destroy();
    page.destroy();
    return { page: i, data };
  });
}

/** Whole-document export through a MuPDF writer: "html", "xhtml", "text", "svg" (SVG: one file per page). */
export function exportWith(doc: mupdf.Document, format: "html" | "xhtml" | "text" | "svg"): Uint8Array[] {
  if (format === "svg") {
    const out: Uint8Array[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const buf = new mupdf.Buffer();
      const w = new mupdf.DocumentWriter(buf, "svg", "");
      const page = doc.loadPage(i);
      page.run(w.beginPage(page.getBounds()), mupdf.Matrix.identity);
      w.endPage();
      w.close();
      out.push(new Uint8Array(buf.asUint8Array()));
      buf.destroy();
      page.destroy();
    }
    return out;
  }
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, format, "");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    page.run(w.beginPage(page.getBounds()), mupdf.Matrix.identity);
    w.endPage();
    page.destroy();
  }
  w.close();
  const out = new Uint8Array(buf.asUint8Array());
  buf.destroy();
  return [out];
}

// ---------- PDF -> Word (.docx) ----------
// Rebuilds the document as flowing paragraphs: headings are detected from font size, bold/italic and
// colour are kept, images are embedded in reading order, and each PDF page starts a new page.

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

export function toDocx(doc: mupdf.Document): Uint8Array {
  const body: string[] = [];
  const media: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  let imgN = 0;
  // Body text size = most common line size, so headings can be recognised as "noticeably bigger".
  const sizes = new Map<number, number>();
  const pages: { text: ReturnType<typeof textBlocks>; images: { bbox: number[]; png: Uint8Array; w: number; h: number }[] }[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const text = textBlocks(page);
    for (const b of text) for (const l of b.lines) sizes.set(Math.round(l.size), (sizes.get(Math.round(l.size)) ?? 0) + l.text.length);
    const images: (typeof pages)[number]["images"] = [];
    const st = page.toStructuredText("preserve-images");
    st.walk({
      onImageBlock(bbox, _m, image) {
        const pix = image.toPixmap();
        images.push({ bbox: Array.from(bbox), png: new Uint8Array(pix.asPNG()), w: bbox[2] - bbox[0], h: bbox[3] - bbox[1] });
        pix.destroy();
      },
    });
    st.destroy();
    pages.push({ text, images });
    page.destroy();
  }
  const bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  pages.forEach((pg, pi) => {
    type Item = { y: number; xml: string };
    const items: Item[] = [];
    for (const b of pg.text) {
      const s = b.style;
      const size = b.lines[0].size;
      const level = size >= bodySize * 1.6 ? 1 : size >= bodySize * 1.25 ? 2 : 0;
      const bold = /Bold/.test(s.font), italic = /Italic|Oblique/.test(s.font);
      const color = s.color.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
      const font = s.font.startsWith("Times") ? "Times New Roman" : s.font.startsWith("Courier") ? "Courier New" : "Arial";
      const rPr = `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}${color !== "000000" ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${Math.round(size * 2)}"/></w:rPr>`;
      // Join wrapped lines into one paragraph; keep hard breaks where a line ends well short of the block width.
      const width = b.bbox[2] - b.bbox[0];
      const runs = b.lines.map((l, k) => {
        const t = `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(l.text.replace(/\s+$/, ""))}</w:t></w:r>`;
        const last = k === b.lines.length - 1;
        const short = l.bbox[2] - l.bbox[0] < width * 0.7;
        return t + (last ? "" : short ? "<w:r><w:br/></w:r>" : `<w:r>${rPr}<w:t xml:space="preserve"> </w:t></w:r>`);
      });
      const indent = Math.max(0, Math.round((b.bbox[0] - 72) * 20));
      const pPr = `<w:pPr>${level ? `<w:pStyle w:val="Heading${level}"/>` : ""}<w:spacing w:after="${level ? 120 : 80}"/>${indent > 200 ? `<w:ind w:left="${indent}"/>` : ""}</w:pPr>`;
      items.push({ y: b.bbox[1], xml: `<w:p>${pPr}${runs.join("")}</w:p>` });
    }
    for (const im of pg.images) {
      imgN++;
      const rid = `rIdImg${imgN}`;
      media[`word/media/image${imgN}.png`] = im.png;
      rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imgN}.png"/>`);
      const cx = Math.round(im.w * 12700), cy = Math.round(im.h * 12700);
      items.push({
        y: im.bbox[1],
        xml: `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${imgN}" name="Image ${imgN}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgN}" name="image${imgN}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      });
    }
    items.sort((a, b) => a.y - b.y);
    body.push(...items.map((i) => i.xml));
    if (pi < pages.length - 1) body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
  });

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.join("")}</Relationships>`),
    "word/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    ...media,
  };
  return zipSync(files, { level: 6 });
}
