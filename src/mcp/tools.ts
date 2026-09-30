// tools.ts - The tools of the MCP server: an AI assistant (Claude Code...) reads the workspace, the
// glossary and the style guide, checks its translations and writes them as PROPOSALS
// (.mumain-translator/proposals/) that a person accepts or skips in MuMain-translator. It never
// changes a translated file. Runtime-neutral (a Session over any Storage), so it is tested in memory.

import { PROPOSAL_VERSION, SEVERITY, type GlossaryEntry, type GlossaryHint, checkGlossary, isConfirmed, isProblemHint } from "../core";
import { ROW_KEEP, type RowIssue, type Status } from "../shared/api";
import { localeName } from "../shared/locales";
import { loadGlossaryFile } from "../session/glossaryFiles";
import { loadDecisions, loadProposals, recordDecisions, writeProposalFile } from "../session/proposals";
import type { ProposalInfo, Session } from "../session/session";
import { SIDECAR_DIR } from "../session/sidecar";
import { tryReadText } from "../session/storage";
import en from "../../web/src/i18n/locales/en.json";
import type { McpTool } from "./protocol";

export interface McpContext {
  session: Session;
  folder: string; // the workspace, as given on the command line
  locale: string;
  glossary: string | null; // glossary file (TSV / legacy CSV)
  style: string | null; // style guide (Markdown)
  by: string; // written into proposals as their author
  now?: () => Date;
}

export const MAX_BATCH = 200;
const STATUSES_OR_ANY = ["untranslated", "translated", "reviewed", "any"] as const;

// ---- helpers ----

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
const str = (v: unknown, name: string, required = false): string => {
  if (v === undefined || v === null) {
    if (required) throw new Error(`"${name}" is required.`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`"${name}" must be a string.`);
  return v;
};
const int = (v: unknown, def: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : def);
const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);

// Issue sentences as the UI shows them (English).
const ISSUE: Record<string, string> = en.issue;
function issueMessage([code, , params = {}]: RowIssue): string {
  const key = code === "stray-backslash" ? `stray-backslash-${params.next === "newline" ? "newline" : params.next === "end" ? "end" : "other"}` : code;
  return (ISSUE[key] ?? code).replace(/\{'([^']*)'\}/g, "$1").replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}
const issueOut = (i: RowIssue) => ({ code: i[0], severity: SEVERITY[i[0]], message: issueMessage(i) });
const hintOut = (h: GlossaryHint) => ({ term: h.term, translation: h.translation ?? "(keep the English term)", ...(h.note ? { note: h.note } : {}), ...(h.suggested ? { suggested: true } : {}) });

interface PlainRow {
  group: string;
  source: "resx" | "items";
  key: string;
  id: string | null; // items: "7:1" (item group : number)
  english: string | null;
  translation: string | null;
  status: Status;
  note: string;
  issues: RowIssue[];
  keep: boolean; // stays English on purpose
}

export function createTools(ctx: McpContext): McpTool[] {
  const { session, locale } = ctx;
  const st = session.storage;
  const now = ctx.now ?? (() => new Date());
  const root = () => session.open!.folder.path;

  // Every call sees the files as they are now (the person may have saved in the meantime).
  async function reload() {
    await session.openFolder(ctx.folder, locale, null, { discard: true, create: true });
  }

  function rows(): PlainRow[] {
    const res = session.rows();
    return res.rows.map((t) => {
      const g = res.groups[t[0]]!;
      return {
        group: g.name,
        source: g.source,
        key: t[1],
        id: g.itemType === null ? null : `${g.itemType}:${t[1]}`,
        english: t[2],
        translation: t[3],
        status: t[11],
        note: t[12]?.note ?? "",
        issues: t[5].filter(([, l]) => l !== "en"),
        keep: (t[9] & ROW_KEEP) !== 0,
      };
    });
  }

  async function glossary(): Promise<GlossaryEntry[]> {
    return ctx.glossary ? (await loadGlossaryFile(st, ctx.glossary)).entries : [];
  }

  const pendingKeys = async () => new Map((await session.proposals()).items.map((p) => [`${p.group}\u0000${p.key}`, p]));

  const rowOut = (r: PlainRow, proposal?: { value: string; file: string }, terms: GlossaryHint[] = []) => ({
    group: r.group,
    key: r.key,
    ...(r.id ? { item: r.id } : {}),
    english: r.english,
    translation: r.translation,
    status: r.status,
    ...(r.note ? { note: r.note } : {}),
    ...(r.issues.length ? { issues: r.issues.map(issueMessage) } : {}),
    ...(r.keep ? { keptEnglish: true } : {}),
    ...(proposal ? { pendingProposal: proposal.value } : {}),
    ...(terms.length ? { glossaryProblems: terms.map((h) => `“${h.term}” should be “${h.translation ?? h.term}”`) } : {}),
  });

  // What happens to a proposed text: the rules of propose_translations.
  function verdict(info: ProposalInfo, hints: GlossaryHint[], note: string): { verdict: "ok" | "needs-note" | "rejected" | "skipped"; reason?: string } {
    if (info.state === "unknown") return { verdict: "rejected", reason: "Not a key of the English source." };
    if (info.state === "invalid") return { verdict: "rejected", reason: "The file cannot hold this text (empty, “||” or a control character)." };
    if (info.state === "reviewed") return { verdict: "rejected", reason: "The row is reviewed: do not change it." };
    if (info.state === "same") return { verdict: "skipped", reason: "Same as the translation now." };
    const errors = info.issues.filter((i) => SEVERITY[i[0]] === "error");
    if (errors.length) return { verdict: "rejected", reason: errors.map(issueMessage).join(" ") };
    const warnings = info.issues.filter((i) => SEVERITY[i[0]] === "warning").map(issueMessage);
    const terms = hints.filter(isProblemHint).map((h) => `Glossary: “${h.term}” should be “${h.translation ?? h.term}”.`);
    if ((warnings.length || terms.length) && !note.trim()) {
      return { verdict: "needs-note", reason: `${[...warnings, ...terms].join(" ")} Fix it, or say in the note why it is right.` };
    }
    return { verdict: "ok" };
  }

  function items(v: unknown, withNote: boolean) {
    if (!Array.isArray(v) || !v.length) throw new Error(`"items" must be a non-empty array.`);
    if (v.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} items per call.`);
    return v.map((it, i) => {
      if (typeof it !== "object" || it === null) throw new Error(`items[${i}] must be an object.`);
      const o = it as Record<string, unknown>;
      return {
        group: str(o.group, `items[${i}].group`, true),
        key: str(o.key, `items[${i}].key`, true),
        value: str(o.value, `items[${i}].value`, true).normalize("NFC"),
        note: withNote ? str(o.note, `items[${i}].note`).replace(/[\t\r\n]+/g, " ").trim() : "",
      };
    });
  }

  async function checked(list: ReturnType<typeof items>) {
    const [infos, entries] = await Promise.all([session.proposalInfo(list), glossary()]);
    return list.map((it, i) => {
      const info = infos[i]!;
      const hints = info.english === null ? [] : checkGlossary(entries, it.value, info.english);
      return { it, info, hints, ...verdict(info, hints, it.note) };
    });
  }

  const itemProps = {
    group: { type: "string", description: 'Group name from list_groups, e.g. "Game" or "Items.Helm".' },
    key: { type: "string", description: "Key of the row (for item names: the item number)." },
    value: { type: "string", description: "The translation. Keep placeholders (%d, %s, {0}), \\n (two characters) and # exactly as in English." },
  };

  const tools: McpTool[] = [
    {
      name: "workspace_info",
      description:
        "Start here. The MuMain workspace being translated: target locale, the two sources (UI strings from src/Localization/*.resx, item names from Data/Items/*.json), progress, whether a glossary and style guide are loaded, undecided proposals, and the working rules.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      async run() {
        const all = rows();
        const count = (source: string) => {
          const list = all.filter((r) => r.source === source && r.english !== null);
          return { total: list.length, untranslated: list.filter((r) => r.status === "untranslated").length, translated: list.filter((r) => r.status === "translated").length, reviewed: list.filter((r) => r.status === "reviewed").length };
        };
        const entries = await glossary();
        const open = session.open!;
        return {
          root: open.folder.path,
          locale,
          language: localeName(locale),
          sources: {
            ...(open.folder.resx ? { resx: { dir: open.folder.resx.rel || ".", ...count("resx") } } : {}),
            ...(open.folder.items ? { items: { dir: open.folder.items.rel || ".", ...count("items") } } : {}),
          },
          glossary: ctx.glossary ? { file: ctx.glossary, confirmed: entries.filter(isConfirmed).length, suggested: entries.filter((e) => !isConfirmed(e)).length } : null,
          styleGuide: ctx.style,
          proposals: { dir: `${SIDECAR_DIR}/proposals`, undecided: (await session.proposals()).items.length },
          rules: [
            "You propose; a person decides in MuMain-translator. Nothing you do changes a translated file.",
            "Follow the style guide (get_style_guide) and the glossary (get_glossary): confirmed terms are mandatory, suggested ones preferred.",
            "Keep placeholders (%d, %s, {0}...), \\n and # exactly as in English; item names at most 49 characters.",
            "Look at how similar texts were translated (find_examples) to stay consistent.",
            "Check before proposing (check_translation). Warnings and glossary deviations need a note saying why.",
            "Do not propose changes to reviewed rows. Put doubts in the note of the item.",
            "Read list_proposals from time to time: the reasons given for skipped proposals tell you what to do differently.",
          ],
        };
      },
    },
    {
      name: "list_groups",
      description: "The groups of the workspace (UI string tables such as Game / Dialog, and one group per item file such as Items.Helm) with how many rows are untranslated / translated / reviewed and how many have an undecided proposal.",
      inputSchema: { type: "object", properties: { source: { type: "string", enum: ["resx", "items"], description: "Only UI strings (resx) or only item names (items)." } } },
      annotations: { readOnlyHint: true },
      async run(args) {
        const source = str(args.source, "source");
        const pending = await pendingKeys();
        const res = session.rows();
        const all = rows();
        return res.groups
          .filter((g) => !source || g.source === source)
          .map((g) => {
            const list = all.filter((r) => r.group === g.name && r.english !== null);
            return {
              group: g.name,
              source: g.source,
              ...(g.itemType !== null ? { itemGroup: g.itemType } : {}),
              file: g.file ?? g.enFile,
              total: list.length,
              untranslated: list.filter((r) => r.status === "untranslated").length,
              translated: list.filter((r) => r.status === "translated").length,
              reviewed: list.filter((r) => r.status === "reviewed").length,
              withProposal: list.filter((r) => pending.has(`${r.group}\u0000${r.key}`)).length,
            };
          });
      },
    },
    {
      name: "get_rows",
      description:
        'Rows to translate or look at: English text, current translation, status, the team\'s note and current check problems. By default the untranslated rows that have no undecided proposal yet, 50 at a time (use offset to page). With glossary_problems: translated rows that do not follow a confirmed glossary term (to correct them).',
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "One group (from list_groups)." },
          source: { type: "string", enum: ["resx", "items"] },
          status: { type: "string", enum: STATUSES_OR_ANY, description: 'Default "untranslated".' },
          query: { type: "string", description: "Words that must appear in the key, English text or translation (accents ignored)." },
          keys: { type: "array", items: { type: "string" }, description: "Only these keys (with group)." },
          skip_proposed: { type: "boolean", description: "Leave out rows with an undecided proposal (default true)." },
          glossary_problems: { type: "boolean", description: 'Only translated rows that break a confirmed glossary term (status then defaults to "any").' },
          offset: { type: "number" },
          limit: { type: "number", description: "Default 50, at most 200." },
        },
      },
      annotations: { readOnlyHint: true },
      async run(args) {
        const group = str(args.group, "group");
        const source = str(args.source, "source");
        const glossaryOnly = bool(args.glossary_problems, false);
        const status = str(args.status, "status") || (glossaryOnly ? "any" : "untranslated");
        if (!(STATUSES_OR_ANY as readonly string[]).includes(status)) throw new Error(`"status" must be one of ${STATUSES_OR_ANY.join(", ")}.`);
        const terms = fold(str(args.query, "query")).split(/\s+/).filter(Boolean);
        const keys = Array.isArray(args.keys) ? new Set(args.keys.map(String)) : null;
        const skip = bool(args.skip_proposed, true);
        const offset = int(args.offset, 0, 0, 1e9);
        const limit = int(args.limit, 50, 1, 200);
        if (group && !session.rows().groups.some((g) => g.name === group)) throw new Error(`No group named "${group}" (see list_groups).`);
        const pending = await pendingKeys();
        const entries = glossaryOnly ? await glossary() : [];
        if (glossaryOnly && !ctx.glossary) throw new Error("No glossary was given to the MCP server (--glossary <file>).");
        const problems = new Map<PlainRow, GlossaryHint[]>();
        const termsOf = (r: PlainRow) => {
          if (!problems.has(r)) problems.set(r, r.translation === null || r.keep ? [] : checkGlossary(entries, r.translation, r.english!).filter(isProblemHint));
          return problems.get(r)!;
        };
        const list = rows().filter(
          (r) =>
            r.english !== null &&
            (!group || r.group === group) &&
            (!source || r.source === source) &&
            (status === "any" || r.status === status) &&
            (!keys || keys.has(r.key)) &&
            (!skip || !pending.has(`${r.group}\u0000${r.key}`)) &&
            terms.every((t) => fold(`${r.key}\u0000${r.english}\u0000${r.translation ?? ""}`).includes(t)) &&
            (!glossaryOnly || termsOf(r).length > 0),
        );
        return {
          total: list.length,
          offset,
          rows: list.slice(offset, offset + limit).map((r) => rowOut(r, pending.get(`${r.group}\u0000${r.key}`), glossaryOnly ? termsOf(r) : [])),
        };
      },
    },
    {
      name: "get_glossary",
      description:
        'The team glossary. With "text" (an English text): the glossary terms that occur in it and how to translate them. Otherwise the entries, filtered by "query" / "status". Confirmed entries are mandatory; suggested ones are candidates (use them unless they are clearly wrong, and say so in the note).',
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "An English text: return the terms it contains." },
          query: { type: "string", description: "Words in the term, translation or note (accents ignored)." },
          status: { type: "string", enum: ["confirmed", "suggested", "any"] },
        },
      },
      annotations: { readOnlyHint: true },
      async run(args) {
        if (!ctx.glossary) return { glossary: null, message: "No glossary was given to the MCP server (--glossary <file>)." };
        const entries = await glossary();
        const text = str(args.text, "text");
        if (text) return { terms: checkGlossary(entries, "", text).map(hintOut) };
        const q = fold(str(args.query, "query"));
        const status = str(args.status, "status") || "any";
        const list = entries.filter(
          (e) => (status === "any" || (status === "confirmed") === isConfirmed(e)) && (!q || fold(`${e.term}\u0000${e.translation ?? ""}\u0000${e.note}`).includes(q)),
        );
        return {
          total: list.length,
          entries: list.slice(0, 300).map((e) => ({
            term: e.term,
            translation: e.translation ?? "(keep the English term)",
            status: isConfirmed(e) ? "confirmed" : "suggested",
            ...(e.note ? { note: e.note } : {}),
            ...(e.category ? { category: e.category } : {}),
            ...(e.source ? { source: e.source } : {}),
          })),
        };
      },
    },
    {
      name: "get_style_guide",
      description: "The style guide for this language (how to address the player, capitalisation, how item names are formed...). Read it before translating.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      async run() {
        if (!ctx.style) return "No style guide was given to the MCP server (--style <file>). Keep placeholders, \\n and # as in English, and follow the glossary.";
        const text = await tryReadText(st, st.resolve(ctx.style));
        if (text === null) throw new Error(`Cannot read the style guide ${ctx.style}.`);
        return text;
      },
    },
    {
      name: "find_examples",
      description:
        "Existing translations whose English text or translation contains the given words (accents ignored), reviewed ones first: how the team already translated a word or phrase. Use it for consistency.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: 'e.g. "Jewel of Chaos", "party", "Hỗn Nguyên".' },
          group: { type: "string" },
          limit: { type: "number", description: "Default 20, at most 100." },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      async run(args) {
        const terms = fold(str(args.query, "query", true)).split(/\s+/).filter(Boolean);
        if (!terms.length) throw new Error(`"query" is empty.`);
        const group = str(args.group, "group");
        const limit = int(args.limit, 20, 1, 100);
        const rank: Record<Status, number> = { reviewed: 0, translated: 1, untranslated: 2 };
        const list = rows()
          .filter(
            (r) =>
              r.english !== null &&
              r.translation !== null &&
              r.translation !== r.english &&
              r.status !== "untranslated" &&
              (!group || r.group === group) &&
              terms.every((t) => fold(`${r.english}\u0000${r.translation}`).includes(t)),
          )
          .sort((a, b) => rank[a.status] - rank[b.status]);
        return { total: list.length, examples: list.slice(0, limit).map((r) => ({ group: r.group, key: r.key, ...(r.id ? { item: r.id } : {}), english: r.english, translation: r.translation, status: r.status })) };
      },
    },
    {
      name: "check_translation",
      description:
        'Checks translations before proposing them, exactly as propose_translations will: placeholders / \\n / # against English, item name length, characters the file cannot hold, glossary terms, reviewed rows. verdict "ok" = will be written; "needs-note" = a warning or glossary deviation: fix it or explain in the note; "rejected" / "skipped" = will not be written.',
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "object", properties: { ...itemProps, note: { type: "string" } }, required: ["group", "key", "value"] },
          },
        },
        required: ["items"],
      },
      annotations: { readOnlyHint: true },
      async run(args) {
        return (await checked(items(args.items, true))).map((c) => ({
          group: c.it.group,
          key: c.it.key,
          verdict: c.verdict,
          ...(c.reason ? { reason: c.reason } : {}),
          ...(c.info.issues.length ? { issues: c.info.issues.map(issueOut) } : {}),
          ...(c.hints.length ? { glossary: c.hints.map((h) => ({ ...hintOut(h), ok: h.kind === "ok" })) } : {}),
          ...(c.info.status ? { status: c.info.status } : {}),
          current: c.info.base,
        }));
      },
    },
    {
      name: "propose_translations",
      description:
        'Writes translations as ONE new proposal file for a person to accept or skip in MuMain-translator (nothing else is changed). Each item is checked like check_translation: "rejected" and "needs-note" items without a note are not written (the answer says why). Put your reasoning or doubts in each item\'s note. At most 200 items per call.',
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { ...itemProps, note: { type: "string", description: "Why this translation / doubts, for the reviewer. Required when there is a warning or glossary deviation." } },
              required: ["group", "key", "value"],
            },
          },
          note: { type: "string", description: "About the whole batch (what was translated, open questions)." },
        },
        required: ["items"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      async run(args) {
        const list = await checked(items(args.items, true));
        const pending = await pendingKeys();
        const written: typeof list = [];
        const notWritten: { group: string; key: string; verdict: string; reason: string }[] = [];
        const seen = new Set<string>();
        for (const c of list) {
          const k = `${c.it.group}\u0000${c.it.key}`;
          let reason = c.verdict === "ok" ? "" : (c.reason ?? "");
          if (!reason && seen.has(k)) reason = "The same key is twice in this call.";
          if (!reason && pending.get(k)?.value === c.it.value) reason = "Already proposed with the same text (undecided).";
          if (reason) {
            notWritten.push({ group: c.it.group, key: c.it.key, verdict: c.verdict === "ok" ? "skipped" : c.verdict, reason });
            continue;
          }
          seen.add(k);
          written.push(c);
        }
        let file: string | null = null;
        if (written.length) {
          file = await writeProposalFile(
            st,
            root(),
            {
              version: PROPOSAL_VERSION,
              locale,
              createdAt: now().toISOString(),
              by: ctx.by,
              note: str(args.note, "note").trim(),
              items: written.map((c) => ({ group: c.it.group, key: c.it.key, english: c.info.english ?? "", base: c.info.base, value: c.it.value, note: c.it.note })),
            },
            now(),
          );
        }
        return {
          file,
          written: written.length,
          notWritten,
          next: written.length ? "The person reviews these in MuMain-translator (they appear when its window gets focus)." : "Nothing was written.",
        };
      },
    },
    {
      name: "list_proposals",
      description:
        "Undecided proposal files, and what the person decided about earlier proposals: accepted, edited (their text is in value), rejected with a reason. Learn from the edits and reasons before the next batch.",
      inputSchema: {
        type: "object",
        properties: {
          decisions: { type: "string", enum: ["changed", "all", "none"], description: 'Which decisions to list: "changed" (edited and rejected, default), "all" or "none".' },
          limit: { type: "number", description: "Most recent decisions to list (default 50, at most 500)." },
        },
      },
      annotations: { readOnlyHint: true },
      async run(args) {
        const which = str(args.decisions, "decisions") || "changed";
        const limit = int(args.limit, 50, 1, 500);
        const scan = await loadProposals(st, root(), locale);
        const files = scan.files
          .map((p) => ({ file: p.name, createdAt: p.file.createdAt, by: p.file.by, items: p.file.items.length, undecided: p.file.items.length - p.decided.size }))
          .filter((f) => f.undecided > 0);
        const decisions =
          which === "none"
            ? []
            : (await loadDecisions(st, root(), locale))
                .flatMap((d) => d.decisions.map((x) => ({ ...x, file: d.file })))
                .filter((x) => which === "all" || x.action === "edited" || x.action === "rejected")
                .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
                .slice(0, limit)
                .map((x) => ({
                  group: x.group,
                  key: x.key,
                  english: x.english,
                  proposed: x.proposed,
                  action: x.action,
                  ...(x.value !== null && x.value !== x.proposed ? { taken: x.value } : {}),
                  ...(x.reason ? { reason: x.reason } : {}),
                  by: x.by,
                  at: x.at,
                }));
        return { undecided: files, broken: scan.broken, decisions };
      },
    },
    {
      name: "withdraw_proposals",
      description: "Takes back undecided proposals you wrote (e.g. after finding a mistake): the whole file, or only some keys of it. Decided items are not touched.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Proposal file name (from propose_translations / list_proposals)." },
          keys: {
            type: "array",
            items: { type: "object", properties: { group: { type: "string" }, key: { type: "string" } }, required: ["group", "key"] },
            description: "Only these (default: every undecided item of the file).",
          },
          reason: { type: "string" },
        },
        required: ["file"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      async run(args) {
        const name = str(args.file, "file", true);
        const scan = await loadProposals(st, root(), locale);
        const p = scan.files.find((f) => f.name === name);
        if (!p) throw new Error(`No undecided proposal file named ${name} (see list_proposals).`);
        const only = Array.isArray(args.keys) ? new Set(args.keys.map((k) => `${(k as Record<string, unknown>)?.group}\u0000${(k as Record<string, unknown>)?.key}`)) : null;
        const at = now().toISOString();
        const reason = str(args.reason, "reason").trim();
        const list = p.file.items.flatMap((it, index) =>
          p.decided.has(index) || (only && !only.has(`${it.group}\u0000${it.key}`))
            ? []
            : [{ index, group: it.group, key: it.key, english: it.english, proposed: it.value, value: null, action: "withdrawn" as const, reason, by: ctx.by, at }],
        );
        const removed = await recordDecisions(st, root(), p, list);
        return { withdrawn: list.length, fileRemoved: removed };
      },
    },
  ];

  // Every tool reads the workspace again first.
  return tools.map((t) => ({
    ...t,
    run: async (args: Record<string, unknown>) => {
      await reload();
      return t.run(args);
    },
  }));
}

export const INSTRUCTIONS = `This server gives access to a MuMain (MU Online client) translation workspace managed by MuMain-translator.
You translate from English and PROPOSE translations; a person reviews them in MuMain-translator and accepts, edits or skips each one. You never change translated files.

Workflow:
1. workspace_info, then get_style_guide. Use get_glossary (with "text") for the terms of each text.
2. list_groups, then get_rows for a group (untranslated rows without a proposal by default).
3. Translate in batches of up to 200 rows. Use find_examples to stay consistent with existing translations.
4. check_translation, fix what it reports, then propose_translations. Add a note to items you are unsure about.
5. Before the next batch, read list_proposals: edits and rejection reasons show what the person expects.
The prompts "translate", "fix_glossary" and "learn_from_feedback" describe these workflows step by step.`;
