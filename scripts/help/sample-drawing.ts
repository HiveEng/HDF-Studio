// A realistic engineering sheet (tabloid, 17 x 11 in) used for the user guide's screenshots:
// a small office floor plan at 1/4" = 1'-0" with walls, doors, grid lines, dimensions,
// room names, general notes and a title block.
import * as mupdf from "mupdf";

const FT = 13.5; // 3/16" = 1'-0": one foot is 0.1875 in = 13.5 pt on paper

export function makeSampleDrawing(o: { revised?: boolean } = {}): Uint8Array {
  const px = o.revised ? 30 : 33; // revision 2 moves the storage partition and adds a door
  const doc = new mupdf.PDFDocument();
  const helv = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const bold = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
  const W = 1224, H = 792;
  const out: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => out.push(`${x1} ${y1} m ${x2} ${y2} l S`);
  const rect = (x: number, y: number, w: number, h: number, fill = false) => out.push(`${x} ${y} ${w} ${h} re ${fill ? "f" : "S"}`);
  const text = (s: string, x: number, y: number, size = 8, b = false) => out.push(`BT /${b ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${s.replace(/([()\\])/g, "\\$1")}) Tj ET`);
  const ctext = (s: string, x: number, y: number, size = 8, b = false) => text(s, x - s.length * size * 0.27, y, size, b);
  const width = (w: number) => out.push(`${w} w`);
  const grey = (g: number) => out.push(`${g} G ${g} g`);
  const circle = (cx: number, cy: number, r: number) => {
    const k = 0.5523 * r;
    out.push(`${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c S`);
  };
  /** Quarter-circle door swing from the hinge, radius r, starting angle a0 (degrees). */
  const door = (hx: number, hy: number, r: number, a0: number) => {
    const rad = (d: number) => (d * Math.PI) / 180;
    const p = (a: number) => [hx + r * Math.cos(rad(a)), hy + r * Math.sin(rad(a))];
    const [x0, y0] = p(a0), [x3, y3] = p(a0 + 90);
    const k = 0.5523;
    const c1 = [x0 - k * (y0 - hy), y0 + k * (x0 - hx)], c2 = [x3 + k * (y3 - hy), y3 - k * (x3 - hx)];
    width(0.35);
    out.push(`[2 2] 0 d ${x0} ${y0} m ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${x3} ${y3} c S [] 0 d`);
    width(0.8);
    line(hx, hy, x3, y3);
  };

  // Sheet border and title block.
  grey(0);
  width(1.6);
  rect(24, 24, W - 48, H - 48);
  width(0.8);
  const tbx = W - 24 - 216;
  rect(tbx, 24, 216, H - 48);
  for (const y of [120, 170, 220, 300, 380]) line(tbx, y, W - 24, y);
  text("HIVE ENGINEERING", tbx + 14, H - 70, 15, true);
  text("Structural  |  Civil  |  Building Science", tbx + 14, H - 88, 7);
  text("PROJECT", tbx + 10, 365, 6);
  text("MAPLE STREET OFFICE", tbx + 10, 348, 11, true);
  text("RENOVATION - LEVEL 1", tbx + 10, 334, 9);
  text("DRAWING TITLE", tbx + 10, 286, 6);
  text("FLOOR PLAN", tbx + 10, 268, 13, true);
  text("SCALE", tbx + 10, 206, 6);
  text("3/16\" = 1'-0\"", tbx + 10, 190, 10, true);
  text("DATE", tbx + 120, 206, 6);
  text("2026-11-20", tbx + 120, 190, 10, true);
  text("DRAWN  SO       CHECKED  JM", tbx + 10, 150, 8);
  text("PROJECT No. 26-114", tbx + 10, 134, 8);
  text("SHEET", tbx + 10, 106, 6);
  text("A-101", tbx + 10, 60, 34, true);
  text("REV 2", tbx + 150, 60, 12, true);
  // Revision table.
  text("REVISIONS", tbx + 10, 470, 7, true);
  width(0.5);
  for (let i = 0; i < 4; i++) line(tbx + 8, 460 - i * 16, W - 32, 460 - i * 16);
  text("1   2026-10-02   ISSUED FOR REVIEW", tbx + 10, 448, 7);
  text("2   2026-11-20   ISSUED FOR PERMIT", tbx + 10, 432, 7);

  // Grid lines and bubbles.
  const ox = 130, oy = 130; // plan origin (bottom left of the building)
  const gx = [0, 18, 36, 54].map((f) => ox + f * FT);
  const gy = [0, 15, 30].map((f) => oy + f * FT);
  grey(0.45);
  width(0.4);
  out.push("[12 3 2 3] 0 d");
  for (const x of gx) line(x, oy - 40, x, gy[2] + 50);
  for (const y of gy) line(ox - 50, y, gx[3] + 40, y);
  out.push("[] 0 d");
  grey(0);
  width(0.7);
  "1234".split("").forEach((n, i) => { circle(gx[i], gy[2] + 64, 12); ctext(n, gx[i], gy[2] + 60, 11, true); });
  "ABC".split("").forEach((n, i) => { circle(ox - 64, gy[i], 12); ctext(n, ox - 64, gy[i] - 4, 11, true); });

  // Exterior walls (double line, 8" thick) and interior partitions.
  const t = (8 / 12) * FT;
  width(1.4);
  rect(ox, oy, 54 * FT, 30 * FT);
  rect(ox + t, oy + t, 54 * FT - 2 * t, 30 * FT - 2 * t);
  width(1);
  const pt = (5 / 12) * FT;
  // Corridor wall along grid B, with door openings.
  const yB = gy[1];
  const openings = [[ox + 6.5 * FT, ox + 9.5 * FT], [ox + 24.5 * FT, ox + 27.5 * FT], [ox + 42.5 * FT, ox + 45.5 * FT]];
  let x0 = ox + t;
  for (const [a, b] of openings) { line(x0, yB, a, yB); line(x0, yB + pt, a, yB + pt); x0 = b; }
  line(x0, yB, ox + 54 * FT - t, yB); line(x0, yB + pt, ox + 54 * FT - t, yB + pt);
  // Partitions on grids 2 and 3 (upper rooms) and a lower split.
  for (const x of [gx[1], gx[2]]) { line(x, yB + pt, x, oy + 30 * FT - t); line(x + pt, yB + pt, x + pt, oy + 30 * FT - t); }
  line(ox + px * FT, oy + t, ox + px * FT, yB); line(ox + px * FT + pt, oy + t, ox + px * FT + pt, yB);
  for (const [a] of openings) door(a, yB + pt, 3 * FT, 0);
  door(ox + 36 * FT, oy + t, 3 * FT, 0);
  if (o.revised) door(ox + 4 * FT, oy + t, 3 * FT, 0);

  // Windows in the top wall.
  width(0.5);
  for (const c of [9, 27, 45]) { const a = ox + (c - 3) * FT, b = ox + (c + 3) * FT, y = oy + 30 * FT; line(a, y - t / 2, b, y - t / 2); rect(a, y - t, b - a, t); }

  // Furniture hints: conference table, desks.
  grey(0.35);
  width(0.5);
  rect(ox + 22 * FT, oy + 22.5 * FT, 10 * FT, 4 * FT);
  for (const c of [2, 11.5]) rect(ox + c * FT, oy + 24 * FT, 5 * FT, 2.5 * FT);
  for (const c of [38, 47]) rect(ox + c * FT, oy + 24 * FT, 5 * FT, 2.5 * FT);
  for (let i = 0; i < 4; i++) rect(ox + (3 + i * 6.5) * FT, oy + 3 * FT, 5 * FT, 2.5 * FT);
  grey(0);

  // Room names and numbers.
  ctext("OFFICE", ox + 9 * FT, oy + 21 * FT, 9, true); ctext("101", ox + 9 * FT, oy + 19.6 * FT, 8);
  ctext("CONFERENCE", ox + 27 * FT, oy + 20.4 * FT, 9, true); ctext("102", ox + 27 * FT, oy + 19.2 * FT, 8);
  ctext("OFFICE", ox + 45 * FT, oy + 21 * FT, 9, true); ctext("103", ox + 45 * FT, oy + 19.6 * FT, 8);
  ctext("OPEN WORK AREA", ox + 16 * FT, oy + 8 * FT, 9, true); ctext("104", ox + 16 * FT, oy + 6.6 * FT, 8);
  ctext(o.revised ? "STORAGE / IT" : "STORAGE", ox + 43.5 * FT, oy + 8 * FT, 9, true); ctext("105", ox + 43.5 * FT, oy + 6.6 * FT, 8);

  // Dimension strings along the bottom and the left.
  width(0.4);
  const dimY = oy - 24;
  const ticks = (x: number, y: number) => line(x - 3, y - 3, x + 3, y + 3);
  line(gx[0], dimY, gx[3], dimY);
  for (const x of gx) { line(x, oy - 6, x, dimY - 6); ticks(x, dimY); }
  for (let i = 0; i < 3; i++) ctext("18'-0\"", (gx[i] + gx[i + 1]) / 2, dimY + 4, 7);
  const dimX = ox - 28;
  line(dimX, gy[0], dimX, gy[2]);
  for (const y of gy) { line(ox - 6, y, dimX - 6, y); ticks(dimX, y); }
  for (let i = 0; i < 2; i++) text("15'-0\"", dimX - 30, (gy[i] + gy[i + 1]) / 2 - 3, 7);
  const dim2 = oy - 48;
  line(gx[0], dim2, gx[3], dim2); ticks(gx[0], dim2); ticks(gx[3], dim2);
  ctext("54'-0\"", (gx[0] + gx[3]) / 2, dim2 + 4, 7);

  // General notes.
  const nx = 130;
  text("GENERAL NOTES", nx, H - 46, 9, true);
  [
    "1. ALL DIMENSIONS ARE TO GRID OR FACE OF",
    "   STUD UNLESS NOTED OTHERWISE.",
    "2. VERIFY ALL DIMENSIONS ON SITE BEFORE",
    "   STARTING WORK.",
    "3. NEW PARTITIONS: 92mm STEEL STUD WITH",
    "   ONE LAYER 16mm TYPE X GYPSUM EACH SIDE.",
    "4. DOORS: 915 x 2135 SOLID CORE WOOD IN",
    "   HOLLOW METAL FRAME. SEE SCHEDULE A-601.",
    "5. PROVIDE BLOCKING FOR WALL-MOUNTED",
    "   EQUIPMENT. COORDINATE WITH OWNER.",
  ].forEach((s, i) => text(s, nx + (i >= 6 ? 330 : 0), H - 62 - (i % 6) * 11, 7));
  const kx = 800;
  text("KEY PLAN", kx, H - 46, 8, true);
  width(0.6);
  rect(kx, H - 116, 100, 60);
  grey(0.7);
  rect(kx + 8, H - 106, 50, 36, true);
  grey(0);
  text("NORTH", kx + 116, H - 118, 7, true);
  out.push(`${kx + 128} ${H - 106} m ${kx + 122} ${H - 90} l ${kx + 128} ${H - 60} l ${kx + 134} ${H - 90} l h S`);

  const page = doc.addPage([0, 0, W, H], 0, { Font: { F1: helv, F2: bold } }, out.join("\n"));
  doc.insertPage(-1, page);
  // A second sheet, so page navigation and thumbnails have something to show.
  const out1 = out.splice(0);
  void out1;
  text("SECTION A", 120, 600, 14, true);
  width(1.2);
  rect(120, 300, 700, 260);
  text("A-301", W - 24 - 206, 60, 34, true);
  const p2 = doc.addPage([0, 0, W, H], 0, { Font: { F1: helv, F2: bold } }, [...out1.filter((s) => !s.includes("A-101") && !s.includes("FLOOR PLAN")), ...out].join("\n"));
  doc.insertPage(-1, p2);
  return new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
}

if (process.argv[1]?.endsWith("sample-drawing.ts")) {
  const fs = await import("node:fs");
  fs.writeFileSync(process.argv[2] ?? "sample-drawing.pdf", makeSampleDrawing());
}
