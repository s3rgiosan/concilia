import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { shortDate } from "../lib/dates";
import { formatMoney, formatSignedMoney } from "../lib/money";
import type { Status } from "../lib/tauri";
import { receiptTitle } from "./receipts";
import type { ListRow } from "./rows";

export const STATUS_DOT: Record<Status, string> = { MATCHED: "dot--green", REVIEW: "dot--orange", UNMATCHED: "dot--red" };

/** A status as a dot and its label: a transaction's status, or a reimbursement's kind when `status` is absent. */
export function StatusLabel({ status }: { status?: Status }) {
  const { t } = useTranslation();
  const label = status ? t(`review.status.${status.toLowerCase()}`) : t("review.reimbursements.label");
  return (
    <span className="status-label">
      <span className={`dot ${status ? STATUS_DOT[status] : "dot--gray"}`} aria-hidden="true" />
      <span className="status-label__text">{label}</span>
    </span>
  );
}

/**
 * One option of the review list: a transaction's status, date, description and signed amount, or
 * a reimbursement's kind, date, name and amount.
 */
export function TransactionRow({
  id,
  row,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  id: string;
  row: ListRow;
  selected: boolean;
  onSelect: () => void;
  /** Runs on a double click. */
  onOpen: () => void;
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  const { i18n } = useTranslation();
  const language = i18n.language;
  let cells;
  if (row.kind === "transaction") {
    const { tx } = row;
    cells = (
      <>
        <span className="list-row__status">
          <StatusLabel status={tx.status} />
        </span>
        <span className="list-row__date numeric">{shortDate(tx.date, language)}</span>
        <span className="list-row__description">{tx.description}</span>
        <span className="list-row__amount numeric">{formatSignedMoney(tx.amount_cents, "EUR", language)}</span>
      </>
    );
  } else {
    const { receipt } = row;
    cells = (
      <>
        <span className="list-row__status">
          <StatusLabel />
        </span>
        <span className="list-row__date numeric">{receipt.date ? shortDate(receipt.date, language) : ""}</span>
        <span className="list-row__description">{receiptTitle(receipt)}</span>
        <span className="list-row__amount numeric">
          {receipt.amount_cents === null ? "" : formatMoney(receipt.amount_cents, receipt.currency, language)}
        </span>
      </>
    );
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`list-row ${selected ? "list-row--selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
    >
      {cells}
    </div>
  );
}
