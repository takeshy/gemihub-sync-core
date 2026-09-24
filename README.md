# gemihub-sync-core

Shared sync protocol core for GemiHub clients: `_sync-meta.json` diffing, conflict detection and Drive helpers for the web app, Obsidian and Desktop plugins.

GemiHub stores a workspace **flat** in one Google Drive folder. A file's Drive name is its relative path, and `_sync-meta.json` in the same folder is the fileId → metadata registry. Every client that syncs this layout (GemiHub web, [obsidian-gemihub](https://github.com/takeshy/obsidian-gemihub), gemihub-gdrive) must agree on the same rules. This package holds those rules as pure, runtime-agnostic TypeScript. It does no I/O and has no runtime dependencies. Cryptography uses the standard Web Crypto API (`globalThis.crypto`), available in browsers, Node and Deno.

## Contents

| Entry point | What it provides |
|---|---|
| `gemihub-sync-core/protocol` | `SyncMeta` / `FileSyncMeta` types, system file names, `computeSyncDiff`, push guards (`remoteChangedSincePushSnapshot`, duplicate-path checks, pending-deletion cancellation), `_sync-meta.json` reconciliation (`pickSyncMetaToKeep`, `mergeSyncMetaSnapshots`, `isFileRemovedFromSyncRoot`, `addUntrackedFilesToSyncMeta`, `refreshDriftedSyncMetaEntries`, `reconcileSyncMetaWithListing`, `syncMetaFromDriveFiles`), `syncMetaSnapshotChanged`, `duplicateRemotePaths` |
| `gemihub-sync-core/paths` | Sync exclusion: system files and folders, excluded folder names, user glob patterns (`isUserExcludedPath`), and `isSyncExcludedPath(path, options)` with client-specific prefixes and segments |
| `gemihub-sync-core/files` | One text/binary/MIME table for every client: `shouldTreatAsBinaryFile`, `guessMimeType`, `isTextFileName`, `isBinaryMimeType`, `looksLikeBinary`, large-file threshold |
| `gemihub-sync-core/conflict` | Conflict backup names: `buildConflictBackupName` (reversible, millisecond timestamp) and `parseConflictBackupName` (also reads every legacy format) |
| `gemihub-sync-core/crypto` | Hybrid encryption (RSA-OAEP + AES-GCM, PBKDF2-protected private key) and the encrypted file envelope with searchable `description` / `publicMetadata`. Web Crypto only. `test/fixtures/gemihub-crypto.json` pins the on-disk format |
| `gemihub-sync-core/auth` | External sync credentials: Migration Tool token (`encodeMigrationToken` / `decodeMigrationToken`), `_encrypted-auth.json` (`buildEncryptedAuthFile` / `parseEncryptedAuthFile` / `decryptEncryptedAuth`), and the token refresh request/response (`buildTokenRefreshRequest` / `parseTokenRefreshResponse` / `needsTokenRefresh`) |
| `gemihub-sync-core/hash` | Pure-JS MD5 (`md5Hash`, `md5HashString`) for comparing content with Drive's `md5Checksum` |
| `gemihub-sync-core` | Everything above |

Drive API access, credentials and local storage stay in each client. The reconciliation helpers take Drive listings as plain objects (`DriveFileLike`), so any transport works: `fetch`, Obsidian `requestUrl`, or a desktop plugin network API.

## Install

Consumers pin an exact commit:

```bash
npm install --save-exact "github:takeshy/gemihub-sync-core#<commit-sha>"
```

Older TypeScript setups (`moduleResolution: "node"`) resolve the subpath types through `typesVersions`.

npm runs `prepare` (the TypeScript build) when it installs a git dependency, so `dist/` is not committed. Build environments therefore need `git` available when they run `npm ci`.

```ts
import { computeSyncDiff, type SyncMeta } from "gemihub-sync-core/protocol";
import { isSyncExcludedPath } from "gemihub-sync-core/paths";
```

The output is standard ESM with explicit `.js` import extensions. It loads directly in Node (for example, Vite SSR externals) and in Deno, and bundles with esbuild or Vite.

## Updating consumers

After a library commit is pushed to `main`, pin every consumer to it in one step:

```bash
npm run sync-plugins -- ../gemihub ../obsidian-gemihub ../gemihub-gdrive
```

The script refuses to run while the library has uncommitted changes or when `HEAD` is not on `origin/main`. It validates every consumer's `package.json` first and then runs `npm install --save-exact git+https://…#<sha>` in each one. Review and commit each consumer's `package.json` and `package-lock.json` afterwards.

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
