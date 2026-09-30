# MuBMD-editor

A GUI tool (runs on `localhost`, Windows + macOS, or as a web page) for a team to translate the
item names of the MuMain client (Mu Online season 6) into Vietnamese.

Since MuMain 2026-09-25 (commit `757f312c`, "load items from JSON with translated names") the game
reads its items from `Data/Items/Group00_Sword.json` … `Group15_Etc.json`, each item with its names
by language (`"name": { "en": "Short Sword", "es": "…", "pt": "…" }`), and no longer reads
`Item.bmd`. Version 2 of this tool edits the `"vi"` name in those files. (Version 1.x edited
`Item.bmd`; to carry old translations over, export them to TSV with 1.x and import the TSV here.)

Team model: **each translator runs the tool on their own machine** (the server only listens on
`127.0.0.1`) and translations are exchanged as files (e.g. via Google Drive), then merged.

> **Built with AI.** This project (code, tests, and documentation) was written with an AI coding
> assistant ([Claude Code](https://claude.com/claude-code)), directed and reviewed by a human
> maintainer. It is covered by automated tests, but review it as you would any other code, and
> keep a backup of your game's `Data/Items` (the tool also backs up every file it rewrites).

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Item.bmd read/write core + byte-exact tests | Done |
| 2 | Server API + read-only grid (groups, filters) | Done |
| 3 | Inline editing, byte counter, validation, undo, save with backup | Done |
| 3b | UI moved to Vue 3 + shadcn-vue + i18n (English default, Vietnamese) | Done |
| 4 | TSV export/import, reference column, per-slot status, merging several translators' work | Done |
| 5 | Glossary, compare with another file, release packaging | Done (1.0.0) |
| Web | Static web version on GitHub Pages: in-browser editing, Firefox/Safari fallback, PWA | Done (1.1.0) |
| JSON | MuMain's new item data (`Data/Items/*.json`) instead of Item.bmd; pick the game folder, the item folder is found per OS layout | Done (2.0.0) |

## Running

Requires Bun (server, tests, executables) and Node 20.19+ (Vite).

```
bun install
bun run dev              # dev: API server (4817) + Vite (5173, HMR), opens data/game and the browser
                         # (no game data is committed: a sample game folder data/game is created if missing)
bun run dev -- path/to/game
bun run dev:web          # web build in development: Vite only (5174), the Session runs in the browser
                         # (open in Chrome or Edge, choose a game folder)
bun run start            # build the UI, then run like a release (one port, http://localhost:4817)
bun run release          # release zips into ./releases/ (inside this folder)
bun run build            # release zips into ./dist/
bun run build -- --out ../somewhere    # release zips into another folder
bun run build -- --only windows-x64    # one platform only (windows-x64 | macos-arm64 | macos-x64)
```

Each release build writes `MuBMD-editor-<version>-<platform>.zip` per platform plus
`SHA256SUMS.txt`.

**Why dev uses two ports:** Vite (5173) only serves the UI with hot reload and proxies `/api`
to the Bun server (4817), so in development the API runs on exactly the same runtime (Bun) as
in releases. Releases (`bun run start`, the executables) use **one port**.

Executable: `MuBMD-editor [path/to/game] [--port 4817] [--no-open] [--version] [--help]`.
If port 4817 is busy, the next free port is used.

**Note:** this folder lives on Google Drive. `releases/`, `dist/` (~80 MB of zips) and
`node_modules/` are synced to Drive if they stay here. Build elsewhere with `--out`, or exclude
those folders from syncing.

## UI language

- English is the default and is **always shown on first launch**; Vietnamese is picked with the
  language button (top right) and remembered in the browser.
- Locale files: `web/src/i18n/locales/en.json`, `vi.json`. `bun test` checks that both have the
  same keys, the same `{…}` placeholders, and a translation for every error code.
- The server/core never return sentences, only **error codes + params**
  (`{ code: "items-not-found", params: { folder } }`); the UI translates them. A new error code
  goes into `src/core/errors.ts` + both locale files.
- Game data (item names, `changes.tsv`) is never translated.
- Native open/save dialogs follow the UI language too.

## UI

**Opening: pick the game folder**
- Choose the **game folder** with the native folder dialog, paste its path, or use "Recently
  opened". The item data folder is found automatically (`src/session/itemsFolder.ts`):

  | Picked folder | Item data used | Badge |
  |---|---|---|
  | contains `Group00_Sword.json` … itself | that folder | Data/Items |
  | `Data` (has `Items/`) | `Data/Items` | Data folder |
  | a MuMain checkout (has `src/bin/Data/Items`) | `src/bin/Data/Items` (the source data; the build copies it next to Main, so a build output would be overwritten) | MuMain source |
  | Windows / Linux game folder | `Data/Items` (next to `Main.exe` / `Main`) | Windows / Linux build |
  | macOS game folder, or the `.app` itself | `<Any>.app/Contents/MacOS/Data/Items` (`Main.app` first) | macOS app |

  When a folder holds both a Windows/Linux and a macOS layout, the one of **this computer's OS**
  wins (desktop: `process.platform`; web: `navigator.userAgentData.platform` / `navigator.platform`).
  To edit the other one, pick its folder directly (e.g. the `.app` or `Data/Items`).
- Every `*.json` in the item folder is read, like MuMain does (the group comes from the file's
  `"group"` field). A file MuMain could not load either (bad JSON, missing group / number / name,
  the same item twice) is refused with its file name.
- Left panel: the 16 ItemType groups, items with a Vietnamese name / items, progress bar, orange
  dot = number of unsaved changes.
- Grid: Type, Index, Vietnamese name, length, status, **English name**, [reference], notes. Slots
  without an item are never listed (they cannot get a name: an item needs all its stats).
- Accent-insensitive search over the Vietnamese and the English name (`truong kiem` → "Trường
  Kiếm", `helm` → every helm), or by position `7:1`, `#3585`.
- Filters: all items / with a Vietnamese name / without; edited (unsaved), warnings, near the
  length limit (≥ 40), glossary mismatch; status.

**Editing**
- Enter, F2 or double-click edits the name in place (the English name is the placeholder). The
  counter shows characters as the game counts them (UTF-16 units, like `wchar_t` on Windows): the
  game shows at most 49 (`MAX_ITEM_NAME` 50 − 1), so over 49 the field turns red and cannot be
  saved (MuMain itself only warns and cuts the name). `||` is refused too (MuMain's language
  separator).
- An **empty name removes the translation** (the `"vi"` key); the game then shows the English name.
- Enter / Tab: save and go to the next row. Shift+Enter: previous row. Esc: cancel.
  Vietnamese IME composition (Telex/VNI, Unikey…) is respected: Enter while composing does not save.
- The first edit asks for a translator name (remembered in the browser), stored with every change.
- Undo/redo: Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z), ↶ ↷ buttons. Undo works after saving too.
- "Restore the saved name" in the detail panel.

**Saving** (Ctrl+S)
- Only the item files with renamed items are rewritten, and in them only the `"name"` value of
  those items, in the form MuMain's own writer uses (`"en"` first, then the other languages sorted
  by code, 2-space indent, raw UTF-8). Every other byte stays as it was, so a later save from
  MuMain's item editor gives the same file, and git diffs show only the names.
- Before writing: re-parse the new files and check every name, back up each file, write to a
  temp file, then rename over it.
- If an item file this save would replace (or `project.json`) changed on disk after it was opened
  (Google Drive sync, someone else saved, MuMain's item editor…), a conflict is reported: overwrite
  (the disk version is still backed up) or cancel. Changes to other item files are no conflict.
- If the game client holds a file, the error says so: close the game and save again.

**Draft:** every edit writes `draft.json`. After closing the console window / browser / a power
loss, reopening the folder offers to restore it. Editing without answering archives the old draft
as `draft-<time>.json` instead of overwriting it.

## Team work (phase 4)

**Per-slot status:** Untranslated / Translated / Reviewed + note + last editor. Editing a name
sets it to "Translated". Change it in the detail panel, with Alt+1 / Alt+2 / Alt+3 on the list,
or in bulk: *Actions → Mark the N listed rows as…* (combine with filters/search). Status is saved
together with the names (Ctrl+S) in `project.json`, is undoable and included in the draft.

**Reference:** the English name of each item is always shown and is what the glossary checks
against. *Actions → Set reference file…* adds names from a TSV (e.g.
`item_names_MuHuyenThoai_JAPANESE.tsv`) or a CSV (e.g. `MuMain_VI_Item.csv`, its `Nguon` column) in
a "Reference" column; search also looks in it. Each browser remembers the reference file per
game folder.

**TSV export / import** (*Actions → Export… / Import…*): columns `ItemType, ItemIndex, Name,
Status, Translator, UpdatedAt, BaseName, Reference, Note`, UTF-8 with BOM (opens directly in
Excel). `Reference` is the reference file's name, else the English name. Import also accepts old
files with only `ItemType, ItemIndex, Name` (e.g. a TSV exported by version 1.x from Item.bmd), and
CSV. An empty name in an imported file **never** clears a name; rows for slots without an item are
skipped.

3-way merge based on the `BaseName` column (the name the other translator started from):

| Case | Result in the preview |
|---|---|
| Only they changed it | "Change", selected by default |
| Only we changed it | skipped (ours is newer) |
| Both changed it differently | "Conflict", keeps ours by default |
| Same name, different status | "Status", selected if theirs is further along |
| Name over 49 characters / invalid | "Invalid", cannot be applied |
| File without BaseName | every different name is a "Change" (conflicts cannot be detected) |

A whole import is **one undo step**; afterwards the "Edited" filter is switched on for review
before saving.

**Suggested workflow (everyone runs the tool on their own machine):**
1. A coordinator keeps the master `Data/Items` (or a MuMain checkout, with git) and shares it.
2. Each translator **copies the item files** into their own game folder (`Items.mubmd` is not
   needed), opens the game folder, translates their assigned groups, saves.
3. Translator: *Export… → Slots I changed* → send the TSV to the coordinator.
4. Coordinator: *Import…* each file, resolve conflicts, save, then share the new item files.
5. Translators replace their item files with the new ones. The tool notices the names changed
   from outside and resets the merge bases for the next round (with a notice).

## Glossary and compare (phase 5)

- *Actions → Glossary…*: open the team glossary - a TSV (`Term, Translation, Note, Category`;
  empty Translation = keep as-is) or the old `MuMain_VI_Glossary.csv` (`A -> B`, comma-separated
  keep lists; the old CSV is read-only, saving creates a new TSV). Terms can be added/removed in
  the tool. Each browser remembers one glossary file shared by every game folder.
- Checks: a source term in the reference (else English) name whose agreed translation is missing
  from the name, a keep-as-is term that got translated, or a source word left inside the translated name
  (e.g. "Đồng Helm" when Helm → Mũ was agreed). Shown via the "Glossary mismatch" filter, the
  Notes column and the detail panel.
- *Actions → Compare with another game folder…*: reuses the import preview, lists Vietnamese
  names that differ and lets you take names from the other folder (items without a Vietnamese
  name there never clear ours).
- Reference / import files may be CSV; `Nguon`/`Source` is the source-name column,
  `TiengViet` the name column.

## Web version

**https://nguyenhuutuananh.github.io/MuBMD-editor/** - no download needed. The same UI runs as a
static web page (a PWA: installable, works offline): the editing Session runs in the browser and
edits files in place through the File System Access API (Chrome / Edge on a computer). Nothing is
uploaded anywhere.

- **Open:** choose the game folder (read + write permission); the item folder is found as on the
  desktop, and the side data - backups, change log, `project.json`, draft - is written next to it.
- **Recent folders** survive a reload: every granted folder/file is remembered in IndexedDB under a
  stable id that is part of its path (`/MU@3/Data/Items`, shown as `/MU/Data/Items`); the browser
  may ask for permission again.
- Export / import / reference / glossary use the browser's file dialogs; compare uses a folder
  dialog (read only).
- Closing the tab with unsaved changes asks first (the draft is kept anyway); opening the same
  folder in a second tab warns both tabs.
- **Firefox / Safari / Brave (no File System Access API) - fallback mode:** the game folder is
  chosen with a folder upload (`webkitdirectory`); only the item files are read (`*.json` directly
  in a folder named `Items`, or named like `Group00_Sword.json`), into a copy kept in the browser
  (IndexedDB, with all side data). Save downloads the rewritten file, or `Items.zip` when several
  were rewritten, to copy back into `Data/Items`; export / glossary save download too; other files
  are uploaded. "Recently opened" reopens the browser copy. Add `?fallback` to the URL to force
  this mode.
- **PWA:** installable from the browser's address bar; the service worker precaches the whole app
  so it opens offline. When a new version is deployed, a "new version ready - Reload" notice
  appears; the new version takes over only after Reload.
- Build: `bun run build:web-static` -> `build/web-static/` (relative paths: works under any sub-path
  or domain). `bun run preview:web` serves it locally (http://localhost:4173/).
- Development: `bun run dev:web`. Tests: `bun run test:e2e:web` answers the file dialogs with
  handles from OPFS (`window.__MUBMD_TEST_PICK__`), preferably on Playwright's Chrome for Testing
  (`bunx playwright-core install chromium`, same as CI). Chromium 153 crashes the browser when an
  OPFS folder handle is read back from IndexedDB after a reload, so `handleDb.ts` stores OPFS
  handles by path (the user's own folders/files are stored as handles as usual).
  `bun run test:e2e:pwa` builds the static site, serves it under `/MuBMD-editor/` and checks the
  manifest / installability, offline use and the update flow.
  `bun run test:e2e:fallback` runs the fallback mode on Chrome (`?fallback`) and on Playwright's
  Firefox and WebKit / Safari engine (`bunx playwright-core install firefox webkit`; each skipped
  if missing).

## Download

Use the [web version](https://nguyenhuutuananh.github.io/MuBMD-editor/), or get ready-to-run builds
for Windows and macOS from the repository's **Releases** page - no clone or Bun needed. Download the zip for your platform, unzip, and read `USER-GUIDE_en.txt`
(`USER-GUIDE_vi.txt` in Vietnamese).

## Release

**Publishing a version (GitHub Actions):**
1. Bump `"version"` in `package.json` (e.g. `1.0.1`), commit, push to `main` and wait for CI to pass.
2. Tag and push the tag - the tag must equal the version with a `v` prefix:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. `.github/workflows/release.yml` checks the tag against `package.json`, runs typecheck + tests,
   cross-compiles all platforms on Linux (`bun run release`) and publishes a GitHub Release with
   the zips + `SHA256SUMS.txt` and generated release notes. Tags with a `-` (e.g. `v1.1.0-beta.1`)
   become pre-releases. Then it builds the web version and deploys it to GitHub Pages, so the web
   and desktop builds always carry the same version.

**One-time setup for the web version:** repository *Settings -> Pages -> Build and deployment ->
Source: GitHub Actions*. Without it the "pages" job fails (the desktop release is still published).

`.github/workflows/ci.yml` runs typecheck, unit tests and the e2e suite (real Chrome on the
runner) on every push to `main` and every pull request.

`bun run release` (or `bun run build`) creates one zip per platform containing the executable
+ `USER-GUIDE_en.txt` + `USER-GUIDE_vi.txt` + `LICENSE.txt` (sources in `docs/`, `{{VERSION}}` is replaced at
build time). The executables are not code-signed: Windows SmartScreen needs "Run anyway", macOS
needs `xattr -d com.apple.quarantine` the first time (see the guides).

### Side data next to the item folder

```
Data/Items/Group00_Sword.json …
Data/Items.mubmd/                              (outside Data/Items, so the game never reads it)
  backups/Group00_Sword-20260928-111300.json   an item file before each save that rewrote it (newest 20 kept per file)
  backups/project-20260928-111300.json         previous project.json before each save
  changes.tsv                                  log: Time, Translator, ItemType, ItemIndex, OldName, NewName
  project.json                                 per-slot status / note / translator / merge base
  draft.json                                   unsaved changes (names + status)
```

In a MuMain checkout this is `src/bin/Data/Items.mubmd/` (add it to `.gitignore` there, or keep it
out of commits). If the game folder sits in a shared Google Drive folder, `Items.mubmd` is synced
as well.

## Layout

```
src/core/     itemData.ts + jsonText.ts (item files read/write), nameCodec.ts, tsv.ts (TSV/CSV), merge.ts (3-way merge),
              glossary.ts, sha1.ts, errors.ts
src/session/  runtime-neutral editing session: session.ts (edit/undo/draft/save, async, one call at a time),
              itemsFolder.ts (find Data/Items in the picked folder, per OS layout),
              sidecar.ts (backups, change log, project.json, draft), storage.ts (the Storage interface),
              memoryStorage.ts, glossaryFiles.ts - no Node APIs, so the web build can run it in the browser
src/shared/   API types shared by server and UI
src/server/   app.ts (HTTP API), nodeStorage.ts (Storage on real files), filePicker.ts, main.ts (Bun.serve)
web/src/lib/  backend.ts (Backend interface), httpBackend.ts (desktop), localBackend.ts + browserStorage.ts +
              handleDb.ts (web: Session in the browser on the File System Access API, granted handles in
              IndexedDB), idbStorage.ts + fileTransfer.ts + zip.ts (fallback: files in IndexedDB, folder upload,
              download), tabs.ts (same folder in two tabs); "@backend" is chosen by VITE_TARGET
web/          Vue 3 UI (Vite, Tailwind 4, shadcn-vue, Pinia, vue-i18n)
  src/components/        AppTopbar, GroupSidebar, ItemToolbar, ItemGrid (virtual scroll), InlineEditor, DetailPanel, dialogs…
  src/components/ui/     shadcn-vue components (copied into the project, edit freely; add with `npx shadcn-vue add <name>` in web/)
  src/composables/actions.ts   user flows (open / edit / save + dialogs, toasts)
  src/stores/doc.ts      state of the open game folder (8192 rows in a shallowRef)
  src/lib/               api.ts, search.ts (accent-insensitive search, filters), dialogs.ts, storage.ts
  src/i18n/              setup + locales/en.json, vi.json
scripts/      dev.ts (server + Vite), build-web.ts (Vite build -> build/web/assets.ts for embedding), build-bin.ts
docs/         end-user guides (packed into the release zips)
tests/        bun test (core, server, session, search, glossary, locales); e2e/run.ts (real Chrome)
```

API: `GET /api/state`, `GET /api/items`; POST `/api/open {path (game folder), discard?}`,
`/api/pick {kind: game|compare|tsv|reference|glossary}`, `/api/pick-save {kind: tsv|glossary}`, `/api/edit {slot, name, translator}`, `/api/revert`, `/api/undo`, `/api/redo`,
`/api/status {slots, status}`, `/api/note`, `/api/reference {path|null}`, `/api/export {path, slots}`,
`/api/import/preview {path, source: tsv|game}` (game = compare with another game folder),
`/api/import/apply {path, token, take, source}`,
`/api/glossary/load {path}`, `/api/glossary/save {path, entries}`,
`/api/draft/restore`, `/api/draft/discard`, `/api/save {force?}`.
The `MUBMD_FAKE_PICK` environment variable (e2e only) answers native file dialogs from a JSON file.
The server only accepts Host `localhost`/`127.0.0.1` (DNS-rebinding protection) and POSTs must be
JSON (other websites cannot send them silently).

## Item data format (MuMain `Data/Items`)

- One file per group (`GetItemGroupFileName`: `Group00_Sword.json` … `Group15_Etc.json`), but MuMain
  reads every `*.json` of the folder; `{"formatVersion": 1, "group": 0, "items": [ … ]}`.
- Each item: `"number"` (0–511) and `"name"` - an object of `"<locale>": "<name>"` (English
  required) or a plain text (= English only), plus stats with defaults left out.
- slot = group × 512 + number (the game's item type), 16 × 512 = 8192 slots.
- The game shows the name in the UI locale and falls back to English. Names must not contain `||`
  and are cut after 49 wide characters (`MAX_ITEM_NAME` 50).
- MuMain writes the files with nlohmann::json `dump(2)` (raw UTF-8, `"tags"` lists on one line,
  `"\n"` at the end) and the names as `"en"` first, then the translations sorted by locale.

## Core (`src/core`)

- `format.ts` — slot ↔ (ItemType, ItemIndex).
- `jsonText.ts` — a JSON parser that keeps the position of every value, and nlohmann-style string
  escaping.
- `itemData.ts` — class `ItemData`: `parse(files)`, `getName()`, `english()`, `setName()`,
  `changedFiles()` (only the edited names rewritten; an unedited folder writes back byte-for-byte).
- `nameCodec.ts` — `checkName()` (NFC normalization, length in UTF-16 units, errors/warnings).

## Tests

```
bun run test         # unit tests (core, server, session, search, glossary, locales)
bun run test:e2e     # desktop build: e2e in real Chrome on a copy of the sample game folder (EN and VI)
bun run test:e2e:web # web build: e2e in real Chrome; the browser's private file system (OPFS) stands in
                     # for the folder the user picks (a macOS and a Windows layout)
bun run typecheck    # tsc (server/core) + vue-tsc (UI)
```

No game data is committed. Tests build a **sample game folder** (`tests/fixtures/sampleItems.ts`):
one item per row of `tests/fixtures/item-names.tsv` (the Vietnamese name for even ItemIndex values,
synthetic English / es / pt names, fake stats), written exactly like MuMain writes its files, so
"adding a name gives what MuMain would write" is checked byte for byte. With
`MUMAIN_DIR=/path/to/MuMain bun test` the real `src/bin/Data/Items` of a checkout is read and
round-tripped too.

## Code conventions

Comments and logs in code are written in **English**. User-facing text lives in
`web/src/i18n/locales/*.json` (and the native dialog captions in `filePicker.ts`).

## License

[MIT](LICENSE) © 2026 Tuan Anh Nguyen. The license covers this tool's source code only, not
game data: item files are not part of this repository.
