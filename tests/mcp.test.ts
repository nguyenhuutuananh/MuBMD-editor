// The MCP server: protocol, the write guard, and the tools on a sample checkout in memory.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GuardedStorage } from "../src/mcp/guardedStorage";
import { createPrompts } from "../src/mcp/prompts";
import { createMcpServer } from "../src/mcp/protocol";
import { INSTRUCTIONS, createTools } from "../src/mcp/tools";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import { sampleCheckout, writeSampleCheckout } from "./fixtures/sampleWorkspace";

const ROOT = "/mu";
const PROPOSALS = `${ROOT}/.mumain-translator/proposals`;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const GLOSSARY = "Term\tTranslation\tNote\tCategory\tSource\tStatus\nChaos Castle\tHỗn Nguyên Lâu\t\tMap\t\tconfirmed\nHelm\tMũ\t\tItem\tMu VN\tsuggested\n";

function setup() {
  const files = sampleCheckout(ROOT);
  files["/kit/glossary.tsv"] = enc(GLOSSARY);
  files["/kit/STYLE_vi.md"] = enc("# Style\nNPC: ta / ngươi.\n");
  const mem = new MemoryStorage(files);
  let t = Date.parse("2026-10-01T10:00:00Z");
  const now = () => new Date((t += 1000));
  const session = new Session(new GuardedStorage(mem, PROPOSALS), now, "win32");
  const tools = createTools({ session, folder: ROOT, locale: "vi", glossary: "/kit/glossary.tsv", style: "/kit/STYLE_vi.md", by: "AI (test)", now });
  const prompts = createPrompts({ locale: "vi", hasGlossary: true, hasStyle: true });
  const server = createMcpServer({ name: "mumain-translator", version: "test", instructions: INSTRUCTIONS, tools, prompts });
  let id = 0;
  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await server.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    const text = res.result.content[0]!.text;
    if (res.result.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return { mem, session, server, call };
}

describe("protocol", () => {
  test("initialize, tools/list, ping, errors", async () => {
    const { server } = setup();
    const init = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })) as {
      result: Record<string, unknown>;
    };
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mumain-translator" } });
    expect(String(init.result.instructions)).toContain("propose_translations");
    const old = (await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
    expect(old.result.protocolVersion).toBe("2025-06-18");
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    const list = (await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "workspace_info",
      "list_groups",
      "get_rows",
      "get_glossary",
      "get_style_guide",
      "find_examples",
      "check_translation",
      "propose_translations",
      "list_proposals",
      "withdraw_proposals",
    ]);
    expect(list.result.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect(await server.handle({ jsonrpc: "2.0", id: 5, method: "nope" })).toMatchObject({ error: { code: -32601 } });
    expect(await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).toMatchObject({ error: { code: -32602 } });
    expect(JSON.parse((await server.handleLine("{oops"))!)).toMatchObject({ error: { code: -32700 } });
  });

  test("a failing tool is an error result, not a protocol error", async () => {
    const { server } = setup();
    const res = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_rows", arguments: { group: "Nope" } } })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toContain("No group named");
  });
});

describe("prompts", () => {
  test("listed, and each becomes one user message", async () => {
    const { server } = setup();
    const init = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as { result: { capabilities: Record<string, unknown> } };
    expect(init.result.capabilities.prompts).toEqual({ listChanged: false });
    const list = (await server.handle({ jsonrpc: "2.0", id: 2, method: "prompts/list" })) as { result: { prompts: { name: string; arguments: unknown[] }[] } };
    expect(list.result.prompts.map((p) => p.name)).toEqual(["translate", "fix_glossary", "learn_from_feedback"]);
    const get = async (name: string, args: Record<string, string> = {}) =>
      (await server.handle({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name, arguments: args } })) as {
        result?: { messages: { role: string; content: { type: string; text: string } }[] };
        error?: { code: number; message: string };
      };
    const t = await get("translate", { group: "Items.Helm", batch: "30" });
    expect(t.result!.messages).toHaveLength(1);
    expect(t.result!.messages[0]!.role).toBe("user");
    const text = t.result!.messages[0]!.content.text;
    for (const s of ['the group "Items.Helm"', "limit 30", "get_style_guide", "check_translation", "propose_translations", "Tiếng Việt", "%%"]) expect(text).toContain(s);
    expect(text).not.toContain("No style guide");
    expect((await get("translate")).result!.messages[0]!.content.text).toContain("list_groups");
    expect((await get("translate", { batch: "999" })).error!.message).toContain("batch");
    const fix = (await get("fix_glossary", { term: "Jewel" })).result!.messages[0]!.content.text;
    expect(fix).toContain('glossary_problems: true, limit 200, query "Jewel"');
    expect(fix).toContain('Only the glossaryProblems whose term contains "Jewel" are in scope');
    const learn = (await get("learn_from_feedback")).result!.messages[0]!.content.text;
    expect(learn).toContain('decisions "all"');
    expect(learn).not.toContain("press Save");
    expect((await get("nope")).error!.code).toBe(-32602);
    const bare = createPrompts({ locale: "vi", hasGlossary: false, hasStyle: false })[0]!.get({});
    expect(bare).toContain("No style guide was configured");
  });
});

describe("write guard", () => {
  test("only below the allowed folder", async () => {
    const mem = new MemoryStorage({});
    const g = new GuardedStorage(mem, PROPOSALS);
    await g.writeAtomic(`${PROPOSALS}/a.json`, enc("{}"));
    await g.writeAtomic(`${PROPOSALS}/decisions/a.json`, enc("{}"));
    await expect(g.writeAtomic(`${ROOT}/src/Localization/Game.vi.resx`, enc(""))).rejects.toThrow("only writes proposals");
    await expect(g.writeAtomic(`${ROOT}/.mumain-translator/project-vi.json`, enc(""))).rejects.toThrow();
    await expect(g.writeAtomic(`${PROPOSALS}/../draft-vi.json`, enc(""))).rejects.toThrow();
    await expect(g.remove(`${ROOT}/.mumain-translator/draft-vi.json`)).rejects.toThrow();
    expect([...mem.files.keys()].sort()).toEqual([`${PROPOSALS}/a.json`, `${PROPOSALS}/decisions/a.json`]);
  });
});

describe("reading tools", () => {
  test("workspace_info and list_groups", async () => {
    const { call } = setup();
    const info = await call("workspace_info");
    expect(info).toMatchObject({ root: ROOT, locale: "vi", glossary: { confirmed: 1, suggested: 1 }, styleGuide: "/kit/STYLE_vi.md", proposals: { undecided: 0 } });
    expect(info.sources.resx.dir).toBe("src/Localization");
    expect(info.sources.items.total).toBeGreaterThan(400);
    const groups = await call("list_groups", { source: "items" });
    expect(groups[0]).toMatchObject({ group: "Items.Sword", source: "items", itemGroup: 0, total: 34, untranslated: 17 });
  });

  test("get_rows: untranslated by default, paging, query", async () => {
    const { call } = setup();
    const game = await call("get_rows", { group: "Game" });
    expect(game.rows.map((r: { key: string }) => r.key)).toEqual(["Gulim", "Connecting to the server", "Level %d", "Chaos Castle"]); // Gulim: same as English
    const helm = await call("get_rows", { group: "Items.Helm", limit: 2, offset: 1 });
    expect(helm.rows).toEqual([
      { group: "Items.Helm", key: "3", item: "7:3", english: "Helm 3", translation: null, status: "untranslated" },
      { group: "Items.Helm", key: "5", item: "7:5", english: "Helm 5", translation: null, status: "untranslated" },
    ]);
    const found = await call("get_rows", { status: "any", query: "su kien" });
    expect(found.rows.map((r: { key: string }) => r.key)).toEqual(["Event"]);
    const issues = await call("get_rows", { group: "Game", status: "any", keys: ["Increase Max HP +4%%"] });
    expect(issues.rows[0].issues[0]).toContain("percent sign");
  });

  test("get_rows: translated rows that break a confirmed term", async () => {
    const { call, mem } = setup();
    // A confirmed term the sample translation does not follow ("ngắt kết nối").
    mem.files.set("/kit/glossary.tsv", enc(`${GLOSSARY}disconnected\tmất kết nối\t\t\t\tconfirmed\n`));
    const res = await call("get_rows", { glossary_problems: true });
    expect(res.rows.map((r: { key: string }) => r.key)).toEqual(["You have been disconnected from the server."]);
    expect(res.rows[0].glossaryProblems).toEqual(["“disconnected” should be “mất kết nối”"]);
  });

  test("glossary, style guide, examples", async () => {
    const { call } = setup();
    expect(await call("get_glossary", { text: "Enter the Chaos Castle" })).toEqual({ terms: [{ term: "Chaos Castle", translation: "Hỗn Nguyên Lâu" }] });
    expect((await call("get_glossary", { status: "suggested" })).entries).toEqual([
      { term: "Helm", translation: "Mũ", status: "suggested", category: "Item", source: "Mu VN" },
    ]);
    expect(await call("get_style_guide")).toContain("ta / ngươi");
    const ex = await call("find_examples", { query: "server" });
    expect(ex.examples).toEqual([{ group: "Game", key: "You have been disconnected from the server.", english: "You have been disconnected from the server.", translation: "Bạn đã bị ngắt kết nối khỏi máy chủ.", status: "translated" }]);
  });
});

describe("check and propose", () => {
  test("check_translation verdicts", async () => {
    const { call } = setup();
    const res = await call("check_translation", {
      items: [
        { group: "Game", key: "Level %d", value: "Cấp %d" },
        { group: "Game", key: "Level %d", value: "Cấp" },
        { group: "Game", key: "Chaos Castle", value: "Lâu Đài Hỗn Loạn" },
        { group: "Game", key: "Chaos Castle", value: "Lâu Đài Hỗn Loạn", note: "tên quen thuộc hơn" },
        { group: "Game", key: "Event", value: "Sự kiện" },
        { group: "Items.Sword", key: "1", value: "Kiếm||1" },
        { group: "Game", key: "Nope", value: "x" },
      ],
    });
    expect(res.map((r: { verdict: string }) => r.verdict)).toEqual(["ok", "rejected", "needs-note", "ok", "skipped", "rejected", "rejected"]);
    expect(res[1].reason).toContain("Placeholders differ");
    expect(res[2].reason).toContain("“Chaos Castle” should be “Hỗn Nguyên Lâu”");
    expect(res[0]).toMatchObject({ status: "untranslated", current: "" });
  });

  test("propose_translations writes one file with english / base; the UI side sees it", async () => {
    const { call, mem } = setup();
    const res = await call("propose_translations", {
      note: "đợt 1",
      items: [
        { group: "Game", key: "Level %d", value: "Cấp %d", note: "" },
        { group: "Game", key: "Chaos Castle", value: "Hỗn Nguyên Lâu" },
        { group: "Game", key: "Chaos Castle", value: "Hỗn Nguyên Lâu 2" },
        { group: "Game", key: "Connecting to the server", value: "Đang kết nối" },
        { group: "Game", key: "Level %d", value: "Cấp" },
      ],
    });
    expect(res.written).toBe(3);
    expect(res.notWritten.map((n: { key: string; verdict: string }) => [n.key, n.verdict])).toEqual([
      ["Chaos Castle", "skipped"],
      ["Level %d", "rejected"],
    ]);
    const file = JSON.parse(dec(mem.files.get(`${PROPOSALS}/${res.file}`)!));
    expect(file).toMatchObject({ version: 1, locale: "vi", by: "AI (test)", note: "đợt 1" });
    expect(file.items[1]).toEqual({ group: "Game", key: "Chaos Castle", english: "Chaos Castle", base: "", value: "Hỗn Nguyên Lâu", note: "" });
    // Nothing but the proposal was written.
    expect([...mem.files.keys()].filter((k) => k.includes(".mumain-translator"))).toEqual([`${PROPOSALS}/${res.file}`]);

    // The same text again: already proposed. Undecided rows are left out of get_rows.
    const again = await call("propose_translations", { items: [{ group: "Game", key: "Chaos Castle", value: "Hỗn Nguyên Lâu" }] });
    expect([again.written, again.file, again.notWritten[0].reason]).toEqual([0, null, "Already proposed with the same text (undecided)."]);
    expect((await call("get_rows", { group: "Game" })).rows.map((r: { key: string }) => r.key)).toEqual(["Gulim"]);
    const withProposals = await call("get_rows", { group: "Game", skip_proposed: false });
    expect(withProposals.rows[1].pendingProposal).toBe("Đang kết nối");
  });

  test("a reviewed row is not proposable", async () => {
    const files = sampleCheckout(ROOT);
    files[`${ROOT}/.mumain-translator/project-vi.json`] = enc(
      JSON.stringify({ version: 1, locale: "vi", bases: {}, records: { Game: { Event: { status: "reviewed", note: "", translator: "An", updatedAt: "" } } } }),
    );
    const session = new Session(new GuardedStorage(new MemoryStorage(files), PROPOSALS), undefined, "win32");
    const [propose] = createTools({ session, folder: ROOT, locale: "vi", glossary: null, style: null, by: "AI" }).filter((t) => t.name === "propose_translations");
    const res = (await propose!.run({ items: [{ group: "Game", key: "Event", value: "Sự Kiện" }] })) as { written: number; notWritten: { reason: string }[] };
    expect([res.written, res.notWritten[0]!.reason]).toEqual([0, "The row is reviewed: do not change it."]);
  });

  test("decisions come back through list_proposals; withdraw", async () => {
    const { call, mem } = setup();
    const a = await call("propose_translations", {
      items: [
        { group: "Game", key: "Chaos Castle", value: "Hỗn Nguyên Lâu" },
        { group: "Game", key: "Connecting to the server", value: "Đang kết nối" },
      ],
    });
    const b = await call("propose_translations", { items: [{ group: "Items.Helm", key: "3", value: "Mũ Ba" }, { group: "Items.Helm", key: "5", value: "Mũ Năm" }] });

    // The person decides in MuMain-translator (a Session with full access to the same files).
    const ui = new Session(mem, undefined, "win32");
    await ui.openFolder(ROOT, "vi");
    await ui.decideProposals(
      [
        { file: a.file, index: 0, action: "reject", reason: "dùng tên cũ" },
        { file: a.file, index: 1, action: "accept", value: "Đang kết nối máy chủ" },
      ],
      "An",
    );
    const list = await call("list_proposals");
    expect(list.undecided).toEqual([{ file: b.file, createdAt: expect.any(String), by: "AI (test)", items: 2, undecided: 2 }]);
    expect(list.decisions.map((d: { key: string; action: string }) => [d.key, d.action])).toEqual([
      ["Chaos Castle", "rejected"],
      ["Connecting to the server", "edited"],
    ]);
    expect(list.decisions[0].reason).toBe("dùng tên cũ");
    expect(list.decisions[1].taken).toBe("Đang kết nối máy chủ");

    expect(await call("withdraw_proposals", { file: b.file, keys: [{ group: "Items.Helm", key: "3" }] })).toEqual({ withdrawn: 1, fileRemoved: false });
    expect(await call("withdraw_proposals", { file: b.file })).toEqual({ withdrawn: 1, fileRemoved: true });
    expect(mem.files.has(`${PROPOSALS}/${b.file}`)).toBe(false);
    expect((await ui.proposals()).items).toEqual([]);
  });
});

describe("stdio", () => {
  test("the mcp command answers over stdin / stdout and writes only proposals", async () => {
    const dir = writeSampleCheckout(fs.mkdtempSync(path.join(os.tmpdir(), "mumain-mcp-")));
    const main = path.join(import.meta.dir, "../src/server/main.ts");
    const proc = Bun.spawn(["bun", main, "mcp", dir, "--locale", "vi"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const send = (m: object) => proc.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "propose_translations", arguments: { items: [{ group: "Game", key: "Chaos Castle", value: "Hỗn Nguyên Lâu" }] } } });
    proc.stdin.end();
    const out = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    await proc.exited;
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[0].result.serverInfo.name).toBe("mumain-translator");
    expect(JSON.parse(out[1].result.content[0].text).written).toBe(1);
    const side = fs.readdirSync(path.join(dir, ".mumain-translator"), { recursive: true }).map(String).sort();
    expect(side.length).toBe(2); // proposals/ and proposals/<file>
    expect(side.every((f) => f.startsWith("proposals"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
