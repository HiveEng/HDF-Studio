// OCR a whole file: shared by the batch panel (engine in a worker, async) and the CLI (engine in-process).
import type { Recipe, Step } from "../engine/recipes";
import type { OcrLine } from "../engine/ocr";
import type { Recognizer } from "./recognize";

type P<T> = T | Promise<T>;
export interface OcrHost {
  open(data: Uint8Array, name: string): P<{ id: number; pageCount: number; needsPassword?: boolean }>;
  unlock(id: number, password: string): P<unknown>;
  pagesWithoutText(id: number): P<number[]>;
  ocrImage(id: number, page: number, dpi?: number): P<{ png: Uint8Array; scale: number }>;
  cleanScans?(id: number, pages: number[], o: { straighten?: boolean; despeckle?: boolean; removeBlank?: boolean }): P<{ info: { pageCount: number } }>;
  addTextLayer(id: number, pages: { page: number; lines: OcrLine[] }[]): P<number>;
  save(id: number, options?: string): P<Uint8Array>;
  close(id: number): P<void>;
}

export const ocrStep = (r: Recipe) => r.steps.find((s): s is Extract<Step, { op: "ocr" }> => s.op === "ocr");
export const cleanStep = (r: Recipe) => r.steps.find((s): s is Extract<Step, { op: "clean" }> => s.op === "clean");

/** Recognize text in a PDF's scanned pages (or all pages) and return the new bytes. */
export async function ocrBytes(host: OcrHost, rec: Recognizer, data: Uint8Array, name: string, which: "scanned" | "all" = "scanned", password?: string, onPage?: (done: number, total: number) => void, clean?: { straighten?: boolean; despeckle?: boolean; removeBlank?: boolean }) {
  const info = await host.open(data.slice(), name); // copy: a worker host takes ownership of what it is sent
  try {
    if (info.needsPassword) {
      if (!password || !(await host.unlock(info.id, password))) throw new Error("password needed to recognize text");
    }
    // Clean up first so recognition reads straight, speck-free pages (and skips blank ones).
    if (clean && host.cleanScans) info.pageCount = (await host.cleanScans(info.id, [...Array(info.pageCount).keys()], { straighten: clean.straighten ?? true, despeckle: clean.despeckle ?? true, removeBlank: clean.removeBlank ?? true })).info.pageCount;
    const pages = which === "all" ? [...Array(info.pageCount).keys()] : await host.pagesWithoutText(info.id);
    if (!pages.length) return { data, pages: 0, words: 0 };
    const done: { page: number; lines: OcrLine[] }[] = [];
    for (const [k, p] of pages.entries()) {
      onPage?.(k, pages.length);
      const img = await host.ocrImage(info.id, p, 300);
      done.push({ page: p, lines: await rec.recognize(img.png, img.scale) });
    }
    const words = await host.addTextLayer(info.id, done);
    return { data: await host.save(info.id, "garbage,compress"), pages: pages.length, words };
  } finally {
    await host.close(info.id);
  }
}
