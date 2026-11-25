/** Make a string safe to use as a file name on Windows, macOS and Linux. */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
