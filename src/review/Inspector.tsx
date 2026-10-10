import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullDownButton } from "../components/PopUpButton";
import { longDate } from "../lib/dates";
import { formatMoney, formatSignedMoney } from "../lib/money";
import type { ReceiptMeta } from "../lib/tauri";
import { isNoReceipt, mismatch, NO_RECEIPT_CATEGORIES, type NoReceiptCategory } from "./effective";
import { matchReason, noReceiptLabel } from "./notes";
import { ReceiptPreview } from "./ReceiptPreview";
import { fileName, receiptTitle } from "./receipts";
import { ReceiptRow } from "./ReceiptRow";
import type { ListRow } from "./rows";
import { StatusLabel } from "./TransactionRow";

export interface InspectorHandlers {
  onFocusReceipt: (receipt: ReceiptMeta) => void;
  /** Accepts a REVIEW candidate or assigns a pool receipt to an UNMATCHED transaction. */
  onAccept: (receipt: ReceiptMeta) => void;
  /** None of These for REVIEW, Remove Match for MATCHED. */
  onReject: () => void;
  onNoReceipt: (category: NoReceiptCategory) => void;
  onRescan: (receipt: ReceiptMeta) => void;
  onOpen: (receipt: ReceiptMeta) => void;
  onQuickLook: () => void;
}

/**
 * Details of the selected row: the transaction, the receipts it can take or holds and the
 * decisions available, then the focused receipt's preview. Decision controls carry
 * `data-inspector-action`, so Return in the list can move focus to the first one. A finalized
 * month shows no decisions.
 */
export function Inspector({
  row,
  receipts,
  focused,
  rescanning,
  readOnly,
  handlers,
}: {
  row: ListRow | null;
  /** The row's receipts, as `rowReceipts` lists them. */
  receipts: ReceiptMeta[];
  focused: ReceiptMeta | null;
  rescanning: Set<string>;
  /** The month is finalized: decisions and new readings are unavailable. */
  readOnly: boolean;
  handlers: InspectorHandlers;
}) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const language = i18n.language;

  if (!row) {
    return (
      <aside className="inspector inspector--empty" aria-label={t("review.inspector")}>
        <p>{t("review.noSelection")}</p>
      </aside>
    );
  }

  const noReceiptMenu = (
    <span data-inspector-action>
      <PullDownButton
        label={t("review.noReceiptMenu")}
        actions={NO_RECEIPT_CATEGORIES.map((category) => ({ label: noReceiptLabel(category, t), onSelect: () => handlers.onNoReceipt(category) }))}
      />
    </span>
  );

  const receiptRow = (receipt: ReceiptMeta, txAbsCents: number | null, action?: { label: string; accessibleName: string; onClick: () => void }) => (
    <ReceiptRow
      key={receipt.file}
      receipt={receipt}
      focused={focused?.file === receipt.file}
      mismatch={txAbsCents === null ? null : mismatch(receipt, txAbsCents)}
      rescanning={rescanning.has(receipt.file)}
      readOnly={readOnly}
      action={readOnly ? undefined : action}
      onFocus={() => handlers.onFocusReceipt(receipt)}
      onRescan={() => handlers.onRescan(receipt)}
      onOpen={() => handlers.onOpen(receipt)}
    />
  );

  let header;
  let heading: string;
  let body;
  let actions = null;
  if (row.kind === "reimbursement") {
    const { receipt } = row;
    header = (
      <>
        <h2 className="inspector__title">{receiptTitle(receipt)}</h2>
        <p className="inspector__amount numeric">
          {receipt.amount_cents === null ? t("review.amountUnknown") : formatMoney(receipt.amount_cents, receipt.currency, language)}
        </p>
        <p className="inspector__meta">
          <span>{t("review.reimbursements.label")}</span>
          {receipt.date ? <span>{longDate(receipt.date, language)}</span> : null}
        </p>
        <p className="inspector__reason">{t("review.reimbursements.subtitle")}</p>
      </>
    );
    heading = t("review.sections.receipts", { count: 1 });
    body = <ul className="receipt-list">{receiptRow(receipt, null)}</ul>;
  } else {
    const { tx } = row;
    const reason = matchReason(tx.notes, t);
    header = (
      <>
        <h2 className="inspector__title">{tx.description}</h2>
        <p className="inspector__amount numeric">{formatSignedMoney(tx.amount_cents, "EUR", language)}</p>
        <p className="inspector__meta">
          <StatusLabel status={tx.status} />
          <span>{longDate(tx.date, language)}</span>
        </p>
        {reason ? <p className="inspector__reason">{reason}</p> : null}
      </>
    );
    switch (tx.status) {
      case "REVIEW":
        heading = t("review.sections.candidates");
        body =
          receipts.length > 0 ? (
            <ul className="receipt-list">
              {receipts.map((r) => receiptRow(r, tx.abs_cents, { label: t("review.actions.assign"), accessibleName: t("review.assignReceipt", { name: receiptTitle(r) }), onClick: () => handlers.onAccept(r) }))}
            </ul>
          ) : (
            <p className="inspector__note">{t("review.candidatesTaken")}</p>
          );
        actions = (
          <>
            <button type="button" data-inspector-action onClick={handlers.onReject}>
              {t("review.actions.noneOfThese")}
            </button>
            {noReceiptMenu}
          </>
        );
        break;
      case "UNMATCHED":
        heading = t("review.sections.assignable");
        body =
          receipts.length > 0 ? (
            <ul className="receipt-list">
              {receipts.map((r) => receiptRow(r, tx.abs_cents, { label: t("review.actions.assign"), accessibleName: t("review.assignReceipt", { name: receiptTitle(r) }), onClick: () => handlers.onAccept(r) }))}
            </ul>
          ) : (
            <p className="inspector__note">{t("review.noCandidates")}</p>
          );
        actions = noReceiptMenu;
        break;
      case "MATCHED":
      default:
        heading = t("review.sections.receipts", { count: Math.max(receipts.length, 1) });
        if (isNoReceipt(tx.notes)) {
          body = <p className="inspector__note">{t("review.noReceiptNeeded", { category: noReceiptLabel(tx.notes, t) })}</p>;
        } else if (receipts.length === 0) {
          body = <p className="inspector__note">{t("review.noReceiptCategories.noReceipt")}</p>;
        } else {
          body = <ul className="receipt-list">{receipts.map((r) => receiptRow(r, tx.abs_cents))}</ul>;
        }
        actions = (
          <button type="button" data-inspector-action onClick={handlers.onReject}>
            {t("review.actions.removeMatch")}
          </button>
        );
        break;
    }
  }

  return (
    <aside className="inspector" aria-label={t("review.inspector")}>
      <div className="inspector__details">
        <header className="inspector__header">{header}</header>
        <section className="inspector__section" aria-labelledby={headingId}>
          <h3 id={headingId} className="inspector__heading">
            {heading}
          </h3>
          {body}
          {readOnly && row.kind === "transaction" ? <p className="inspector__note inspector__note--finalized">{t("review.finalizedNote")}</p> : null}
          {actions && !readOnly ? <div className="inspector__actions">{actions}</div> : null}
        </section>
      </div>
      {focused ? (
        <section className="inspector__preview" aria-label={t("review.previewOf", { name: fileName(focused.file) })}>
          <header className="inspector__preview-bar">
            <span className="inspector__preview-name" title={focused.file}>
              {fileName(focused.file)}
            </span>
            <button
              type="button"
              className="icon"
              aria-label={t("review.actions.quickLook")}
              title={t("review.actions.quickLook")}
              onClick={handlers.onQuickLook}
              disabled={!focused.rel_path}
            >
              <Icon name="eye" size={15} />
            </button>
          </header>
          <ReceiptPreview receipt={focused} />
        </section>
      ) : null}
    </aside>
  );
}
