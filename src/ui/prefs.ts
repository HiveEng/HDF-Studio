// User preferences, kept on this computer (localStorage). One place for defaults that tools read.
import type { RGB } from "../engine/annotations";
import type { Unit } from "../engine/measure";

export type ToolGroup = "shapes" | "ink" | "text" | "cloud" | "callout" | "lines" | "dimension" | "measure" | "count";
export interface ToolPrefs {
  color: string; width: number; opacity: number; fontSize: number;
  /** Text boxes and callouts: background ("none" = see-through). */
  fill?: string;
  /** Callouts: arrow head style. */
  arrow?: string;
}

export const TOOL_GROUPS: [ToolGroup, string][] = [
  ["shapes", "Rectangles, ellipses and arrows"],
  ["ink", "Pen"],
  ["text", "Text boxes"],
  ["cloud", "Revision clouds"],
  ["callout", "Callouts"],
  ["lines", "Polylines and polygons"],
  ["dimension", "Dimension lines"],
  ["measure", "Measurements"],
  ["count", "Count markers"],
];

const TOOL_DEFAULTS: Record<ToolGroup, ToolPrefs> = {
  shapes: { color: "#d91a1a", width: 2, opacity: 1, fontSize: 12 },
  ink: { color: "#1a4de6", width: 2, opacity: 1, fontSize: 12 },
  text: { color: "#000000", width: 1, opacity: 1, fontSize: 12, fill: "none" },
  cloud: { color: "#d91a1a", width: 1.5, opacity: 1, fontSize: 12 },
  callout: { color: "#d91a1a", width: 1, opacity: 1, fontSize: 12, fill: "#ffffff", arrow: "OpenArrow" },
  lines: { color: "#d91a1a", width: 2, opacity: 1, fontSize: 12 },
  dimension: { color: "#d91a1a", width: 1, opacity: 1, fontSize: 10 },
  measure: { color: "#0b6fd6", width: 1.5, opacity: 1, fontSize: 10 },
  count: { color: "#d91a1a", width: 1, opacity: 1, fontSize: 9 },
};

export interface Prefs {
  name: string;
  company: string;
  units: Unit;
  dateFormat: "iso" | "us" | "long";
  tools: Record<ToolGroup, ToolPrefs>;
}

const KEY = "hdfstudio.prefs";

/** A tool-chest preset in use: its settings win over the saved defaults for that group. */
let override: { group: ToolGroup; p: Partial<ToolPrefs> } | null = null;
export const setToolOverride = (o: typeof override) => (override = o);
export const toolOverride = () => override;

export function getPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    /* defaults */
  }
  const tools = { ...TOOL_DEFAULTS } as Record<ToolGroup, ToolPrefs>;
  for (const g of Object.keys(TOOL_DEFAULTS) as ToolGroup[]) tools[g] = { ...TOOL_DEFAULTS[g], ...(saved.tools?.[g] ?? {}) };
  if (override) tools[override.group] = { ...tools[override.group], ...override.p };
  return {
    name: localStorage.getItem("hdfstudio.author") ?? "",
    company: saved.company ?? "",
    units: saved.units ?? "ft-in",
    dateFormat: saved.dateFormat ?? "iso",
    tools,
  };
}

export function savePrefs(p: Prefs) {
  if (p.name) localStorage.setItem("hdfstudio.author", p.name);
  else localStorage.removeItem("hdfstudio.author");
  localStorage.setItem(KEY, JSON.stringify({ company: p.company, units: p.units, dateFormat: p.dateFormat, tools: p.tools }));
}

export const toolPrefs = (g: ToolGroup) => getPrefs().tools[g];
export const hexToRgb = (h: string): RGB => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  const n = m ? parseInt(m[1], 16) : 0xd91a1a;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const rgbToHex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

export function formatDate(d: Date, f: Prefs["dateFormat"] = getPrefs().dateFormat) {
  if (f === "us") return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  if (f === "long") return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Review stamps people pick from; colour = border and text. */
export const REVIEW_STAMPS: { title: string; color: string }[] = [
  { title: "APPROVED", color: "#1a7f37" },
  { title: "APPROVED AS NOTED", color: "#1a7f37" },
  { title: "REVIEWED", color: "#0b5cad" },
  { title: "REVIEWED - NO EXCEPTIONS TAKEN", color: "#1a7f37" },
  { title: "MAKE CORRECTIONS NOTED", color: "#c25e00" },
  { title: "REVISE AND RESUBMIT", color: "#c25e00" },
  { title: "REJECTED", color: "#c41e1e" },
  { title: "FOR CONSTRUCTION", color: "#1a7f37" },
  { title: "PRELIMINARY - NOT FOR CONSTRUCTION", color: "#c25e00" },
  { title: "FOR REVIEW", color: "#0b5cad" },
  { title: "RECEIVED", color: "#0b5cad" },
  { title: "VOID", color: "#c41e1e" },
];

/** Save one tool group's style as the default for new markups of that kind. */
export function setToolDefaults(g: ToolGroup, p: Partial<ToolPrefs>) {
  const all = getPrefs();
  all.tools[g] = { ...all.tools[g], ...p };
  savePrefs(all);
}
