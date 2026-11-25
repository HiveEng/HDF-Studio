// Printing: render the chosen pages at print resolution and hand them to the system print dialog
// (paper, printer, copies, duplex and colour are chosen there). "Actual size" keeps drawings to scale.
import type { Progress } from "./progress";

export interface PrintJob {
  pages: number[];
  /** Page sizes in points, indexed by page number. */
  sizes: [number, number][];
  dpi: number;
  markups: boolean;
  fit: "actual" | "fit";
  render(page: number, dpi: number, markups: boolean): Promise<{ png: Uint8Array; dpi: number }>;
  progress?: Progress;
}

/** Build the print document; returns false if cancelled. Exported for tests via buildPrintHtml. */
export async function printPages(job: PrintJob): Promise<boolean> {
  const urls: string[] = [];
  try {
    for (let i = 0; i < job.pages.length; i++) {
      if (job.progress?.cancelled) return false;
      job.progress?.set(i / job.pages.length, `Preparing page ${i + 1} of ${job.pages.length}…`);
      const { png } = await job.render(job.pages[i], job.dpi, job.markups);
      urls.push(URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })));
    }
    job.progress?.set(1, "Opening the print dialog…");
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, { position: "fixed", width: "0", height: "0", border: "0", right: "0", bottom: "0" });
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(buildPrintHtml(job.pages.map((p, i) => ({ url: urls[i], size: job.sizes[p] })), job.fit));
    doc.close();
    await Promise.all([...doc.images].map((im) => im.decode().catch(() => {})));
    job.progress?.close();
    await new Promise<void>((resolve) => {
      const win = frame.contentWindow!;
      // print() blocks in most webviews; afterprint covers the ones where it doesn't.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        setTimeout(() => frame.remove(), 500);
        resolve();
      };
      win.addEventListener("afterprint", finish);
      win.focus();
      win.print();
      setTimeout(finish, 1000);
    });
    return true;
  } finally {
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 60_000);
  }
}

/** One printed sheet per page. Actual size: each sheet is the PDF page's own size (named @page rules). */
export function buildPrintHtml(pages: { url: string; size: [number, number] }[], fit: "actual" | "fit"): string {
  const sizes = [...new Set(pages.map((p) => `${round(p.size[0])}x${round(p.size[1])}`))];
  const named = sizes.map((k, i) => {
    const [w, h] = k.split("x");
    return `@page s${i} { size: ${w}pt ${h}pt; margin: 0; }`;
  });
  const body = pages
    .map((p) => {
      const k = sizes.indexOf(`${round(p.size[0])}x${round(p.size[1])}`);
      return fit === "actual"
        ? `<div class="pg actual" style="page: s${k}; width:${round(p.size[0])}pt; height:${round(p.size[1])}pt"><img src="${p.url}" style="width:${round(p.size[0])}pt; height:${round(p.size[1])}pt"></div>`
        : `<div class="pg fit"><img src="${p.url}"></div>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Print</title><style>
${fit === "actual" ? named.join("\n") : "@page { margin: 8mm; }"}
html, body { margin: 0; padding: 0; background: #fff; }
.pg { break-after: page; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.pg:last-child { break-after: auto; }
.pg.fit { width: 100%; height: 100vh; }
.pg.fit img { max-width: 100%; max-height: 100%; object-fit: contain; }
img { display: block; }
</style></head><body>${body}</body></html>`;
}
const round = (n: number) => Math.round(n * 100) / 100;
