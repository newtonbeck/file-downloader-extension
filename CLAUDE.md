# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` and `README.md` are symlinks to this file — there is exactly one copy of this
document, edit it here.

## What this is

A Chrome extension that downloads a whole folder from a cloud storage provider unattended:
queue a folder, close the tab, and it works through every file one at a time — starting the
next download once the previous one finishes, retrying one that fails, and remembering
progress across browser and service-worker restarts.

Dropbox is the first provider. The provider boundary (see Architecture below) exists so a
second one can be added without touching the queue engine.

**Status:** this is a fresh rewrite of what used to be a Ground-internal sales tooling
extension — the side panel + service worker shape and build tooling carried over, but the
download queue, provider adapters and their UI do not exist yet. Treat the "Architecture"
section below as the intended design to build toward, not a description of code that is
already there. `public/icon16.png` / `icon32.png` / `icon64.png` / `icon128.png` are leftover
placeholder art from that project — replace them before shipping.

## Commands

```bash
npm install          # .npmrc sets legacy-peer-deps=true
npm run build        # tsc -b, then the Vite build
npm run lint         # eslint .
npm run dev          # Vite dev server — renders the panel UI in a normal tab, but every
                     # chrome.* call fails, so it is only useful for pure layout work
```

There is no test suite and no test runner. Verification means building and loading `dist/`
as an unpacked extension at `chrome://extensions/` (Developer mode → Load unpacked), then
reloading the extension after each rebuild.

## Build layout

`npm run build` runs one Vite build (`vite.config.ts`): a multi-entry ES-module build —
`index.html` → `main.js` (the side panel) and `public/background.js` → `background.js` (the
service worker). It empties `dist/` and copies everything else in `public/` verbatim.

`public/manifest.json`, `public/background.js` and the icons are hand-written and copied
as-is; edit them in `public/`, never in `dist/`.

If a provider ever needs a content script (running code inside a page the provider's web app
serves, rather than only calling its API), it cannot be an ES module — a manifest content
script must emit as one self-contained file with no imports, which this multi-entry build
would split into chunks. Give it its own `vite build --config vite.content.config.ts` step
with `emptyOutDir: false`, the way the previous version of this project did for a LinkedIn
content script — check git history for that config if you need the shape again.

## Architecture (intended)

Two isolated execution contexts, talking through `chrome.runtime.sendMessage`:

- **Side panel** (`src/main.tsx` → `src/App.tsx`) — React 19 + Tailwind v4. Opened from the
  toolbar action. Lists queued folders/files, per-file progress and status, and lets the user
  start, pause, cancel, or manually retry an item.
- **Service worker** (`public/background.js`) — plain JS, no bundling of its own imports. The
  only place that holds provider tokens, talks to the network, or calls `chrome.downloads`.
  Owns the queue: persists it to `chrome.storage.local` so it survives service-worker
  restarts (a MV3 worker can be killed between downloads), advances to the next item once
  `chrome.downloads.onChanged` reports the current one `complete`, and retries on `interrupted`
  up to some bounded count before marking the item failed and moving on.

### Providers

Each provider is an adapter behind one shared interface — folder listing and per-file
download-link resolution — so the queue engine never branches on which provider a file came
from. Put each provider's adapter and its typed API payloads in `src/providers/<name>/`
(e.g. `src/providers/dropbox/`). Auth (OAuth token exchange/refresh) lives with the adapter
and is called only from the service worker, same reasoning as `callSalesApi` in the prior
version of this file: one place holds the token, one place talks to the network.

Dropbox specifics to design around when this gets built:
- Folder listing paginates (`list_folder` / `list_folder/continue`) — the queue is built from
  a fully-drained listing, not the first page.
- File links come from `get_temporary_link` (or a batch equivalent) and expire — resolve one
  right before the download it's for, not up front for the whole queue.
- Rate limiting (`429`) is a retry case, not a failure — respect `Retry-After` before the
  normal backoff kicks in.

### The message protocol

Whatever shape this ends up taking, keep the seam the previous project used: the service
worker's `onMessage` listener returns `true` on every branch that answers asynchronously, and
every response is `{ success, data | error }` so the panel never has to branch on transport
errors versus provider errors.

## Conventions

- Comments explain *why* — a non-obvious constraint, a backend quirk, an ordering
  requirement — not what the line does. Match that density; do not narrate code.
- Feature work goes on `feat/<slug>` branches merged by PR; commit subjects are Conventional
  Commits (`feat:`, `chore(deps):`).
- Tailwind v4 via `@import "tailwindcss"` in `src/index.css` (the `tailwind.config.js` is a
  v3 leftover).
- `noUnusedLocals`/`noUnusedParameters` are on, so `tsc -b` fails the build on dead bindings.
