import { useTranslation } from "react-i18next";
import { formatMoney } from "../lib/money";
import type { ReceiptMeta } from "../lib/tauri";
import { ReceiptRow } from "./ReceiptRow";

/** Receipts paid personally on company VAT. They have no transaction and are only listed. */
export function Reimbursements({
  receipts,
  rescanning,
  selectedFile,
  onPreview,
  onRescan,
}: {
  receipts: ReceiptMeta[];
  rescanning: Set<string>;
  selectedFile: string | null;
  onPreview: (receipt: ReceiptMeta) => void;
  onRescan: (receipt: ReceiptMeta) => void;
}) {
  const { t, i18n } = useTranslation();
  if (receipts.length === 0) {
    return null;
  }
  const total = receipts.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
  return (
    <section className="reimbursements" aria-labelledby="reimbursements-title">
      <header className="reimbursements__header">
        <h2 id="reimbursements-title" className="form-section__title">
          {t("review.reimbursements.title")} ({receipts.length})
        </h2>
        <span className="numeric">
          {t("review.reimbursements.total")}: {formatMoney(total, "EUR", i18n.language)}
        </span>
      </header>
      <p className="muted reimbursements__subtitle">{t("review.reimbursements.subtitle")}</p>
      <ul className="tx__receipts form-group">
        {receipts.map((r) => (
          <ReceiptRow
            key={r.file}
            receipt={r}
            mismatch={false}
            selected={selectedFile === r.file}
            onSelect={() => onPreview(r)}
            actions={[
              {
                id: "rescan",
                label: t("review.actions.rescan"),
                icon: "refresh",
                onClick: () => onRescan(r),
                disabled: rescanning.has(r.file) || !r.rel_path,
                spinning: rescanning.has(r.file),
              },
            ]}
          />
        ))}
      </ul>
    </section>
  );
}
