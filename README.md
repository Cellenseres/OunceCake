# OunceCake Fork!!!

Vibe-coded fork to add dumping of:
* Full system firmware titles with ExeFS and RomFS.
  - So that you can view the contents of applets (e.g. MiiEdit).
* System data archives.
  - e.g., MiiModel (0400000000000849) for Mii rendering resources.

(... Can you guess why I did this 😅)

## Instructions

> _This section was written by **Claude Opus 4.7** (because an-Throb-bic kept blocking this task on the newer models)_

### Prerequisites

* A Switch 2 running the kurumuz fork of **ns2jb** (`node run.cjs --rpc`), on
  the same machine or reachable from it. The `--rpc` flag is important: it
  tells ns2jb to hold the exploit session open after the user payload runs,
  so OunceCake can reattach over the retained FS/Loader roots.
* The run directory ns2jb prints at the end of its exploit
  (something like `.../ns2jb/runs/switch2-XxYyZz/`). OunceCake takes that
  path as its first argument; it reads `switch2/current-acquisition.json`,
  `switch2/ro/root/current-root.json`, and
  `switch2/ro/<session>-loader-root-copy.json` out of it.

### Firmware + system data dumping (the new flow)

Dump SystemProgram titles (applets like MiiEdit — ExeFS **and** RomFS) and
SystemData archives (MiiModel, SharedFont, dictionaries, …) straight to
disk:

```sh
# Dump everything (both kinds) into <run>/firmware-dump/.
node firmware-dump.cjs <run-directory>

# Only one kind.
node firmware-dump.cjs <run-directory> --include-programs
node firmware-dump.cjs <run-directory> --include-data

# A specific title or two (16-hex-digit title IDs, comma-separated).
node firmware-dump.cjs <run-directory> --titles 0100000000001009
node firmware-dump.cjs <run-directory> --titles 0100000000001009,0100000000000810

# Pick where it lands.
node firmware-dump.cjs <run-directory> --out /path/to/archive
```

Each dumped title lands under `<out>/<titleId>/` as:

* `exefs/` — `main`, `main.npdm`, … (SystemProgram only).
* `romfs/` — the full RomFS tree, with original paths preserved.
* `firmware-dump.json` at the output root — per-file SHA-256 journal so you
  can diff two dumps or verify an archive later.

Ctrl-C is safe: in-flight writes complete, the FS handles get closed, and
the journal is flushed with whatever was captured so far.

### Common hiccups

* **A title logs "no RomFS section (0x7d202)"** — expected for some
  SystemProgram titles that are code-only. Not an error.
* **A title fails with `0x7d802`** — needs an ES license to open. The
  dumper already tries `prepareInstalledLicense`; if it still fails the
  license isn't installed on this console. Skip it or install the title
  first.
