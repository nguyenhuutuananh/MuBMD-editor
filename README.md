# MuMain-translator

One tool for a team to translate everything the [MuMain](https://github.com/sven-n/MuMain) client
shows. It replaces MuResx-editor (the string tables) and MuBMD-editor (the item names), and carries
their working data over. This repository was MuBMD-editor (up to v1.1.1): its history is kept here.

| Source | Files | Used by the game |
|---|---|---|
| UI strings (`resx`) | `src/Localization/<Group>.<locale>.resx` (Game, Dialog, Editor, Metadata) | compiled into the client by MuMain's build (ResxGen): rebuild to see a change |
| Item names (`items`) | `Data/Items/GroupNN_<Name>.json`, `"name": { "en": …, "<locale>": … }` | read at start: restart the game |

Both use the same locale codes (`I18N::GetCurrentLocale()` also selects the item names), so one
target locale is translated in both at once. It runs on your own machine (`localhost`, Windows +
macOS) or as a web page (Chrome / Edge edit in place; Firefox / Safari upload + download).

> **Built with AI.** Written with an AI coding assistant ([Claude Code](https://claude.com/claude-code)),
> directed and reviewed by a human maintainer. It is covered by automated tests, but keep your files
> under git (or backed up) before a first save.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core + session with several sources (resx, items), workspace detection, API, unit tests | Done |
| 2 | Desktop UI per source (sidebar, item rows, checks), new name / ports | Done |
| 3 | Web build, fallback (Firefox / Safari), PWA; one TSV + glossary for both | Done |
| 4 | Carrying over `.muresx/` + `Items.mubmd/`, user guides, release packaging | Done |

## Getting started

**1. Get what to translate**, one of:

- a MuMain checkout (`git clone https://github.com/sven-n/MuMain.git`): UI strings + item names.
  Keep the tool's side data out of git (neither the build nor the game reads it):
  `echo ".mumain-translator/" >> MuMain/.git/info/exclude` (or add it to `.gitignore`);
- a game folder (a MuMain build): item names only - a released game has no `.resx` files.

**2. Run the tool**, one of:

- **Release zip** (Windows x64, macOS arm64 / x64): unzip and run `MuMain-translator`
  (`MuMain-translator.exe`); the browser opens. See the user guide for macOS quarantine and Windows
  SmartScreen. Command line: `MuMain-translator [folder] [--locale vi] [--port 4837] [--no-open]`.
- **Web version** (GitHub Pages, `https://<user>.github.io/MuMain-translator/`): nothing to install;
  works offline once installed.
- **From source**: Bun 1.1.32+ and Node 20.19+ (for Vite): `bun install`, then
  `bun run start -- /path/to/MuMain --locale vi`.

**3. Translate**, save (Ctrl+S). Then rebuild MuMain for the UI strings; restart the game for the
item names. If the locale is new to the game, add it to the language list first (the red "Not
selectable in the game" badge shows how, see [docs/MuMain-issues_vi.md](docs/MuMain-issues_vi.md)).

The user guides (`docs/USER-GUIDE_en.txt`, `docs/USER-GUIDE_vi.txt`) are shipped with each release.

## Workspace

Pick one folder; what it holds is found automatically (`src/session/workspace.ts`):

| Picked folder | Sources | Root (side data) |
|---|---|---|
| a MuMain checkout | `src/Localization` + `src/bin/Data/Items` | the checkout |
| `src` or `src/Localization` of a checkout | both, as above | the checkout |
| a game folder | items: `Data/Items` (Windows / Linux) or `<Any>.app/Contents/MacOS/Data/Items` (macOS, preferred on a Mac) | the game folder |
| `Data/Items` | items | that folder |
| a Localization folder outside a checkout | resx | that folder |

A checkout's own `src/bin/Data/Items` wins over build outputs (the build copies it next to Main and
would overwrite a change made there).

## Files the tool writes

| Path | What |
|---|---|
| `src/Localization/<Group>.<locale>.resx` | translations (only the changed entries are rewritten; a new locale's files are created on the first save) |
| `Data/Items/GroupNN_<Name>.json` | item names (only the changed `"name"` values, the way MuMain writes them) |
| `.mumain-translator/backups/` | each file before a save that rewrote it (20 kept per file) |
| `.mumain-translator/changes.tsv` | who changed which key of which file, from what to what |
| `.mumain-translator/project-<locale>.json` | status / note / last editor / merge base per key, per group |
| `.mumain-translator/draft-<locale>.json` | unsaved edits (offered for restore when the folder is opened again) |
| `.mumain-translator/proposals/decisions/<file>` | what was decided about each AI proposal (the proposal file itself is removed once every item in it is decided) |

`.mumain-translator/` is at the workspace root. ResxGen only reads the top-level `*.resx` of
Localization and the game only the top-level `*.json` of Data/Items, so it never reaches either.

## Moving from MuResx-editor / MuBMD-editor

The first time a workspace is opened for a locale (no `project-<locale>.json` yet),
`src/session/migrate.ts` reads the old side data and writes it as this tool's project / draft files:

- MuResx-editor: `<Localization>/.muresx/project-<locale>.json` (records per group + key, merge
  bases per file) and `draft-<locale>.json`;
- MuBMD-editor 2.x: `<Data/Items>.mubmd/project.json` (records per slot = group × 512 + number) and
  `draft.json`, for `vi` only (the only locale it translated).

Groups changed since then get their merge bases reset, as after a `git pull`. A toast reports what
was carried over. The old folders are only read: their change logs and backups stay there. Names
translated in an old `Item.bmd` (MuBMD-editor 1.x): export them to TSV with 1.x and import the TSV
(`ItemType, ItemIndex, Name` files are read into the item groups).

## UI

- The sidebar lists everything, then per source (when the workspace has both) a total line and its
  groups: *UI strings* (Dialog, Editor, Game, Metadata) and *Item names* (`0. Swords` … `15. Skill
  scrolls`). The top bar shows which sources were found and where (e.g. *Item names · macOS app*).
- Item rows: ID `7:1` (group : number; search `7:1` to jump to it), English name, translation, a
  49-character counter while typing, the checks; no "keep English". Resx rows as in MuResx-editor
  (`#470` = legacy id, placeholders highlighted, "keep English").
- Ports: 4837 (server) / 5193 (Vite) / 5194 (web dev), so the three tools can run side by side.

## Web version

The same UI as a static page (a PWA: installable, works offline); the Session runs in the browser.

- **Chrome / Edge:** the chosen folder is edited in place through the File System Access API; side
  data is written next to it as on the desktop. Recently opened folders come back after a reload.
- **Firefox / Safari / Brave (fallback, or `?fallback` in the URL):** the folder is chosen with a
  folder upload, and only the files to translate are read (`<Group>.<locale>.resx` in a
  `Localization` folder, the item files of a `Data/Items` folder; never `.git`, `Items/Models`…)
  into a copy kept in the browser (IndexedDB, with its side data). Saving downloads what was
  rewritten: one file as it is, several as `<folder>-<locale>.zip` with their paths relative to the
  folder (unpack it over the folder). Export / glossary save download too; TSV files are uploaded.
- One TSV for both sources: `Group, Key, English, Translation, Status, …` with item rows as
  `Items.Helm / 1`. The glossary is checked against the English text of both kinds of rows.

## Glossary

A TSV file shared by the team (`Term, Translation, Note, Category, Source, Status`; the old
`MuMain_VI_Glossary.csv` and glossary files without the last two columns still open). **Status**:
`confirmed` entries are the agreed translations - a text that does not follow one is flagged
(*Glossary problems*); `suggested` entries are candidates, shown as hints only (several suggestions for
one term: any of them counts as used). Confirm or take back an entry with ✓ in *Actions → Glossary…*.

`scripts/glossary-build.ts` starts a glossary from names already translated elsewhere (a Vietnamese Mu
client, other servers), matched with MuMain's English item names **by id**: it writes the item names as a
TSV to import, and suggested terms - item names used in the UI texts, and words / set names found by
co-occurrence (`Helm → Mũ`, `Legendary → Ma Thuật`, `Red Wing → Hỏa Thiên`) - plus a report. Run it
directly (`bun scripts/glossary-build.ts --mumain … --source "Label=file.tsv" … --out …`; `bun run … --`
splits paths with spaces). See the comment at the top of the script.

## AI proposals

Translations proposed by an AI assistant (through the MCP server below) or a script are files in
`.mumain-translator/proposals/`, one per batch, never changed by their writer:

```json
{"version":1,"locale":"vi","createdAt":"2026-10-01T10:30:00Z","by":"AI (Claude Code)","note":"about the batch",
 "items":[{"group":"Items.Helm","key":"1","english":"Dragon Helm","base":"","value":"Mũ Rồng","note":"why / doubts"}]}
```

`english` / `base` are the English text and the translation (`""` = none) the proposal was made from:
when either changed since, the proposal is shown as outdated. The tool reads the folder when the
window gets focus (and *Actions → Reload AI proposals*); rows with one get a ✨ marker and the filter
*Has an AI proposal*. The detail panel shows the proposed text with its checks: **Accept** (an ordinary
undoable edit, status *Translated*; the proposal's note becomes the row's note when it has none, marked
"AI"), **Edit, then accept**, or **Skip** with a reason. *Actions → Accept … without problems* takes every
proposal of the list made from the current translation with no error, warning or glossary problem.
Nothing is written into the translated files until **Save**. Decisions go to
`proposals/decisions/<same name>` right away (history the assistant can learn from). Only the newest
undecided proposal of a key is shown; deciding it sets the older ones aside. Needs the desktop build or
Chrome / Edge on the web (the fallback mode uploads no side data).

## AI assistant (MCP server)

`MuMain-translator mcp <folder>` is an [MCP](https://modelcontextprotocol.io) server (stdio) for AI
assistants such as Claude Code. It reads the workspace, the glossary and the style guide, and writes
**only** proposal files (see above) - every other write is refused, so translated files, the project
file and drafts stay the person's. Each call reads the files again, so it sees what was saved in the
meantime. Register it once (with the release binary, or `bun <repo>/src/server/main.ts` from a checkout):

```
claude mcp add mumain -- MuMain-translator mcp /path/to/MuMain --locale vi \
  --glossary /path/to/glossary.tsv --style /path/to/STYLE_vi.md
```

Workflows, offered by Claude Code as commands (MCP prompts):

| Command | What the assistant does |
|---|---|
| `/mcp__mumain__translate [group] [batch] [batches]` | reads the style guide and earlier review decisions, translates untranslated rows batch by batch (glossary terms, consistent set names), checks and proposes them, then summarizes doubts and new glossary candidates |
| `/mcp__mumain__fix_glossary [term] [group]` | proposes corrections for translated rows that break a confirmed glossary term, changing only the term |
| `/mcp__mumain__learn_from_feedback [limit]` | turns the person's edits and skip reasons into suggested glossary entries and style rules; writes nothing |

Tools: `workspace_info`, `list_groups`, `get_rows` (untranslated rows without a proposal by default;
`glossary_problems` for rows that break a confirmed term),
`get_glossary` (the terms of a text), `get_style_guide`, `find_examples` (how the team translated a
phrase), `check_translation`, `propose_translations`, `list_proposals` (with the person's edits and
reasons for skipping), `withdraw_proposals`. Proposals are checked like the UI checks: errors, reviewed
rows and texts the file cannot hold are refused; warnings and deviations from confirmed glossary terms
need a note. Then review them in MuMain-translator (desktop, or the web version in Chrome / Edge on the
same folder).

## Checks

- UI strings (from MuResx-editor): ResxGen build errors, printf / `{0}` placeholders, `\n` and Item
  Shop `#` line breaks, stray backslashes, `%` vs `%%`, empty texts, NFC, duplicate / extra keys,
  identical to English, outdated "keep".
- Item names: the same text checks, plus over 49 characters (error: the game cuts it); `||` or
  control characters are refused (the game would not start).

## Design

- `src/session/sources/`: a `SourceGroup` per group - `ResxGroup` (one `<Group>`) and `ItemsGroup`
  (one item file, `Items.Sword`… from its `"group"`, keys = item numbers). Each reads, checks and
  writes its own file; the `Session` works per key of a group (undo, draft, status, merge, save,
  reload). An empty translation removes the key (the game shows English) in both.
- `src/core/`: pure logic, also used by the UI - `resx.ts` / `xml.ts` (position-keeping XML),
  `validate.ts`, `resxgen.ts`, `keep.ts`, `registration.ts`; `itemData.ts` / `jsonText.ts`
  (position-keeping JSON, nlohmann-style escaping), `itemName.ts`; `tsv.ts`, `merge.ts`,
  `glossary.ts`, `sha1.ts`.
- `src/session/`: `workspace.ts`, `itemsFolder.ts`, `session.ts`, `sidecar.ts`, `migrate.ts`, all file
  access through a `Storage` (disk: `src/server/nodeStorage.ts`; browser: `web/src/lib/browserStorage.ts`
  and `idbStorage.ts`; tests: `memoryStorage.ts`).
- `src/server/`: the HTTP API on 127.0.0.1, native file / folder dialogs, serving the built UI.
- `web/`: the Vue UI (English / Vietnamese). `@backend` is `httpBackend.ts` (desktop) or
  `localBackend.ts` (web build).

## Development

```
bun install
bun run dev                # API server (4837) + Vite (5193, HMR)
bun run dev -- /path/to/MuMain --locale vi
bun run dev:web            # the web build: Vite only (5194)
bun run typecheck
bun test                                   # unit tests
MUMAIN_DIR=/path/to/MuMain bun test        # plus the real checkout (read only)
bun run test:e2e           # desktop: the sample Localization folder, a sample checkout with both sources,
                           # and (MUMAIN_DIR) a real checkout, read only; screenshots in e2e-shots/
bun run test:e2e:web       # the web build in Chromium (OPFS stands in for the folder), PWA offline
bun run test:e2e:fallback  # the fallback in Chromium (?fallback), Firefox and WebKit
bun run build:web-static   # build/web-static/: the static PWA (relative paths, any host / sub-path)
bun run release            # releases/MuMain-translator-<version>-{windows-x64,macos-arm64,macos-x64}.zip + SHA256SUMS.txt
bun run build -- --out ../somewhere --only macos-arm64
```

If this folder lives in a synced folder (Google Drive…), build elsewhere with `--out` (the zips are
~60 MB together).

**Releases:** `bun run tag` makes the next one. It shows the latest tag and suggests the next
version - patch / minor / major (after a pre-release: finish it, or the next `-beta.N`) or one you
type - optionally runs the typecheck + unit tests, writes the version to `package.json` and commits
it (`chore: release vX.Y.Z`), creates the tag, then pushes the branch + tag or leaves them local
(printing the push / undo commands). Non-interactive: `bun run tag -- minor --push`,
`bun run tag -- 2.1.0-beta.1 --no-push --no-checks`, `--yes` for the default answers. It refuses to
run with uncommitted changes or an existing tag.

A pushed tag `v<version>` runs `.github/workflows/release.yml` (the tag must match `version` in
`package.json`, which `bun run tag` takes care of): tests, the zips as a GitHub Release, and the web
version on GitHub Pages (one-time setup: Settings → Pages → Source: "GitHub Actions"). `ci.yml` runs the typecheck, the unit
tests and the three e2e suites on every push.

## License

[MIT](LICENSE). The license covers this tool's source code only, not game data.
