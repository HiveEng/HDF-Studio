// Drawing scale stored on each page as a PDF viewport (/VP with a /Measure dictionary), the way
// CAD exports and other PDF apps do, so a scale set here is read elsewhere and vice versa.
import * as mupdf from "mupdf";
import { measureDict, scaleFromMeasure, type Scale } from "./measure";

export function getPageScale(doc: mupdf.PDFDocument, pageIndex: number): Scale | null {
  const vp = doc.findPage(pageIndex).get("VP");
  if (!vp.isArray()) return null;
  for (let i = vp.length - 1; i >= 0; i--) {
    const m = vp.get(i).get("Measure");
    if (!m.isDictionary()) continue;
    const hk = m.get("HDFK"), hu = m.get("HDFUnit"), r = m.get("R"), x = m.get("X");
    const x0 = x.isArray() && x.length ? x.get(0) : null;
    const s = scaleFromMeasure({
      hdfK: hk.isNumber() ? hk.asNumber() : undefined,
      hdfUnit: hu.isString() ? hu.asString() : undefined,
      ratio: r.isString() ? r.asString() : undefined,
      xUnit: x0?.get("U").isString() ? x0.get("U").asString() : undefined,
      xC: x0?.get("C").isNumber() ? x0.get("C").asNumber() : undefined,
    });
    if (s) return s;
  }
  return null;
}

/** Set (or clear, with null) the scale for whole pages. Replaces our own viewport; leaves others alone. */
export function setPageScale(doc: mupdf.PDFDocument, pages: number[], s: Scale | null) {
  for (const i of pages) {
    const pageObj = doc.findPage(i);
    const old = pageObj.get("VP");
    const vp = doc.newArray();
    if (old.isArray()) for (let k = 0; k < old.length; k++) if (old.get(k).get("Name").asString?.() !== "HDF Studio scale") vp.push(old.get(k));
    if (s) {
      const d = measureDict(s);
      const fmt = (u: string, c: number) => {
        const f = doc.newDictionary();
        f.put("Type", doc.newName("NumberFormat"));
        f.put("U", doc.newString(u));
        f.put("C", doc.newReal(c));
        f.put("D", doc.newInteger(100));
        const a = doc.newArray();
        a.push(f);
        return a;
      };
      const m = doc.newDictionary();
      m.put("Type", doc.newName("Measure"));
      m.put("Subtype", doc.newName("RL"));
      m.put("R", doc.newString(d.ratio));
      m.put("X", fmt(d.xUnit, d.xC));
      m.put("D", fmt(d.xUnit, 1));
      m.put("A", fmt(d.aUnit, 1));
      m.put("HDFK", doc.newReal(s.k));
      m.put("HDFUnit", doc.newString(s.unit));
      const v = doc.newDictionary();
      v.put("Type", doc.newName("Viewport"));
      v.put("Name", doc.newString("HDF Studio scale"));
      v.put("BBox", pageObj.get("MediaBox"));
      v.put("Measure", m);
      vp.push(v);
    }
    if (vp.length) pageObj.put("VP", vp);
    else pageObj.delete("VP");
  }
}
