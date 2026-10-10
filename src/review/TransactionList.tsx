import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { formatMoney } from "../lib/money";
import type { ListRow } from "./rows";
import { TransactionRow } from "./TransactionRow";

/** The DOM id of a list option, for `aria-activedescendant`. */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/** A row that left the list, collapsing after the row it followed (`after`, or null at the top). */
interface LeavingRow {
  row: ListRow;
  after: string | null;
}

/** Most rows that collapse out at once; a larger change, such as a new filter, replaces the list. */
const MAX_LEAVING = 3;
/** Time after which collapsing rows are dropped even if their animation never reports its end, in milliseconds. */
const LEAVE_LIMIT_MS = 400;

/** Whether rows can collapse out: the web view animates and Reduce Motion is off. */
function canAnimate(): boolean {
  const animates = typeof Element.prototype.getAnimations === "function";
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return animates && !reduced;
}

/**
 * Rows that just left `rows` while `viewKey` (the filter and search) stayed the same, such as a
 * decided transaction under the Needs Review filter. They stay in place, collapsing, so the rows
 * below move up into the gap. Returns them with a function that drops one once it has collapsed.
 */
function useLeavingRows(rows: ListRow[], viewKey: string): [LeavingRow[], (id: string) => void] {
  const [previous, setPrevious] = useState({ rows, viewKey });
  const [leaving, setLeaving] = useState<LeavingRow[]>([]);

  if (previous.rows !== rows || previous.viewKey !== viewKey) {
    const current = new Set(rows.map((row) => row.id));
    const before = new Set(previous.rows.map((row) => row.id));
    const removed: LeavingRow[] = [];
    let after: string | null = null;
    for (const row of previous.rows) {
      if (current.has(row.id)) {
        after = row.id;
      } else {
        removed.push({ row, after });
      }
    }
    const added = rows.some((row) => !before.has(row.id));
    const kept = leaving.filter((l) => !current.has(l.row.id));
    setPrevious({ rows, viewKey });
    if (removed.length === 0) {
      if (kept.length !== leaving.length) {
        setLeaving(kept);
      }
    } else {
      const animate = previous.viewKey === viewKey && !added && removed.length <= MAX_LEAVING && canAnimate();
      setLeaving(animate ? [...kept, ...removed] : []);
    }
  }

  useEffect(() => {
    if (leaving.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return [leaving, (id: string) => setLeaving((prev) => prev.filter((l) => l.row.id !== id))];
}

/**
 * The review list: a single-selection listbox that keeps focus itself and points at the selected
 * option. Reimbursements follow the transactions in a group under a sticky header with their total.
 * A row that leaves while the filter and search stay the same collapses out of its place.
 */
export function TransactionList({
  listId,
  rows,
  viewKey,
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
  /** The filter and search the rows come from; rows only collapse out while it stays the same. */
  viewKey: string;
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

  const [leaving, dropLeaving] = useLeavingRows(rows, viewKey);

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
  const ghost = ({ row }: LeavingRow) => (
    <TransactionRow
      key={`leaving-${row.id}`}
      id=""
      row={row}
      selected={false}
      onSelect={() => undefined}
      onOpen={() => undefined}
      onContextMenu={() => undefined}
      onLeft={() => dropLeaving(row.id)}
    />
  );
  const ghostsAfter = (id: string | null) => leaving.filter((l) => l.after === id).map((l) => ({ kind: l.row.kind, node: ghost(l) }));
  const items: { kind: ListRow["kind"]; node: ReactNode }[] = ghostsAfter(null);
  rows.forEach((row, index) => {
    items.push({ kind: row.kind, node: option(row, index) }, ...ghostsAfter(row.id));
  });
  const transactions = items.filter((item) => item.kind === "transaction").map((item) => item.node);
  const reimbursements = items.filter((item) => item.kind === "reimbursement").map((item) => item.node);
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
      {transactions}
      {reimbursements.length > 0 ? (
        <div className="review-list__group" role="group" aria-label={header}>
          <div className="review-list__header" aria-hidden="true">
            {header}
          </div>
          {reimbursements}
        </div>
      ) : null}
    </div>
  );
}
