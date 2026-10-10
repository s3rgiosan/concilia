import { useEffect, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { formatMoney } from "../lib/money";
import type { ListRow } from "./rows";
import { TransactionRow } from "./TransactionRow";

/** The DOM id of a list option, for `aria-activedescendant`. */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * The review list: a single-selection listbox that keeps focus itself and points at the selected
 * option. Reimbursements follow the transactions in a group under a sticky header with their total.
 */
export function TransactionList({
  listId,
  rows,
  selectedId,
  reimbursementTotal,
  listRef,
  onSelect,
  onOpen,
  onContextMenu,
  onKeyDown,
}: {
  listId: string;
  rows: ListRow[];
  selectedId: string | null;
  /** The sum of every reimbursement, in cents. */
  reimbursementTotal: number;
  listRef: Ref<HTMLDivElement>;
  onSelect: (row: ListRow) => void;
  onOpen: (row: ListRow) => void;
  /** Runs on a right click on a row, to show its menu. */
  onContextMenu: (row: ListRow, e: MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { t, i18n } = useTranslation();
  const selectedIndex = rows.findIndex((row) => row.id === selectedId);
  const active = selectedIndex >= 0 ? optionId(listId, selectedIndex) : undefined;

  useEffect(() => {
    if (active) {
      document.getElementById(active)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [active]);

  const option = (row: ListRow, index: number) => (
    <TransactionRow
      key={row.id}
      id={optionId(listId, index)}
      row={row}
      selected={index === selectedIndex}
      onSelect={() => onSelect(row)}
      onOpen={() => onOpen(row)}
      onContextMenu={(e) => onContextMenu(row, e)}
    />
  );
  const firstReimbursement = rows.findIndex((row) => row.kind === "reimbursement");
  const transactions = firstReimbursement < 0 ? rows : rows.slice(0, firstReimbursement);
  const reimbursements = firstReimbursement < 0 ? [] : rows.slice(firstReimbursement);
  const header = t("review.reimbursements.header", { total: formatMoney(reimbursementTotal, "EUR", i18n.language) });

  return (
    <div
      ref={listRef}
      className="review-list"
      role="listbox"
      tabIndex={0}
      aria-label={t("review.transactions")}
      aria-activedescendant={active}
      onKeyDown={onKeyDown}
    >
      {transactions.map(option)}
      {reimbursements.length > 0 ? (
        <div className="review-list__group" role="group" aria-label={header}>
          <div className="review-list__header" aria-hidden="true">
            {header}
          </div>
          {reimbursements.map((row, index) => option(row, firstReimbursement + index))}
        </div>
      ) : null}
    </div>
  );
}
