import type { TFunction } from "i18next";
import type { AlertRequest } from "../lib/tauri";
import type { FinalizeCounts } from "./effective";

/**
 * The alert that confirms Finalize, which sorts every receipt into folders and saves the report.
 * It lists the receipts by where they go, leaving out empty groups. While transactions still need
 * a decision, it offers Review Remaining, which goes to the first of them.
 */
export function finalizeAlert(
  {
    period,
    counts,
    pending,
    refused,
  }: {
    /** The month's name, such as "March 2030". */
    period: string;
    counts: FinalizeCounts;
    /** Transactions still needing a decision. */
    pending: number;
    /** Files left in the receipts folder because Concilia can't read them. */
    refused: number;
  },
  t: TFunction,
  language: string,
): AlertRequest {
  const groups = [
    { key: "matched", count: counts.matched },
    { key: "review", count: counts.review },
    { key: "unmatched", count: counts.unmatched },
  ].filter((group) => group.count > 0);
  const parts = new Intl.ListFormat(language, { type: "conjunction" }).format(
    groups.map((group) => t(`review.finalizeConfirm.groups.${group.key}`, { count: group.count })),
  );
  const lines = [t("review.finalizeConfirm.moves", { count: counts.total, parts })];
  if (refused > 0) {
    lines.push(t("review.finalizeConfirm.refused", { count: refused }));
  }
  lines.push(t("review.finalizeConfirm.report"), t("review.finalizeConfirm.later"));
  if (pending > 0) {
    lines.push(t("review.finalizeConfirm.pending", { count: pending }));
  }
  return {
    title: t("review.finalizeConfirm.title", { period }),
    message: lines.join("\n\n"),
    confirm: t("review.finalizeConfirm.confirm"),
    cancel: t("common.cancel"),
    alternate: pending > 0 ? t("review.finalizeConfirm.reviewRemaining") : undefined,
  };
}
