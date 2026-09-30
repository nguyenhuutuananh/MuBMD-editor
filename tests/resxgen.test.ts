import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkBuild, isBlankKey, parseResx, resxValues, toIdentifier } from "../src/core";

describe("toIdentifier (Naming.ToIdentifier)", () => {
  test("PascalCase from ASCII letters and digits", () => {
    expect(toIdentifier("Save Skills")).toBe("SaveSkills");
    expect(toIdentifier("Are you sure?")).toBe("AreYouSure");
    expect(toIdentifier("BlessAegis Mining Lab")).toBe("BlessAegisMiningLab");
    expect(toIdentifier("FindHack file is damaged. Please reinstall MU client.")).toBe("FindHackFileIsDamagedPleaseReinstallMUClient");
    expect(toIdentifier("~ <msg>: Message to party members")).toBe("MsgMessageToPartyMembers");
    expect(toIdentifier("Index {0} is already in use")).toBe("Index0IsAlreadyInUse");
  });

  test("leading digit, one-letter slugs, non-ASCII", () => {
    expect(toIdentifier("3 days")).toBe("_3Days");
    expect(toIdentifier("%s")).toBe("S");
    expect(toIdentifier("À%s")).toBe(""); // one letter from a non-ASCII key: dropped
    expect(toIdentifier("Mũ Rồng")).toBe("MRNg"); // non-ASCII letters are word breaks
    expect(toIdentifier("몬스터")).toBe("");
    expect(toIdentifier("😀ab")).toBe("Ab");
  });

  test("blank keys", () => {
    expect(isBlankKey(" \t")).toBe(true);
    expect(isBlankKey("\u0085")).toBe(true);
    expect(isBlankKey("﻿")).toBe(false);
    expect(isBlankKey("a")).toBe(false);
  });
});

describe("checkBuild", () => {
  const doc = (entries: Array<[string, string?]>) =>
    parseResx(
      `<root>${entries
        .map(([k, c]) => `<data name="${k}"><value>${k}</value>${c ? `<comment>${c}</comment>` : ""}</data>`)
        .join("")}</root>`,
    );

  test("reports every ResxGen error, not only the first", () => {
    const long = "Word ".repeat(14); // 14 x "Word" = 56 chars: fine
    const tooLong = "Word ".repeat(17); // 68 chars
    const { issues, identifiers } = checkBuild(
      doc([
        ["Save Items", "legacy_id=1"],
        ["Save-Items"],
        [long],
        [tooLong],
        ["몬스터"],
        [" "],
        ["Other", "legacy_id=2, 1"],
      ]),
    );
    expect(issues.map((i) => [i.code, i.key, i.params])).toEqual([
      ["identifier-collision", "Save-Items", { identifier: "SaveItems", other: "Save Items" }],
      ["identifier-too-long", tooLong, { identifier: "Word".repeat(17), length: 68, max: 64 }],
      ["no-identifier", "몬스터", {}],
      ["blank-key", " ", {}],
      ["legacy-id-collision", "Other", { legacyId: 1, other: "Save Items" }],
    ]);
    expect([...identifiers.keys()]).toEqual(["Save Items", long, "Other"]);
  });
});

// The build output of a MuMain checkout (MUMAIN_DIR, built at least once: out/build/<preset>/),
// when there is one: every accessor ResxGen declared must be the identifier this port computes.
const MUMAIN = process.env.MUMAIN_DIR ?? "";
function generatedDir(): string {
  const builds = MUMAIN ? path.join(MUMAIN, "out/build") : "";
  if (!builds || !fs.existsSync(builds)) return "";
  for (const preset of fs.readdirSync(builds).sort()) {
    const dir = path.join(builds, preset, "Generated/I18N");
    if (fs.existsSync(path.join(dir, "Game.h"))) return dir;
  }
  return "";
}
const GENERATED = generatedDir();
const haveGenerated = GENERATED !== "";

describe.skipIf(!haveGenerated)("identifiers match the generated headers", () => {
  test.each(["Game", "Dialog", "Editor", "Metadata"])("%s.h", (group) => {
    const header = fs.readFileSync(path.join(GENERATED, `${group}.h`), "utf-8");
    const declared = [...header.matchAll(/^extern const \w+\* (\w+);   \/\/ (.*)$/gm)].map((m) => ({ id: m[1]!, key: m[2]! }));
    expect(declared.length).toBeGreaterThan(0);
    const en = parseResx(new Uint8Array(fs.readFileSync(path.join(MUMAIN, "src/Localization", `${group}.en.resx`))));
    const keys = new Map([...resxValues(en).keys()].map((k) => [k.replace(/[\r\n]/g, " "), k]));
    let checked = 0;
    for (const d of declared) {
      const key = keys.get(d.key);
      if (key === undefined) continue; // the key changed since that build
      expect([d.key, toIdentifier(key)]).toEqual([d.key, d.id]);
      checked++;
    }
    expect(checked / declared.length).toBeGreaterThan(0.9);
    // Same set in the other direction.
    const ids = new Set(declared.map((d) => d.id));
    const build = checkBuild(en);
    const missing = [...build.identifiers.values()].filter((id) => !ids.has(id));
    expect(missing.length / declared.length).toBeLessThan(0.1);
  });
});
