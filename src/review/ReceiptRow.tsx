import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ActionPopUpButton } from "../components/PopUpButton";
import { shortDate } from "../lib/dates";
import { formatMoney } from "../lib/money";
import type { ReceiptMeta } from "../lib/tauri";
import type { Mismatch } from "./effective";
import { fileName, receiptTitle } from "./receipts";

/**
 * A receipt in the inspector: vendor, amount, date and file, with a note when its amount differs
 * from the transaction's. Clicking it focuses it, so its preview shows. Its `•••` menu rescans it
 * or opens it in Preview; `action` is the decision button at the end.
 */
export function ReceiptRow({
  receipt,
  focused,
  mismatch,
  rescanning,
  action,
  onFocus,
  onRescan,
  onOpen,
}: {
  receipt: ReceiptMeta;
  focused: boolean;
  mismatch: Mismatch | null;
  rescanning: boolean;
  action?: { label: string; accessibleName: string; onClick: () => void };
  onFocus: () => void;
  onRescan: () => void;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const title = receiptTitle(receipt);
  let difference: string | null = null;
  switch (mismatch?.kind) {
    case "amount":
      difference = t("review.mismatch.amount", { amount: formatMoney(mismatch.cents, "EUR", i18n.language) });
      break;
    case "fx":
      difference = t("review.mismatch.fx", { currency: receipt.currency ?? "" });
      break;
    default:
      break;
  }
  return (
    <li className={`receipt-row ${focused ? "receipt-row--focused" : ""}`}>
      <button type="button" className="receipt-row__main" aria-pressed={focused} onClick={onFocus}>
        <span className="receipt-row__line">
          <span className="receipt-row__title">{title}</span>
          {receipt.amount_cents !== null ? (
            <span className="receipt-row__amount numeric">{formatMoney(receipt.amount_cents, receipt.currency, i18n.language)}</span>
          ) : null}
        </span>
        <span className="receipt-row__meta">
          <span>{receipt.date ? shortDate(receipt.date, i18n.language) : t("review.dateUnknown")}</span>
          {receipt.vendor ? <span className="receipt-row__file">{fileName(receipt.file)}</span> : null}
          {receipt.confidence && receipt.confidence !== "high" ? <span>{t("review.lowConfidence")}</span> : null}
        </span>
        {difference ? (
          <span className="receipt-row__mismatch">
            <Icon name="warning" size={12} className="receipt-row__warning" />
            {difference}
          </span>
        ) : null}
      </button>
      <span className="receipt-row__actions">
        {rescanning ? <span className="spinner receipt-row__spinner" role="status" aria-label={t("review.rescanning")} /> : null}
        <ActionPopUpButton
          borderless
          label={t("review.receiptActions", { name: title })}
          actions={[
            { label: t("review.actions.rescan"), onSelect: onRescan, disabled: rescanning || !receipt.rel_path },
            { label: t("review.openInPreview"), onSelect: onOpen, disabled: !receipt.rel_path },
          ]}
        />
        {action ? (
          <button type="button" aria-label={action.accessibleName} onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </span>
    </li>
  );
}
