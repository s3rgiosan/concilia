import { memo, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { shortDate } from "../lib/dates";
import { formatMoney, formatSignedMoney } from "../lib/money";
import type { Status } from "../lib/tauri";
import { isNoReceipt } from "./effective";
import { noReceiptTitle } from "./notes";
import { receiptTitle } from "./receipts";
import type { ListRow } from "./rows";

const STATUS_DOT: Record<Status, string> = { MATCHED: "dot--green", REVIEW: "dot--orange", UNMATCHED: "dot--red" };

/**
 * A status as a dot and its label: a transaction's status, No Receipt with its category for a
 * transaction marked as needing none (`notes`), or a reimbursement's kind when `status` is absent.
 */
export function StatusLabel({ status, notes }: { status?: Status; notes?: string }) {
  const { t } = useTranslation();
  let label: string;
  if (!status) {
    label = t("review.reimbursements.label");
  } else if (status === "MATCHED" && notes !== undefined && isNoReceipt(notes)) {
    label = t("review.status.noReceipt", { category: noReceiptTitle(notes, t) });
  } else {
    label = t(`review.status.${status.toLowerCase()}`);
  }
  return (
    <span className="status-label" title={label}>
      <span className={`dot ${status ? STATUS_DOT[status] : "dot--gray"}`} aria-hidden="true" />
      <span className="status-label__text">{label}</span>
    </span>
  );
}

/**
 * One option of the review list: a transaction's status, date, description, a pencil when the
 * user decided it (`edited`) and its signed amount, or a reimbursement's kind, date, name and
 * amount. A press selects it. With `onLeft` it is a row that just left the list: hidden from
 * assistive technology, collapsing until `onLeft` runs. Memoized: its handlers take the row, so
 * the list can pass the same functions to every row and an arrow key renders only the two rows
 * whose selection changed.
 */
export const TransactionRow = memo(function TransactionRow({
  id,
  row,
  selected,
  edited = false,
  onSelect,
  onOpen,
  onContextMenu,
  onLeft,
}: {
  id: string;
  row: ListRow;
  selected: boolean;
  edited?: boolean;
  onSelect: (row: ListRow) => void;
  /** Runs on a double click. */
  onOpen: (row: ListRow) => void;
  onContextMenu: (row: ListRow, e: MouseEvent<HTMLDivElement>) => void;
  onLeft?: (row: ListRow) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  let cells;
  if (row.kind === "transaction") {
    const { tx } = row;
    cells = (
      <>
        <span className="list-row__status">
          <StatusLabel status={tx.status} notes={tx.notes} />
        </span>
        <span className="list-row__date numeric">{shortDate(tx.date, language)}</span>
        <span className="list-row__description">{tx.description}</span>
        <span className="list-row__edited">
          {edited ? (
            <>
              <Icon name="pencil" size={11} />
              <span className="visually-hidden">{t("review.edited")}</span>
            </>
          ) : null}
        </span>
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
        <span className="list-row__edited" />
        <span className="list-row__amount numeric">
          {receipt.amount_cents === null ? "" : formatMoney(receipt.amount_cents, receipt.currency, language)}
        </span>
      </>
    );
  }
  if (onLeft) {
    return (
      <div className="list-row list-row--leaving" aria-hidden="true" onAnimationEnd={() => onLeft(row)}>
        {cells}
      </div>
    );
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`list-row ${selected ? "list-row--selected" : ""}`}
      onMouseDown={(e) => {
        if (e.button === 0) {
          onSelect(row);
        }
      }}
      onDoubleClick={() => onOpen(row)}
      onContextMenu={(e) => onContextMenu(row, e)}
    >
      {cells}
    </div>
  );
});
