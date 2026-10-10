// What Reject does for a transaction in the review.

import type { Transaction } from "../lib/tauri";
import type { RejectKind } from "../lib/menuCommands";
import { isNoReceipt } from "./effective";

/** What Reject does for a transaction, which names its menu item and button. */
export function rejectKindOf(tx: Transaction | null): RejectKind {
  if (tx?.status === "REVIEW") {
    return "noneOfThese";
  }
  if (tx && isNoReceipt(tx.notes)) {
    return "needsReceipt";
  }
  return "removeMatch";
}
