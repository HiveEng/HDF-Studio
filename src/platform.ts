// File I/O that works both inside the Tauri desktop shell and in a plain browser (dev).
export const isTauri = "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  name: string;
  path: string | null;
  data: Uint8Array;
}

export async function pickFiles(multiple = true): Promise<OpenedFile[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const sel = await open({ multiple, filters: [{ name: "Documents", extensions: ["pdf", "xps", "epub", "cbz", "png", "jpg", "jpeg"] }] });
    if (!sel) return [];
    const paths = Array.isArray(sel) ? sel : [sel];
    return Promise.all(paths.map(async (p) => ({ name: baseName(p), path: p, data: await readFile(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = ".pdf,.xps,.epub,.cbz,.png,.jpg,.jpeg";
    input.onchange = async () => resolve(await filesFromList(input.files));
    input.click();
  });
}

export async function filesFromList(list: FileList | null): Promise<OpenedFile[]> {
  return Promise.all(Array.from(list ?? []).map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) })));
}

/** Save bytes. With a known path in Tauri, writes in place unless saveAs is set. Returns the path used. */
export async function saveFile(data: Uint8Array, suggestedName: string, path: string | null, saveAs: boolean): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    let target = path;
    if (!target || saveAs) target = await save({ defaultPath: suggestedName, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!target) return null;
    await writeFile(target, data);
    return target;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: suggestedName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
