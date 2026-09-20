# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` and `README.md` are symlinks to this file — there is exactly one copy of this
document, edit it here.

## What this is

A Chrome extension that downloads a whole folder from a cloud storage provider unattended:
scan a folder, press Start, close the panel, and it works through every file one at a time —
starting the next download once the previous one finishes, retrying one that fails, and
remembering progress across browser and service-worker restarts.

Dropbox shared links (`/scl/fo/…`) are the first and only provider. The provider boundary (see
Architecture below) exists so a second one can be added without touching the queue engine.

Files land under the browser's Downloads directory — `chrome.downloads` rejects absolute paths,
so an arbitrary destination is not possible; the user repoints Chrome's download location
instead. Two consequences worth knowing: empty folders do not appear on disk (no file, no
directory), and the destination is assumed empty — reconciling against a partly-downloaded
folder is not implemented.

**Status:** the Dropbox shared-folder path is built but has never been run against a real
account — it has only been type-checked and linted. Until someone completes a real download,
treat the Dropbox protocol details below as researched-and-implemented rather than proven.
`public/icon*.png` are leftover placeholder art from the project this repo was rebuilt from;
replace them before shipping.

## Commands

```bash
npm install          # .npmrc sets legacy-peer-deps=true
npm run build        # tsc -b, then the panel build, then the service-worker build
npm run lint         # eslint .
npm run dev          # Vite dev server — renders the panel UI in a normal tab, but every
                     # chrome.* call fails, so it is only useful for pure layout work
```

There is no test suite and no test runner. Verification means building and loading `dist/`
as an unpacked extension at `chrome://extensions/` (Developer mode → Load unpacked), then
reloading the extension after each rebuild.

### Still unverified against a real browser

Nothing here has run yet. In rough order of how much damage being wrong would do:

1. **Does `chrome.downloads.download` create nested directories?** The docs say a filename "may
   contain subdirectories" but never explicitly promise multi-level creation. Test with a
   10-byte download to `test/a/b/c.txt` before trusting anything else.
2. **Does `href` + `dl=1` actually yield the file?** Test a file over 1 GB — the risk is an HTML
   interstitial, and it is size-dependent. The size check in `settleActive` should catch it and
   fall over to `generate_download_url`, but confirm that path rather than assuming it.
3. **Is the pagination field really `voucher`?** Six independent implementations say yes. Confirm
   in DevTools by scrolling a folder with more than one page and copying the second
   `list_shared_link_folder_entries` request.
4. **Does `saveAs: false` beat Chrome's "Ask where to save each file" setting?** Evidence says the
   preference wins. If it does, unattended runs need that setting off; the panel surfaces a hint
   after a download sits at zero bytes for two minutes.

## Build layout

`npm run build` runs **two** Vite builds and the order matters:

1. `vite build` (`vite.config.ts`) — the side panel: `index.html` → `dist/main.js`. It empties
   `dist/` and copies everything in `public/` verbatim.
2. `vite build --config vite.worker.config.ts` — the service worker: `src/worker/index.ts` →
   `dist/background.js`, as a single **IIFE** with `emptyOutDir: false`.

The worker gets its own build because a manifest `service_worker` declared without
`"type": "module"` cannot `import`, and the panel build would split shared code into chunks
under `assets/`. IIFE guarantees one self-contained classic script. Keeping the worker in
`src/` (rather than as hand-written JS in `public/`) is what gets it type-checked, linted, and
sharing types with the panel — it holds the entire queue state machine.

**`target: 'esnext'` in `vite.worker.config.ts` is load-bearing, not a preference** — see the
injected-function rule under Conventions.

`public/manifest.json` and the icons are hand-written and copied as-is; edit them in `public/`,
never in `dist/`.

No content script is needed: `chrome.scripting.executeScript({ func })` serializes a function
rather than loading a file, so provider code runs in the page without a manifest entry or a
third build.

## Architecture

Two isolated execution contexts, talking through `chrome.runtime.sendMessage`:

- **Side panel** (`src/main.tsx` → `src/App.tsx`, components in `src/panel/`) — React 19 +
  Tailwind v4, purely presentational. It polls the worker and dispatches commands; it holds no
  queue state of its own.
- **Service worker** (`src/worker/`) — owns the queue, `chrome.storage.local`,
  `chrome.downloads`, and all provider traffic. `index.ts` is the entry and does nothing but
  register listeners; `engine.ts` holds the state machine.

### The service worker dies constantly, and that is the whole design

An MV3 worker idle-terminates after ~30s. A 45 GB run lasts hours, and a single large file
downloads with the worker dead the entire time. So:

- **No in-memory state is load-bearing.** Every operation rehydrates from `chrome.storage.local`
  and writes back before returning. The `serialize()` promise chain in `engine.ts` orders
  operations *within* one worker instance; nothing depends on it surviving.
- **Listeners are registered synchronously at the top level of `src/worker/index.ts`.** That is
  what lets a terminated worker be woken rather than miss the event. Do not move registration
  inside an `async` function or behind a condition.
- `chrome.downloads.onChanged` wakes the worker and drives the queue. It reports every
  `DownloadItem` property **except `bytesReceived` and `estimatedEndTime`**, so live progress is
  polling-only (`chrome.downloads.search`) and there is nothing to push to the panel.
- A `chrome.alarms` watchdog ticks every minute as a backstop against a missed event; a one-shot
  alarm handles retry backoff. `setTimeout` is useless — the worker will be dead before it fires.

Three storage keys: `run` (one object), `items` (the flat queue), `tree` (display only).
`tick()` in `engine.ts` is the single queue driver and is idempotent — every wake path calls it.
**"One download at a time" is enforced by `run.activeItemId` in storage**, never by a variable.

### Providers

Each provider is an adapter behind the interface in `src/providers/types.ts` — match a URL,
list a folder (pagination drained internally), resolve one file's download URL — so the engine
never branches on which provider a file came from. There is deliberately no registry module:
one provider exists, so `engine.ts` imports it directly.

Errors cross the seam as `ProviderError`, and **the engine branches on `retryable` / `needsTab` /
`fatal`, never on `code`**.

### Dropbox

Shared links (`/scl/fo/…`) have no public API, so the extension replays Dropbox's private web
endpoints from inside the user's own tab via
`chrome.scripting.executeScript({ world: 'MAIN', func })`. There are **no tokens and no OAuth** —
it borrows the browser session, which is why the worker holds no credentials.

Hard-won details, each of which will cost you a day if changed carelessly:

- **The pagination field is `voucher`, not `next_request_voucher`.** Sending the wrong name is
  *not rejected* — Dropbox ignores it and returns page one forever, silently truncating the
  tree. `listAllEntries` in `protocol.ts` guards this three ways: the right field name, the
  voucher echoed verbatim (it is already a JSON string; a second `JSON.stringify` breaks its
  signature), and `entries.length` reconciled against `total_num_entries` per folder.
  A short listing is a hard error, never a warning.
- **Listing a subfolder needs that subfolder's own `secureHash` plus its full path from the link
  root.** The parent's hash with a child `sub_path` returns 404. Both come from `share_tokens[]`,
  which is positionally parallel to `entries[]` (guarded by a length check).
- **Downloads use the entry's own `href` with `dl=1`**, handed straight to `chrome.downloads`,
  which follows Dropbox's redirect chain with the browser's cookies. No per-file API call and no
  tab needed. `generate_download_url` is the fallback, used only after repeated size mismatches.
- **Chrome reporting `complete` is not proof of success.** `settleActive` compares the download's
  `fileSize` against the size from the listing; a mismatch is a retry, not a completion. This is
  what catches an HTML interstitial arriving instead of a 2.5 GB video.
- Throttling shows up as `429`, as `509` (a *hours-long* link bandwidth block — pause, never
  hammer), and confusingly as `400`/`403`/`404` mid-walk on requests that already worked.
- `PROTOCOL_CHANGED` and `INCOMPLETE_LISTING` are deliberately separate from every other error so
  "Dropbox changed and this tool is now lying to you" can never render as "3 files failed".

### The message protocol

The worker's `onMessage` listener returns `true` on every branch and answers
`{ success, data | error }`, so the panel never branches on transport versus provider errors.
`SCAN` returns immediately — a 190-file walk far outlives the message channel — and the panel
follows progress through `run.scanProgress`.

## Conventions

- **Injected functions live only in `src/providers/dropbox/injected.ts`.** Anything passed to
  `executeScript({ func })` is serialized with `Function.prototype.toString()` and re-parsed in
  the page, so it must take every input as a parameter and reference nothing but its own locals
  and page globals. `import type` is fine (types are erased); importing a runtime value is not —
  it becomes a module-scope identifier the page has never heard of. This is also why the worker
  build must stay at `target: 'esnext'`: a lower target has esbuild rewrite `async`/spread into
  module-scope helpers, breaking every injected function. Keep them dumb — one request in,
  stripped data out — so loops and guards stay in typed, linted code.
- Chrome requires an `executeScript` result to be **JSON-serializable**, so injected functions
  catch internally and *return* `{ ok: false, error }`; a thrown `Error` would arrive as `{}`.
- Comments explain *why* — a non-obvious constraint, a backend quirk, an ordering
  requirement — not what the line does. Match that density; do not narrate code.
- `erasableSyntaxOnly` is on: no `enum`, no parameter properties, no namespaces. Status sets are
  `const X = {...} as const` plus a derived union.
- TypeScript 6 no longer auto-includes every `@types` package, so the `chrome` globals are
  referenced explicitly in `src/vite-env.d.ts`.
- Feature work goes on `feat/<slug>` branches merged by PR; commit subjects are Conventional
  Commits (`feat:`, `chore(deps):`).
- Tailwind v4 via `@import "tailwindcss"` in `src/index.css` (the `tailwind.config.js` is a
  v3 leftover).
- `noUnusedLocals`/`noUnusedParameters` are on, so `tsc -b` fails the build on dead bindings.
