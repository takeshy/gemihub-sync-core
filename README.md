# gemihub-sync-core

Shared sync protocol core for GemiHub clients: `_sync-meta.json` diffing, conflict detection and Drive helpers for the web app, Obsidian and Desktop plugins.

GemiHub stores a workspace **flat** in one Google Drive folder. A file's Drive name is its relative path, and `_sync-meta.json` in the same folder is the fileId → metadata registry. Every client that syncs this layout (GemiHub web, [obsidian-gemihub](https://github.com/takeshy/obsidian-gemihub), gemihub-gdrive) must agree on the same rules. This package holds those rules as pure, runtime-agnostic TypeScript. It does no I/O and has no runtime dependencies.

## Contents

| Entry point | What it provides |
|---|---|
| `gemihub-sync-core/protocol` | `SyncMeta` / `FileSyncMeta` types, system file names, `computeSyncDiff`, push guards (`remoteChangedSincePushSnapshot`, duplicate-path checks, pending-deletion cancellation), and `_sync-meta.json` reconciliation (`pickSyncMetaToKeep`, `mergeSyncMetaSnapshots`, `isFileRemovedFromSyncRoot`, `addUntrackedFilesToSyncMeta`, `refreshDriftedSyncMetaEntries`) |
| `gemihub-sync-core/paths` | Sync-excluded paths, text/binary/MIME detection, Google Workspace native file detection, large-file threshold |
| `gemihub-sync-core` | Everything above |

Drive API access, credentials and local storage stay in each client. The reconciliation helpers take Drive listings as plain objects (`DriveFileLike`), so any transport works: `fetch`, Obsidian `requestUrl`, or a desktop plugin network API.

## Install

Consumers pin an exact commit:

```bash
npm install --save-exact "github:takeshy/gemihub-sync-core#<commit-sha>"
```

npm runs `prepare` (the TypeScript build) when it installs a git dependency, so `dist/` is not committed. Build environments therefore need `git` available when they run `npm ci`.

```ts
import { computeSyncDiff, type SyncMeta } from "gemihub-sync-core/protocol";
import { isSyncExcludedPath } from "gemihub-sync-core/paths";
```

The output is standard ESM with explicit `.js` import extensions. It loads directly in Node (for example, Vite SSR externals) and in Deno, and bundles with esbuild or Vite.

## Development

Requires Node.js 22.18+ (tests run TypeScript directly through Node's type stripping).

```bash
npm install
npm run typecheck
npm test
npm run build
```

Sources import siblings with `.ts` extensions. `tsc` rewrites them to `.js` in `dist/` (`rewriteRelativeImportExtensions`). Keep the code free of runtime-specific APIs (DOM, Node built-ins, Obsidian) so that every client can use it.

## License

MIT
