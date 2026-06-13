# Release Versioning & Channels — SP1: Versioning Scheme + Dual-Channel Publishing

**Date:** 2026-06-13
**Status:** Draft (pending spec review)
**Branch:** `feat/versioning-channels`
**Sub-project:** 1 of 2 (CI/release side). SP2 — in-app channel selector — is a
separate spec.

## Problem

The release pipeline conflates a CI build counter with the semantic version, and
ships a single channel:

1. **Nightly patch = `github.run_number`** — a global, monotonic CI counter. The
   first build on the `0.2` line came out `0.2.9` (run #9) and keeps climbing
   (`0.2.10`, `0.2.11`…). A clean `0.2.0` can never be produced this way, and the
   patch number means "total CI runs," not a release version.
2. **A `vX.Y.Z` stable tag would sort below the nightlies.** Tag `v0.2.0` →
   version `0.2.0`, but the current nightly is `0.2.9`. Semver says `0.2.0 < 0.2.9`.
3. **Only one channel exists.** The updater polls `…/nightly/latest.json`
   ([`tauri.conf.json` updater endpoints]). There is no stable update track, so a
   tagged stable release is just a manual-download artifact — nobody auto-updates
   to it, and (per #2) it looks older than nightly.

Net effect: there is no safe way to cut a real `v0.2.0`, and "stable" is not a
functioning channel.

## Scope

**SP1 (this spec) — CI/release side only:**
- A coherent versioning model: clean stable, prerelease nightlies that sort
  correctly, and a fixed-URL stable channel pointer.
- `.gitea/workflows/release.yml` + the `scripts/ci/` helpers updated to publish
  both channels correctly.

**Out of scope (SP2, separate spec):** the in-app Settings channel selector,
the runtime updater-endpoint command, and the version comparator. SP1 only makes
the *releases* correct; SP2 lets the app *choose* between them. SP1 ships and is
verifiable on its own (two correct `latest.json` files).

## Goals

1. **Stable releases are clean human-chosen versions** — `v0.2.0`, `v0.2.1`,
   `v0.3.0` produce exactly `0.2.0`, etc.
2. **Nightlies are prereleases of the next target** and sort *below* it
   (`0.3.0-nightly.<run> < 0.3.0`), so they read honestly as "ahead of the last
   stable, not yet released."
3. **A fixed-URL stable channel pointer** (`…/stable/latest.json`) exists for SP2
   to point at, updated on every stable tag, alongside the permanent `vX.Y.Z`
   archive release.
4. **Within each channel, versions are monotonic**, so the updater's default
   `update > current` comparison behaves correctly for same-channel updates.

## Non-goals

- Resetting or rewriting existing published releases. The current `nightly`
  (`0.2.x`) and `v0.1.0` stay as-is; the new scheme applies going forward.
- Any app/runtime behaviour (SP2).

## Versioning model

| Source | Trigger | Version string | Example |
|---|---|---|---|
| **Committed** (`Cargo.toml`, `tauri.conf.json`) | — | in-development **target** `X.Y.Z` | `0.3.0` |
| **Nightly** | push to `master` | `X.Y.Z-nightly.<run_number>` (prerelease of committed target) | `0.3.0-nightly.42` |
| **Stable** | push `vX.Y.Z` tag | `X.Y.Z` (from the tag) | `0.3.0` |

**Semver ordering (the whole point):**
`0.3.0-nightly.41 < 0.3.0-nightly.42 < 0.3.0` — nightlies climb monotonically and
all sort below the eventual stable `0.3.0`.

**Lifecycle:** the committed version is always the *next unreleased target*. After
cutting `vX.Y.Z` stable, bump the committed version to the next target (e.g.
`0.3.0` → `0.4.0`, or `0.3.1` for a planned patch) so subsequent nightlies become
`<next>-nightly.<run>` and stay ahead of the just-released stable.

> **Relationship to the pending `fix/linux-appindicator-conflict` PR:** that PR
> set the committed version to `0.2.0` and made nightly derive a *numeric*
> `0.2.<run>` from it. SP1 **supersedes the nightly numbering** with the prerelease
> scheme above. Whichever merges first, the end state is: committed = next target,
> nightly = `<target>-nightly.<run>`. If that PR is already merged, SP1's first
> step also bumps the committed target to `0.3.0` (since `0.2.x` nightlies were
> published) so the prerelease line starts clean above them.

### ⚠️ Open risk to resolve first: NSIS + prerelease version strings

Windows installer (`ProductVersion`) is numeric `a.b.c.d`. Tauri's NSIS bundler
must accept a semver **prerelease** string (`0.3.0-nightly.42`) for the nightly
build — typically Tauri keeps the full semver in `latest.json` while deriving a
numeric installer version, but this must be **verified before committing to the
scheme**. The implementation plan's **first task** is a spike: run
`cargo tauri build --bundles nsis --config '{"version":"0.3.0-nightly.42"}'`
(cross-compile, as CI does) and confirm it builds and the `latest.json` version is
the full prerelease string.

- **If it works:** proceed with the prerelease scheme (Approach A).
- **If NSIS rejects it:** fall back to **numeric nightly** for the nightly channel
  only — `0.3.<run>` with the *next* minor as prefix (stable stays clean `0.2.0`,
  channels are separate so cross-channel ordering is handled by SP2's comparator).
  Stable's clean numbering and the dual-channel publishing are unaffected either
  way.

## Architecture: dual-channel publishing

Two **rolling channel pointers**, each a Gitea release whose assets are
force-replaced on every build for that channel, plus **permanent `vX.Y.Z` archive
releases** for stable:

| Release tag | Kind | Holds | URL the updater reads |
|---|---|---|---|
| `nightly` | rolling (exists) | latest nightly assets + `latest.json` | `…/releases/download/nightly/latest.json` |
| `stable` | rolling (**new**) | latest stable assets + `latest.json` | `…/releases/download/stable/latest.json` |
| `vX.Y.Z` | permanent (exists) | that version's archived assets | (archive only; not polled) |

Both `latest.json` files use the same signed-artifact format already produced by
`scripts/ci/make-latest-json.sh` (Windows + Linux entries). The only difference is
the version string and which release they're uploaded to.

## Workflow changes (`.gitea/workflows/release.yml`)

1. **Compute version + channel** step:
   - **Tag build (`refs/tags/v*`)** → `VER` = tag minus `v`; `channel=stable`;
     publish to BOTH the permanent `vX.Y.Z` release AND the rolling `stable`
     pointer.
   - **Master push** → derive target `X.Y.Z` from `Cargo.toml`;
     `VER="${TARGET}-nightly.${run_number}"`; `channel=nightly`; publish to the
     rolling `nightly` pointer (as today).
2. **Create release + upload assets** step: the stable branch additionally rolls
   the `stable` pointer. Reuse the existing `gitea-release.sh` helpers; add a
   `roll_stable` path analogous to `roll_nightly` (force-update the rolling
   `stable` release with the new assets + `latest.json`), then also
   `create_release` for the permanent `vX.Y.Z` tag.
3. The committed-version derivation reuses the robust extraction
   (`grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/'`), taking the
   full `X.Y.Z` target (not stripping the patch — the prerelease is appended to
   the full target).

## Components / files touched

| File | Change |
|---|---|
| `Cargo.toml`, `tauri.conf.json` | committed version = next target (`0.3.0`) |
| `.gitea/workflows/release.yml` | prerelease nightly version; stable publishes to `stable` rolling pointer + permanent tag |
| `scripts/ci/gitea-release.sh` | add `roll_stable` (or generalize `roll_nightly` to a `roll_channel <tag>`) |
| `scripts/ci/make-latest-json.sh` | no change expected (version is passed in); confirm it handles a prerelease `VERSION` value verbatim |
| `scripts/ci/make-latest-json.test.sh` | add a case asserting a prerelease `VERSION` (e.g. `0.3.0-nightly.42`) is emitted verbatim into `latest.json` |
| `docs/RELEASES.md`, `CLAUDE.md` | document the prerelease nightly scheme, the `stable` channel pointer, and the post-tag committed bump |

## Data flow

```
push master ──► compute: TARGET=Cargo.toml version (0.3.0)
                VER = 0.3.0-nightly.<run>          channel=nightly
             ──► build win+linux, sign, make-latest-json
             ──► roll_channel "nightly"  (force-update …/nightly/latest.json)

push tag v0.3.0 ──► compute: VER = 0.3.0           channel=stable
             ──► build win+linux, sign, make-latest-json
             ──► create_release "v0.3.0"  (permanent archive)
             ──► roll_channel "stable"   (force-update …/stable/latest.json)
```

## Error handling / edge cases

- **Tagging `vX.Y.Z` without bumping committed first:** harmless for the tag build
  (version comes from the tag), but the *next* nightly would then be
  `X.Y.Z-nightly.<run>` — a prerelease of the version you just released, sorting
  *below* it. Mitigation: documented lifecycle step ("after tagging, bump
  committed to next target") + a CI guard that warns if `TARGET` ≤ the latest
  stable tag on a master build. (Guard is a nice-to-have, not required for SP1.)
- **`make-latest-json.sh` mangling the prerelease string:** covered by the new
  test case asserting verbatim emission.
- **Rolling `stable` pointer race / first run:** `roll_channel` must create the
  rolling release if absent (mirror `roll_nightly`'s create-or-update behaviour).

## Testing

- **`scripts/ci/make-latest-json.test.sh`** — add a prerelease-version case
  (`VERSION=0.3.0-nightly.42` → `latest.json` `version` field is exactly that).
- **Version-derivation unit check** — a small shell assertion that the
  `Cargo.toml`-extraction + `-nightly.<run>` composition yields the expected
  string (can live in the same test script).
- **NSIS spike (first plan task)** — see the open-risk section; gates the scheme.
- **Manual CI verification** — after merge: one master push produces a
  `0.3.0-nightly.<run>` nightly; one `v0.3.0`-style tag (or a throwaway
  `v0.3.0-rc` on a test repo) produces a clean stable in BOTH the permanent
  release and the rolling `stable` pointer with a correct `latest.json`.

## What SP2 will build on top (context, not in scope)

SP2 adds a Settings "Update channel" toggle, a Rust command that builds
`updater_builder().endpoints([nightly|stable url])` from the setting, and a
`version_comparator` so switching to a lower channel still updates. SP1's two
fixed-URL `latest.json` pointers are exactly what SP2 selects between.
