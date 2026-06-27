# ObsidianYamlUpdater

A small local desktop tool for batch-editing the YAML frontmatter of Obsidian notes.

Open the window, pick your vault folder, see the notes, select the ones you want, define the
YAML changes (add / delete / rename / set — with conditions), preview the result on a sample
note, then apply across every selected file. Every run writes a log of exactly what happened.

Built with [Wails](https://wails.io) (Go backend + web frontend), compiles to a single `.exe`.
No server, no network, no database — it only reads and writes the local files you select.

## Status

Early development. See the design docs (Obsidian vault, "ClaudeCode / 01 - Projects / ObsidianYamlUpdater").

## Develop

```powershell
wails dev      # live development with hot-reload
wails build    # build the redistributable .exe (output: build/bin/ObsidianYamlUpdater.exe)
```

Requires Go 1.23+, Node, and the Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`).

## How it works

- **vault** — scans the chosen folder for `.md` notes, parses frontmatter, and writes changes
  back surgically (only the touched lines) via atomic temp-file + rename.
- **ops** — the operation model (add/delete/rename/set) plus guard conditions, with a
  dry-run/apply executor.
- **frontend** — the window: folder picker, note list (filterable), operation builder,
  before/after preview pane, dry-run + apply, and a live log.
