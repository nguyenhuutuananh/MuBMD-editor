// fileTransfer.ts - Upload / download for browsers without the File System Access API.

// Let the user choose a file; null if they cancel. Must run while handling a click.
export function uploadFile(accept: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.hidden = true;
    document.body.append(input); // some browsers only open the dialog for inputs in the page
    const done = (v: { name: string; bytes: Uint8Array } | null) => {
      input.remove();
      resolve(v);
    };
    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      done(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    });
    input.click();
  });
}

// Let the user choose a folder (Firefox / Safari support this through "webkitdirectory"); null if
// they cancel. `keep` picks the files to read, by their path relative to the parent of the folder
// ("Game/Data/Items/Group00_Sword.json"); the others are never read. Must run while handling a click.
export function uploadFolder(keep: (relativePath: string) => boolean): Promise<{ root: string; files: { path: string; bytes: Uint8Array }[] } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.hidden = true;
    document.body.append(input);
    const done = (v: Awaited<ReturnType<typeof uploadFolder>>) => {
      input.remove();
      resolve(v);
    };
    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", async () => {
      const all = [...(input.files ?? [])];
      if (!all.length) return done(null);
      const root = all[0]!.webkitRelativePath.split("/")[0] || "folder";
      const files = await Promise.all(
        all
          .filter((f) => keep(f.webkitRelativePath))
          .map(async (f) => ({ path: f.webkitRelativePath, bytes: new Uint8Array(await f.arrayBuffer()) })),
      );
      done({ root, files });
    });
    input.click();
  });
}

// Hand the bytes to the browser as a download (it saves to the Downloads folder, or asks).
export function downloadFile(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as ArrayBuffer], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
