import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ActionPopUpButton, PullDownButton } from "../components/PopUpButton";
import { longDate } from "../lib/dates";
import { formatMoney, formatSignedMoney } from "../lib/money";
import type { ReceiptMeta, Transaction } from "../lib/tauri";
import { isNoReceipt, mismatch, NO_RECEIPT_CATEGORIES, type NoReceiptCategory } from "./effective";
import { matchReason, noReceiptLabel, noReceiptTitle } from "./notes";
import { ReceiptPreview } from "./ReceiptPreview";
import { fileName, receiptTitle } from "./receipts";
import { ReceiptRow } from "./ReceiptRow";
import type { ListRow } from "./rows";
import { StatusLabel } from "./TransactionRow";

export interface DetailsHandlers {
  onFocusReceipt: (receipt: ReceiptMeta) => void;
  /** Accepts a REVIEW candidate or assigns a pool receipt to an UNMATCHED transaction. */
  onAccept: (receipt: ReceiptMeta) => void;
  /** None of These for REVIEW, Remove Match or Needs a Receipt for MATCHED. */
  onReject: () => void;
  onNoReceipt: (category: NoReceiptCategory) => void;
  onRescan: (receipt: ReceiptMeta) => void;
  onOpen: (receipt: ReceiptMeta) => void;
  onQuickLook: () => void;
}

/** The categories a credit most likely needs no receipt for, offered as buttons. */
const CREDIT_CATEGORIES: NoReceiptCategory[] = ["transfer", "salary", "refund"];

/**
 * The No Receipt Needed choices for a transaction. Money coming in shows its likely categories
 * as buttons, with the rest under a `•••` menu; money going out shows every category in one
 * pull-down.
 */
function NoReceiptChoices({ tx, onNoReceipt }: { tx: Transaction; onNoReceipt: (category: NoReceiptCategory) => void }) {
  const { t } = useTranslation();
  const labelId = useId();
  if (tx.amount_cents <= 0) {
    return (
      <span data-details-action>
        <PullDownButton
          label={t("review.noReceiptMenu")}
          actions={NO_RECEIPT_CATEGORIES.map((category) => ({ label: noReceiptLabel(category, t), onSelect: () => onNoReceipt(category) }))}
        />
      </span>
    );
  }
  const others = NO_RECEIPT_CATEGORIES.filter((category) => !CREDIT_CATEGORIES.includes(category));
  return (
    <div className="details__choices" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="details__choices-label">
        {t("review.noReceiptMenu")}
      </span>
      <div className="details__actions">
        {CREDIT_CATEGORIES.map((category) => (
          <button key={category} type="button" data-details-action onClick={() => onNoReceipt(category)}>
            {noReceiptTitle(category, t)}
          </button>
        ))}
        <ActionPopUpButton label={t("review.noReceiptMore")} actions={others.map((category) => ({ label: noReceiptTitle(category, t), onSelect: () => onNoReceipt(category) }))} />
      </div>
    </div>
  );
}

/**
 * The details column: the selected row's transaction, the receipts it can take or holds and the
 * decisions available, then the focused receipt's preview. Decision controls carry
 * `data-details-action`, so Return in the list can move focus to the first one. A finalized
 * month shows no decisions, and a decision the user made reads as manual. Without a row it shows
 * `empty`, or No Selection.
 */
export function Details({
  row,
  receipts,
  focused,
  rescanning,
  readOnly,
  edited,
  empty,
  handlers,
}: {
  row: ListRow | null;
  /** The row's receipts, as `rowReceipts` lists them. */
  receipts: ReceiptMeta[];
  focused: ReceiptMeta | null;
  rescanning: Set<string>;
  /** The month is finalized: decisions and new readings are unavailable. */
  readOnly: boolean;
  /** The selected transaction carries a decision the user made. */
  edited: boolean;
  /** What the column shows when no row is selected. */
  empty?: ReactNode;
  handlers: DetailsHandlers;
}) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const language = i18n.language;

  if (!row) {
    return (
      <aside className="details details--empty" aria-label={t("review.details")}>
        {empty ?? <p>{t("review.noSelection")}</p>}
      </aside>
    );
  }

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
        <h2 className="details__title">{receiptTitle(receipt)}</h2>
        <p className="details__amount numeric">
          {receipt.amount_cents === null ? t("review.amountUnknown") : formatMoney(receipt.amount_cents, receipt.currency, language)}
        </p>
        <p className="details__meta">
          <span>{t("review.reimbursements.label")}</span>
          {receipt.date ? <span>{longDate(receipt.date, language)}</span> : null}
        </p>
        <p className="details__reason">{t("review.reimbursements.subtitle")}</p>
      </>
    );
    heading = t("review.sections.receipts", { count: 1 });
    body = <ul className="receipt-list">{receiptRow(receipt, null)}</ul>;
  } else {
    const { tx } = row;
    const reason = edited ? t("review.manualDecision") : matchReason(tx.notes, t);
    const assignAction = (r: ReceiptMeta) => ({ label: t("review.actions.assign"), accessibleName: t("review.assignReceipt", { name: receiptTitle(r) }), onClick: () => handlers.onAccept(r) });
    const noReceiptChoices = <NoReceiptChoices tx={tx} onNoReceipt={handlers.onNoReceipt} />;
    header = (
      <>
        <h2 className="details__title">{tx.description}</h2>
        <p className="details__amount numeric">{formatSignedMoney(tx.amount_cents, "EUR", language)}</p>
        <p className="details__meta">
          <StatusLabel status={tx.status} notes={tx.notes} />
          <span>{longDate(tx.date, language)}</span>
        </p>
        {reason ? (
          <p className="details__reason">
            {edited ? <Icon name="pencil" size={11} className="details__edited" /> : null}
            {reason}
          </p>
        ) : null}
      </>
    );
    switch (tx.status) {
      case "REVIEW":
        heading = t("review.sections.candidates");
        body =
          receipts.length > 0 ? (
            <ul className="receipt-list">{receipts.map((r) => receiptRow(r, tx.abs_cents, assignAction(r)))}</ul>
          ) : (
            <p className="details__note">{t("review.candidatesTaken")}</p>
          );
        actions = (
          <>
            <button type="button" data-details-action onClick={handlers.onReject}>
              {t("review.actions.noneOfThese")}
            </button>
            {noReceiptChoices}
          </>
        );
        break;
      case "UNMATCHED":
        heading = t("review.sections.assignable");
        body =
          receipts.length > 0 ? (
            <ul className="receipt-list">{receipts.map((r) => receiptRow(r, tx.abs_cents, assignAction(r)))}</ul>
          ) : (
            <p className="details__note">{t("review.noCandidates")}</p>
          );
        actions = noReceiptChoices;
        break;
      case "MATCHED":
      default:
        heading = t("review.sections.receipts", { count: Math.max(receipts.length, 1) });
        if (isNoReceipt(tx.notes)) {
          body = <p className="details__note">{t("review.noReceiptNeeded", { category: noReceiptLabel(tx.notes, t) })}</p>;
        } else if (receipts.length === 0) {
          body = <p className="details__note">{t("review.noReceiptCategories.noReceipt")}</p>;
        } else {
          body = <ul className="receipt-list">{receipts.map((r) => receiptRow(r, tx.abs_cents))}</ul>;
        }
        actions = (
          <button type="button" data-details-action onClick={handlers.onReject}>
            {isNoReceipt(tx.notes) ? t("review.actions.needsReceipt") : t("review.actions.removeMatch")}
          </button>
        );
        break;
    }
  }

  return (
    <aside className="details" aria-label={t("review.details")}>
      <div className="details__info">
        <header className="details__header">{header}</header>
        <section className="details__section" aria-labelledby={headingId}>
          <h3 id={headingId} className="details__heading">
            {heading}
          </h3>
          {body}
          {readOnly && row.kind === "transaction" ? <p className="details__note details__note--finalized">{t("review.finalizedNote")}</p> : null}
          {actions && !readOnly ? <div className="details__actions">{actions}</div> : null}
        </section>
      </div>
      {focused ? (
        <section className="details__preview" aria-label={t("review.previewOf", { name: fileName(focused.file) })}>
          <header className="details__preview-bar">
            <span className="details__preview-name" title={focused.file}>
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
