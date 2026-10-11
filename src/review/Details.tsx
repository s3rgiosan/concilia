import { memo, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullDownButton } from "../components/PopUpButton";
import { fileName } from "../lib/paths";
import type { MenuEntry } from "../lib/popUpMenu";
import { longDate } from "../lib/dates";
import { formatMoney, formatSignedMoney } from "../lib/money";
import type { ReceiptMeta, Transaction } from "../lib/tauri";
import { isNoReceipt, noReceiptChoices, type NoReceiptCategory } from "./effective";
import { matchReason, noReceiptLabel, noReceiptTitle } from "./notes";
import { ReceiptPreview } from "./ReceiptPreview";
import { receiptTitle } from "./receipts";
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

/** How many receipts an unmatched transaction's list shows before Show All. */
export const RECEIPT_LIMIT = 20;

/** Longest a new preview waits during key repeat, in milliseconds. */
const PREVIEW_DELAY_MS = 120;

/** The No Receipt Needed pull-down, its categories in the order `noReceiptChoices` gives. */
function NoReceiptChoices({ tx, onNoReceipt }: { tx: Transaction; onNoReceipt: (category: NoReceiptCategory) => void }) {
  const { t } = useTranslation();
  const actions: MenuEntry[] = noReceiptChoices(tx).map((choice) =>
    choice === "separator" ? choice : { label: noReceiptTitle(choice, t), onSelect: () => onNoReceipt(choice) },
  );
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
 * offers Show All for the rest. `handlers` should keep their identity between renders.
 */
export const Details = memo(function Details({
  row,
  receipts,
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
  const headingId = useId();
  const language = i18n.language;
  /** The transaction whose full receipt list was asked for. */
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!row) {
    return (
      <aside className="details details--empty" aria-label={t("review.details")}>
        {empty ?? <p>{t("review.noSelection")}</p>}
      </aside>
    );
  }

  const receiptRow = (receipt: ReceiptMeta, txAbsCents: number | null, assignable = false) => (
    <ReceiptRow
      key={receipt.file}
      receipt={receipt}
      focused={focused?.file === receipt.file}
      txAbsCents={txAbsCents}
      rescanning={rescanning.has(receipt.file)}
      readOnly={readOnly}
      onAssign={assignable && !readOnly ? handlers.onAccept : undefined}
      onFocus={handlers.onFocusReceipt}
      onRescan={handlers.onRescan}
      onOpen={handlers.onOpen}
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
            <ul className="receipt-list">{receipts.map((r) => receiptRow(r, tx.abs_cents, true))}</ul>
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
          const focusedIndex = focused ? receipts.findIndex((r) => r.file === focused.file) : -1;
          const showAll = expanded === row.id || focusedIndex >= RECEIPT_LIMIT;
          const listed = showAll ? receipts : receipts.slice(0, RECEIPT_LIMIT);
          body = (
            <>
              <ul className="receipt-list">{listed.map((r) => receiptRow(r, tx.abs_cents, true))}</ul>
              {listed.length < receipts.length ? (
                <div className="details__more">
                  <button type="button" onClick={() => setExpanded(row.id)}>
                    {t("review.showAllReceipts", { count: receipts.length })}
                  </button>
                </div>
              ) : null}
            </>
          );
        }
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
          <ReceiptPreview receipt={focused} delayMs={PREVIEW_DELAY_MS} suspended={quickLook} />
        </section>
      ) : null}
    </aside>
  );
});
