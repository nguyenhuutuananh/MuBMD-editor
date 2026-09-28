# MuBMD-editor

A GUI tool (runs on `localhost`, Windows + macOS) for a team to translate the item names in
`Item.bmd` of the MuMain client (Mu Online season 6).

Team model: **each translator runs the tool on their own machine** (the server only listens on
`127.0.0.1`) and translations are exchanged as files (e.g. via Google Drive), then merged.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Item.bmd read/write core + byte-exact tests | Done |
| 2 | Server API + read-only grid (groups, filters) | Done |
| 3 | Inline editing, byte counter, validation, undo, save with backup | Done |
| 3b | UI moved to Vue 3 + shadcn-vue + i18n (English default, Vietnamese) | Done |
| 4 | TSV export/import, reference column, per-slot status, merging several translators' work | Done |
| 5 | Glossary, compare with another file, release packaging | Done (1.0.0) |

## Running

Requires Bun (server, tests, executables) and Node 20.19+ (Vite).

```
bun install
bun run dev              # dev: API server (4817) + Vite (5173, HMR), opens data/Item.bmd and the browser
bun run dev -- path/to/Item.bmd
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

Executable: `MuBMD-editor [path/to/Item.bmd] [--port 4817] [--no-open] [--version] [--help]`.
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
  (`{ code: "bmd-size", params: { size, expected } }`); the UI translates them. A new error code
  goes into `src/core/errors.ts` + both locale files.
- Game data (item names, `changes.tsv`) is never translated.
- Native open/save dialogs follow the UI language too.

## UI

**Browsing**
- Open a file with the native dialog, by pasting a path, or from "Recently opened".
- Left panel: the 16 ItemType groups, named slots / 512, translation progress bar, orange dot =
  number of unsaved changes.
- Accent-insensitive search (`rong do` → "Mũ Rồng Đỏ"), or by position `7:1`, `#3585`.
- Filters: named / all / empty slots; edited (unsaved), warnings, near the byte limit (≥ 40),
  not UTF-8, glossary mismatch; status.

**Editing**
- Enter, F2 or double-click edits the name in place. The byte counter updates while typing;
  over 49 bytes the field turns red and cannot be saved.
- Enter / Tab: save and go to the next row. Shift+Enter: previous row. Esc: cancel.
  Vietnamese IME composition (Telex/VNI, Unikey…) is respected: Enter while composing does not save.
- The first edit asks for a translator name (remembered in the browser), stored with every change.
- Undo/redo: Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z), ↶ ↷ buttons. Undo works after saving too.
- "Restore original name" in the detail panel.

**Saving** (Ctrl+S; "Save as…" = Ctrl+Shift+S)
- Before writing: back up the old file, re-verify checksum + every name, write to a temp file,
  then rename over the target.
- If the file on disk changed after it was opened (Google Drive sync, someone else saved…), a
  conflict is reported with the choice: save to another file / overwrite / cancel.
- If the game client holds the file, the error says so: close the game and save again.

**Draft:** every edit writes `draft.json`. After closing the console window / browser / a power
loss, reopening the file offers to restore it. Editing without answering archives the old draft
as `draft-<time>.json` instead of overwriting it.

## Team work (phase 4)

**Per-slot status:** Untranslated / Translated / Reviewed + note + last editor. Editing a name
sets it to "Translated". Change it in the detail panel, with Alt+1 / Alt+2 / Alt+3 on the list,
or in bulk: *Actions → Mark the N listed rows as…* (combine with filters/search). Status is saved
together with Item.bmd (Ctrl+S), is undoable and included in the draft.

**Reference file:** *Actions → Set reference file…* - another Item.bmd (e.g. the original), a TSV
(e.g. `item_names_MuHuyenThoai_JAPANESE.tsv`) or a CSV (e.g. `MuMain_VI_Item.csv`, its `Nguon`
column). Adds a "Reference" column; search also looks in it. Each browser remembers the
reference file per Item.bmd.

**TSV export / import** (*Actions → Export… / Import…*): columns `ItemType, ItemIndex, Name,
Status, Translator, UpdatedAt, BaseName, Reference, Note`, UTF-8 with BOM (opens directly in
Excel). Import also accepts old files with only `ItemType, ItemIndex, Name`, and CSV. An empty
name in an imported file **never** clears a name.

3-way merge based on the `BaseName` column (the name the other translator started from):

| Case | Result in the preview |
|---|---|
| Only they changed it | "Change", selected by default |
| Only we changed it | skipped (ours is newer) |
| Both changed it differently | "Conflict", keeps ours by default |
| Same name, different status | "Status", selected if theirs is further along |
| Name over 49 bytes / invalid | "Invalid", cannot be applied |
| File without BaseName | every different name is a "Change" (conflicts cannot be detected) |

A whole import is **one undo step**; afterwards the "Edited" filter is switched on for review
before saving.

**Suggested workflow (everyone runs the tool on their own machine):**
1. A coordinator keeps the master Item.bmd and shares it on Google Drive.
2. Each translator **copies Item.bmd** to their machine (the `.mubmd` folder is not needed),
   opens it, translates their assigned groups, saves.
3. Translator: *Export… → Slots I changed* → send the TSV to the coordinator.
4. Coordinator: *Import…* each file, resolve conflicts, save, then share the new Item.bmd.
5. Translators replace their Item.bmd with the new one. The tool notices the file was replaced
   from outside and resets the merge bases for the next round (with a notice).

## Glossary and compare (phase 5)

- *Actions → Glossary…*: open the team glossary - a TSV (`Term, Translation, Note, Category`;
  empty Translation = keep as-is) or the old `MuMain_VI_Glossary.csv` (`A -> B`, comma-separated
  keep lists; the old CSV is read-only, saving creates a new TSV). Terms can be added/removed in
  the tool. Each browser remembers one glossary file shared by every Item.bmd.
- Checks: a source term in the reference name whose agreed translation is missing from the
  name, a keep-as-is term that got translated, or a source word left inside the translated name
  (e.g. "Đồng Helm" when Helm → Mũ was agreed). Shown via the "Glossary mismatch" filter, the
  Notes column and the detail panel.
- *Actions → Compare with another Item.bmd…*: reuses the import preview, lists names that
  differ and lets you take names from the other file (empty names there never clear ours).
- Reference / import files may be CSV; `Nguon`/`Source` is the source-name column,
  `TiengViet` the name column.

## Download

Ready-to-run builds for Windows and macOS are on the repository's **Releases** page - no clone or
Bun needed. Download the zip for your platform, unzip, and read `USER-GUIDE.txt`
(`HUONG-DAN-SU-DUNG.txt` in Vietnamese).

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
   become pre-releases.

`.github/workflows/ci.yml` runs typecheck, unit tests and the e2e suite (real Chrome on the
runner) on every push to `main` and every pull request.

`bun run release` (or `bun run build`) creates one zip per platform containing the executable
+ `HUONG-DAN-SU-DUNG.txt` + `USER-GUIDE.txt` (sources in `docs/`, `{{VERSION}}` is replaced at
build time). The executables are not code-signed: Windows SmartScreen needs "Run anyway", macOS
needs `xattr -d com.apple.quarantine` the first time (see the guides).

### Side data next to the file

```
Item.bmd
Item.bmd.mubmd/
  backups/Item-20260928-111300.bmd      previous version before each save (newest 20 kept)
  backups/project-20260928-111300.json  previous project.json before each save
  changes.tsv                           log: Time, Translator, ItemType, ItemIndex, OldName, NewName
  project.json                          per-slot status / note / translator / merge base
  draft.json                            unsaved changes (names + status)
```

If `Item.bmd` sits in a shared Google Drive folder, the `.mubmd` folder (up to ~14 MB of
backups) is synced as well.

## Layout

```
src/core/     Item.bmd read/write, tsv.ts (TSV/CSV), merge.ts (3-way merge), glossary.ts, errors.ts
src/shared/   API types shared by server and UI
src/server/   app.ts (API), session.ts (edit/undo/draft/save), storage.ts (disk writes), filePicker.ts,
              main.ts (Bun.serve)
web/          Vue 3 UI (Vite, Tailwind 4, shadcn-vue, Pinia, vue-i18n)
  src/components/        AppTopbar, GroupSidebar, ItemToolbar, ItemGrid (virtual scroll), InlineEditor, DetailPanel, dialogs…
  src/components/ui/     shadcn-vue components (copied into the project, edit freely; add with `npx shadcn-vue add <name>` in web/)
  src/composables/actions.ts   user flows (open / edit / save + dialogs, toasts)
  src/stores/doc.ts      state of the open file (8192 rows in a shallowRef)
  src/lib/               api.ts, search.ts (accent-insensitive search, filters), dialogs.ts, storage.ts
  src/i18n/              setup + locales/en.json, vi.json
scripts/      dev.ts (server + Vite), build-web.ts (Vite build -> build/web/assets.ts for embedding), build-bin.ts
docs/         end-user guides (packed into the release zips)
tests/        bun test (core, server, session, search, glossary, locales); e2e/run.ts (real Chrome)
```

API: `GET /api/state`, `GET /api/items`; POST `/api/open {path, discard?}`, `/api/pick`,
`/api/pick-save`, `/api/edit {slot, name, translator}`, `/api/revert`, `/api/undo`, `/api/redo`,
`/api/status {slots, status}`, `/api/note`, `/api/reference {path|null}`, `/api/export {path, slots}`,
`/api/import/preview {path}` (TSV/CSV, or .bmd = compare), `/api/import/apply {path, token, take}`,
`/api/glossary/load {path}`, `/api/glossary/save {path, entries}`,
`/api/draft/restore`, `/api/draft/discard`, `/api/save {path?, force?}`.
The `MUBMD_FAKE_PICK` environment variable (e2e only) answers native file dialogs from a JSON file.
The server only accepts Host `localhost`/`127.0.0.1` (DNS-rebinding protection) and POSTs must be
JSON (other websites cannot send them silently).

## Item.bmd format (MuMain)

- 8192 records x 84 bytes (16 ItemType x 512 index) + 4-byte checksum = 688,132 bytes.
- The body is XOR-encoded with the repeating key `FC CF AB`; checksum `GenerateCheckSum2` with key `0xE2F1`.
- The name is the first 50 bytes of each record, UTF-8, 0x00-terminated → at most **49 bytes**
  (Vietnamese accented letters take 2-3 bytes each).

## Core (`src/core`)

- `format.ts` — constants, XOR, checksum, slot ↔ (ItemType, ItemIndex).
- `nameCodec.ts` — `checkName()` (NFC normalization, byte count, errors/warnings),
  `encodeName()`, `decodeName()`.
- `itemBmd.ts` — class `ItemBmd`: `parse()`, `entries()`, `setName()`, `toBytes()`.

Differences from `../tools/item_ts`:
- Names over 49 bytes are **rejected** (`NameValidationError`) instead of silently truncated.
- Only renamed slots are rewritten; an unedited file is written back byte-for-byte identical.
- Non-UTF-8 names (original Japanese/Korean data) are flagged `encoding: "unknown"`. Bun has
  no Shift_JIS/EUC-KR decoder, so the old tool's fallback branch never actually worked.

## Tests

```
bun run test         # unit tests (core, server, session, search, glossary, locales)
bun run test:e2e     # build the UI, then e2e in real Chrome on a copy of data/Item.bmd (EN and VI)
bun run typecheck    # tsc (server/core) + vue-tsc (UI)
```

Tests use `data/Item.bmd`; if `../tools/item_ts` + `../items.tsv` exist, TSV import results are
compared with the old tool (must be byte-identical, checksum included).

## Code conventions

Comments and logs in code are written in **English**. User-facing text lives in
`web/src/i18n/locales/*.json` (and the native dialog captions in `filePicker.ts`).
