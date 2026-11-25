// Drawing scales and measurements. Pure functions, shared by the engine and the UI.
// A scale is stored as k = real inches per PDF point, plus the unit people want to read.

export type Pt = [number, number];
export type Unit = "ft-in" | "ft" | "in" | "m" | "mm" | "cm";
export interface Scale {
  /** Real-world inches per PDF point. */
  k: number;
  unit: Unit;
  /** How the scale was written, e.g. 1/4" = 1'-0" or 1:100. */
  label: string;
}

export const UNITS: [Unit, string][] = [
  ["ft-in", "Feet and inches (12'-6 1/2\")"],
  ["ft", "Feet (decimal)"],
  ["in", "Inches"],
  ["m", "Metres"],
  ["mm", "Millimetres"],
  ["cm", "Centimetres"],
];
const IN_PER: Record<Exclude<Unit, "ft-in">, number> = { ft: 12, in: 1, m: 39.37007874, mm: 0.03937007874, cm: 0.3937007874 };

/** Common drawing scales: [label, real inches per paper inch]. */
export const PRESET_SCALES: [string, number][] = [
  ['1/16" = 1\'-0"', 192],
  ['3/32" = 1\'-0"', 128],
  ['1/8" = 1\'-0"', 96],
  ['3/16" = 1\'-0"', 64],
  ['1/4" = 1\'-0"', 48],
  ['3/8" = 1\'-0"', 32],
  ['1/2" = 1\'-0"', 24],
  ['3/4" = 1\'-0"', 16],
  ['1" = 1\'-0"', 12],
  ['1 1/2" = 1\'-0"', 8],
  ['3" = 1\'-0"', 4],
  ['1" = 10\'', 120],
  ['1" = 20\'', 240],
  ['1" = 30\'', 360],
  ['1" = 40\'', 480],
  ['1" = 50\'', 600],
  ['1" = 100\'', 1200],
  ["1:1", 1],
  ["1:2", 2],
  ["1:5", 5],
  ["1:10", 10],
  ["1:20", 20],
  ["1:25", 25],
  ["1:50", 50],
  ["1:100", 100],
  ["1:200", 200],
  ["1:250", 250],
  ["1:500", 500],
  ["1:1000", 1000],
];

/** Scale from a "real inches per paper inch" ratio. */
export const scaleFromRatio = (ratio: number, unit: Unit, label: string): Scale => ({ k: ratio / 72, unit, label });

/** Scale from a calibration: a line of `pts` PDF points that is really `real` long in `unit`. */
export function scaleFromCalibration(pts: number, real: number, unit: Unit): Scale {
  const inches = unit === "ft-in" ? real * 12 : real * IN_PER[unit];
  const k = inches / pts;
  return { k, unit, label: `Calibrated (1" = ${formatLength(k * 72, unit)})` };
}

/** Parse a length typed by a person: 12'-6", 12' 6 1/2", 12.5', 150", 3.2 m, 3200 mm, 12.5 (in the default unit). */
export function parseLength(s: string, unit: Unit): number | null {
  const t = s.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/\s+/g, " ");
  if (!t) return null;
  const num = (x: string) => {
    const m = /^(\d+(?:\.\d+)?)?(?:\s*(\d+)\/(\d+))?$/.exec(x.trim());
    if (!m || (!m[1] && !m[2])) return null;
    return (m[1] ? parseFloat(m[1]) : 0) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0);
  };
  const fm = /^(.*?)\s*(?:'|ft\b|feet\b)(.*)$/.exec(t);
  if (fm) {
    const ft = num(fm[1]);
    const rest = fm[2].replace(/^[\s-]+/, "").replace(/\s*(?:"|in|inch|inches)$/, "");
    const inch = rest ? num(rest) : 0;
    if (ft === null || inch === null) return null;
    return toUnit(ft * 12 + inch, unit);
  }
  let m: RegExpExecArray | null;
  m = /^(.+?)\s*(mm|cm|m|"|in|inch|inches)$/.exec(t);
  if (m) {
    const v = num(m[1]);
    if (v === null) return null;
    const u = m[2] === '"' || m[2].startsWith("in") ? "in" : (m[2] as "mm" | "cm" | "m");
    return toUnit(v * IN_PER[u], unit);
  }
  const v = num(t);
  return v === null ? null : v;
}
/** Inches → a number in `unit` (ft-in counts in feet). */
const toUnit = (inches: number, unit: Unit) => (unit === "ft-in" ? inches / 12 : inches / IN_PER[unit]);

/** Format a real length given in inches. */
export function formatLength(inches: number, unit: Unit): string {
  if (unit === "ft-in") {
    const sixteenths = Math.round(Math.abs(inches) * 16);
    const ft = Math.floor(sixteenths / (12 * 16));
    const rem = sixteenths - ft * 12 * 16;
    const whole = Math.floor(rem / 16);
    let frac = rem - whole * 16;
    let den = 16;
    while (frac && frac % 2 === 0) (frac /= 2), (den /= 2);
    return `${inches < 0 ? "-" : ""}${ft}'-${whole}${frac ? ` ${frac}/${den}` : ""}"`;
  }
  const v = inches / IN_PER[unit];
  const d = unit === "mm" ? 0 : unit === "cm" || unit === "in" ? 1 : 2;
  return `${v.toFixed(d)} ${unit === "in" ? "in" : unit}`;
}

/** Format a real area given in square inches. */
export function formatArea(sqIn: number, unit: Unit): string {
  if (unit === "ft-in" || unit === "ft") return `${(sqIn / 144).toFixed(2)} sq ft`;
  if (unit === "in") return `${sqIn.toFixed(1)} sq in`;
  const per = IN_PER[unit] ** 2;
  const v = sqIn / per;
  return `${v.toFixed(unit === "m" ? 2 : 0)} ${unit}²`;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const pathLength = (pts: Pt[], closed = false) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0) + (closed && pts.length > 2 ? dist(pts[pts.length - 1], pts[0]) : 0);
/** Shoelace area in square points. */
export function polygonArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}
export function centroid(pts: Pt[]): Pt {
  const a = polygonArea(pts);
  if (a < 1e-6) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  let cx = 0, cy = 0, s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    s += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return [cx / (3 * s), cy / (3 * s)];
}
/** Angle at b between b→a and b→c, in degrees (0–180). */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
  const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

export const lengthText = (pts: number, s: Scale) => formatLength(pts * s.k, s.unit);
export const areaText = (sqPts: number, s: Scale) => formatArea(sqPts * s.k * s.k, s.unit);

/** Read a scale from a page's viewport /Measure dictionary values (ours, or one written by CAD or other PDF apps). */
export function scaleFromMeasure(m: { hdfK?: number; hdfUnit?: string; ratio?: string; xUnit?: string; xC?: number }): Scale | null {
  if (m.hdfK && m.hdfK > 0) return { k: m.hdfK, unit: (m.hdfUnit as Unit) || "ft-in", label: m.ratio || "Custom" };
  if (!m.xC || !(m.xC > 0)) return null;
  const u = (m.xUnit ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const inches = u === "ft" ? 12 : u === "in" ? 1 : u === "m" ? IN_PER.m : u === "mm" ? IN_PER.mm : u === "cm" ? IN_PER.cm : u === "yd" ? 36 : u === "km" ? IN_PER.m * 1000 : null;
  if (inches === null) return null;
  const unit: Unit = u === "ft" || u === "in" || u === "yd" ? "ft-in" : u === "mm" ? "mm" : u === "cm" ? "cm" : "m";
  return { k: m.xC * inches, unit, label: m.ratio || "From drawing" };
}

/** Values for a PDF /Measure dictionary (RL) so other apps read the same scale. */
export function measureDict(s: Scale): { ratio: string; xUnit: string; xC: number; aUnit: string } {
  const metric = s.unit === "m" || s.unit === "mm" || s.unit === "cm";
  const xUnit = metric ? s.unit : s.unit === "in" ? "in" : "ft";
  const per = xUnit === "ft" ? 12 : xUnit === "in" ? 1 : IN_PER[xUnit as "m" | "mm" | "cm"];
  return { ratio: s.label, xUnit, xC: s.k / per, aUnit: `sq ${xUnit}` };
}
