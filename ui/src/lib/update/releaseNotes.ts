/**
 * releaseNotes.ts — fetch + shape the GitHub release history for the About view.
 *
 * `selectReleases` is the pure transform (drop the rolling `stable` pointer,
 * newest-first, map to display shape). `getReleases` is the thin IPC wrapper
 * around the Rust `get_releases` command (which does the actual GitHub API call,
 * so there are no CORS / webview-fetch concerns and it works once the repo is
 * public).
 */
import { invoke } from "@tauri-apps/api/core";

/** Subset of a GitHub Releases API entry that the Rust command returns. */
export interface RawRelease {
  tag_name: string;
  name?: string | null;
  published_at?: string | null;
  body?: string | null;
  prerelease?: boolean;
}

/** A release as shown in the About list. */
export interface ReleaseNote {
  /** Display title — the release name, or the tag if unnamed. */
  version: string;
  /** Publish date as `YYYY-MM-DD` (empty if unknown). */
  date: string;
  /** Release notes body (empty if none). */
  notes: string;
}

function formatDate(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/**
 * Shape raw GitHub releases for display: drop the rolling `stable` pointer (it
 * duplicates the latest `vX.Y.Z`), sort newest-first, and map to the view shape.
 */
export function selectReleases(raw: RawRelease[]): ReleaseNote[] {
  return raw
    .filter((r) => r.tag_name !== "stable")
    .slice()
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .map((r) => ({
      version: r.name?.trim() || r.tag_name,
      date: formatDate(r.published_at),
      notes: (r.body ?? "").trim(),
    }));
}

/**
 * Fetch the release history via Rust and shape it for display. Rejects on a
 * fetch failure (offline / private repo / rate limit) so the About view can show
 * a distinct "couldn't load" state; resolves to [] only when there genuinely are
 * no releases.
 */
export async function getReleases(): Promise<ReleaseNote[]> {
  const raw = await invoke<RawRelease[]>("get_releases");
  return selectReleases(raw);
}
