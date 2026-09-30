import { describe, expect, test } from "bun:test";
import { hasKeepMark, parseLegacyIds, withKeepMark } from "../src/core";

describe("keep mark", () => {
  test("read", () => {
    expect(hasKeepMark("legacy_id=0,18; keep")).toBe(true);
    expect(hasKeepMark("KEEP")).toBe(true);
    expect(hasKeepMark("Keep this window open")).toBe(false);
    expect(hasKeepMark("legacy_id=1")).toBe(false);
    expect(hasKeepMark(null)).toBe(false);
  });

  test("add / remove, legacy ids untouched", () => {
    expect(withKeepMark("legacy_id=0,18", true)).toBe("legacy_id=0,18; keep");
    expect(withKeepMark(null, true)).toBe("keep");
    expect(withKeepMark("legacy_id=0,18; keep", false)).toBe("legacy_id=0,18");
    expect(withKeepMark("keep", false)).toBeNull();
    expect(withKeepMark("legacy_id=1; keep", true)).toBe("legacy_id=1; keep");
    expect(parseLegacyIds(withKeepMark("legacy_id=0,18", true))).toEqual([0, 18]);
  });
});
