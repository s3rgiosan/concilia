import { useTranslation } from "react-i18next";
import { Sheet, SheetNote } from "../components/Sheet";
import type { FinalizeCounts } from "./effective";

/**
 * Confirms Finalize, which sorts every receipt into folders and saves the report. It lists the
 * receipts by where they go, leaving out empty groups. While transactions still need a decision,
 * Review Remaining closes it and goes to the first of them.
 */
export function FinalizeSheet({
  period,
  counts,
  pending,
  refused,
  busy,
  onCancel,
  onConfirm,
  onReviewRemaining,
}: {
  /** The month's name, such as "March 2030". */
  period: string;
  counts: FinalizeCounts;
  /** Transactions still needing a decision. */
  pending: number;
  /** Files left in the receipts folder because Concilia can't read them. */
  refused: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onReviewRemaining: () => void;
}) {
  const { t, i18n } = useTranslation();
  const groups = [
    { key: "matched", count: counts.matched },
    { key: "review", count: counts.review },
    { key: "unmatched", count: counts.unmatched },
  ].filter((group) => group.count > 0);
  const parts = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
    groups.map((group) => t(`review.finalizeConfirm.groups.${group.key}`, { count: group.count })),
  );
  const moves = t("review.finalizeConfirm.moves", { count: counts.total, parts });
  return (
    <Sheet
      title={t("review.finalizeConfirm.title", { period })}
      message={
        <>
          <span className="sheet__line">{moves}</span>
          {refused > 0 ? <span className="sheet__line">{t("review.finalizeConfirm.refused", { count: refused })}</span> : null}
          <span className="sheet__line">{t("review.finalizeConfirm.report")}</span>
          <span className="sheet__line">{t("review.finalizeConfirm.later")}</span>
        </>
      }
      submitLabel={t("review.finalizeConfirm.confirm")}
      destructive
      busy={busy}
      onCancel={onCancel}
      onSubmit={onConfirm}
      accessory={
        pending > 0 ? (
          <button type="button" onClick={onReviewRemaining} disabled={busy}>
            {t("review.finalizeConfirm.reviewRemaining")}
          </button>
        ) : undefined
      }
    >
      {pending > 0 ? <SheetNote tone="warning">{t("review.finalizeConfirm.pending", { count: pending })}</SheetNote> : null}
    </Sheet>
  );
}
