// The panel <-> worker contract. src/worker.ts reads it; panel/app.js follows it by hand (plain JS).
import type { ListResponse, OpenResult, Scope } from './types.ts'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Answers from the cache at once; starts a background scan when stale (see `indexing`). */
    'artifacts.list': { input: { scope: Scope }; output: ListResponse }
    /** Starts a scan now (`full` drops the cache first). `started` is false when one is running (no `reason`) or it cannot start (`reason`). */
    'artifacts.refresh': { input: { full?: boolean }; output: { started: boolean; reason?: string } }
    /** Opens the item in a new tab of Orca's embedded browser, in the focused worktree. */
    'artifacts.open': { input: { key: string }; output: OpenResult }
    /** Pins or unpins an item; answers the full pin list. */
    'artifacts.pin': { input: { key: string; pinned: boolean }; output: { pins: string[] } }
  }
  interface PluginPanelEvents {
    /** Index or pins changed, or the focused workspace changed: re-request `artifacts.list`. */
    'artifacts.changed': { rev: number; indexing: boolean }
  }
}
