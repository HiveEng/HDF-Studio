// OneDrive and SharePoint through Microsoft Graph: browse, open (download) and save (upload) files.
// Transport and sign-in are injected so this runs in tests without a network.

export const GRAPH = "https://graph.microsoft.com/v1.0";
/** Delegated permissions: the user's own files and every SharePoint library they can reach. */
export const GRAPH_SCOPES = "https://graph.microsoft.com/Files.ReadWrite.All";

export type Fetcher = (method: string, url: string, o?: { token?: string; contentType?: string; extra?: [string, string]; body?: Uint8Array }) => Promise<Uint8Array>;

export interface CloudItem {
  id: string;
  driveId: string;
  name: string;
  folder: boolean;
  size: number;
  modified: string;
  modifiedBy?: string;
  eTag?: string;
  webUrl?: string;
  /** Parent folder, for saving next to it. */
  parentId?: string;
}

/** A place to browse: OneDrive, a SharePoint document library, or a list such as Recent. */
export interface CloudPlace {
  kind: "drive" | "recent" | "shared" | "site";
  name: string;
  driveId?: string;
  siteId?: string;
  hint?: string;
}

/** Where an opened file lives, so Save can write it back. */
export interface CloudRef {
  driveId: string;
  itemId: string;
  parentId?: string;
  eTag?: string;
  name: string;
  webUrl?: string;
  /** Shown in the title, e.g. "OneDrive" or "Projects (SharePoint)". */
  where: string;
}

/** Larger files go through an upload session in chunks (multiples of 320 KiB). */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
export const CHUNK = 320 * 1024 * 16; // 5 MiB

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

/** Error text from Graph, made readable. */
export function graphError(e: unknown): Error {
  const m = String((e as Error)?.message ?? e);
  const hit = m.match(/^HTTP (\d+): ([\s\S]*)$/);
  if (!hit) return new Error(m);
  let msg = hit[2];
  try {
    msg = JSON.parse(hit[2]).error?.message ?? msg;
  } catch {
    /* not JSON */
  }
  const code = +hit[1];
  const friendly = code === 401 ? "Your Microsoft 365 sign-in has expired. Try again." : code === 403 ? "You don't have permission for that file or folder." : code === 404 ? "That file or folder no longer exists." : code === 412 ? "Someone changed the file since you opened it." : code === 423 ? "The file is locked (checked out or open for editing by someone)." : code === 507 ? "The OneDrive or SharePoint storage is full." : msg;
  return Object.assign(new Error(friendly), { status: code });
}

function toItem(j: Record<string, any>, driveId?: string): CloudItem {
  const remote = j.remoteItem; // shared-with-me items point at another drive
  const src = remote ?? j;
  return {
    id: src.id,
    driveId: src.parentReference?.driveId ?? driveId ?? "",
    name: j.name ?? src.name,
    folder: !!(src.folder ?? j.folder),
    size: Number(src.size ?? j.size ?? 0),
    modified: j.lastModifiedDateTime ?? src.lastModifiedDateTime ?? "",
    modifiedBy: (j.lastModifiedBy ?? src.lastModifiedBy)?.user?.displayName,
    eTag: src.eTag ?? j.eTag,
    webUrl: src.webUrl ?? j.webUrl,
    parentId: src.parentReference?.id,
  };
}

export class Graph {
  constructor(private fetch: Fetcher, private token: () => Promise<string>) {}

  private async json(method: string, path: string, body?: unknown, extra?: [string, string]): Promise<any> {
    const url = path.startsWith("https://") ? path : GRAPH + path;
    try {
      const b = await this.fetch(method, url, { token: await this.token(), contentType: body ? "application/json" : undefined, body: body ? enc(JSON.stringify(body)) : undefined, extra });
      return b.length ? JSON.parse(dec(b)) : {};
    } catch (e) {
      throw graphError(e);
    }
  }

  private async list(path: string, driveId?: string, limit = 2000): Promise<CloudItem[]> {
    const out: CloudItem[] = [];
    let next: string | undefined = path;
    while (next && out.length < limit) {
      const j: any = await this.json("GET", next);
      for (const v of j.value ?? []) out.push(toItem(v, driveId));
      next = j["@odata.nextLink"];
    }
    return out;
  }

  /** OneDrive and the shortcuts (SharePoint sites aren't browsed: files there show up under Recent and Shared with me). */
  async places(): Promise<CloudPlace[]> {
    const out: CloudPlace[] = [];
    try {
      const d = await this.json("GET", "/me/drive?$select=id,name");
      out.push({ kind: "drive", name: "OneDrive", driveId: d.id, hint: "My files" });
    } catch {
      /* no OneDrive licence: Recent and Shared still work */
    }
    out.push({ kind: "recent", name: "Recent", hint: "Files you used lately" }, { kind: "shared", name: "Shared with me" });
    return out;
  }

  children(driveId: string, folderId = "root"): Promise<CloudItem[]> {
    return this.list(`/drives/${driveId}/items/${folderId}/children?$top=500&$select=id,name,folder,file,size,lastModifiedDateTime,lastModifiedBy,eTag,webUrl,parentReference`, driveId);
  }
  recent(): Promise<CloudItem[]> {
    return this.list("/me/drive/recent?$top=100", undefined, 100);
  }
  sharedWithMe(): Promise<CloudItem[]> {
    return this.list("/me/drive/sharedWithMe?$top=200", undefined, 200);
  }
  async item(driveId: string, itemId: string): Promise<CloudItem> {
    return toItem(await this.json("GET", `/drives/${driveId}/items/${itemId}?$select=id,name,folder,file,size,lastModifiedDateTime,lastModifiedBy,eTag,webUrl,parentReference`), driveId);
  }

  async download(driveId: string, itemId: string): Promise<Uint8Array> {
    try {
      return await this.fetch("GET", `${GRAPH}/drives/${driveId}/items/${itemId}/content`, { token: await this.token() });
    } catch (e) {
      throw graphError(e);
    }
  }

  /**
   * Save bytes: over an existing file (itemId; with eTag, refused if someone changed it since) or as
   * a new file in a folder (parentId + name; an existing file of that name is replaced only if `replace`).
   */
  async upload(t: { driveId: string; data: Uint8Array; itemId?: string; eTag?: string; parentId?: string; name?: string; replace?: boolean }): Promise<CloudItem> {
    const target = t.itemId ? `/drives/${t.driveId}/items/${t.itemId}` : `/drives/${t.driveId}/items/${t.parentId ?? "root"}:/${encodeURIComponent(t.name ?? "Document.pdf")}:`;
    const ifMatch: [string, string] | undefined = t.itemId && t.eTag ? ["If-Match", t.eTag] : undefined;
    const conflict = t.itemId || t.replace ? "replace" : "fail";
    if (t.data.length <= SIMPLE_UPLOAD_MAX) {
      try {
        const b = await this.fetch("PUT", `${GRAPH}${target}/content?@microsoft.graph.conflictBehavior=${conflict}`, { token: await this.token(), contentType: "application/octet-stream", body: t.data, extra: ifMatch });
        return toItem(JSON.parse(dec(b)), t.driveId);
      } catch (e) {
        throw graphError(e);
      }
    }
    const session = await this.json("POST", `${target}/createUploadSession`, { item: { "@microsoft.graph.conflictBehavior": conflict } }, ifMatch);
    const url: string = session.uploadUrl;
    let last: Uint8Array = new Uint8Array();
    for (let at = 0; at < t.data.length; at += CHUNK) {
      const part = t.data.subarray(at, Math.min(t.data.length, at + CHUNK));
      try {
        // The upload URL carries its own authorization; no token goes to it.
        last = await this.fetch("PUT", url, { contentType: "application/octet-stream", extra: ["Content-Range", `bytes ${at}-${at + part.length - 1}/${t.data.length}`], body: part });
      } catch (e) {
        await this.fetch("DELETE", url).catch(() => {});
        throw graphError(e);
      }
    }
    return toItem(JSON.parse(dec(last)), t.driveId);
  }
}
