// prompts.ts - Ready-made workflows of the MCP server. A client offers them as commands (Claude Code:
// /mcp__<server>__translate ...); each becomes a user message telling the assistant how to use the
// tools for one job. They ship with the server, so they always match its tools.

import { localeName } from "../shared/locales";
import type { McpPrompt } from "./protocol";

export interface PromptContext {
  locale: string;
  hasGlossary: boolean;
  hasStyle: boolean;
}

const num = (v: string | undefined, def: number, min: number, max: number, name: string) => {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${name}" must be a whole number from ${min} to ${max}.`);
  return n;
};

export function createPrompts(ctx: PromptContext): McpPrompt[] {
  const lang = `${localeName(ctx.locale)} (${ctx.locale})`;
  const missing = [
    ctx.hasStyle ? "" : "No style guide was configured (--style): tell the user, and follow only the glossary and the rules below.",
    ctx.hasGlossary ? "" : "No glossary was configured (--glossary): tell the user; terms will not be checked.",
  ].filter(Boolean);

  // Shared by every workflow.
  const rules = `Ground rules:
- You PROPOSE translations with propose_translations; a person accepts, edits or skips them in MuMain-translator. Never edit the game's files (resx / JSON) directly, even if you have file access.
- Priority when rules conflict: technical constraints > confirmed glossary terms > the style guide > reviewed translations > your own judgement.
- Technical constraints: keep every placeholder (%d, %s, %I64d, {0}...) in the same order, %% as %%, \\n (two characters) and # exactly as in English; leading / trailing spaces as in English; item names at most 49 characters; never "||".
- Confirmed glossary terms are mandatory. Suggested terms: use them unless clearly wrong, and say why in the note.
- Leave reviewed rows alone. Texts that must stay English (font names, chat commands like /party, stat codes like STR, LV): do not propose them; list them in your summary instead.
- Put every doubt in the item's note (it is shown to the reviewer). A short honest note beats a confident wrong translation.
${missing.map((m) => `- ${m}`).join("\n")}`.trimEnd();

  const summary = (extra: string, review = true) =>
    `When done, write a short summary for the user in ${localeName(ctx.locale)}: ${extra}` +
    (review ? " Then remind them to review the proposals in MuMain-translator (they appear when its window gets focus; the web version needs Chrome or Edge opened on the same folder) and to press Save." : "");

  return [
    {
      name: "translate",
      title: "Translate a batch",
      description: `Translate untranslated rows into ${lang} and write them as proposals to review in MuMain-translator.`,
      arguments: [
        { name: "group", description: 'A group (e.g. "Items.Helm", "Game"), "items" / "resx" for a whole source, or empty: the assistant picks.' },
        { name: "batch", description: "Rows per proposal file (default 50, at most 200)." },
        { name: "batches", description: "How many batches before stopping to report (default 1, at most 10)." },
      ],
      get(args) {
        const batch = num(args.batch, 50, 1, 200, "batch");
        const batches = num(args.batches, 1, 1, 10, "batches");
        const g = args.group ?? "";
        const target =
          g === "items" || g === "resx"
            ? `the ${g === "items" ? "item names" : "UI strings"} (get_rows with source "${g}"; work through its groups in list_groups order)`
            : g
              ? `the group "${g}"`
              : "the group you choose: call list_groups and take the one with the most untranslated rows (tell the user which one and why)";
        return `Translate MuMain texts from English into ${lang}: ${target}. Do ${batches} batch${batches > 1 ? "es" : ""} of up to ${batch} rows.

Before translating:
1. Call workspace_info and get_style_guide. Read the style guide completely and follow it.
2. Call list_proposals: the person's edits ("taken") and reasons for skipping show what they expect. Apply those lessons.

For each batch:
3. get_rows (limit ${batch}; untranslated rows without a pending proposal come by default).
4. For each row, call get_glossary with the English text as "text" (group several short texts into one call when you can) and use the terms it returns.
5. Stay consistent with what exists: find_examples for recurring words and phrases (for item names: the set word, e.g. "Dragon", to reuse the set name already used for other pieces of the same set).
   - Item names are type + set name in the style guide's order (e.g. "Mũ Rồng"), proper names in Hán-Việt, never a word-by-word translation of the English; new sets follow the pattern of the existing ones. Explain invented set names in the note.
   - UI strings: short and clear; NPC dialogue uses the forms of address in the style guide.
6. check_translation on the whole batch. Fix every "rejected"; fix "needs-note" items or explain in their note why they are right. Repeat until nothing is rejected.
7. propose_translations with the batch and a batch note (what it covers, open questions).

${rules}

${summary("the proposal file(s), how many rows were proposed, what was not written and why, the items you are unsure about, texts that should stay English, and new terms that deserve a glossary entry (English → translation, as a list the user can copy).")}`;
      },
    },
    {
      name: "fix_glossary",
      title: "Fix glossary problems",
      description: `Find ${lang} translations that break a confirmed glossary term (e.g. an old name) and propose corrected texts.`,
      arguments: [
        { name: "term", description: 'Only glossary terms containing this English word (e.g. "Jewel"; default: every term).' },
        { name: "group", description: "Only this group (default: every group)." },
      ],
      get(args) {
        const scope = [args.term ? `terms containing "${args.term}"` : "", args.group ? `group "${args.group}"` : ""].filter(Boolean).join(", ");
        return `Correct ${lang} translations that do not follow a confirmed glossary term${scope ? ` (${scope})` : ""}.

1. Call workspace_info and get_style_guide.
2. Call get_rows with glossary_problems: true${args.group ? `, group "${args.group}"` : ""}, limit 200${args.term ? `, query "${args.term}"` : ""}; page with offset until you have them all. Each row lists its glossaryProblems.
3. ${args.term ? `Only the glossaryProblems whose term contains "${args.term}" are in scope; leave the other problems of the same rows as they are (mention how many in the summary). ` : ""}For each row, change ONLY what the glossary requires (replace the wrong term with the confirmed one, adjusting the words around it just enough to stay grammatical). Keep everything else exactly as it is: the person already approved that text.
4. If a row seems to be right as it is (the term is used in another sense, a proper name...), do not propose it; list it in your summary.
5. check_translation on all corrections, then propose_translations with one note per item such as: glossary: "<old>" → "<new>". Batch note: "Glossary corrections".
6. Rows marked reviewed cannot be proposed: list them for the user to correct by hand.

${rules}

${summary("how many corrections were proposed, rows you left alone and why, and reviewed rows the user has to correct by hand.")}`;
      },
    },
    {
      name: "learn_from_feedback",
      title: "Learn from review decisions",
      description: "Summarize how the person edited and skipped earlier proposals, and suggest glossary entries or style rules. Writes nothing.",
      arguments: [{ name: "limit", description: "How many recent decisions to read (default 200, at most 500)." }],
      get(args) {
        const limit = num(args.limit, 200, 1, 500, "limit");
        return `Look at how the person reviewed earlier ${lang} proposals and turn it into lessons. Do not write proposals in this task.

1. Call list_proposals with decisions "all" and limit ${limit}, then get_style_guide and get_glossary (no arguments) to know the current rules.
2. Compare what was proposed with what was taken (edited items) and read the reasons of rejected items. Group them into patterns: terminology, word choice, forms of address, capitalization, length, item-name patterns, placeholders.
3. For each pattern, give 1-3 examples (English → proposed → taken / reason) and a concrete rule.

${summary("the acceptance rate (accepted / edited / rejected), the patterns, then: glossary entries to add or confirm (as TSV lines: Term<TAB>Translation<TAB>Note<TAB>Category<TAB>Source<TAB>Status, Status \"confirmed\" or \"suggested\"), and sentences to add to the style guide. Say plainly that you changed nothing; the user decides what to adopt.", false)}`;
      },
    },
  ];
}
