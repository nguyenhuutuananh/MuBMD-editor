// main.ts - `MuMain-translator mcp <folder> --locale vi [--glossary file] [--style file]`: the MCP
// server on stdin / stdout, started by an AI client (Claude Code: `claude mcp add ...`). It reads the
// workspace and writes proposals only (see guardedStorage.ts).

import * as path from "node:path";
import pkg from "../../package.json";
import { hostPlatform } from "../session/itemsFolder";
import { proposalsDir } from "../session/proposals";
import { Session } from "../session/session";
import { NodeStorage } from "../server/nodeStorage";
import { GuardedStorage } from "./guardedStorage";
import { createMcpServer, serveStdio } from "./protocol";
import { createPrompts } from "./prompts";
import { INSTRUCTIONS, createTools } from "./tools";

export const MCP_HELP = `MuMain-translator ${pkg.version} - MCP server for AI assistants

Usage: MuMain-translator mcp <folder> [--locale vi] [--glossary FILE] [--style FILE] [--by NAME]

  folder            the workspace (MuMain checkout, game folder, Localization or Data/Items)
  --locale CODE     locale to translate (default vi)
  --glossary FILE   the team glossary (TSV, or the old MuMain_VI_Glossary.csv)
  --style FILE      the style guide (Markdown)
  --by NAME         author written into proposals (default "AI (MCP)")

Speaks MCP over stdin / stdout. It reads the workspace and only writes proposal files to
<folder>/.mumain-translator/proposals/, which are accepted or skipped in MuMain-translator.
Claude Code:  claude mcp add mumain -- MuMain-translator mcp /path/to/MuMain --locale vi --glossary /path/glossary.tsv --style /path/STYLE_vi.md
`;

function parseArgs(argv: string[]) {
  let folder = "";
  let locale = "vi";
  let glossary: string | null = null;
  let style: string | null = null;
  let by = "AI (MCP)";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === "--help" || a === "-h") {
      process.stderr.write(MCP_HELP);
      process.exit(0);
    } else if (a === "--locale") locale = value();
    else if (a === "--glossary") glossary = path.resolve(value());
    else if (a === "--style") style = path.resolve(value());
    else if (a === "--by") by = value();
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else folder = a;
  }
  if (!folder) throw new Error("Missing the workspace folder.");
  return { folder: path.resolve(folder), locale, glossary, style, by };
}

export async function runMcp(argv: string[]): Promise<void> {
  // stdout carries the protocol: everything else goes to stderr (the client's log).
  console.log = console.info = console.warn = console.debug = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${MCP_HELP}`);
    process.exit(2);
  }
  const disk = new NodeStorage();
  const probe = new Session(new GuardedStorage(disk, "/nonexistent-mumain-translator"), undefined, hostPlatform(process.platform));
  let root: string;
  try {
    root = (await probe.scan(args.folder)).path; // the workspace root (where .mumain-translator/ is)
  } catch (e) {
    process.stderr.write(`Cannot open ${args.folder}: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const session = new Session(new GuardedStorage(disk, proposalsDir(disk, root)), undefined, hostPlatform(process.platform));
  const tools = createTools({ session, folder: args.folder, locale: args.locale, glossary: args.glossary, style: args.style, by: args.by });
  process.stderr.write(`MuMain-translator MCP server ${pkg.version}: ${root} (${args.locale})\n`);
  const prompts = createPrompts({ locale: args.locale, hasGlossary: args.glossary !== null, hasStyle: args.style !== null });
  await serveStdio(createMcpServer({ name: "mumain-translator", version: pkg.version, instructions: INSTRUCTIONS, tools, prompts }));
}
