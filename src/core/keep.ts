// keep.ts - The "stay English" mark of a translated entry, kept in its <comment> so it travels
// with the file (git, Drive) and is visible without this tool:
//   <comment>legacy_id=0,18; keep</comment>
// The comment is read as ';'-separated fields; the mark is a field that is exactly "keep"
// (any case). ResxGen only looks for "legacy_id=..." in comments, so the build is unaffected.

export const KEEP_MARK = "keep";

const fields = (comment: string | null): string[] =>
  (comment ?? "")
    .split(";")
    .map((f) => f.trim())
    .filter((f) => f !== "");

const isMark = (f: string) => f.toLowerCase() === KEEP_MARK;

export function hasKeepMark(comment: string | null): boolean {
  return fields(comment).some(isMark);
}

// The comment with the mark added / removed (null when nothing is left).
export function withKeepMark(comment: string | null, keep: boolean): string | null {
  if (hasKeepMark(comment) === keep) return comment;
  const rest = fields(comment).filter((f) => !isMark(f));
  const next = keep ? [...rest, KEEP_MARK] : rest;
  return next.length ? next.join("; ") : null;
}
