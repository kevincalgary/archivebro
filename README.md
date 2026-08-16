# Archive Browser

A local-first desktop browser for macOS and Windows that automatically saves a durable, searchable, offline copy of every page you actually visit — no account, no cloud service, nothing sent anywhere.

## Why

Normal browser history is a list of URLs, not the pages themselves. Pages change, go offline, or end up behind logins you no longer have. Archive Browser captures what you actually saw — a full-page screenshot, the complete MHTML snapshot, and the extracted text — at the moment you visited, and keeps it on your disk, in a format you can open years later with no network connection.

## Two kinds of archiving

Archive Browser saves pages in two complementary ways:

1. **Automatic per-page capture** (always on, in the background). Every page you visit is saved to the local Library as MHTML + full-page screenshot + extracted text, catalogued in SQLite. This is the "never lose a page you looked at" layer.
2. **"Capture the Page" → a portable `.sitearchive` file** (explicit, on demand). Captures the current page — or the whole website — into a single self-contained file you can move, back up, or send to someone else, and browse offline as though it were still live.

The rest of this README covers both; the `.sitearchive` feature is described in its own section below.

## Architecture overview

Three trust tiers, three sessions/partitions:

1. **Trusted chrome** — a single `BrowserWindow` running the React UI (tabs, address bar, Library, Settings). `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a strict `Content-Security-Policy`, and one narrow `contextBridge` preload ([src/preload/trusted-preload.ts](src/preload/trusted-preload.ts)) exposing only typed, `zod`-validated IPC calls.
2. **Live browsing** — one `WebContentsView` per tab (Electron's current recommended primitive for embedding web content, replacing the deprecated `BrowserView` and the discouraged `<webview>` tag), attached as a child view of the trusted window's `contentView`. Sandboxed, no preload, session partition `persist:browsing` shared across normal tabs (so cookies/logins persist), or a unique in-memory partition per private tab.
3. **Offline archive viewer** — another `WebContentsView`, on a dedicated session whose `webRequest` handler denies every request except our own `archive://` protocol (screenshot/text/fallback content) and a `file://` path scoped to the archives root (the MHTML snapshot itself — see the note on MHTML below), with JavaScript disabled by default (`javascript: false` in `webPreferences`).

No preload script is ever attached to a browsing or offline-archive `WebContentsView` — page content has no path to `ipcRenderer`, Node, or Electron internals, directly or indirectly, regardless of what the page's own script does.

**Capture pipeline** ([src/main/capture/captureService.ts](src/main/capture/captureService.ts)): on a top-level navigation (`did-navigate`, main frame only), a debounced settle timer (default 3s, configurable) fires, then the page is snapshotted — `webContents.savePage(..., 'MHTML')`, a full-page PNG via the Chrome DevTools Protocol (`Page.captureScreenshot` with `captureBeyondViewport: true`, since `capturePage()` alone only grabs the viewport), and extracted visible text (host-initiated `executeJavaScript`, form/password values stripped before serialization). SPA route changes (`did-navigate-in-page`) are debounced and filtered so hash-only changes aren't treated as new visits. Writes go through a staging directory and are `rename()`d into place only on success — a crash mid-capture can never leave a half-written archive in the catalog.

**Storage layout**:

```
archives/
  <archive-id>/       # UUID, never derived from user input
    page.mhtml
    screenshot.png
    text.txt
    metadata.json
```

SQLite (`better-sqlite3`, with an FTS5 index for search) is the catalog; the files on disk are the source of truth. Re-visiting a URL creates a new archive row grouped by `canonical_url`, never an overwrite.

**A disclosed exception to "prefer a custom protocol over `file://`":** the offline viewer's MHTML snapshot is loaded via `loadFile()` on a path built by [`archiveFilePaths()`](src/main/util/paths.ts) (never attacker- or page-influenced), not through `archive://`. This was empirically verified during development: Chromium's MHTML document loader only recognizes a document as MHTML when it's fetched via `file:` (or a small set of built-in schemes) — serving the identical bytes with an identical `multipart/related; boundary=...` `Content-Type` through our own `protocol.handle()` response is accepted at the network layer but Chromium still fails it with `ERR_FAILED` before it ever reaches the MHTML renderer. [`offlineSession.ts`](src/main/offline/offlineSession.ts)'s `webRequest` denylist independently re-validates that the one `file://` request it allows resolves inside the archives root, on top of the caller-side validation, so this doesn't reopen arbitrary filesystem access — it's `loadFile()` given one specific, pre-checked path, on a session with no other network access and JavaScript disabled. Screenshot, extracted text, and the no-MHTML fallback page are all still served through `archive://` as originally designed.

### Threat model (summary)

| Concern | Mitigation |
|---|---|
| Malicious website in a tab | sandbox + no preload + `nodeIntegration: false`; can't reach Electron/Node; can't navigate the trusted window (`will-navigate` guard on the trusted `BrowserWindow`); popups routed through our own validated tab-creation, never raw `shell.openExternal` on unvalidated input |
| Path traversal via archive IDs | IDs are server-generated UUIDs only; every filesystem path is built via [`archiveDirFor()`](src/main/util/paths.ts), which validates the ID and verifies the resolved path stays under the archives root |
| Unsafe/unvalidated IPC | Every `ipcMain.handle` call checks `event.sender.id` against the trusted window and validates arguments against a `zod` schema in [ipcContract.ts](src/shared/ipcContract.ts) before doing anything |
| Archive tampering | Atomic staged writes (temp dir → rename); UUIDs prevent cross-archive collision via the UI. File-hash verification on read is **not** implemented — see Known Limitations |
| Credential leakage into archives | Cookies/localStorage/session tokens are never read into archive files; password `<input>` values are stripped before text extraction; MHTML capture is the browser's own same-origin snapshot, not a credential export |
| Unwanted network during offline viewing | Enforced at the session/`webRequest` layer, not just by omitting scripts — even a hypothetical future JS-enabled mode would still hit the denylist |
| Certificate errors | Never overridden/ignored — default Chromium verification behavior is left intact |

## Portable website archives (`.sitearchive`)

Click **Capture the Page** in the toolbar (or File ▸ Capture the Page…, `Cmd/Ctrl+Shift+S`) and choose a scope:

- **Current page only** — this page plus everything it needs to display.
- **Entire current website** — follows links on the same origin, recursively, within safe default limits (depth 3, 50 pages, 256 MB).
- **Custom scope** — max depth, max pages, max archive size, additional allowed domains, explicitly-included external domains, whether to include documents or audio/video, crawl delay, and concurrency.

Anything beyond the recommended limits requires an explicit confirmation before it will start. During capture you get live pages-discovered / pages-saved / current-URL / downloaded-size / warning / failure counts, plus **Pause** and **Cancel**. On completion you get the saved location, page and asset counts, final file size, a list of anything that failed, and **Open Archive** / **Reveal in Finder** (or **Show in File Explorer**) / **Retry failed pages**.

### The file format

A `.sitearchive` is a **ZIP container with a documented layout** — not a proprietary blob. Rename it to `.zip` and inspect it with any standard tool:

```
manifest.json          # format version, URLs, scope, page list, route map,
                       # failures, content types + SHA-256 checksums, app
                       # version, total uncompressed size
pages/<pageId>.html    # serialized rendered DOM (not the original server HTML)
pages/<pageId>.txt     # extracted searchable text
assets/<sha256>.<ext>  # content-addressed, so a shared logo is stored once
screenshots/<pageId>.png
responses/<sha256>.json # safe captured GET responses
index.sqlite           # queryable catalog of everything above
```

Writes are atomic: everything is staged in a temp directory, zipped to `<name>.tmp-<uuid>`, and only renamed to the final `.sitearchive` after the capture and validation both succeed. A cancelled or crashed capture therefore can never damage an existing archive at that path.

Double-clicking a `.sitearchive` opens it in Archive Browser on both macOS and Windows 11 (registered via `fileAssociations` in [electron-builder.yml](electron-builder.yml); delivered by the `open-file` event on macOS and via argv/`second-instance` on Windows).

### Reading an archive safely

A `.sitearchive` is a portable file people will share, so it is treated as untrusted input. Before any entry's bytes are used ([archiveReader.ts](src/main/sitearchive/archiveReader.ts)):

| Threat | Defence |
|---|---|
| Path traversal (`../`, absolute, UNC, `C:\`, backslash, NUL) | Entry names normalized and rejected by `safeEntryName()`; manifest-referenced paths validated too, so a hostile manifest can't point outside the container either |
| Zip bomb | Per-entry and whole-archive uncompressed size caps, plus a compression-ratio cap that rejects absurd expansion **before** decompressing |
| Oversized archive | Entry-count cap and a 4 GB total-uncompressed cap |
| Tampering / corruption | Every entry's SHA-256 is verified against the manifest before its bytes are served |
| Smuggled extra files | Entries not listed in the manifest are ignored entirely — the manifest is the authority |
| Wrong/newer format | Manifest shape is validated field by field; a newer `formatVersion` is refused with a clear message |

### Browsing an archive offline

Archives open in a dedicated session where **all network access is blocked at the session layer** — only the custom `archive-site://` protocol resolves. That's a structural guarantee, not a promise about page content: an archived page cannot reach the internet even if it contains scripts that try. On top of that, `fetch`/`XHR`/`WebSocket` are neutralized in-page, service worker registration is disabled, Node integration stays off, context isolation and sandboxing stay on, no preload is attached, and a persistent **Offline Archive** indicator is shown while you're in one.

Links are rewritten at serve time (once the crawl's route map is complete, so a link captured on page 1 to a page discovered later still resolves):

- Target **in the archive** → opens the archived page. Back, forward, refresh, fragments, query strings, and relative links all behave normally.
- Target **not captured** → an explicit offline page naming the URL, with an **Open Live Version** button that confirms before leaving the archive.
- **Downloadable files** captured in the archive open the local archived copy.
- `mailto:`, `tel:`, custom protocols → explicit confirmation. **Executables are refused outright.**
- Forms are read-only; `POST`/`PUT`/`PATCH`/`DELETE` are never captured and never replayed.

### What is and isn't saved

Captured: rendered HTML and current DOM state, CSS, inline styles, images, favicons, web fonts, SVG, background images, `srcset` resources, same-origin frames, scripts needed for offline display, safe static GET responses, video poster images, the current values of non-sensitive form controls, a full-page screenshot, and extracted searchable text.

**Never** saved: password-field contents, authentication headers, cookies, session tokens, API keys, payment or autofill data, sensitive hidden fields (CSRF tokens), private keys, or DRM-protected media. Fields whose name/id/autocomplete look credential-shaped are cleared as well, and credential-shaped URLs and content types are skipped outright. The crawl renders pages using your existing logged-in session so authenticated pages look right — but only the rendered output is stored, so a shared archive never carries reusable credentials. This is verified by a test that greps the entire container for the fixture's password and CSRF values.

### Image screenshot fallback

Normal downloading is always attempted first and always preferred, because it preserves the original file, resolution, animation, and vector properties. When an image *cannot* be stored normally — a cross-origin image that can't be downloaded, a `blob:` URL, a canvas whose pixels can't be serialized, a dynamically generated or blocked image — Archive Browser preserves what you actually saw by taking a **tightly cropped screenshot of the rendered element**.

The crop comes from the element's own `getBoundingClientRect()` scaled by the device pixel ratio, so it already accounts for CSS transforms, zoom, `object-fit`/`object-position`, cropping, and clipping, and it captures **only** the element's box — never surrounding text, account details, or form fields. The element is scrolled into view, layout and fonts are allowed to settle, and **your original scroll position is restored afterwards**.

A screenshot is *not* saved when the area is blank or fully transparent (checked by actually decoding the pixels via Electron's `nativeImage`, not by guessing from file size), when the element has zero size or was never rendered, when it's a tracking pixel (≤3px), or when it's a broken-image placeholder icon. In those cases the page shows a clearly styled **"Image unavailable in this archive"** placeholder instead. Any surrounding hyperlink is preserved either way.

Each screenshot-derived asset records its original URL (when known), page URL, element type, rendered and screenshot dimensions, capture timestamp, the reason normal saving failed, its content hash, and an explicit `isRenderedScreenshot` flag — so an archive never passes a screenshot off as the original file. These assets are deduplicated by content hash like any other.

Screenshot-derived images only preserve appearance at the displayed resolution. They do not retain original resolution, animation, embedded metadata, vector properties, transparency composited against the page, or hidden/offscreen portions of a cropped image.

### What can't be preserved

Perfect offline reproduction is not possible for every website, and the app doesn't claim it. Live search results, server-side forms, real-time feeds, multiplayer/collaborative features, live chat, continuously changing APIs, protected streaming media, DRM content, CAPTCHAs, payment flows, and anything requiring an active server session will not work in an archive. What an archive preserves is the content and navigation available at capture time. The full-page screenshot and extracted text remain available as durable fallbacks for every captured page.

## Project structure

```
archive-browser/
  src/
    main/            # Electron main process (Node, full privileges)
      browser/        tabManager.ts (WebContentsView lifecycle), urlUtils.ts
      capture/         captureService.ts, screenshotCapture.ts (CDP), textExtraction.ts, diskSpace.ts, recovery.ts
      db/              database.ts, schema.ts, migrations.ts, archiveRepo.ts
      offline/         offlineSession.ts, offlineProtocol.ts (archive:// scheme)
      sitearchive/     portable .sitearchive feature:
                        archiveWriter.ts (container + atomic write), archiveReader.ts (safe read),
                        crawler.ts (scoped GET-only crawl), captureManager.ts (job lifecycle),
                        pageCapture.ts + pageScript.ts (rendered-DOM serialization),
                        imageFallback.ts (element screenshot fallback),
                        resourceFetcher.ts, urlNormalize.ts (routing/scope/trap heuristics),
                        sitearchiveSession.ts (archive-site:// + network-blocked session)
      security/        csp.ts, permissions.ts
      settings/        settingsStore.ts, storageManager.ts (retention/quota)
      ipc/             handlers.ts (validated IPC surface)
      windows/         mainWindow.ts, appMenu.ts
      util/            paths.ts, atomicWrite.ts, logger.ts, zipExport.ts, moveStorage.ts
      testHooks.ts     # e2e-test-only backdoor, gated by ARCHIVE_BROWSER_E2E=1
      index.ts         # app entry / lifecycle wiring
    preload/
      trusted-preload.ts   # the ONLY preload script in the app
    renderer/          # React UI (trusted chrome only — never renders page content)
      components/       Toolbar, TabBar, BrowserSurface, Library/, Settings/
      state/            zustand store
    shared/             types.ts, ipcContract.ts (channels + zod schemas)
  fixtures/             local fixture websites used by tests
                          server.js      (single-page capture fixtures)
                          siteServer.js  (multi-page site: relative/absolute links, nested
                                          pages, redirects, fragments, query strings, CSS/
                                          images/fonts/SVG, lazy loading, JS-generated links,
                                          SPA routes, duplicate assets, missing resources,
                                          cross-origin links, forms, destructive links, loops,
                                          and the awkward-image page for fallback tests)
  tests/
    unit/               vitest — pure logic, no Electron runtime needed
    e2e/                Playwright + Electron — full app, real navigation/capture
  electron-builder.yml
  vite.config.ts
```

## Development

Requires Node.js 20+.

```bash
npm install
npm run dev
```

`npm run dev` builds the main/preload process once, then runs Vite's dev server for the renderer and a `nodemon`-watched Electron process together, so renderer changes hot-reload and main-process changes trigger a rebuild + relaunch.

To run the production build without the dev server:

```bash
npm run build
npm start
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Renderer dev server + watched Electron main process |
| `npm run build` | Full production build (renderer + main + preload) into `dist/` |
| `npm run typecheck` | `tsc --noEmit` across main, preload, and renderer projects |
| `npm run test:unit` | `vitest` — pure-logic unit tests, no Electron needed |
| `npm run test:e2e` | Builds, then runs the Playwright + Electron end-to-end suite |
| `npm test` | Both of the above |
| `npm run fixtures:serve` | Runs the single-page fixture site standalone on port 4173, for manual testing |
| `npm run fixtures:serve:site` | Runs the multi-page `.sitearchive` fixture site on port 4174 |
| `npm run package:mac` / `package:win` | Fast **unpacked** local build (`--dir`) for the current or specified platform |
| `npm run package:mac:dist` / `package:win:dist` | Full distributable (dmg+zip / nsis+portable), **unsigned** |

## Testing strategy and a real constraint

Tabs and the offline archive viewer are `WebContentsView` instances, not separate `BrowserWindow`s — Playwright's Electron support can only attach to real `BrowserWindow`s, so it cannot click into or read the DOM of a browsed or archived page directly. Two things work around this without weakening the app's own security boundaries:

- End-to-end tests drive the **trusted UI** (address bar, tab bar, Library, Settings) exactly as a user would, via Playwright's normal `Page` API against the one real `BrowserWindow`.
- For assertions that need to reach into a tab's content (e.g. simulating an SPA's `pushState` route change) or into main-process state (the capture catalog, settings, tab list), tests use [`src/main/testHooks.ts`](src/main/testHooks.ts) — a narrow object attached to `globalThis` **only** when `ARCHIVE_BROWSER_E2E=1` is set, reached via Playwright's `electronApplication.evaluate()`. It is never wired to any IPC channel, preload, or `contextBridge`, so it isn't reachable from any renderer or web content, and it doesn't exist at all in a normal run.

Tests run against local fixture websites ([fixtures/](fixtures/)) rather than the real internet. As of this build: **113 unit tests** and **71 end-to-end tests**, all passing (`npm test`).

**Unit** (`tests/unit`, pure logic): URL resolution/validation and normalization, tracking-parameter stripping, same-origin scope checks, destructive-link and crawler-trap heuristics, atomic writes, path/ID validation, the IPC zod schemas, the SQLite catalog including FTS search and versioning, disk-space checks, settings persistence, domain-exclusion matching, the `.sitearchive` container round-trip, and its rejection of malformed and malicious archives (traversal in every form, zip bombs, bad manifests, checksum mismatches, future format versions).

**End-to-end** (`tests/e2e`, driving the real built app): normal navigation, redirects, SPA routes with debouncing, dynamic content, lazy images, broken resources, multiple tabs, back/forward, `window.open()` popups, capture versioning, domain exclusions, pausing archiving, private browsing, offline viewing, archive deletion, invalid/unsafe address-bar input, restart recovery — plus, for `.sitearchive`: current-page and whole-site capture, relative/absolute/nested links, redirects, cross-origin links never followed, GET-only enforcement, destructive links skipped, recursive loops terminating, depth/page/size limits, asset deduplication, missing resources, lazy-loaded content, JS-generated links, SPA routes, cancelled captures leaving no file or temp data, pause/resume, progress reporting, offline rendering with the server stopped, route-map resolution, checksum-verified asset serving, back/forward inside an archive, corrupt and traversal-crafted archives refused, the full capture UI flow, and every image-fallback case (normal download preferred, canvas, blob URL, broken image, tracking pixel, wrapping link preserved, provenance metadata, deduplication, scroll restoration, private-content exclusion, offline display).

Not covered by automated tests in this MVP: actual disk-full behavior (simulated at the unit level via a mocked `fs.statfs` instead — genuinely filling a disk in CI isn't practical), pixel-level screenshot correctness, and Windows-specific behavior (developed and tested on macOS only — see Known Limitations).

## Packaging

Both package.json scripts and `electron-builder.yml` are already wired up. **These are unsigned local builds.** electron-builder can cross-package both platforms from a single macOS machine (it ships its own macOS-native `makensis`/7-Zip tooling for the Windows installer, so nothing extra needs installing) — no Windows or Linux machine required to produce any of these.

```bash
npm run package:mac        # fast unpacked .app in release/
npm run package:mac:dist   # unsigned .dmg + .zip (arm64 + x64) in release/
npm run package:win        # fast unpacked build in release/
npm run package:win:dist   # unsigned installer + portable .exe (arm64 + x64) in release/
```

Verified in this repo's own build environment (macOS, arm64 host):
- `npm run package:mac:dist` — produced `.dmg`/`.zip` for both arm64 and x64. The arm64 `.dmg` was mounted and the app inside launched successfully directly off the disk image, matching what a user double-clicking it would experience.
- `npm run package:win:dist` — produced `Archive Browser Setup 0.1.0.exe` (NSIS installer, one-click, bundles both x64 and arm64) and `Archive Browser 0.1.0.exe` (portable). Both are valid `PE32 executable (GUI) Intel 80386, ... Nullsoft Installer` files, and the underlying per-arch `.exe` binaries they contain are valid `PE32+` Windows executables for their target architecture. **Not actually run on a Windows machine** — none was available in this environment — so this is structural/build verification, not an execution test. See "Native module note" below for why this should work at runtime.

Native module note: `better-sqlite3` (the only native dependency) is built on N-API, which Node.js and Electron both guarantee is ABI-stable across versions — unlike older native addons, it does not need per-Electron-version rebuilding, and it already ships real prebuilt binaries for every platform/arch this app targets (`node_modules/better-sqlite3/prebuilds/*.node`, picked at runtime by its own loader based on `process.platform`/`process.arch`). `electron-builder.yml` sets `npmRebuild: false` accordingly — leaving it on makes electron-builder attempt a `node-gyp` rebuild instead of using those prebuilds, which is both unnecessary and fails outright when cross-packaging a Windows target from macOS (`node-gyp` can't cross-compile native modules from source). If a future native dependency isn't N-API-based and needs real per-platform compilation, cross-packaging from one machine stops being reliable and a per-OS CI build (e.g. a GitHub Actions matrix with `macos-latest` and `windows-latest` runners) becomes the correct approach instead.

### Public distribution (not done here)

- **macOS**: requires an Apple Developer ID certificate, `hardenedRuntime` entitlements, code signing, and notarization via `notarytool`. `electron-builder` supports this via `mac.notarize`/`CSC_LINK`/`CSC_KEY_PASSWORD` env vars once you have a certificate.
- **Windows**: requires a code-signing certificate (EV or OV) and `win.certificateFile`/`certificatePassword`, or a cloud signing service — otherwise SmartScreen will warn on every install.

Both are deliberately left unconfigured; wiring them up is a roadmap item, not something to fake with a self-signed cert.

## Privacy and legal boundaries (by design)

Archive Browser does **not**: bypass authentication, paywalls, CAPTCHAs, DRM, or access controls; attempt to archive protected video streams; export cookies, passwords, authorization headers, session tokens, form entries, or localStorage secrets into an archive; capture password-field values; log keystrokes; send browsing history or archive contents to any server; or recursively crawl pages you didn't visit. Authenticated pages are archived only as the content currently rendered for the signed-in session — never with reusable credentials copied into the archive.

Some sites cannot be preserved perfectly: pages that depend on live APIs, server-side sessions, streamed/DRM media, or service workers will render differently or not at all when viewed offline. The screenshot and extracted text are the durable fallback in those cases, and the offline viewer automatically falls back to them if the MHTML snapshot fails to render.

## Known limitations

- **"Ask" permission default currently resolves to deny.** There's no in-UI permission-prompt dialog yet; `ask` is accepted in Settings but behaves like `deny` until that prompt ships (see roadmap).
- **No archive integrity verification on read.** Files aren't hashed at capture time, so on-disk tampering between capture and viewing isn't detected.
- **MHTML rendering fidelity varies by site.** Pages relying on service workers, streamed media, or heavy runtime JS state may render imperfectly or fail entirely in the offline viewer; the screenshot/text fallback covers this case automatically, but it's a real fidelity gap, not a bug.
- **SPA "meaningful navigation" detection is a heuristic**, not a guarantee: hash-only changes with an unchanged pathname/search and title are treated as noise. Sites with unusual routing may occasionally under- or over-capture.
- **Closing the last window on macOS and reopening via the dock icon works** (window is hidden, not destroyed) but there's no true multi-window support — only one `BrowserWindow` is ever created.
- **No packaged app icon** is included yet (`build/` is currently empty) — packaged builds use Electron's default icon.
- **No dependency-audit CI step** is wired up yet (`npm audit` is run manually); see roadmap. As of this build, `npm audit` reports 10 advisories (2 critical) — all of them transitive dependencies of **devDependencies only** (`@electron/rebuild`'s `tar`/`make-fetch-happen` chain, and `vitest`'s bundled `esbuild`/`vite`), used at install/build time and never bundled into the packaged app. None are in a runtime dependency (`better-sqlite3`, `react`, `zod`, `archiver`, `zustand`). Still worth fixing before this goes further — `npm audit fix --force` resolves them but pulls in breaking major-version bumps (`vitest@4`, `@electron/rebuild@4`) that weren't re-verified against this codebase in this pass.
- **Disk-full handling is checked before a capture starts** (a free-space floor via `fs.statfs`), not enforced mid-write via OS-level `ENOSPC` recovery — a capture that starts with enough headroom but hits a suddenly-full disk mid-write will fail that single capture (caught, logged, marked `failed`) rather than crash the app, but isn't retried.
- **Developed and functionally verified on macOS only.** `npm run dev`, `npm run build`, the full `npm test` suite (82 tests), and both `npm run package:mac` and `package:mac:dist` were actually run in this environment, including launching the packaged `.app` straight off the built `.dmg`. `npm run package:win:dist` was also run here (cross-packaged from macOS — see "Packaging") and produced a valid NSIS installer and portable `.exe`, but neither was *executed*, since no Windows machine was available in this environment. The Windows-specific code paths (accelerator strings, `%LOCALAPPDATA%`-style paths via `app.getPath`) use the same cross-platform Electron APIs exercised on macOS and are expected to work, but that's an expectation, not a verified fact, until someone runs the installer on real Windows.
- **`.sitearchive` crawling is sequential**, despite the concurrency setting being exposed and validated. Pages are rendered one at a time in a single hidden view; the setting is plumbed through to the scope but does not yet increase parallelism. Crawl delay and all the limits do take effect.
- **SPA routes that use the History API are captured as the single rendered state** they were in at capture time. Hash routes are captured the same way. The crawler discovers links from the rendered DOM, so JS-created `<a href>` links are followed, but routes reachable only by clicking a JS handler (no real href) are not.
- **Cross-origin frames are not archived**; only same-origin frames are captured. A cross-origin frame will be blank in the archive rather than showing a screenshot placeholder.
- **The "not captured" offline page signals its Open Live Version request via `document.title`**, because archived content deliberately has no IPC access. It works and is confirmed before anything opens, but it's a workaround rather than a clean channel.
- **Retry failed pages re-runs the whole capture** from the same starting point rather than resuming just the failures. This keeps the resulting archive internally consistent instead of stitching two partial crawls together, but it does redo work.
- **This is an MVP**: unsigned builds only, no auto-update, no accessibility audit performed.

## Roadmap (post-MVP, prioritized)

1. **Run the built Windows installer/portable exe on real Windows hardware** and fix whatever that surfaces — the build itself is produced and structurally valid (see Packaging), but has not been executed on Windows (untested in this environment — see Known Limitations).
2. **Permission-prompt UI** for the `ask` permission default (currently behaves as deny).
3. **Archive integrity hashing** (content hash recorded at capture time, verified on open) to detect tampering or bit rot.
4. **Packaged app icons** and proper `build/` resources for macOS/Windows.
5. **Code signing + notarization** for macOS, code signing for Windows, so builds can be distributed publicly without OS warnings.
6. **Auto-update** via `electron-updater`, pointed at a release channel once signed builds exist.
7. **Dependency audit in CI** (`npm audit` / `osv-scanner`) and a documented update cadence for Electron itself.
8. **Parallel crawling** for `.sitearchive` site captures (the concurrency setting is plumbed through but the crawl is currently sequential — see Known Limitations).
9. **Search inside a `.sitearchive`**, using the `index.sqlite` catalog and the per-page extracted text that already ship in the container.
10. **Resume-only retry** for failed pages, instead of re-running the whole capture.
11. **Full-text search ranking/snippets** in the Library (currently exact FTS5 match, no relevance snippet preview).
12. **True multi-window support.**
13. **Export/import of the whole library** (not just per-archive export), for migrating between machines.
14. **Accessibility pass** on the trusted UI (keyboard navigation, screen reader labeling).

---

Built incrementally: secure browser shell → automatic capture → offline library/viewer → settings/exclusions → recovery/storage management → tests/packaging → portable `.sitearchive` capture, offline site browsing, and the image screenshot fallback.
