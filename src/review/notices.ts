import type { TFunction } from "i18next";
import type { IconName } from "../components/Icon";
import type { AddStatementsResult, ScanResult } from "../lib/tauri";

/** A short message over the list, such as a rule that was added or what a scan found. */
export type Notice = { tone: "success" | "info"; text: string; icon?: IconName };

/** "3 new receipts · 1 matched", or that the scan found nothing new. */
export function scanNotice(result: ScanResult, t: TFunction): Notice {
  if (result.new_receipts === 0 && result.newly_matched === 0) {
    return { tone: "info", text: t("review.result.noNewReceipts"), icon: "scan" };
  }
  const parts = [t("review.result.newReceipts", { count: result.new_receipts })];
  if (result.newly_matched > 0) {
    parts.push(t("review.result.matched", { count: result.newly_matched }));
  }
  return { tone: "success", text: parts.join(" · ") };
}

/** "3 transactions added · 1 duplicate skipped · 2 matched". */
export function addNotice(result: AddStatementsResult, t: TFunction): Notice {
  const parts = [t("review.result.added", { count: result.added })];
  if (result.duplicates_skipped > 0) {
    parts.push(t("review.result.skipped", { count: result.duplicates_skipped }));
  }
  if (result.newly_matched > 0) {
    parts.push(t("review.result.matched", { count: result.newly_matched }));
  }
  return result.added > 0 ? { tone: "success", text: parts.join(" · ") } : { tone: "info", text: parts.join(" · "), icon: "doc" };
}
