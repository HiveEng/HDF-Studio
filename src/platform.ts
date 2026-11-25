// File I/O that works both inside the Tauri desktop shell and in a plain browser (dev).
export const isTauri = "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  name: string;
  path: string | null;
  data: Uint8Array;
}

const DOC_EXT = ["pdf", "xps", "epub", "cbz", "png", "jpg", "jpeg"];

export async function pickFiles(multiple = true, extensions = DOC_EXT): Promise<OpenedFile[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const sel = await open({ multiple, filters: [{ name: extensions.includes("pdf") ? "Documents" : extensions.join(", ").toUpperCase(), extensions }] });
    if (!sel) return [];
    const paths = Array.isArray(sel) ? sel : [sel];
    return Promise.all(paths.map(async (p) => ({ name: baseName(p), path: p, data: await readFile(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = extensions.map((e) => "." + e).join(",");
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

/** Save several files at once: into a chosen folder in Tauri, or as downloads in a browser. */
export async function saveMany(files: { name: string; data: Uint8Array }[]): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const dir = await open({ directory: true, title: "Choose a folder for the output files" });
    if (!dir || Array.isArray(dir)) return null;
    for (const f of files) await writeFile(`${dir}/${f.name}`, f.data);
    return dir;
  }
  for (const f of files) await saveFile(f.data, f.name, null, true);
  return null;
}

/** Save a text file (e.g. XFDF export). */
export async function saveText(name: string, text: string): Promise<string | null> {
  return saveBytes(name, new TextEncoder().encode(text));
}

/** Save any file with a Save dialog filtered to its extension. */
export async function saveBytes(name: string, data: Uint8Array): Promise<string | null> {
  const ext = name.split(".").pop() ?? "txt";
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const target = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!target) return null;
    await writeFile(target, data);
    return target;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/octet-stream" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}
