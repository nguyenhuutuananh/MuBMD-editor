// registration.ts - Is a locale selectable in the game? ResxGen compiles every <Group>.<locale>.resx
// it finds, but two hand-written lists must know the locale too (docs/MuMain-issues_vi.md, issue 2):
//   src/source/UI/NewUI/Options/NewUIOptionWindow.cpp   s_Languages: the language combo in Options
//   tools/ResxGen/CppEmitter.cs                          display names ("Tiếng Việt")
// Pure logic on the file texts: finds the entries and builds the line to add, placed in
// alphabetical order like the existing ones. The tool never edits these files.

export interface RegistrationCheck {
  registered: boolean;
  codes: string[]; // locales listed in the file
  line: string; // the line to add (when not registered)
  after: string | null; // add it after the entry of this locale (null: before the first one)
}

// L"..." wide literal with \uXXXX for every non-ASCII character, as NewUIOptionWindow.cpp writes them
// (so MSVC reads them right whatever the source charset).
export function wideLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 && ch !== '"' && ch !== "\\") out += ch;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `L"${out}"`;
}

// The entry to add the new line after: s_Languages has en first, then alphabetical;
// CppEmitter.cs is alphabetical, en included.
function place(codes: string[], locale: string, enFirst: boolean): string | null {
  const before = codes.filter((c) => (enFirst ? c !== "en" : true) && c < locale).sort();
  if (before.length) return before[before.length - 1]!;
  return enFirst && codes.includes("en") ? "en" : null;
}

const pad = (code: string, width: number) => `"${code}",`.padEnd(width);

export function checkOptionWindow(cpp: string, locale: string, displayName: string): RegistrationCheck {
  const codes = [...cpp.matchAll(/\{\s*"([A-Za-z0-9-]+)"\s*,\s*L"/g)].map((m) => m[1]!);
  const name = displayName === locale ? locale : displayName;
  const comment = /[^\u0000-\u007f]/.test(name) ? ` // ${name}` : "";
  return {
    registered: codes.includes(locale),
    codes,
    line: `    { ${pad(locale, 9)}${wideLiteral(name)} },${comment}`,
    after: place(codes, locale, true),
  };
}

export function checkEmitter(cs: string, locale: string, displayName: string): RegistrationCheck {
  const codes = [...cs.matchAll(/\["([A-Za-z0-9-]+)"\]\s*=\s*"/g)].map((m) => m[1]!);
  return {
    registered: codes.includes(locale),
    codes,
    line: `            ${`["${locale}"]`.padEnd(10)}= "${displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}",`,
    after: place(codes, locale, false),
  };
}
