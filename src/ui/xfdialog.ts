// "Size and rotation" dialog for images and signatures: exact width, height and angle.
import type { Xf } from "../engine/xform";
import { norm } from "../engine/xform";
import { ask } from "./dialog";
import { getPrefs } from "./prefs";

export async function sizeDialog(t: Xf): Promise<Xf | null> {
  const metric = ["m", "mm", "cm"].includes(getPrefs().units);
  const per = metric ? 72 / 25.4 : 72; // points per mm or per inch
  const u = metric ? "mm" : "in";
  const fmt = (pt: number) => String(+(pt / per).toFixed(metric ? 1 : 3));
  const r = await ask("Size and rotation", [
    { name: "w", label: `Width (${u})`, type: "number", value: fmt(t.w) },
    { name: "h", label: `Height (${u})`, type: "number", value: fmt(t.h), hint: "Leave as is to keep the shape; change one side and choose Keep proportions." },
    { name: "keep", label: "Proportions", type: "select", value: "keep", options: [["keep", "Keep proportions"], ["free", "Use both values as typed"]] },
    { name: "angle", label: "Rotation (degrees clockwise)", type: "number", value: String(+norm(t.angle).toFixed(1)) },
  ], "Apply");
  if (!r) return null;
  let w = parseFloat(r.w) * per, h = parseFloat(r.h) * per;
  if (!(w > 0) || !(h > 0)) return null;
  if (r.keep === "keep") {
    const wChanged = Math.abs(w - t.w) > 0.01, hChanged = Math.abs(h - t.h) > 0.01;
    if (wChanged && !hChanged) h = (w * t.h) / t.w;
    else if (hChanged && !wChanged) w = (h * t.w) / t.h;
  }
  const angle = parseFloat(r.angle);
  return { ...t, w, h, angle: norm(Number.isFinite(angle) ? angle : t.angle) };
}
