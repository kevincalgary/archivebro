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

**Removing the limits.** In Custom scope, leaving a limit field blank means *no limit*, and a **Remove all limits** button clears all three at once. Unlimited captures require ticking the confirmation, because on a large site they can run a long time and produce a very large file. Two things still hold regardless: **Pause and Cancel work throughout**, and a **free-disk-space floor (500 MB) is enforced and cannot be bypassed** — the capture stops itself and records the reason rather than filling your drive. Finite values are still clamped to sane ceilings (depth 25, 50,000 pages, 64 GB) so a typo can't become an accidental multi-day crawl; only an explicitly blank field is truly unbounded. Request concurrency is never bypassable, since that limit protects the site being captured rather than your disk.

Anything beyond the recommended limits requires an explicit confirmation before it will start. During capture you get a live progress bar, an elapsed clock, and pages-discovered / pages-saved / current-URL / downloaded-size / warning / failure counts, plus **Pause** and **Cancel**.

### Which pages a budgeted crawl spends itself on

A page limit forces a choice about *which* pages get captured, and the obvious answer is wrong. A plain FIFO queue makes the crawl strictly breadth-first, which sounds even-handed but lets a single link-dense page own the entire budget.

This was reported against a real forum and it is severe. `rangerovers.net`'s front page yields **86 in-scope links** — 37 forum sections, 21 member profiles, 22 utility pages (`/login`, `/register`, `/search`, …) and only 5 threads. Threads otherwise live one level below, inside section pages. Breadth-first with the default 50-page budget therefore captured section and navigation pages until the budget ran out and archived **zero threads** — the entire reason someone captures a forum.

Two changes fix that, neither of them site-specific:

- **The frontier is rotated across the page that discovered each link** ([crawlFrontier.ts](src/main/sitearchive/crawlFrontier.ts)), taking one item per discovering page per turn instead of draining an entire level first. As soon as a section page is captured, the threads it found interleave with the sections still queued. Order within one page's links stays document order. On the forum fixture this takes a 25-page capture from 0 threads to 9.
- **Account, search and navigation routes are skipped** (`looksNonContent()`), because they are not archivable content and every one captured is a thread not captured. Each skip is recorded as a `skipped-non-content` failure so it is visible in the archive rather than silent.

**A single page cannot stall the crawl.** Navigation has a timeout and each resource fetch has one, but the capture phases had no collective limit — so one pathological page could hold a crawl open indefinitely. Measured on a real forum photo thread (116 images, 27 dead third-party image hosts, heavy ad tags): **over 15 minutes on one page without finishing.** Each page now gets a two-minute wall-clock budget; when it runs out, remaining resource fetches and per-element image fallbacks are abandoned, the shortfall is recorded as a warning, and the durable fallbacks (full-page screenshot and extracted text) are still captured. Per-phase timings are logged for every page, including pages that fail or blow the budget — which is exactly when they matter.

**Skips are recorded once per URL, not once per link.** A "Log in" link in a site's global navigation is seen on every page crawled, and skips are decided before the enqueue dedupe — so without a guard of their own each records an identical failure entry per page, burying real failures. Skip kinds also get a per-kind ceiling (500) below the manifest's global 5,000, so they can never crowd genuine fetch failures out of the list.

**Hitting a limit is now recorded in the archive**, as a `stopped-at-limit` failure naming how many discovered pages were left uncaptured. Previously a budget-truncated capture was indistinguishable from a complete one, which is exactly how a forum capture that reached no threads still looked like a success.

The bar is measured against *pages discovered so far*, which is the only honest denominator mid-crawl — the true total isn't knowable up front, and finding new links legitimately makes the bar recede. While the archive is being zipped there's no countable unit, so that phase shows an indeterminate bar rather than a fabricated percentage. On completion you get the saved location, page and asset counts, final file size, a list of anything that failed, and **Open Archive** / **Reveal in Finder** (or **Show in File Explorer**) / **Retry failed pages**.

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

### Surviving an interrupted capture

Writing the archive only at the end is what makes a half-written file impossible — but on its own it also means a crawl that dies at minute 150 produces *nothing*, which is exactly what happened to a 151-minute, 810-page, 2.6 GB capture of `landrover.ca`.

Every captured byte was already on disk in the staging tree. What died with the process was the bookkeeping held in memory: which pages exist, which assets dedupe to which hash, the route map, and the crawl queue. So that bookkeeping is now journalled to disk as it is produced ([captureJournal.ts](src/main/sitearchive/captureJournal.ts)) — an append-only `checkpoint.jsonl` beside the staged files, plus a small metadata sidecar recording the start URL, scope and chosen output path.

The ordering rule the design rests on: **bytes are written to the staging tree first, and the journal record is appended only after that succeeds.** A crash can leave a file the journal never mentions, which is harmless because the manifest is the authority and unlisted entries are ignored — but never a journal record naming a file that isn't there. Records are `await`ed rather than buffered, since buffered writes lost to a kill would be precisely the ones describing the most recent work. Replay tolerates a truncated final line, which is what a process killed mid-append leaves behind.

An interrupted capture can then be:

- **finished as it stands** (`finalizeRecoveredCapture()`) — a valid, checksum-consistent `.sitearchive` holding the pages that were captured, with a failure entry recording that it stopped early so it can never pass as complete; or
- **resumed** (`CaptureManager.resumeInterrupted()`) — the crawl continues from the pending queue, re-capturing nothing. A resumed run keeps the original archive id, because that id is baked into the `archive-site://<archiveId>` URLs already serialized into every page captured before the interruption; or
- **discarded** (`discardRecoveredCapture()`) — the staging tree and everything captured in it are deleted for good.

A capture that *fails* (as opposed to being cancelled) now keeps its staging tree rather than deleting it, since that tree is recoverable work. Cancelling still discards everything, because the user asked for that.

**Surfaced in the UI as a startup prompt.** Once per launch, before any tab is created, the trusted window checks for recoverable captures (`captureRecovery:list`) and — if any exist — shows a dialog naming each one (start URL, pages captured so far, failures, bytes on disk, where it will be saved) with Resume / Finish / Discard actions. Finish only appears when at least one page was captured (finishing an empty crawl would produce an archive `openSiteArchive` itself refuses to open); Discard asks for confirmation inline before it removes anything. Resume and Finish both reuse the exact main-process functions above — the dialog is a thin display and confirmation layer, not a second implementation of the recovery logic — and Resume's progress is reported through the same live-progress channel and dialog an ordinary capture uses, so a resumed crawl looks and behaves like any other. Dismissing the prompt ("Not now") leaves the capture exactly as it was; since nothing was resolved, it is offered again the next time the app starts. Each staging directory also carries a pid lock while its journal is open, so a capture actually running right now — in this instance or another one sharing the OS temp directory — is never offered as recoverable in the first place, and Resume/Finish/Discard all refuse it defensively even if the UI's list happens to be stale.

Staging directories are also swept on startup (`sweepSiteArchiveStaging()`). A cancelled or failed capture cleans up after itself, but a *killed* process never runs its cleanup, and the staging tree for a large crawl is gigabytes — six such directories totalling 3.8 GB were found left behind by real runs. The sweep skips any directory written to within the last hour, judged by the mtimes of its subdirectories rather than the parent, so it can never delete the staging tree of a capture that is still running in another instance. It also spares checkpointed trees for a full week, so the fix for leaked staging directories can never quietly delete a crawl that died overnight and is still recoverable.

Double-clicking a `.sitearchive` opens it in Archive Browser on both macOS and Windows 11 (registered via `fileAssociations` in [electron-builder.yml](electron-builder.yml); delivered by the `open-file` event on macOS and via argv/`second-instance` on Windows).

### Per-page memory telemetry

A 151-minute unlimited capture once died mid-run with no crash report and nothing logged for the whole run (see Known Limitations) — diagnosing that after the fact meant manually estimating the archive builder's in-memory bookkeeping, which turned out not to be the cause. [`memoryTelemetry.ts`](src/main/capture/memoryTelemetry.ts) exists so the *next* long crawl leaves an actual trend behind it instead of requiring that again.

Every page's existing `sitearchive.page_timings` log line now also carries `mainRssBytes`/`mainHeapUsedBytes` (the main process, where the builder's bookkeeping lives) and `rendererBytes`/`rendererPeakBytes` (the crawling `WebContentsView`, matched by OS pid via `app.getAppMetrics()` — a separate process from Electron's point of view, and the untested suspect). This adds fields to a line that was already logged once per page; it doesn't add new log volume on its own. `recycleView()`'s existing `sitearchive.recycling_view` line gets the same renderer reading taken immediately before the view is torn down, which is the first actual measurement of whether recycling reclaims the memory its own docstring says it does. The pid-matching logic (`findRendererMemory`) is pure and unit-tested; the sampling itself needs a real multi-process Electron app and is exercised implicitly by every e2e capture test.

This is telemetry, not a fix — the 151-minute crash has not recurred or been reproduced in this environment, so whether the renderer process is actually the culprit is still an open question the next long run's logs can now answer.

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

**Cross-origin frames** can't be read or safely archived, so rather than leaving a mysterious blank box (or an `<iframe>` still pointing at the live web), they're replaced with a marked placeholder naming the host the content came from. No `<iframe>` in an archived page ever points at a network address; the original URL survives only as an inert provenance attribute.

**Very tall pages** are screenshotted from the top down to 12,000 CSS pixels, and scaled down beyond that if the rasterized bitmap would still be too large. Real marketing pages are frequently 20,000–40,000px tall and Chromium simply refuses to rasterize a bitmap that size — a truncated screenshot is far more useful than the silent failure that produced no screenshot at all, and the extracted text still covers the whole page.

The capture budget is expressed in **device** pixels, not CSS pixels, because that is what Chromium actually allocates: a page is rasterized at the display's device pixel ratio, so on an ordinary 2× display a CSS-pixel budget silently permits four times as much memory as it names. Two limits apply to the rasterized bitmap — 16,000px in either dimension (Chromium's own texture ceiling is 16,384, past which the capture fails outright) and 32 million pixels in total, roughly 128 MB as a raw bitmap. The page is scaled to fit both. `fitCaptureToBudget()` is pure and unit-tested across the full range of page shapes and display ratios.

If the full-page capture fails anyway, a viewport screenshot is used so there is always *some* visual record — but the downgrade is **reported**, never silent: the Library records a `screenshot-viewport-only` warning on the archive, a site capture counts it as a warning on that page, and a run of consecutive downgrades during a crawl rebuilds the crawling view and is logged. An archive full of viewport crops that claims to hold full-page screenshots is a data-quality problem, not a cosmetic one.

**Never** saved: password-field contents, authentication headers, cookies, session tokens, API keys, payment or autofill data, sensitive hidden fields (CSRF tokens), private keys, or DRM-protected media. Fields whose name/id/autocomplete look credential-shaped are cleared as well, and credential-shaped URLs and content types are skipped outright. The crawl renders pages using your existing logged-in session so authenticated pages look right — but only the rendered output is stored, so a shared archive never carries reusable credentials. This is verified by a test that greps the entire container for the fixture's password and CSRF values.

### Image screenshot fallback

Normal downloading is always attempted first and always preferred, because it preserves the original file, resolution, animation, and vector properties. When an image *cannot* be stored normally — a cross-origin image that can't be downloaded, a `blob:` URL, a canvas whose pixels can't be serialized, a dynamically generated or blocked image — Archive Browser preserves what you actually saw by taking a **tightly cropped screenshot of the rendered element**.

The crop comes from the element's own `getBoundingClientRect()` scaled by the device pixel ratio, so it already accounts for CSS transforms, zoom, `object-fit`/`object-position`, cropping, and clipping, and it captures **only** the element's box — never surrounding text, account details, or form fields. The element is scrolled into view, layout and fonts are allowed to settle, and **your original scroll position is restored afterwards**.

A screenshot is *not* saved when the area is blank or fully transparent (checked by actually decoding the pixels via Electron's `nativeImage`, not by guessing from file size), when the element has zero size or was never rendered, when it's a tracking pixel (≤3px), or when it's a broken-image placeholder icon. In those cases the page shows a clearly styled **"Image unavailable in this archive"** placeholder instead. Any surrounding hyperlink is preserved either way.

Each screenshot-derived asset records its original URL (when known), page URL, element type, rendered and screenshot dimensions, capture timestamp, the reason normal saving failed, its content hash, and an explicit `isRenderedScreenshot` flag — so an archive never passes a screenshot off as the original file. These assets are deduplicated by content hash like any other.

Screenshot-derived images only preserve appearance at the displayed resolution. They do not retain original resolution, animation, embedded metadata, vector properties, transparency composited against the page, or hidden/offscreen portions of a cropped image.

### What can't be preserved

Perfect offline reproduction is not possible for every website, and the app doesn't claim it. Live search results, server-side forms, real-time feeds, multiplayer/collaborative features, live chat, continuously changing APIs, protected streaming media, DRM content, CAPTCHAs, payment flows, and anything requiring an active server session will not work in an archive. What an archive preserves is the content and navigation available at capture time. The full-page screenshot and extracted text remain available as durable fallbacks for every captured page.

## Progress feedback

Every operation that can take longer than a moment shows motion, so slow work never looks frozen:

| Operation | Feedback |
|---|---|
| Page loading in a tab | Spinner in the tab |
| Automatic background archiving | Toolbar indicator that pulses while pending, pulses faster while writing, pops once on success |
| Site capture | Determinate progress bar + elapsed clock + live counts + spinner on the current URL; indeterminate bar while zipping; full green bar when finished |
| Capture button while busy | Inline spinner, kept fully legible rather than dimmed out |
| Opening a `.sitearchive` | Full-surface busy overlay (it reads and checksum-verifies entries first) |
| Library search | Spinner; previous results stay visible so the grid doesn't blank on each keystroke |
| Archive details / Settings | Loading panel instead of an empty screen |
| Exporting an archive | Spinner on the button while zipping |

Two rules these follow: **never fake a percentage** — if the total isn't knowable, the bar is indeterminate; and **respect `prefers-reduced-motion`** — with that OS setting on, spinners and sweeps stop animating but every bar, count and label stays fully visible, so no information is lost, only the motion.

### Permissions

Websites get nothing by default. Each capability (notifications, geolocation, camera, microphone, MIDI, clipboard-read, display-capture) has a setting of **Deny**, **Allow**, or **Ask**; anything not on that list — USB, serial, HID, window-management — is refused outright with no way to enable it.

**Ask** shows a prompt naming the capability in plain language and the requesting origin (origin only, never a full URL, so a prompt can't leak a path). "Remember this choice" turns the answer into a standing default. There is no path where silence grants anything: an unanswered prompt auto-denies after two minutes, and if no window can display a prompt the request is denied rather than queued.

The pending-request registry lives in the main process with server-generated ids, and the only way to resolve one is the validated `permission:respond` channel from the trusted window. An unknown, stale, or already-used id is ignored, so a reply can't be forged or replayed to grant something that was never asked for.

### A note on dialogs and native views

Tab content is a native `WebContentsView` that the OS composites **on top of** this window's HTML. Any HTML dialog would therefore be painted *underneath* the live web page and be completely invisible, even though it is present and "visible" in the DOM. The app collapses the tab view to zero size whenever a modal is open ([App.tsx](src/renderer/App.tsx) `modalOpen`), which is what actually puts dialogs on screen.

This is worth knowing because DOM-level tests cannot catch a regression here — Playwright's `toBeVisible()` and `page.screenshot()` both ignore native-view occlusion. [tests/e2e/dialog-visibility.spec.ts](tests/e2e/dialog-visibility.spec.ts) asserts against the tab view's real bounds instead, and was confirmed to fail against the buggy version.

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
                        captureJournal.ts (crash-recovery checkpoint + replay),
                        crawlFrontier.ts (crawl queue ordering, Electron-free),
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
                                          a forum-shaped section (index -> sections -> threads,
                                          plus member/utility routes) for crawl-ordering tests,
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

Tests run against local fixture websites ([fixtures/](fixtures/)) rather than the real internet, so nothing depends on a third-party site being up.

As of this build: **164 unit tests** and **104 end-to-end tests**, all passing.

**Unit** (`tests/unit`, pure logic): URL resolution/validation and normalization, tracking-parameter stripping, same-origin scope checks, destructive-link and crawler-trap heuristics, atomic writes, path/ID validation, the IPC zod schemas, the SQLite catalog including FTS search and versioning, disk-space checks, settings persistence, domain-exclusion matching, the `.sitearchive` container round-trip, and its rejection of malformed and malicious archives (traversal in every form, zip bombs, bad manifests, checksum mismatches, future format versions).

**End-to-end** (`tests/e2e`, driving the real built app): normal navigation, redirects, SPA routes with debouncing, dynamic content, lazy images, broken resources, multiple tabs, back/forward, `window.open()` popups, capture versioning, domain exclusions, pausing archiving, private browsing, offline viewing, archive deletion, invalid/unsafe address-bar input, restart recovery, the interrupted-capture recovery dialog (detection, Finish, Resume, cancelling and confirming a Discard, a capture with nothing yet to finish, a capture still running elsewhere, and relaunch behavior) — plus, for `.sitearchive`: current-page and whole-site capture, relative/absolute/nested links, redirects, cross-origin links never followed, GET-only enforcement, destructive links skipped, recursive loops terminating, depth/page/size limits, asset deduplication, missing resources, lazy-loaded content, JS-generated links, SPA routes, cancelled captures leaving no file or temp data, pause/resume, progress reporting, offline rendering with the server stopped, route-map resolution, checksum-verified asset serving, back/forward inside an archive, corrupt and traversal-crafted archives refused, the full capture UI flow, every image-fallback case (normal download preferred, canvas, blob URL, broken image, tracking pixel, wrapping link preserved, provenance metadata, deduplication, scroll restoration, private-content exclusion, offline display); permission prompting (shown for `ask`, never for `deny`, remembered choices, and that the prompt isn't hidden behind the page); the diagnostic-logging toggle; cross-origin frame placeholders; and that every captured page really does contain a decodable screenshot and extracted text.

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

- **No archive integrity verification on read.** Files aren't hashed at capture time, so on-disk tampering between capture and viewing isn't detected.
- **MHTML rendering fidelity varies by site.** Pages relying on service workers, streamed media, or heavy runtime JS state may render imperfectly or fail entirely in the offline viewer; the screenshot/text fallback covers this case automatically, but it's a real fidelity gap, not a bug.
- **SPA "meaningful navigation" detection is a heuristic**, not a guarantee: hash-only changes with an unchanged pathname/search and title are treated as noise. Sites with unusual routing may occasionally under- or over-capture.
- **Closing the last window on macOS and reopening via the dock icon works** (window is hidden, not destroyed) but there's no true multi-window support — only one `BrowserWindow` is ever created.
- **No packaged app icon** is included yet (`build/` is currently empty) — packaged builds use Electron's default icon.
- **No dependency-audit CI step** is wired up yet (`npm audit` is run manually); see roadmap. As of this build, `npm audit` reports 10 advisories (2 critical) — all of them transitive dependencies of **devDependencies only** (`@electron/rebuild`'s `tar`/`make-fetch-happen` chain, and `vitest`'s bundled `esbuild`/`vite`), used at install/build time and never bundled into the packaged app. None are in a runtime dependency (`better-sqlite3`, `react`, `zod`, `archiver`, `zustand`). Still worth fixing before this goes further — `npm audit fix --force` resolves them but pulls in breaking major-version bumps (`vitest@4`, `@electron/rebuild@4`) that weren't re-verified against this codebase in this pass.
- **Disk-full handling is checked before a capture starts** (a free-space floor via `fs.statfs`), not enforced mid-write via OS-level `ENOSPC` recovery — a capture that starts with enough headroom but hits a suddenly-full disk mid-write will fail that single capture (caught, logged, marked `failed`) rather than crash the app, but isn't retried.
- **Developed and functionally verified on macOS only.** `npm run dev`, `npm run build`, the full `npm test` suite (289 tests: 180 unit + 109 e2e), and both `npm run package:mac` and `package:mac:dist` were actually run in this environment, including launching the packaged `.app` straight off the built `.dmg`. `npm run package:win:dist` was also run here (cross-packaged from macOS — see "Packaging") and produced a valid NSIS installer and portable `.exe`, but neither was *executed*, since no Windows machine was available in this environment. The Windows-specific code paths (accelerator strings, `%LOCALAPPDATA%`-style paths via `app.getPath`) use the same cross-platform Electron APIs exercised on macOS and are expected to work, but that's an expectation, not a verified fact, until someone runs the installer on real Windows.
- **`.sitearchive` pages are crawled one at a time**, despite the concurrency setting being exposed and validated — it's plumbed through to the scope but doesn't yet render pages in parallel. Crawl delay and all the limits do take effect. *Within* a page, subresources are fetched with a bounded parallel pool (8 at a time), which is what makes real sites practical: on landrover.ca that's roughly 7s per page instead of ~50s.
- **SPA routes that use the History API are captured as the single rendered state** they were in at capture time. Hash routes are captured the same way. The crawler discovers links from the rendered DOM, so JS-created `<a href>` links are followed, but routes reachable only by clicking a JS handler (no real href) are not.
- **The "not captured" offline page signals its Open Live Version request via `document.title`**, because archived content deliberately has no IPC access. It works and is confirmed before anything opens, but it's a workaround rather than a clean channel.
- **Retry failed pages re-runs the whole capture** from the same starting point rather than resuming just the failures. This keeps the resulting archive internally consistent instead of stitching two partial crawls together, but it does redo work.
- **A very long unlimited capture can still die mid-run, and the cause is not yet identified.** A full unlimited capture of `landrover.ca` ran 151 minutes, saved 810 pages and 2,818 deduplicated assets (2.6 GB staged, 6.8 GB downloaded before dedup), then the Electron process died with no output file. No crash report was produced and the app logged nothing for the whole run, so the mechanism is still unknown. Two things were ruled out by measurement: **disk space** (1.5 TB free) and **the archive builder's in-memory metadata** — `pages`, `assets`, `routes`, `queuedOrDone` and `failures` together hold ~26 MB at that scale, so spilling them into `index.sqlite` would not have helped. The screenshot budget fix above removes one plausible contributor (bitmaps of up to 41.4 megapixels, ~166 MB raw, were being requested against a cap that named 20 million) but is **not** demonstrated to be the cause. Per-page memory telemetry now exists (see "Per-page memory telemetry" above) so the next occurrence has a trend to look at, but the crash has not recurred or been reproduced in this environment, so the mechanism is still genuinely unknown.
- **Full-page screenshots degraded badly on that same run** — 693 of 810 pages fell back to a viewport crop, and after page 346 every remaining page did, 464 in a row with no recovery. The downgrade is now reported and a run of them rebuilds the crawling view, but *why* the renderer stopped being able to produce full-page captures, and never recovered across view recycles, is still unexplained.
- **Non-content routes are skipped with no way to opt back in.** Sign-in, registration, search, member profiles and "new thread" routes are excluded from crawls (see "Which pages a budgeted crawl spends itself on"). The heuristic is deliberately narrow and every skip is recorded in the archive, but a site whose real content genuinely lives under, say, `/members/` cannot currently override it — Custom scope has no per-path allowlist.
- **Very large forums cannot be captured whole.** Discovery stops at 50,000 URLs and one archive is capped at 64 GB. A mid-sized vBulletin/XenForo forum (rangerovers.net: 114,229 threads, 917,167 posts) needs roughly 52,000 pages and, at measured rates, far more space and time than either ceiling allows. Capturing individual sections or threads works; capturing a whole forum of that size does not.
- **Images hotlinked to dead third-party hosts cannot be recovered.** Old forum posts overwhelmingly embed images from Photobucket, Flickr and similar, most of which stopped serving years ago. On one sampled photo thread, 60 of 116 images were already broken on the live site. Those become an explicit "Image unavailable in this archive" placeholder — the archive is honest about them, but the pictures are gone from the web, not merely un-archived.
- **Crawl ordering is fair, not smart.** Rotating the frontier across discovering pages stops any one page monopolising the budget, but it does not rank pages by how interesting they are. A budgeted capture gets a spread across the site's structure rather than the "best" pages, because the tool has no basis for judging which those are.
- **This is an MVP**: unsigned builds only, no auto-update, no accessibility audit performed.

## Roadmap (post-MVP, prioritized)

~~A UI for recovering an interrupted capture~~ — **done.** See "Surviving an interrupted capture" above: a startup dialog offers Finish / Resume / Discard for every recoverable capture, backed by the same checkpoint/resume machinery, and tested end-to-end (`tests/e2e/recovery-ui.spec.ts`) including detection, each action, cancelling a discard, a capture with nothing to finish, a capture still running elsewhere, and relaunch behavior (an unresolved prompt reappears; a resolved one doesn't).

~~Per-page memory telemetry over a long crawl~~ — **instrumentation done, mystery still open.** See "Per-page memory telemetry" above: every page now logs main-process and crawling-renderer memory, and view recycling logs the renderer's reading right before tearing it down. What killed the original 151-minute crawl has *not* been identified — the crash hasn't recurred or been reproduced in this environment — but the next occurrence will have an actual trend to look at instead of nothing.

1. **Run the built Windows installer/portable exe on real Windows hardware** and fix whatever that surfaces — the build itself is produced and structurally valid (see Packaging), but has not been executed on Windows (untested in this environment — see Known Limitations).
2. **Archive integrity hashing** (content hash recorded at capture time, verified on open) to detect tampering or bit rot.
3. **Packaged app icons** and proper `build/` resources for macOS/Windows.
4. **Code signing + notarization** for macOS, code signing for Windows, so builds can be distributed publicly without OS warnings.
5. **Auto-update** via `electron-updater`, pointed at a release channel once signed builds exist.
6. **Dependency audit in CI** (`npm audit` / `osv-scanner`) and a documented update cadence for Electron itself.
7. **Parallel crawling** for `.sitearchive` site captures (the concurrency setting is plumbed through but the crawl is currently sequential — see Known Limitations).
8. **Search inside a `.sitearchive`**, using the `index.sqlite` catalog and the per-page extracted text that already ship in the container.
9. **Resume-only retry** for failed pages, instead of re-running the whole capture.
10. **Full-text search ranking/snippets** in the Library (currently exact FTS5 match, no relevance snippet preview).
11. **True multi-window support.**
12. **Export/import of the whole library** (not just per-archive export), for migrating between machines.
13. **Accessibility pass** on the trusted UI (keyboard navigation, screen reader labeling).

---

Built incrementally: secure browser shell → automatic capture → offline library/viewer → settings/exclusions → recovery/storage management → tests/packaging → portable `.sitearchive` capture, offline site browsing, and the image screenshot fallback.
