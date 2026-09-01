# Development workflow

`pnpm dev` (which runs `wxt`) is a long-running watcher. Source changes rarely need a restart: WXT rebuilds on every save and signals the browser to reload the right thing. What each kind of change needs:

> **Testing against the staging API:** `pnpm build:staging` emits `.output/chrome-mv3-staging` targeting `https://api-staging.emojery.app`, a public testing environment where you can verify a new-site adapter's reaction round-trip end-to-end (see [adding-a-site.md step 11](adding-a-site.md#11-manual-smoke-on-the-live-site--against-the-staging-api)). Staging data is reset periodically. Override the target with `WXT_API_BASE` (or `.env.staging`) to point at a different backend instead.
>
> **Debug logging:** `pnpm dev` and `pnpm build:staging` compile `__EM_DEBUG_LOG__` to `true`, which turns on the `[emojery:api]`, `[emojery:indexeddb]` and `[emojery:error]` channels in the service-worker console (`src/background/debug.ts`; credential-shaped fields are redacted before they are printed). A **production** build compiles it to `false`, so those channels are dead code and never reach the shipped bundle — including a `pnpm build` output you load unpacked. Debugging a request means loading a staging or dev build — a production folder has the channels compiled out.
>
> **Queue diagnostics:** the popup's **Debug tab** lists the votes waiting in the durable queue, each one's attempt count and retry countdown, plus the queue-wide hold and consecutive-failure count that explain a queue with work in it sending nothing. It refreshes once a second, so a reaction burst is visible as it piles up and drains. It ships in every build and is off by default — Settings → Debug reveals it (`settings.debugMode`), so it is a user setting rather than a build mode, and no user-facing behavior depends on it.

| Change you made | Dev-server restart? | Action to see it |
| --- | --- | --- |
| Popup UI (`entrypoints/popup/main.tsx`, popup CSS) | No | Close + reopen the popup. Simple component edits HMR in place; module-level changes require a re-open. |
| Content scripts (`adapters/*.ts`, `ui/mount.ts`, `ui/picker.tsx` rendered into pages) | No | Reload the host tab (Cmd/Ctrl-R on Facebook / Instagram / GitHub / Amazon). WXT reloads the extension itself; the tab refresh is needed because content scripts can't be hot-swapped in already-injected pages. |
| Background service worker (`entrypoints/background.ts`, anything in `background/`) | No | WXT restarts the SW automatically. Inspect it via `chrome://extensions` → **service worker**. |
| `wxt.config.ts` (manifest, host_permissions, plugins, permissions list) | **Yes** | Stop and re-run `pnpm dev` — config is read at startup. |
| New dependency installed (`pnpm add ...`) | **Yes** | Restart dev. |
| `public/` content (`icons/`, `emoji-data/*.json`) | No | Tab reload. The `dev` script runs `prepare:assets` before `wxt` starts; new generated locales added while the watcher is running need `pnpm run prepare:assets` or a dev-server restart. |

## Auto-reload prerequisites

WXT's reload signal only reaches the Chrome instance **it spawned** (the one that opens when you run `pnpm dev`). A `Load unpacked` copy of `.output/chrome-mv3-dev/` in your personal Chrome never receives that signal: you have to click **Reload** on the extension card in `chrome://extensions` after each source change. Iterate in the spawned Chrome window, and keep your personal Chrome for final smoke tests.

## Quick "is the watcher working?" check

Edit `entrypoints/popup/main.tsx`, save, and watch the `pnpm dev` terminal: a rebuild line should print within ~1 second. If nothing prints, the file watcher isn't seeing your saves. On native Windows with NTFS this is rare; the common causes are:

- **WSL paths.** Editing under `/mnt/c/...` or watching a Windows-side checkout from inside WSL drops fs events. Either move the checkout inside WSL's ext4 filesystem, or enable polling in `wxt.config.ts`:

  ```ts
  vite: () => ({
    server: { watch: { usePolling: true, interval: 200 } },
    plugins: [preact() as never],
  }),
  ```

- **Network drives** (mapped SMB shares, OneDrive selective-sync folders). Same fix: move the checkout to local disk or enable polling.
- **Aggressive antivirus** that intercepts file writes: exclude the repo root.

## Things that look like watcher bugs but aren't

- A content-script edit doesn't change the page until you refresh the tab. Expected; see the table above.
- Popup still shows the old UI after an edit. Close the popup completely (click anywhere outside it) and reopen, because Chrome doesn't re-render an already-open popup on extension reload.
- `wxt.config.ts` change "didn't apply". Config changes need a full `pnpm dev` restart; there's no in-process re-eval.
