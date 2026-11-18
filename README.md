# Artifacts

An [Orca](https://orca.dev) plugin that adds an **Artifacts** tab to the right sidebar. It lists what Claude made in the focused worktree's repo and opens each item in Orca's browser with one click:

- **claude.ai Artifacts** published with Claude's Artifact tool (design canvases, dashboards, reports).
- **Orca chat visuals**, the inline HTML pages shown in Orca's native chat.

Three views: **List** (grouped by date or session), **Cards** (cover per item, pinned rail) and **Sessions** (timeline per chat, with version history). Scope is the whole repo (all local worktrees) or just the focused worktree. Items can be pinned, copied and opened in the external browser.

## How it works

A trusted worker (`src/worker.ts`) indexes Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) incrementally and caches the index on disk (`%LOCALAPPDATA%\orca-artifacts` on Windows, `~/.cache/orca-artifacts` elsewhere). It reads only successful Artifact `publish` results and `::orca-visual` directives. Opening an item runs `orca tab create --url … --worktree path:…`. The panel (`panel/`) is plain HTML/JS talking to the worker through `plugin.request`; `src/protocol.ts` and `src/types.ts` define the contract.

Access requested: read workspaces and agent status, own storage and settings. The worker runs with your user's access because it reads local transcripts.

Settings: `cliPath` (Orca CLI, auto-detected), `claudeDirs` (Claude config folders, auto-detected), `visualPreviews` (card previews, on by default) and `browserPath` (Edge/Chrome for visual previews, auto-detected).

## Privacy: previews

Card previews are captured locally and stored in the cache folder (`thumbs/`, capped at about 300 files / 30 MB). A claude.ai artifact is captured only when you open it from the panel, as a screenshot of its tab in Orca's browser. A chat visual is rendered by a headless Edge/Chrome with its own throwaway profile, no sandbox flags removed, no proxy, WebRTC restricted, and network access limited to Orca's CDN allowlist (jsDelivr, unpkg, cdnjs, esm.sh, Google Fonts). Nothing is uploaded. Turn off the `visualPreviews` setting to disable all capturing; a full refresh deletes stored previews.

Limitations: local workspaces only (no SSH/WSL); artifacts on claude.ai are private, so Orca's browser must be signed in to claude.ai to show them.

## Develop

```sh
orca plugin validate .
orca plugin test .            # node:test suites for indexer, worker, CLI, scope and panel logic
orca plugin dev watch .       # load into Orca (asks for approval), stream logs, reload on save
orca plugin dev request . artifacts.list --data '{"scope":"repo"}'
```

## License

MIT
