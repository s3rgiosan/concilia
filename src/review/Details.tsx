import { memo, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullDownButton } from "../components/PopUpButton";
import { fileName } from "../lib/paths";
import type { MenuEntry } from "../lib/popUpMenu";
import { longDate } from "../lib/dates";
import { formatMoney, formatSignedMoney } from "../lib/money";
import type { ReceiptMeta } from "../lib/tauri";
import { reasonLabel, reasonName, useReasons } from "../lib/reasons";
import { isNoReceipt, receiptsTotal, totalMismatch } from "./effective";
import { matchReason } from "./notes";
import { ReceiptPreview } from "./ReceiptPreview";
import { receiptTitle } from "./receipts";
import { ReceiptRow } from "./ReceiptRow";
import type { ListRow } from "./rows";
import { StatusLabel } from "./TransactionRow";

export interface DetailsHandlers {
  onFocusReceipt: (receipt: ReceiptMeta) => void;
  /** Accepts a REVIEW candidate or assigns a pool receipt to an UNMATCHED transaction. */
  onAccept: (receipt: ReceiptMeta) => void;
  /** Adds a pool receipt to a MATCHED transaction's receipts. */
  onAddReceipt: (receipt: ReceiptMeta) => void;
  /** Takes one receipt off a MATCHED transaction that holds several. */
  onRemoveReceipt: (receipt: ReceiptMeta) => void;
  /** None of These for REVIEW, Remove Match or Needs a Receipt for MATCHED. */
  onReject: () => void;
  /** Marks the transaction as needing no receipt for the reason with this id. */
  onNoReceipt: (reason: string) => void;
  onRescan: (receipt: ReceiptMeta) => void;
  onOpen: (receipt: ReceiptMeta) => void;
  onQuickLook: () => void;
}

/** How many receipts an unmatched transaction's list shows before Show All. */
export const RECEIPT_LIMIT = 20;

/** Longest a new preview waits during key repeat, in milliseconds. */
const PREVIEW_DELAY_MS = 120;

/** The No Receipt Needed pull-down, with the reasons in their Settings order. */
function NoReceiptChoices({ onNoReceipt }: { onNoReceipt: (reason: string) => void }) {
  const { t, i18n } = useTranslation();
  const reasons = useReasons();
  const actions: MenuEntry[] = reasons.map((reason) => ({ label: reasonName(reason, i18n.language), onSelect: () => onNoReceipt(reason.id) }));
  return (
    <span data-details-action>
      <PullDownButton label={t("review.noReceiptMenu")} actions={actions} />
    </span>
  );
}

/**
 * The details column: the selected row's transaction, the receipts it can take or holds and the
 * decisions available, then the focused receipt's preview. Decision controls carry
 * `data-details-action`, so Return in the list can move focus to the first one. A finalized
 * month shows no decisions, and a decision the user made reads as manual. Without a row it shows
 * `empty`, or No Selection. An unmatched transaction lists the closest receipts by amount and
 * offers Show All for the rest. A matched transaction can take more receipts from `addable`, and
 * one with several lists their total and lets each go. `handlers` should keep their identity
 * between renders.
 */
export const Details = memo(function Details({
  row,
  receipts,
  addable = [],
  focused,
  rescanning,
  readOnly,
  edited,
  quickLook = false,
  empty,
  handlers,
}: {
  row: ListRow | null;
  /** The row's receipts, as `rowReceipts` lists them. */
  receipts: ReceiptMeta[];
  /** Pool receipts a MATCHED transaction can add, as `addableReceipts` lists them. */
  addable?: ReceiptMeta[];
  focused: ReceiptMeta | null;
  rescanning: Set<string>;
  /** The month is finalized: decisions and new readings are unavailable. */
  readOnly: boolean;
  /** The selected transaction carries a decision the user made. */
  edited: boolean;
  /** Quick Look shows the focused receipt, so the preview here stays empty. */
  quickLook?: boolean;
  /** What the column shows when no row is selected. */
  empty?: ReactNode;
  handlers: DetailsHandlers;
}) {
  const { t, i18n } = useTranslation();
  const reasons = useReasons();
  const headingId = useId();
  const language = i18n.language;
  /** The transaction whose full receipt list was asked for. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The matched transaction whose Add Receipt list is open. */
  const [adding, setAdding] = useState<string | null>(null);

  if (!row) {
    return (
      <aside className="details details--empty" aria-label={t("review.details")}>
        {empty ?? <p>{t("review.noSelection")}</p>}
      </aside>
    );
  }

  const receiptRow = (
    receipt: ReceiptMeta,
    txAbsCents: number | null,
    onAssign?: (receipt: ReceiptMeta) => void,
    onRemove?: (receipt: ReceiptMeta) => void,
  ) => (
    <ReceiptRow
      key={receipt.file}
      receipt={receipt}
      focused={focused?.file === receipt.file}
      txAbsCents={txAbsCents}
      rescanning={rescanning.has(receipt.file)}
      readOnly={readOnly}
      onAssign={readOnly ? undefined : onAssign}
      onRemove={readOnly ? undefined : onRemove}
      onFocus={handlers.onFocusReceipt}
      onRescan={handlers.onRescan}
      onOpen={handlers.onOpen}
    />
  );

  /** `list` up to the limit, with Show All for the rest unless the focused receipt lies beyond it. */
  const limitedList = (rowId: string, list: ReceiptMeta[], render: (receipt: ReceiptMeta) => ReactNode) => {
    const focusedIndex = focused ? list.findIndex((r) => r.file === focused.file) : -1;
    const showAll = expanded === rowId || focusedIndex >= RECEIPT_LIMIT;
    const listed = showAll ? list : list.slice(0, RECEIPT_LIMIT);
    return (
      <>
        <ul className="receipt-list">{listed.map(render)}</ul>
        {listed.length < list.length ? (
          <div className="details__more">
            <button type="button" onClick={() => setExpanded(rowId)}>
              {t("review.showAllReceipts", { count: list.length })}
            </button>
          </div>
        ) : null}
      </>
    );
  };

  let header;
  let heading: string;
  let body;
  let actions = null;
  /** A section after the main one: the receipts a matched transaction can add. */
  let extra: ReactNode = null;
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
    const reason = edited ? t("review.manualDecision") : matchReason(tx.notes, t, (id) => reasonLabel(reasons, id, language));
    const noReceiptChoices = <NoReceiptChoices onNoReceipt={handlers.onNoReceipt} />;
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
            <ul className="receipt-list">{receipts.map((r) => receiptRow(r, tx.abs_cents, handlers.onAccept))}</ul>
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
        if (receipts.length === 0) {
          body = <p className="details__note">{t("review.noCandidates")}</p>;
        } else {
          body = limitedList(row.id, receipts, (r) => receiptRow(r, tx.abs_cents, handlers.onAccept));
        }
        actions = noReceiptChoices;
        break;
      case "MATCHED":
      default:
        heading = t("review.sections.receipts", { count: Math.max(receipts.length, 1) });
        if (isNoReceipt(tx.notes)) {
          body = <p className="details__note">{t("review.noReceiptNeeded", { reason: reasonLabel(reasons, tx.notes, language) })}</p>;
        } else if (receipts.length === 0) {
          body = <p className="details__note">{t("review.noReceipts")}</p>;
        } else {
          const several = receipts.length > 1;
          const total = several ? receiptsTotal(receipts) : null;
          const difference = total === null ? null : totalMismatch(receipts, tx.abs_cents);
          body = (
            <>
              <ul className="receipt-list">
                {receipts.map((r) => receiptRow(r, several ? null : tx.abs_cents, undefined, several ? handlers.onRemoveReceipt : undefined))}
              </ul>
              {total !== null ? (
                <p className="details__total">
                  <span className="numeric">{t("review.receiptsTotal", { amount: formatMoney(total, "EUR", language) })}</span>
                  {difference === null ? null : (
                    <span className="receipt-row__mismatch">
                      <Icon name="warning" size={12} className="receipt-row__warning" />
                      {t("review.mismatch.amount", { amount: formatMoney(difference, "EUR", language) })}
                    </span>
                  )}
                </p>
              ) : null}
            </>
          );
        }
        if (adding === row.id && !isNoReceipt(tx.notes)) {
          extra = (
            <section className="details__section" aria-labelledby={`${headingId}-add`}>
              <h3 id={`${headingId}-add`} className="details__heading">
                {t("review.sections.addable")}
              </h3>
              {addable.length === 0 ? (
                <p className="details__note">{t("review.noCandidates")}</p>
              ) : (
                limitedList(`${row.id}:add`, addable, (r) => receiptRow(r, null, handlers.onAddReceipt))
              )}
            </section>
          );
        }
        actions = (
          <>
            {isNoReceipt(tx.notes) ? null : (
              <button type="button" aria-expanded={adding === row.id} onClick={() => setAdding(adding === row.id ? null : row.id)}>
                {t("review.actions.addReceipt")}
              </button>
            )}
            <button type="button" data-details-action onClick={handlers.onReject}>
              {isNoReceipt(tx.notes) ? t("review.actions.needsReceipt") : t("review.actions.removeMatch")}
            </button>
          </>
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
        {readOnly ? null : extra}
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
          <ReceiptPreview receipt={focused} delayMs={PREVIEW_DELAY_MS} suspended={quickLook} />
        </section>
      ) : null}
    </aside>
  );
});
