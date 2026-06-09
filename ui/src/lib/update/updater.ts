import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateInfo = { version: string; notes?: string };

/** Check for an update. Returns the pending Update, or null if none / on error. Never throws. */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (e) {
    console.warn("Update check failed:", e);
    return null;
  }
}

/** Download + install the update with progress callbacks, then relaunch the app. */
export async function applyUpdate(update: Update, onProgress?: (pct: number) => void): Promise<void> {
  let total = 0;
  let got = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") {
      total = e.data.contentLength ?? 0;
    } else if (e.event === "Progress") {
      got += e.data.chunkLength;
      if (total) onProgress?.(Math.round((got / total) * 100));
    }
  });
  await relaunch();
}
