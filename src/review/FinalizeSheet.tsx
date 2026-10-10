import { useTranslation } from "react-i18next";
import { Sheet, SheetNote } from "../components/Sheet";
import type { FinalizeCounts } from "./effective";

/** Confirms Finalize, which moves every receipt file and cannot be undone. */
export function FinalizeSheet({
  period,
  counts,
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The month's name, such as "March 2030". */
  period: string;
  counts: FinalizeCounts;
  /** Transactions still needing a decision. */
  pending: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const moves = t("review.finalizeConfirm.moves", { count: counts.total, matched: counts.matched, review: counts.review, unmatched: counts.unmatched });
  return (
    <Sheet
      title={t("review.finalizeConfirm.title", { period })}
      message={
        <>
          <span className="sheet__line">{moves}</span>
          <span className="sheet__line">{t("review.finalizeConfirm.irreversible")}</span>
        </>
      }
      submitLabel={t("review.finalizeConfirm.confirm")}
      destructive
      busy={busy}
      onCancel={onCancel}
      onSubmit={onConfirm}
    >
      {pending > 0 ? <SheetNote tone="warning">{t("review.finalizeConfirm.pending", { count: pending })}</SheetNote> : null}
    </Sheet>
  );
}
