# Dependencies

`abtars deps` manages two independent optional-dependency systems: **npm package groups** and **system binaries**. This page is the reference for both.

## Command surface

```
abtars deps list             # show every group + system binary + install status
abtars deps install [name|all]   # install a group (default: native)
abtars deps update [name|all]    # refresh an installed group
abtars deps remove <name>        # uninstall a group
```

There is no `deps check` — use `deps list`, which shows install status for everything in one view.

## Npm package groups

| Group | Packages | What it enables |
|-------|----------|------------------|
| `native` | `better-sqlite3`, `sqlite-vec` | SQLite storage for kanban + abmind memory. Installed automatically on first boot if missing; `deps install`/`update` exist for manual repair or refresh. |
| `twitter` | `rettiwt-api` | Twitter/X integration |
| `pdf` | `pdf-parse` | PDF reading |
| `youtube` | `youtube-transcript` | YouTube transcript fetching |
| `image` | `jimp` | Image processing |

All npm groups install under `~/.local/lib/node_modules/` — no sudo, no system paths. Daemon mode wires `NODE_PATH` automatically; simple mode needs the manual export documented in [Installation](./install.md).

`pi` (the coding-agent CLI/AI/TUI bundle) is managed through the same `deps install|update|remove pi` commands but is a separate external distribution with its own compatibility check — see [Pi Executor](./pi-executor.md).

The browser capability (`cloakbrowser`) is **not** a `deps` group — it's a standalone external binary you install yourself. See [Browser](./browser.md).

## Native deps: shared with abmind

`better-sqlite3` and `sqlite-vec` are the one dependency group abtars and abmind both need, and both products may end up owning the same install (same shared `~/.local/lib/node_modules/` root, same target versions). `abtars deps install/update native` and the equivalent `abmind deps` command coordinate through a shared, file-locked manifest — whichever product touches the group first records ownership; the other becomes a consumer.

### States you may see

`deps list` reports one of these states per npm group:

| State | Meaning |
|-------|---------|
| `ready` | Installed at the target version and recorded in the shared manifest — nothing to do. |
| `absent` | Not installed. `deps install` will fetch it. |
| `partial` | Only some packages in the group are present. `deps install`/`update` repairs it. |
| `invalid` | Present but corrupted (unreadable metadata, missing version). Repaired the same way as `partial`. |
| `drifted` | The exact target version is present on disk, but the shared manifest doesn't already own it — usually because another install path (manual npm install, an older abtars/abmind version, or the other product) put it there first. |

### What happens on `drifted`

A `drifted` group is not automatically broken — it just means abtars can't yet prove ownership through the manifest. `deps install`/`update` resolves this one of two ways:

- **Adopt** — if the installed package and everything it depends on (its full dependency closure) checks out exactly against the target contract, abtars records ownership in the shared manifest without running npm or touching any files. You'll see output like:
  ```
  ✓ native adopted (2 roots, 1 transitive; no npm install)
  ```
- **Repair** — if the closure can't be verified as an exact match (wrong version, corrupted files, unexpected structure), abtars falls back to a normal npm-backed install/refresh instead.

### Collision errors

If `deps update`/`install` stages a fresh npm install and finds an **unrelated, unrecorded package** already sitting in the shared root under the same name — something neither abtars nor abmind is tracking, and not the same content — it refuses to overwrite it rather than silently replacing files another tool put there:

```
✗ native failed: Collision with unrelated package "some-package"; refusing to overwrite.
```

This is a real, if rare, conflict — it means something outside abtars/abmind's coordination put a same-named package in the shared root. It is not triggered by ordinary version-range differences between dependents (e.g. one package wanting `^1.2.0` and another `^1.2.3` of the same transitive dependency) — that kind of declaration diversity is normal and does not cause a collision.

If you hit this, check what else writes to `~/.local/lib/node_modules/` on your machine before re-running `deps update`.

## System binaries (manual install)

| Binary | What for | Install command |
|--------|----------|------------------|
| `ollama` | Local embeddings + local models | `curl -fsSL https://ollama.ai/install.sh \| sh` |
| `bwrap` | Sandbox (Linux only) | `apt install bubblewrap` |
| `lightpanda` | Fast web fetch | See https://lightpanda.io |

abtars never runs a system installer or `sudo` for you. `abtars deps install ollama` (or any system binary name) just prints the upstream install command — it does not execute it. See [Prerequisites](./prerequisites.md#do-i-need-sudo-no) for why.

## Troubleshooting

- **`abtars deps update` fails with a collision on a transitive package** you didn't expect — see [Collision errors](#collision-errors) above.
- **A group stays `drifted` after `deps update`** — the closure verification failed silently; re-run with the group name explicit (`abtars deps update native`) and check the printed error for the specific mismatch (version, hash, ABI, platform).
- **Simple mode can't find installed npm packages at runtime** — add `NODE_PATH="$HOME/.local/lib/node_modules:$NODE_PATH"` to your shell profile; daemon mode sets this automatically. See [Installation](./install.md#install-modes).
