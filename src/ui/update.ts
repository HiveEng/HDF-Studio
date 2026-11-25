// Updates: on start-up the desktop app asks GitHub for a newer signed build and offers to install it.
import { isTauri } from "../platform";
import { confirmDialog } from "./dialog";
import { showProgress } from "./progress";

export async function checkForUpdates(status: (m: string) => void, manual = false) {
  if (!isTauri) {
    if (manual) status("Updates are checked by the installed desktop app");
    return;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { getVersion } = await import("@tauri-apps/api/app");
    const update = await check();
    if (!update) {
      if (manual) status(`HDF Studio ${await getVersion()} is up to date`);
      return;
    }
    const ok = await confirmDialog(`HDF Studio ${update.version} is available (you have ${update.currentVersion}). Update now? Save your work first; the app restarts when the update is installed.`, "Update and restart");
    if (!ok) return status(`Update ${update.version} skipped. Use "Check for updates" in Ctrl+K when you're ready.`);
    const prog = showProgress(`Downloading HDF Studio ${update.version}`);
    let total = 0, got = 0;
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        prog.set(total ? got / total : 0.5, total ? `${(got / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB` : "Downloading…");
      } else if (e.event === "Finished") prog.set(1, "Installing…");
    });
    prog.close();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    if (manual) status(`Could not check for updates: ${(e as Error).message ?? e}`);
  }
}
