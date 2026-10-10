import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ActionPopUpButton } from "../components/PopUpButton";
import { shortDate } from "../lib/dates";
import { formatMoney } from "../lib/money";
import { popUpMenu, type MenuEntry } from "../lib/popUpMenu";
import type { ReceiptMeta } from "../lib/tauri";
import type { Mismatch } from "./effective";
import { fileName, receiptTitle } from "./receipts";

/**
 * A receipt in the details column: vendor, amount, date and file, with a note when its amount
 * differs from the transaction's. Clicking it shows it in the preview below, and an eye marks the
 * one shown. Its `•••` menu and its context menu read it again or open it in Preview; `action` is
 * the decision button at the end. A receipt Gemini couldn't read says so under it, with Read
 * Again unless it is read-only. A read-only receipt cannot be read again.
 */
export function ReceiptRow({
  receipt,
  focused,
  mismatch,
  rescanning,
  readOnly,
  action,
  onFocus,
  onRescan,
  onOpen,
}: {
  receipt: ReceiptMeta;
  focused: boolean;
  mismatch: Mismatch | null;
  rescanning: boolean;
  readOnly?: boolean;
  action?: { label: string; accessibleName: string; onClick: () => void };
  onFocus: () => void;
  onRescan: () => void;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const title = receiptTitle(receipt);
  const unreadable = receipt.amount_cents === null;
  const canRescan = !readOnly && !rescanning && Boolean(receipt.rel_path);
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
  const actions: MenuEntry[] = [
    { label: t("review.actions.rescan"), onSelect: onRescan, disabled: !canRescan },
    { label: t("review.openInPreview"), onSelect: onOpen, disabled: !receipt.rel_path },
  ];
  return (
    <li
      className={`receipt-row ${focused ? "receipt-row--focused" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onFocus();
        void popUpMenu(actions, { x: e.clientX, y: e.clientY });
      }}
    >
      <button type="button" className="receipt-row__main" aria-pressed={focused} onClick={onFocus}>
        <span className="receipt-row__marker" aria-hidden="true">
          {focused ? <Icon name="eye" size={12} /> : null}
        </span>
        <span className="receipt-row__text">
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
        </span>
      </button>
      <span className="receipt-row__actions">
        {rescanning ? <span className="spinner receipt-row__spinner" role="status" aria-label={t("review.rescanning")} /> : null}
        <ActionPopUpButton borderless label={t("review.receiptActions", { name: title })} actions={actions} />
        {action ? (
          <button type="button" data-details-action aria-label={action.accessibleName} onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </span>
      {unreadable ? (
        <span className="receipt-row__problem">
          <Icon name="warning" size={12} className="receipt-row__warning" />
          <span className="grow">{t("review.unreadable")}</span>
          {readOnly ? null : (
            <button type="button" onClick={onRescan} disabled={!canRescan} aria-label={t("review.readAgainNamed", { name: title })}>
              {t("review.actions.rescan")}
            </button>
          )}
        </span>
      ) : null}
    </li>
  );
}
