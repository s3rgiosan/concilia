import type { TFunction } from "i18next";

/** Error kinds the backend reports, as `ErrorKind` in src-tauri/src/error.rs. */
export const ERROR_KINDS = [
  "invalid_input",
  "not_found",
  "busy",
  "not_configured",
  "keychain",
  "unauthorized",
  "network",
  "poppler_missing",
  "parse",
  "finalized",
  "cancelled",
  "timeout",
  "read_only",
  "io",
  "internal",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface CommandError {
  kind: ErrorKind;
  message: string;
}

export function isCommandError(e: unknown): e is CommandError {
  if (typeof e !== "object" || e === null) {
    return false;
  }
  const candidate = e as Record<string, unknown>;
  return (
    typeof candidate.kind === "string" &&
    (ERROR_KINDS as readonly string[]).includes(candidate.kind) &&
    typeof candidate.message === "string"
  );
}

/** The error's kind, when it came from a command. */
export function errorKind(e: unknown): ErrorKind | null {
  return isCommandError(e) ? e.kind : null;
}

function rawMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return "";
}

/** A sentence for the user describing why a command failed, in the current language. */
export function friendlyError(e: unknown, t: TFunction): string {
  if (isCommandError(e)) {
    return t(`errors.${e.kind}`, { message: e.message });
  }
  const message = rawMessage(e);
  return message ? t("errors.internal", { message }) : t("errors.unknown");
}
