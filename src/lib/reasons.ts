// The no-receipt reasons: why a transaction needs no receipt. A marked transaction stores its
// reason's id as `notes`.

import { createContext, useContext } from "react";
import type { Reason } from "./tauri";

/** The reason that stays in every list. Transactions marked with a deleted reason show as this one. */
export const OTHER_REASON = "no_receipt";

/** The ids of the reasons Concilia ships with. */
export const SHIPPED_REASONS: readonly string[] = ["bank_fee", "salary", "transfer", "refund", OTHER_REASON];

/** The start of the id of a reason the user added. */
const CUSTOM_REASON_PREFIX = "reason:";

/** The start of a reason's menu item id; the reason id follows. */
export const REASON_MENU_PREFIX = "no_receipt_";

/** Whether `notes` is a reason id, so the transaction needs no receipt. True also for a deleted reason's id. */
export function isReasonId(notes: string): boolean {
  if (SHIPPED_REASONS.includes(notes)) {
    return true;
  }
  return notes.startsWith(CUSTOM_REASON_PREFIX) && notes.slice(CUSTOM_REASON_PREFIX.length).trim() !== "";
}

/** A new id for a reason the user adds. */
export function newReasonId(): string {
  return `${CUSTOM_REASON_PREFIX}${crypto.randomUUID()}`;
}

/** The reason's name in `language`, or its name in the other language when that one is blank. */
export function reasonName(reason: Reason, language: string): string {
  const pt = language.startsWith("pt");
  const first = pt ? reason.names.pt : reason.names.en;
  const second = pt ? reason.names.en : reason.names.pt;
  return first || second;
}

/** The name of the reason `id` in `language`. A deleted reason reads as the Other reason. */
export function reasonLabel(reasons: readonly Reason[], id: string, language: string): string {
  const reason = reasons.find((r) => r.id === id) ?? reasons.find((r) => r.id === OTHER_REASON);
  return reason ? reasonName(reason, language) : id;
}

/** The no-receipt reasons the window shows, in menu order. */
export const ReasonsContext = createContext<readonly Reason[]>([]);

export function useReasons(): readonly Reason[] {
  return useContext(ReasonsContext);
}
