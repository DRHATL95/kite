import { invoke, Channel } from "@tauri-apps/api/core";

export type UpdateInfo = { version: string; notes?: string };
export type UpdateChannel = "stable" | "nightly";

type UpdateMeta = { version: string; currentVersion: string; notes?: string | null };
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/**
 * Check the given channel for an update via the Rust command. `allowDowngrade`
 * is true only for an explicit channel switch. Returns null on no-update / error
 * (never throws — preserves silent-no-op-offline behavior).
 */
export async function checkForUpdate(
  channel: UpdateChannel,
  allowDowngrade: boolean,
): Promise<UpdateInfo | null> {
  try {
    const meta = await invoke<UpdateMeta | null>("check_update", { channel, allowDowngrade });
    if (!meta) return null;
    return { version: meta.version, notes: meta.notes ?? undefined };
  } catch (e) {
    console.warn("Update check failed:", e);
    return null;
  }
}

/** Download + install the pending update (Rust relaunches on success). */
export async function applyUpdate(onProgress?: (pct: number) => void): Promise<void> {
  let total = 0;
  let got = 0;
  const onEvent = new Channel<DownloadEvent>();
  onEvent.onmessage = (msg) => {
    if (msg.event === "Started") {
      total = msg.data.contentLength ?? 0;
    } else if (msg.event === "Progress") {
      got += msg.data.chunkLength;
      if (total) onProgress?.(Math.min(100, Math.round((got / total) * 100)));
    } else if (msg.event === "Finished") {
      onProgress?.(100);
    }
  };
  await invoke("install_update", { onEvent });
}
