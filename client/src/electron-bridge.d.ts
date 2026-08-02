// Shared global type for the Electron preload bridge exposed via
// contextBridge.exposeInMainWorld('concilia', ...) in electron/preload.js.
// Imported implicitly by all .ts files in this project (see tsconfig include).
export {};

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
}

declare global {
  interface Window {
    concilia?: {
      bootLanguage?: string;
      getConfig: () => Promise<Record<string, unknown>>;
      setConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown> & { error?: string }>;
      pickFolder: () => Promise<string | null>;
      pickFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
      checkUpdate: () => Promise<UpdateCheckResult>;
      getVersion: () => Promise<string>;
    };
  }
}
