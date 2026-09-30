// tag.ts - Create the next release tag (and push it). A pushed tag v<version> runs
// .github/workflows/release.yml, which requires the tag to equal "version" in package.json, so the
// version is written to package.json and committed ("chore: release vX.Y.Z") before tagging.
//
//   bun run tag                              ask everything
//   bun run tag -- patch|minor|major|1.4.0   choose the version (after a pre-release also: release, pre)
//            [--push | --no-push]            push the commit + tag, or only create them locally
//            [--checks | --no-checks]        run typecheck + unit tests first (asked by default)
//            [--yes]                         no questions: default answers (checks on, no push)
//
// Refuses to run with uncommitted changes, an existing tag, or a version not above the latest tag
// (unless confirmed). Nothing is changed before the last confirmation.

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const pkgPath = path.join(root, "package.json");

// ---- helpers ----

function git(...args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function mustGit(...args: string[]): string {
  const r = git(...args);
  if (!r.ok) fail(`git ${args.join(" ")} failed:\n${r.err || r.out}`);
  return r.out;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string; // "" or e.g. "beta.1"
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(s: string): Version | null {
  const m = SEMVER.exec(s.trim());
  return m ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? "" } : null;
}

const str = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;

// Semver order: a pre-release comes before its release (2.1.0-beta.1 < 2.1.0).
function compare(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function bump(v: Version, kind: "patch" | "minor" | "major"): Version {
  // A pre-release bumps to its own release (2.1.0-beta.1 + patch = 2.1.0).
  if (v.pre && (kind === "patch" || (kind === "minor" && v.patch === 0) || (kind === "major" && v.minor === 0 && v.patch === 0))) {
    return { ...v, pre: "" };
  }
  if (kind === "patch") return { ...v, patch: v.patch + 1, pre: "" };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0, pre: "" };
  return { major: v.major + 1, minor: 0, patch: 0, pre: "" };
}

// ---- arguments ----

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const yes = flag("yes");
const choiceArg = args.find((a) => !a.startsWith("--"));
const pushArg = flag("push") ? true : flag("no-push") ? false : null;
const checksArg = flag("checks") ? true : flag("no-checks") ? false : null;

function ask(question: string, fallback: string): string {
  if (yes) return fallback;
  const answer = prompt(question);
  if (answer === null) fail("Cancelled.");
  return answer.trim() || fallback;
}

const askYesNo = (question: string, fallback: boolean) => {
  const a = ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`, fallback ? "y" : "n").toLowerCase();
  return a === "y" || a === "yes" || a === "c" || a === "có";
};

// ---- state of the repository ----

if (!git("rev-parse", "--is-inside-work-tree").ok) fail("Not inside a git repository.");
const dirty = mustGit("status", "--porcelain");
if (dirty) fail(`Uncommitted changes - commit or stash them first:\n${dirty}`);

const branch = mustGit("rev-parse", "--abbrev-ref", "HEAD");
if (branch === "HEAD") fail("Detached HEAD: check out a branch first.");
if (branch !== "main" && !askYesNo(`You are on "${branch}", not "main". Continue?`, false)) fail("Cancelled.");

const remote = git("remote", "get-url", "origin");
if (remote.ok) {
  // Tags created elsewhere (e.g. by a teammate) count too; offline is fine.
  const fetched = git("fetch", "--tags", "--quiet", "origin");
  if (!fetched.ok) console.log("(Could not fetch tags from origin - using the local tags only.)");
}

const tags = mustGit("tag", "--list", "v*")
  .split("\n")
  .map((t) => ({ tag: t, v: parse(t) }))
  .filter((t): t is { tag: string; v: Version } => t.v !== null)
  .sort((a, b) => compare(b.v, a.v));
const latest = tags[0]?.v ?? null;

const pkgText = fs.readFileSync(pkgPath, "utf-8");
const pkgVersion = parse(JSON.parse(pkgText).version ?? "");
if (!pkgVersion) fail(`package.json has no valid "version".`);

// ---- choose the version ----

const base = latest && compare(latest, pkgVersion) > 0 ? latest : pkgVersion;
const untagged = !tags.some((t) => compare(t.v, pkgVersion) === 0) && (!latest || compare(pkgVersion, latest) > 0);
// After a pre-release (2.1.0-beta.1): its release, or the next pre-release (2.1.0-beta.2).
const nextPre = base.pre && /\d+$/.test(base.pre) ? { ...base, pre: base.pre.replace(/\d+$/, (n) => String(Number(n) + 1)) } : null;
const candidates: { key: string; label: string; v: Version | null }[] = [
  ...(untagged ? [{ key: "current", label: "package.json (not tagged yet)", v: pkgVersion }] : []),
  ...(base.pre ? [{ key: "release", label: `release - finish ${str(base)}`, v: { ...base, pre: "" } }] : []),
  ...(nextPre ? [{ key: "pre", label: "pre     - next pre-release", v: nextPre }] : []),
  { key: "patch", label: "patch   - fixes only", v: bump(base, "patch") },
  { key: "minor", label: "minor   - new features, compatible", v: bump(base, "minor") },
  { key: "major", label: "major   - breaking changes", v: bump(base, "major") },
  { key: "custom", label: "custom  - type a version (e.g. 2.1.0-beta.1)", v: null },
];
// The same version twice (a pre-release bumps to its release) is listed once, under its first name.
const options = candidates.filter((o, i) => !o.v || candidates.findIndex((x) => x.v && str(x.v) === str(o.v!)) === i);

console.log(`\nLatest tag:           ${tags[0]?.tag ?? "(none)"}`);
console.log(`package.json version: ${str(pkgVersion)}`);
console.log(`Branch:               ${branch}${remote.ok ? ` (origin: ${remote.out})` : " (no origin)"}\n`);

let chosen: Version | null = null;
if (choiceArg) {
  const byKey = options.find((o) => o.key === choiceArg);
  chosen = byKey?.v ?? parse(choiceArg);
  if (!chosen) fail(`"${choiceArg}" is neither patch / minor / major nor a version like 1.4.0.`);
} else {
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.v ? `v${str(o.v)}`.padEnd(16) : "".padEnd(16)} ${o.label}`));
  const pick = ask(`\nNext version [1-${options.length}, default 1]:`, "1");
  const o = options[Number(pick) - 1];
  if (!o) fail(`No option "${pick}".`);
  if (o.v) chosen = o.v;
  else {
    const typed = ask("Version (e.g. 2.1.0 or 2.1.0-beta.1):", "");
    chosen = parse(typed);
    if (!chosen) fail(`"${typed}" is not a version like 2.1.0 or 2.1.0-beta.1.`);
  }
}

const version = str(chosen);
const tag = `v${version}`;
if (tags.some((t) => t.tag === tag) || git("rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok) fail(`Tag ${tag} already exists.`);
if (latest && compare(chosen, latest) <= 0) {
  if (yes) fail(`${tag} is not above the latest tag ${tags[0]!.tag} (run without --yes to confirm it).`);
  if (!askYesNo(`${tag} is not above the latest tag ${tags[0]!.tag}. Continue anyway?`, false)) fail("Cancelled.");
}

// ---- checks, then confirm ----

const runChecks = checksArg ?? askYesNo("Run typecheck + unit tests first?", true);
if (runChecks) {
  for (const cmd of [["bun", "run", "typecheck"], ["bun", "test"]]) {
    console.log(`\n$ ${cmd.join(" ")}`);
    const p = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) fail(`${cmd.join(" ")} failed - nothing was tagged.`);
  }
}

const needsBump = compare(chosen, pkgVersion) !== 0;
const push = pushArg ?? (remote.ok ? askYesNo(`\nPush ${branch} and ${tag} to origin now (starts the release on GitHub)?`, false) : false);

console.log("\nAbout to:");
if (needsBump) console.log(`  - set package.json version ${str(pkgVersion)} -> ${version} and commit "chore: release ${tag}"`);
console.log(`  - create the tag ${tag} on ${needsBump ? "that commit" : `HEAD (${mustGit("log", "-1", "--format=%h %s")})`}`);
console.log(push ? `  - push ${branch} and ${tag} to origin` : "  - not push (only local)");
if (!askYesNo("Go ahead?", true)) fail("Cancelled - nothing was changed.");

// ---- do it ----

if (needsBump) {
  // Only the version value changes; the rest of package.json is kept as written.
  const next = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === pkgText) fail(`Could not find "version" in package.json.`);
  fs.writeFileSync(pkgPath, next);
  mustGit("add", "package.json");
  mustGit("commit", "-q", "-m", `chore: release ${tag}`);
}
mustGit("tag", "-a", tag, "-m", `Release ${tag}`);
console.log(`\n✓ Created ${tag}${needsBump ? ` (with commit "chore: release ${tag}")` : ""}.`);

if (push) {
  const b = git("push", "origin", branch);
  if (!b.ok) fail(`Pushing ${branch} failed (the tag stays local):\n${b.err}\nFix it, then: git push origin ${branch} && git push origin ${tag}`);
  const t = git("push", "origin", tag);
  if (!t.ok) fail(`Pushing ${tag} failed:\n${t.err}\nTry again: git push origin ${tag}`);
  const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote.out)?.[1];
  console.log(`✓ Pushed ${branch} and ${tag}.${repo ? `\n  The release runs at https://github.com/${repo}/actions` : ""}`);
} else {
  console.log("\nNot pushed. When ready:");
  console.log(`  git push origin ${branch} && git push origin ${tag}`);
  console.log("To undo instead:");
  console.log(`  git tag -d ${tag}${needsBump ? " && git reset --soft HEAD~1 && git restore --staged package.json && git checkout package.json" : ""}`);
}
