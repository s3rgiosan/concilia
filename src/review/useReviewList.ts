import { useMemo, useState } from "react";
import type { Draft, ReceiptMeta, ReviewData } from "../lib/tauri";
import {
  addableReceipts,
  claimedFiles,
  filterCounts,
  isNoReceipt,
  mergeDraft,
  pendingCount,
  reimbursementsTotal,
  relPaths,
  unmatchedPool,
  visibleReimbursements,
  visibleTransactions,
  type Filter,
} from "./effective";
import { buildRows, findPending, initialSelection, resolveSelection, rowReceipts } from "./rows";

/**
 * The selected row, and where it was in the list, so the row after it takes over if it leaves.
 * A decision on the row sets `advance`, which hands the selection to the next undecided row.
 */
export type Selection = { id: string | null; index: number; advance?: boolean };

/** The receipt focused in the details column, for the row it was focused in. */
export type Focus = { rowId: string; file: string } | null;

/**
 * What the list shows: the transactions with the draft applied, narrowed by the filter and the
 * search, the selected row and the receipt focused for it.
 */
export function useReviewList(data: ReviewData | null, draft: Draft) {
  const [filter, setFilterState] = useState<Filter>("all");
  const [search, setSearchState] = useState("");
  const [selection, setSelection] = useState<Selection>({ id: null, index: 0 });
  const [focus, setFocus] = useState<Focus>(null);

  const paths = useMemo(() => (data ? relPaths(data) : new Map<string, string>()), [data]);
  const merged = useMemo(() => (data ? mergeDraft(data.transactions, draft, paths) : []), [data, draft, paths]);
  const claimed = useMemo(() => claimedFiles(merged), [merged]);
  const pool = useMemo(() => (data ? unmatchedPool(data, merged) : []), [data, merged]);
  const counts = useMemo(() => filterCounts(merged), [merged]);
  const pending = pendingCount(merged);
  const visible = useMemo(() => visibleTransactions(merged, filter, search), [merged, filter, search]);
  const shownReimbursements = useMemo(() => (data ? visibleReimbursements(data.reimbursements, filter, search) : []), [data, filter, search]);
  const rows = useMemo(() => buildRows(visible, shownReimbursements), [visible, shownReimbursements]);
  const reimbursementTotal = useMemo(() => reimbursementsTotal(data?.reimbursements ?? []), [data]);
  const edited = useMemo(() => new Set(Object.keys(draft)), [draft]);

  const selected = selection.id === null ? initialSelection(rows) : resolveSelection(rows, selection.id, selection.index, selection.advance);
  const selectedIndex = selected ? rows.indexOf(selected) : -1;
  const selectedTx = selected?.kind === "transaction" ? selected.tx : null;

  // The selection follows its row through filtering and decisions, or moves to the row resolved for it.
  if (selected && (selected.id !== selection.id || selectedIndex !== selection.index)) {
    setSelection({ id: selected.id, index: selectedIndex });
  }

  const receipts = useMemo(() => rowReceipts(selected, pool, claimed), [selected, pool, claimed]);
  /** Pool receipts the selected MATCHED transaction can add to its receipts. */
  const addable = useMemo(
    () => (selectedTx && selectedTx.status === "MATCHED" && !isNoReceipt(selectedTx.notes) ? addableReceipts(pool, selectedTx) : []),
    [selectedTx, pool],
  );
  const focusedChoice =
    focus && selected && focus.rowId === selected.id
      ? (receipts.find((r) => r.file === focus.file) ?? addable.find((r) => r.file === focus.file))
      : undefined;
  const focused: ReceiptMeta | null = focusedChoice ?? receipts[0] ?? null;

  const nextPendingIndex = findPending(rows, selectedIndex, 1);
  const previousPendingIndex = findPending(rows, selectedIndex < 0 ? rows.length : selectedIndex, -1);

  function setFilter(next: Filter) {
    setFilterState(next);
    setSelection((prev) => ({ id: prev.id, index: 0 }));
  }

  function setSearch(next: string) {
    setSearchState(next);
    setSelection((prev) => ({ id: prev.id, index: 0 }));
  }

  return {
    filter,
    search,
    selection,
    merged,
    claimed,
    pool,
    counts,
    pending,
    rows,
    reimbursementTotal,
    edited,
    selected,
    selectedIndex,
    selectedTx,
    receipts,
    addable,
    focused,
    nextPendingIndex,
    previousPendingIndex,
    setFilter,
    setSearch,
    setFilterState,
    setSearchState,
    setSelection,
    setFocus,
  };
}
