# CI runner (CT 106)

The release workflow runs on a self-hosted GitHub Actions runner: Proxmox LXC
**CT 106** (`gitea-ci-linux`), Ubuntu 22.04. `setup-ct106.sh` is the source of
truth for its build toolchain — re-run it any time to (re)provision the box.

## Provision a runner (fresh or existing CT)

As root on the CT:

```bash
./setup-ct106.sh
```

Installs: apt build deps + GTK/WebKit + AppImage tooling, **Node 22** (nodesource)
+ corepack, **gh**, **rust** (rustup) with the `x86_64-pc-windows-msvc` target +
`cargo-tauri` + `cargo-xwin`, and downloads the GitHub Actions runner agent to
`/opt/actions-runner`. Idempotent — safe to re-run; it upgrades Node and leaves
an already-registered runner untouched.

## Register the runner (one-time, token-gated)

Registration needs a short-lived token (kept out of the committed script). From
a machine with `gh` logged in:

```bash
gh api -X POST repos/DRHATL95/kite/actions/runners/registration-token -q .token
```

Then either re-run the script with the token:

```bash
./setup-ct106.sh --runner-token <TOKEN>
```

or register by hand in `/opt/actions-runner`:

```bash
RUNNER_ALLOW_RUNASROOT=1 ./config.sh --unattended --replace \
  --url https://github.com/DRHATL95/kite --token <TOKEN> --name ct106 --work _work
./svc.sh install root && ./svc.sh start
```

The runner runs **as root** (`RUNNER_ALLOW_RUNASROOT=1`, set in `.env`) and gets
`/root/.cargo/bin` on its PATH via `.path`, so `cargo`/`cargo-tauri`/`cargo-xwin`
resolve in jobs. Labels are the defaults: `self-hosted, Linux, X64`.

## Verify

```bash
node --version            # v22.x
gh --version; cargo-xwin --version
gh api repos/DRHATL95/kite/actions/runners -q '.runners[] | "\(.name) \(.status)"'
```
