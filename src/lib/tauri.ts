// Typed wrappers around the Tauri commands the windows use.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface PopplerStatus {
  version: string;
  bundled: boolean;
}

export function popplerStatus(): Promise<PopplerStatus> {
  return invoke<PopplerStatus>("poppler_status");
}

/** URL of a receipt file served by the `receipt://` scheme, from its period-relative path. */
export function receiptUrl(relativePath: string): string {
  return convertFileSrc(relativePath, "receipt");
}
