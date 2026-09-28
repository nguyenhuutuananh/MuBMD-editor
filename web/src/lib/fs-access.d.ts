// File System Access API pieces not (yet) in TypeScript's lib.dom (Chrome / Edge only).
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
}

interface OpenFilePickerOptions {
  id?: string;
  multiple?: boolean;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
}

interface SaveFilePickerOptions {
  id?: string;
  suggestedName?: string;
  types?: FilePickerAcceptType[];
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
}

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
