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

/** Known cases the backend marks with a `code`, as set in src-tauri/src/pipeline.rs. */
export const ERROR_CODES = [
  "no_transactions",
  "not_reconciled",
  "no_bank_match",
  "not_pdf",
  "file_missing",
  "receipt_outside_period",
  "read_timeout",
] as const;

function isKnownCode(code: string | undefined): code is (typeof ERROR_CODES)[number] {
  return code !== undefined && (ERROR_CODES as readonly string[]).includes(code);
}

export interface CommandError {
  kind: ErrorKind;
  message: string;
  /** A known case with its own sentence under `errors.codes`. */
  code?: string;
}

export function isCommandError(e: unknown): e is CommandError {
  if (typeof e !== "object" || e === null) {
    return false;
  }
  const candidate = e as Record<string, unknown>;
  return (
    typeof candidate.kind === "string" &&
    (ERROR_KINDS as readonly string[]).includes(candidate.kind) &&
    typeof candidate.message === "string" &&
    (candidate.code === undefined || typeof candidate.code === "string")
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

/** Kinds whose sentence says everything the backend message does. */
const SELF_EXPLAINING: readonly ErrorKind[] = ["cancelled", "timeout", "read_only"];

/**
 * A sentence for the user describing why a command failed, in the current language. A known
 * code has its own sentence; otherwise the kind does. The backend's message is never part of it.
 */
export function friendlyError(e: unknown, t: TFunction): string {
  if (isCommandError(e)) {
    if (isKnownCode(e.code)) {
      return t(`errors.codes.${e.code}`);
    }
    return t(`errors.${e.kind}`);
  }
  return t("errors.internal");
}

/**
 * The backend's own words for a failure, for a secondary line under the sentence. Null when the
 * sentence already says it all.
 */
export function errorDetail(e: unknown): string | null {
  if (isCommandError(e)) {
    if (isKnownCode(e.code) || SELF_EXPLAINING.includes(e.kind)) {
      return null;
    }
    return e.message.trim() || null;
  }
  return rawMessage(e).trim() || null;
}
