import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "../lib/hooks/useLatest";
import { getDraft, getReview, periodStatus, rescanReceipt, rescanReimbursement, saveDraft, type Draft, type ReceiptMeta, type ReviewData } from "../lib/tauri";
import { patchDraftReceipt } from "./decisions";
import { mergeDraft, patchReceipt, pendingCount, type Filter } from "./effective";
import { useHistory } from "./history";
import { useDraftAutosave } from "./useDraftAutosave";

type Loaded = { data: ReviewData; applied: boolean };

interface ReviewDataOptions {
  year: string;
  month: string;
  /** Runs after a save, since the month list shows how many transactions are left. */
  onSaved?: () => void;
  onError: (e: unknown) => void;
  /** Picks the filter the month opens on, once the first load shows what is left to decide. */
  onFirstLoad: (filter: Filter) => void;
}

/**
 * A month's review data and its draft: loads both, keeps the draft's history and autosave, and
 * reads receipts again in place.
 */
export function useReviewData({ year, month, onSaved, onError, onFirstLoad }: ReviewDataOptions) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const history = useHistory<Draft>({});
  const [dirty, setDirty] = useState(false);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  /** Whether the filter was set for the month. */
  const filterSet = useRef(false);

  const draft = history.present;
  const latestDraft = useLatest(draft);
  const save = useCallback((next: Draft) => saveDraft(year, month, next), [year, month]);
  const autosave = useDraftAutosave(draft, dirty, save);

  const saveKind = autosave.state.kind;
  const latestOnSaved = useLatest(onSaved);
  const latestOnFirstLoad = useLatest(onFirstLoad);
  useEffect(() => {
    if (saveKind === "saved") {
      latestOnSaved.current?.();
    }
  }, [saveKind, latestOnSaved]);

  const { reset: resetHistory, map: mapHistory } = history;
  const { forget: forgetSaveState } = autosave;
  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([getReview(year, month), getDraft(year, month), periodStatus(year, month)]).then(
      ([data, stored, periodState]) => {
        setLoaded({ data, applied: periodState.applied });
        if (!filterSet.current) {
          filterSet.current = true;
          const open = pendingCount(mergeDraft(data.transactions, stored));
          latestOnFirstLoad.current(open > 0 && !periodState.applied ? "pending" : "all");
        }
        resetHistory(stored);
        setDirty(false);
        forgetSaveState();
      },
      (e) => setLoadError(e),
    );
  }, [year, month, resetHistory, forgetSaveState, latestOnFirstLoad]);

  useEffect(load, [load]);

  const applied = loaded?.applied ?? false;

  /** Reads a receipt again and patches the result into the data and the decisions that hold it. */
  async function rescan(receipt: ReceiptMeta, reimbursement: boolean) {
    if (!receipt.rel_path || rescanning.has(receipt.file) || applied) {
      return;
    }
    const relPath = receipt.rel_path;
    setRescanning((prev) => new Set(prev).add(receipt.file));
    try {
      const meta = await (reimbursement ? rescanReimbursement : rescanReceipt)(year, month, relPath);
      setLoaded((prev) => (prev ? { ...prev, data: patchReceipt(prev.data, meta) } : prev));
      // Decisions keep their own copy of each receipt; they take the new reading too.
      if (patchDraftReceipt(latestDraft.current, meta).changed) {
        setDirty(true);
      }
      mapHistory((value) => patchDraftReceipt(value, meta).draft);
    } catch (e) {
      onError(e);
    } finally {
      setRescanning((prev) => {
        const next = new Set(prev);
        next.delete(receipt.file);
        return next;
      });
    }
  }

  return { data: loaded?.data ?? null, applied, ready: loaded !== null, loadError, load, history, draft, setDirty, autosave, rescanning, rescan };
}
