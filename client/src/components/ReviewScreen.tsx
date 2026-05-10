import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, Save, ScanLine, Lock, AlertTriangle, Search, X, ChevronsDownUp, ChevronsUpDown, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReviewData, TransactionResult, ReceiptMeta } from '../types';
import type { ProgressEvent } from '../App';
import { ProgressCard } from './ProgressCard';
import { SidePanel } from './ui/SidePanel';
import { useToast } from './ui/Toast';
import {
  PreviewButton,
  RescanButton,
  AcceptButton,
  RejectButton,
  AssignButton,
  DisputeButton,
} from './ui/ReceiptActions';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface DroppedDecision {
  txId: string;
  description: string;
  removedReceiptFiles: string[];
}

interface Props {
  year: string;
  month: string;
}

interface TransactionChange {
  status: 'MATCHED' | 'REVIEW' | 'UNMATCHED';
  receipt_meta: ReceiptMeta[];
  receipt_files: string[];
  notes: string;
}

type FilterStatus = 'all' | 'review' | 'unmatched' | 'matched';

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', BRL: 'R$',
};

function formatCents(cents: number | null, currency?: string | null): string {
  if (cents === null) return '—';
  const symbol = currency ? (CURRENCY_SYMBOLS[currency] ?? currency + ' ') : '€';
  return `${symbol}${(Math.abs(cents) / 100).toFixed(2)}`;
}

function fileBasename(path: string): string {
  return path.split('/').pop() || path;
}

function TxAmount({ cents }: { cents: number }) {
  const isIncome = cents > 0;
  const colorClass = isIncome ? 'text-success' : 'text-error';
  const Icon = isIncome ? ArrowUpRight : ArrowDownRight;
  const labelKey = isIncome ? 'review.amountKind.income' : 'review.amountKind.expense';
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-semibold whitespace-nowrap ${colorClass}`}>
      <Icon className="w-3.5 h-3.5" aria-label={t(labelKey)} />
      {formatCents(cents)}
    </span>
  );
}

const NO_RECEIPT_CATEGORY_KEYS = ['bank_fee', 'salary', 'transfer', 'refund', 'no_receipt'] as const;
type NoReceiptCategory = typeof NO_RECEIPT_CATEGORY_KEYS[number];
const NO_RECEIPT_NOTES = new Set<string>(NO_RECEIPT_CATEGORY_KEYS);

const NO_RECEIPT_LABEL_KEYS: Record<NoReceiptCategory, string> = {
  bank_fee: 'review.noReceiptCategories.bankFee',
  salary: 'review.noReceiptCategories.salary',
  transfer: 'review.noReceiptCategories.transfer',
  refund: 'review.noReceiptCategories.refund',
  no_receipt: 'review.noReceiptCategories.noReceipt',
};

function buildNoReceiptLabel(notes: string, t: TFunction): string {
  if (NO_RECEIPT_NOTES.has(notes)) return t(NO_RECEIPT_LABEL_KEYS[notes as NoReceiptCategory]);
  return notes;
}

function buildMatchReasonLabel(notes: string, t: TFunction): string {
  if (!notes) return '';
  if (notes === 'bank_fee') return t('review.matchReason.bankFeeAuto');
  if (notes === 'name_amount_match') return t('review.matchReason.nameAmountMatch');
  if (notes === 'name_amount_date_match') return t('review.matchReason.nameAmountDateMatch');
  if (notes === 'amount_match') return t('review.matchReason.amountMatch');
  if (notes.startsWith('fx_match')) {
    const cur = notes.match(/\(([^)]+)/)?.[1] ?? '';
    return t('review.matchReason.fxMatch', { detail: cur });
  }
  if (notes.startsWith('filename_match')) return t('review.matchReason.filenameMatch');
  const nameAmountMulti = notes.match(/^(\d+) receipts match name\+amount$/);
  if (nameAmountMulti) return t('review.matchReason.multipleNameAmount', { count: Number(nameAmountMulti[1]) });
  const amountMulti = notes.match(/^(\d+) receipts match amount$/);
  if (amountMulti) return t('review.matchReason.multipleAmount', { count: Number(amountMulti[1]) });
  const fxMulti = notes.match(/^(\d+) fx receipts within (.+)$/);
  if (fxMulti) return t('review.matchReason.multipleFx', { count: Number(fxMulti[1]), tolerance: fxMulti[2] });
  const filenameMulti = notes.match(/^(\d+) receipts match by filename$/);
  if (filenameMulti) return t('review.matchReason.multipleFilename', { count: Number(filenameMulti[1]) });
  if (notes === 'manual_match') return t('review.matchReason.manualMatch');
  if (notes.startsWith('rule_match')) return notes.replace('rule_match', t('review.matchReason.ruleMatch'));
  return notes;
}

function amountMismatch(receiptCents: number | null, txAbsCents: number, currency?: string | null): boolean {
  if (receiptCents === null) return false;
  // Non-EUR receipts: bank charges in EUR after conversion, allow ±10% before flagging.
  // EUR receipts: same currency, any cent diff is suspicious.
  if (currency && currency !== 'EUR') {
    const tolerance = txAbsCents * 0.10;
    return Math.abs(receiptCents - txAbsCents) > tolerance;
  }
  return receiptCents !== txAbsCents;
}


const FILTER_KEYS: FilterStatus[] = ['all', 'review', 'unmatched', 'matched'];

export function ReviewScreen({ year, month }: Props) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Tracks whether the user has interacted; avoids the first-mount race where
  // an empty `changes` map gets PUT and overwrites a freshly-restored draft.
  const [dirty, setDirty] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterStatus>('all');
  const [nameFilter, setNameFilter] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<Map<string, TransactionChange>>(new Map());
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatedReportUrl, setUpdatedReportUrl] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanEvents, setScanEvents] = useState<ProgressEvent[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanBanner, setScanBanner] = useState<DroppedDecision[] | null>(null);
  const [finalizeModalOpen, setFinalizeModalOpen] = useState(false);
  const [finalizeConsent, setFinalizeConsent] = useState(false);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setToolbarSlot(document.getElementById('review-toolbar-slot'));
  }, []);
  const scanAbortRef = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    filename: string;
    tx: TransactionResult;
    receipt: ReceiptMeta | null;
    action: 'review' | 'unmatched' | 'matched';
  } | null>(null);
  const { showToast } = useToast();
  const { t, i18n } = useTranslation();
  const matchReasonLabel = (notes: string) => buildMatchReasonLabel(notes, t);
  const noReceiptLabel = (notes: string) => buildNoReceiptLabel(notes, t);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/review/${year}/${month}`).then((res) => {
        if (res.status === 404) { setNotFound(true); return null; }
        if (!res.ok) throw new Error(`Failed to load review data: ${res.status}`);
        return res.json();
      }),
      fetch(`/api/draft/${year}/${month}`).then((res) => res.ok ? res.json() : {}).catch(() => ({})),
    ])
      .then(([d, draft]: [ReviewData | null, Record<string, TransactionChange>]) => {
        if (cancelled) return;
        if (d) setData(d);
        if (draft && typeof draft === 'object') {
          const restored = new Map<string, TransactionChange>();
          for (const [k, v] of Object.entries(draft)) restored.set(k, v as TransactionChange);
          if (restored.size > 0) setChanges(restored);
        }
      })
      .catch((err) => { if (!cancelled) setFetchError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [year, month]);

  // Debounced auto-save of pending changes so they survive app close / reload.
  // Only saves AFTER the user has interacted (dirty), so the initial empty
  // changes Map doesn't clobber a just-restored draft on first mount.
  useEffect(() => {
    if (loading || notFound || fetchError || !dirty) return;
    const timer = setTimeout(() => {
      const body = Object.fromEntries(changes);
      fetch(`/api/draft/${year}/${month}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        })
        .catch((e) => {
          // Surface persistent failures so the user knows their progress isn't
          // being saved. Toast component dedupes identical messages.
          showToast(t('review.draftSaveFailed', 'Could not save draft: {{msg}}', { msg: (e as Error).message }), 'error');
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [changes, year, month, loading, notFound, fetchError, dirty, showToast, t]);

  const effectiveTransactions = useMemo<TransactionResult[]>(() => {
    if (!data) return [];
    return data.transactions.map((tx) => {
      const change = changes.get(tx.id);
      return change ? { ...tx, ...change } : tx;
    });
  }, [data, changes]);

  const claimedReceiptFiles = useMemo<Set<string>>(() => {
    const claimed = new Set<string>();
    // Include receipts from ANY currently-MATCHED transaction (initial server
    // state + user changes). Otherwise an UNMATCHED tx's suggested-receipt
    // pool can include receipts already bound to a MATCHED tx.
    for (const tx of effectiveTransactions) {
      if (tx.status === 'MATCHED' && !NO_RECEIPT_NOTES.has(tx.notes)) {
        for (const m of (tx.receipt_meta || [])) claimed.add(m.file);
      }
    }
    return claimed;
  }, [effectiveTransactions]);

  const txById = useMemo(() => {
    if (!data) return new Map<string, TransactionResult>();
    return new Map(data.transactions.map((t) => [t.id, t]));
  }, [data]);

  const effectiveUnmatchedPool = useMemo<ReceiptMeta[]>(() => {
    if (!data) return [];
    const pool = new Map(data.unmatchedReceipts.map((r) => [r.file, r]));
    for (const [txId, change] of changes) {
      const origTx = txById.get(txId);
      if (!origTx) continue;
      if (change.status === 'UNMATCHED' && (origTx.status === 'REVIEW' || origTx.status === 'MATCHED')) {
        for (const m of origTx.receipt_meta) pool.set(m.file, m);
      }
    }
    for (const file of claimedReceiptFiles) pool.delete(file);
    return Array.from(pool.values());
  }, [data, changes, claimedReceiptFiles, txById]);

  // Memoized per-amount sort of the unmatched pool. Each UNMATCHED transaction
  // wants the pool ordered by proximity to its own abs_cents — without this
  // cache the sort would run inside .map() on every keystroke in the name filter.
  const sortedUnmatchedPoolByAmount = useMemo(() => {
    const cache = new Map<number, ReceiptMeta[]>();
    return (absCents: number) => {
      const cached = cache.get(absCents);
      if (cached) return cached;
      const base = absCents || 1;
      const sorted = [...effectiveUnmatchedPool].sort((a, b) => {
        const aDiff = a.amount_cents !== null ? Math.abs(a.amount_cents - absCents) / base : 1;
        const bDiff = b.amount_cents !== null ? Math.abs(b.amount_cents - absCents) / base : 1;
        return aDiff - bDiff;
      });
      cache.set(absCents, sorted);
      return sorted;
    };
  }, [effectiveUnmatchedPool]);

  const filterCounts = useMemo(() => {
    const counts = { all: 0, review: 0, unmatched: 0, matched: 0 };
    for (const tx of effectiveTransactions) {
      counts.all++;
      if (tx.status === 'REVIEW') counts.review++;
      else if (tx.status === 'UNMATCHED') counts.unmatched++;
      else counts.matched++;
    }
    return counts;
  }, [effectiveTransactions]);

  const visibleTransactions = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase();
    const filtered = effectiveTransactions.filter((tx) => {
      if (activeFilter !== 'all' && tx.status.toLowerCase() !== activeFilter) return false;
      if (needle && !tx.description.toLowerCase().includes(needle)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      const dateDiff = a.date.localeCompare(b.date);
      return dateDiff !== 0 ? dateDiff : a.id.localeCompare(b.id);
    });
  }, [effectiveTransactions, activeFilter, nameFilter]);

  useEffect(() => {
    setNameFilter('');
    if (data) {
      const seed = new Set<string>();
      for (const tx of data.transactions) {
        if (tx.status !== 'MATCHED') seed.add(tx.id);
      }
      setExpandedIds(seed);
    } else {
      setExpandedIds(new Set());
    }
  }, [data]);

  const allVisibleExpanded = visibleTransactions.length > 0
    && visibleTransactions.every((tx) => expandedIds.has(tx.id));

  function toggleExpandAll() {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleExpanded) {
        for (const tx of visibleTransactions) next.delete(tx.id);
      } else {
        for (const tx of visibleTransactions) next.add(tx.id);
      }
      return next;
    });
  }

  function setExpanded(txId: string, open: boolean) {
    setExpandedIds((prev) => {
      if (open === prev.has(txId)) return prev;
      const next = new Set(prev);
      if (open) next.add(txId); else next.delete(txId);
      return next;
    });
  }

  function applyChange(txId: string, change: TransactionChange) {
    setChanges((prev) => new Map(prev).set(txId, change));
    setDirty(true);
  }

  function confirmMatch(txId: string, receipt?: ReceiptMeta) {
    const tx = effectiveTransactions.find((t) => t.id === txId);
    if (!tx) return;
    // Bind only the clicked receipt when specified, leaving other candidates
    // free for sibling transactions in the same ambiguous-match group.
    const meta = receipt ? [receipt] : tx.receipt_meta;
    const files = meta.map((m) => m.file);
    applyChange(txId, { status: 'MATCHED', receipt_meta: meta, receipt_files: files, notes: tx.notes || 'amount_match' });
  }

  function rejectMatch(txId: string) {
    applyChange(txId, { status: 'UNMATCHED', receipt_meta: [], receipt_files: [], notes: '' });
  }

  function assignReceipt(txId: string, receiptFile: string) {
    const receipt = effectiveUnmatchedPool.find((r) => r.file === receiptFile);
    if (!receipt) return;
    applyChange(txId, { status: 'MATCHED', receipt_meta: [receipt], receipt_files: [receipt.file], notes: 'manual_match' });
  }

  function markAsNoReceipt(txId: string, category: NoReceiptCategory) {
    applyChange(txId, { status: 'MATCHED', receipt_meta: [], receipt_files: [], notes: category });
  }

  function dispute(txId: string) {
    // Send the transaction back to UNMATCHED so the user can pick a receipt
    // from the full unmatched pool OR select a no-receipt category. Keeping
    // the tx in REVIEW would only show its original candidates (which may be
    // empty for bank_fee / no-receipt-category transactions, leaving the
    // user with nothing actionable).
    applyChange(txId, {
      status: 'UNMATCHED',
      receipt_meta: [],
      receipt_files: [],
      notes: '',
    });
  }

  async function rescanReceipt(file: string) {
    if (rescanning.has(file)) return;
    setRescanning((prev) => new Set(prev).add(file));
    try {
      const res = await fetch(`/api/rescan-receipt/${year}/${month}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error: ${res.status}`);
      }
      const newMeta: ReceiptMeta = await res.json();
      setData((prev) => {
        if (!prev) return prev;
        const patch = (m: ReceiptMeta) => m.file === file ? newMeta : m;
        return {
          transactions: prev.transactions.map((tx) => ({
            ...tx,
            receipt_meta: tx.receipt_meta.map(patch),
          })),
          unmatchedReceipts: prev.unmatchedReceipts.map(patch),
        };
      });
      showToast(t('review.rescanDone'), 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setRescanning((prev) => {
        const next = new Set(prev);
        next.delete(file);
        return next;
      });
    }
  }

  async function rescanReimbursement(file: string) {
    if (rescanning.has(file)) return;
    setRescanning((prev) => new Set(prev).add(file));
    try {
      const res = await fetch(`/api/rescan-reimbursement/${year}/${month}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error: ${res.status}`);
      }
      const newMeta: ReceiptMeta = await res.json();
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          reimbursements: (prev.reimbursements || []).map((m) => m.file === file ? newMeta : m),
        };
      });
      showToast(t('review.reimbursements.rescanDone'), 'success');
    } catch (err) {
      showToast(t('review.reimbursements.rescanFailed', { msg: (err as Error).message }), 'error');
    } finally {
      setRescanning((prev) => {
        const next = new Set(prev);
        next.delete(file);
        return next;
      });
    }
  }

  async function saveChanges() {
    if (!data) return;
    setSaving(true);
    try {
      const body = Object.fromEntries(changes);
      const res = await fetch(`/api/draft/${year}/${month}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t('review.changesSaved'), 'success');
    } catch (err) {
      showToast(t('review.saveFailed', { msg: (err as Error).message }), 'error');
    } finally {
      setSaving(false);
    }
  }

  function scanReceipts() {
    if (!data || scanModalOpen) return;
    setScanModalOpen(true);
    setScanEvents([]);
    setScanError(null);
    setScanBanner(null);

    const ctrl = new AbortController();
    scanAbortRef.current = ctrl;
    const lang = i18n.language;

    fetch(`/api/scan-receipts/${year}/${month}?lang=${encodeURIComponent(lang)}`, {
      method: 'POST',
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok || !res.body) {
          return res.json().catch(() => ({})).then((body: { error?: string }) => {
            throw new Error(body.error || `Server error: ${res.status}`);
          });
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dropped: DroppedDecision[] = [];
        let reportUrlOut: string | null = null;
        let errored = false;

        function pump(): Promise<void> {
          return reader.read().then(({ done, value }) => {
            if (done) {
              if (errored) return;
              setScanModalOpen(false);
              if (reportUrlOut) setUpdatedReportUrl(reportUrlOut);
              setScanBanner(dropped);
              showToast(t('review.scanComplete'), 'success');
              // Refetch review data so newly extracted/removed receipts show up.
              return fetch(`/api/review/${year}/${month}`)
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Refresh failed: ${r.status}`))))
                .then((fresh: ReviewData) => {
                  if (fresh) {
                    setData(fresh);
                    // Drop user changes referencing transactions whose receipts no longer exist.
                    const presentFiles = new Set<string>();
                    for (const tx of fresh.transactions) {
                      for (const m of tx.receipt_meta || []) presentFiles.add(m.file);
                    }
                    for (const r of fresh.unmatchedReceipts || []) presentFiles.add(r.file);
                    setChanges((prev) => {
                      const next = new Map(prev);
                      for (const [txId, change] of prev) {
                        const stillValid = (change.receipt_files || []).every((f) => presentFiles.has(f));
                        if (!stillValid) next.delete(txId);
                      }
                      return next;
                    });
                  }
                })
                .catch((e) => showToast(t('review.refreshFailed', { msg: (e as Error).message }), 'error'));
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data:')) continue;
              try {
                const evt = JSON.parse(line.slice(5).trim()) as ProgressEvent & { droppedDecisions?: DroppedDecision[] };
                setScanEvents((prev) => [...prev, evt as ProgressEvent]);
                if (evt.step === 'done') {
                  dropped = evt.droppedDecisions || [];
                  reportUrlOut = evt.reportUrl;
                } else if (evt.step === 'error') {
                  errored = true;
                  setScanError(evt.message);
                }
              } catch {
                // ignore malformed event
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        setScanError((err as Error).message);
      })
      .finally(() => {
        scanAbortRef.current = null;
      });
  }

  function cancelScan() {
    scanAbortRef.current?.abort();
    setScanModalOpen(false);
    setScanError(null);
  }

  async function finalize() {
    if (!data) return;
    setApplying(true);
    try {
      const updatedTransactions = data.transactions.map((tx) => {
        const change = changes.get(tx.id);
        return change ? { ...tx, ...change } : tx;
      });
      const res = await fetch(`/api/review/${year}/${month}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: updatedTransactions, unmatchedReceipts: effectiveUnmatchedPool, language: i18n.language }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error: ${res.status}`);
      }
      const result = await res.json();
      setUpdatedReportUrl(result.reportUrl);
      setChanges(new Map());
      setDirty(false);
      setFinalizeModalOpen(false);
      setFinalizeConsent(false);
      showToast(t('review.changesApplied'), 'success');
      fetch(`/api/review/${year}/${month}`)
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`Refresh failed: ${r.status}`)))
        .then((fresh) => { if (fresh) setData(fresh); })
        .catch((e) => showToast(t('review.refreshFailed', 'Could not refresh review data: {{msg}}', { msg: (e as Error).message }), 'error'));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setApplying(false);
    }
  }

  function renderPreview() {
    if (!preview) return null;
    const { tx, receipt, action } = preview;
    const mismatch = receipt ? amountMismatch(receipt.amount_cents, tx.abs_cents, receipt.currency) : false;
    const header = (
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-base-content/50">{tx.date}</span>
          {tx.status === 'REVIEW' && <span className="badge badge-warning badge-sm">{t('review.filters.review')}</span>}
          {tx.status === 'UNMATCHED' && <span className="badge badge-error badge-sm">{t('review.filters.unmatched')}</span>}
          <span className="text-sm font-medium text-base-content flex-1 truncate">{tx.description}</span>
          <TxAmount cents={tx.amount_cents} />
        </div>
        {receipt && (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-base-content truncate block">{receipt.vendor ?? fileBasename(receipt.file)}</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {receipt.vendor && <span className="text-xs text-base-content/50 truncate">{fileBasename(receipt.file)}</span>}
                <span className="text-xs text-base-content/50">{receipt.date ?? t('review.dateUnknown')}</span>
                {tx.notes && <span className="text-xs text-base-content/50">{matchReasonLabel(tx.notes)}</span>}
              </div>
            </div>
            {receipt.amount_cents !== null && (
              <span className={`text-sm font-medium flex-shrink-0 ${mismatch ? 'text-warning' : 'text-success'}`}>
                {formatCents(receipt.amount_cents, receipt.currency)}
              </span>
            )}
            <div className="flex items-center gap-1 flex-shrink-0">
              {action === 'review' && (
                <>
                  <AcceptButton placement="bottom" onClick={() => { confirmMatch(tx.id, receipt ?? undefined); setPreview(null); }} />
                  <RejectButton placement="bottom" onClick={() => { rejectMatch(tx.id); setPreview(null); }} />
                </>
              )}
              {action === 'unmatched' && (
                <AssignButton placement="bottom" onClick={() => { assignReceipt(tx.id, receipt.file); setPreview(null); }} />
              )}
              {action === 'matched' && (
                <DisputeButton placement="bottom" onClick={() => { dispute(tx.id); setPreview(null); }} />
              )}
            </div>
          </div>
        )}
      </div>
    );
    return <SidePanel url={preview.url} filename={preview.filename} onClose={() => setPreview(null)} header={header} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="loading loading-spinner loading-md text-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="card bg-base-100 rounded-none">
        <div className="card-body">
          <div className="py-8 text-center text-sm text-base-content/70">
            {t('review.empty')}
          </div>
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="card bg-base-100 rounded-none">
        <div className="card-body">
          <div role="alert" className="alert alert-error">
            <span className="text-sm">{fetchError}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {toolbarSlot && createPortal(
          <div className="max-w-6xl mx-auto px-8 py-2 flex flex-col lg:flex-row lg:items-center gap-3">
            <div role="tablist" className="tabs tabs-boxed w-fit">
              {FILTER_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  onClick={() => setActiveFilter(key)}
                  className={`tab gap-2 ${activeFilter === key ? 'tab-active !bg-neutral !text-neutral-content' : ''}`}
                >
                  {t(`review.filters.${key}`)}
                  <span className={`badge badge-sm ${activeFilter === key ? '!bg-base-200 !text-base-content !border-transparent' : 'badge-neutral'}`}>
                    {filterCounts[key]}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 lg:flex-1">
              <div className="relative flex-1 min-w-[12rem]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-base-content/50 pointer-events-none" />
                <input
                  type="text"
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                  placeholder={t('review.nameFilter.placeholder')}
                  className="input input-bordered w-full pl-9 pr-9 !h-10 !min-h-[2.5rem] text-sm"
                />
                {nameFilter && (
                  <button
                    type="button"
                    onClick={() => setNameFilter('')}
                    aria-label={t('review.nameFilter.clear')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-base-200"
                  >
                    <X className="w-3.5 h-3.5 text-base-content/60" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={toggleExpandAll}
                disabled={visibleTransactions.length === 0}
                className="btn btn-sm btn-ghost gap-2 ml-auto !h-10 !min-h-[2.5rem]"
              >
                {allVisibleExpanded
                  ? <><ChevronsDownUp className="w-4 h-4" />{t('review.collapse')}</>
                  : <><ChevronsUpDown className="w-4 h-4" />{t('review.expand')}</>}
              </button>
            </div>
          </div>,
          toolbarSlot,
      )}
      <div className="card bg-base-100 rounded-none !overflow-visible">
        <div className="card-body !pb-0 !gap-8">
          {/* Transaction list */}
          <div className="space-y-3">
            {visibleTransactions.length === 0 && (
              <p className="text-sm text-base-content/60 py-4 text-center">{t('review.noTransactions')}</p>
            )}

            {visibleTransactions.map((tx) => (
              <details
                key={tx.id}
                open={expandedIds.has(tx.id)}
                onToggle={(e) => setExpanded(tx.id, (e.currentTarget as HTMLDetailsElement).open)}
                className="collapse collapse-arrow rounded-btn border border-base-content/20 bg-base-100 [&[open]]:!overflow-visible"
              >
                {/* Transaction header */}
                <summary className="collapse-title !min-h-[3rem] !py-3 !flex items-center justify-between gap-4 cursor-pointer marker:content-none [&::-webkit-details-marker]:hidden [&::after]:!top-[1.5rem]">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm text-base-content/60 whitespace-nowrap">{tx.date}</span>
                    {tx.status === 'REVIEW' && <span className="badge badge-warning">{t('review.filters.review')}</span>}
                    {tx.status === 'UNMATCHED' && <span className="badge badge-error">{t('review.filters.unmatched')}</span>}
                    {tx.status === 'MATCHED' && <span className="badge badge-success !text-white">{t('review.filters.matched')}</span>}
                    <span className="text-sm font-medium text-base-content truncate">{tx.description}</span>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <TxAmount cents={tx.amount_cents} />
                  </div>
                </summary>

                {/* Receipt / action area */}
                <div className="collapse-content !p-0">
                  <div className="border-t border-base-200 divide-y divide-base-200">

                    {/* REVIEW: one row per candidate receipt (excluding receipts claimed by another tx) */}
                    {tx.status === 'REVIEW' && tx.receipt_meta.filter((m) => !claimedReceiptFiles.has(m.file)).map((m) => {
                      const mismatch = amountMismatch(m.amount_cents, tx.abs_cents, m.currency);
                      return (
                        <div key={m.file} className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-base-content truncate block">{m.vendor ?? fileBasename(m.file)}</span>
                            <div className="flex items-center gap-2 text-xs text-base-content/50">
                              {m.vendor && <span className="truncate">{fileBasename(m.file)}</span>}
                              <span className="flex-shrink-0">{m.date ?? t('review.dateUnknown')}</span>
                            </div>
                          </div>
                          {m.confidence && m.confidence !== 'high' && <span className="badge badge-warning badge-sm">low</span>}
                          {tx.notes && <span className="text-xs text-base-content/50 flex-shrink-0 hidden sm:block">{matchReasonLabel(tx.notes)}</span>}
                          {m.amount_cents !== null && (
                            <span className={`text-sm font-medium flex-shrink-0 ${mismatch ? 'text-warning' : 'text-success'}`}>
                              {formatCents(m.amount_cents, m.currency)}
                            </span>
                          )}
                          <PreviewButton onClick={() => setPreview({ url: m.receiptUrl, filename: fileBasename(m.file), tx, receipt: m, action: 'review' })} />
                          <RescanButton onClick={() => rescanReceipt(m.file)} disabled={rescanning.has(m.file)} spinning={rescanning.has(m.file)} />
                          <AcceptButton onClick={() => confirmMatch(tx.id, m)} />
                          <RejectButton onClick={() => rejectMatch(tx.id)} />
                        </div>
                      );
                    })}

                    {/* UNMATCHED: full pool, sorted by amount proximity (closest first). */}
                    {tx.status === 'UNMATCHED' && sortedUnmatchedPoolByAmount(tx.abs_cents)
                      .map((r) => {
                        const mismatch = amountMismatch(r.amount_cents, tx.abs_cents, r.currency);
                        return (
                          <div key={r.file} className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-base-content truncate block">{r.vendor ?? fileBasename(r.file)}</span>
                              <div className="flex items-center gap-2 text-xs text-base-content/50">
                                {r.vendor && <span className="truncate">{fileBasename(r.file)}</span>}
                                <span className="flex-shrink-0">{r.date ?? t('review.dateUnknown')}</span>
                              </div>
                            </div>
                            {r.confidence && r.confidence !== 'high' && <span className="badge badge-warning badge-sm">low</span>}
                            {r.amount_cents !== null && (
                              <span className={`text-sm font-medium flex-shrink-0 ${mismatch ? 'text-warning' : 'text-success'}`}>
                                {formatCents(r.amount_cents, r.currency)}
                              </span>
                            )}
                            <PreviewButton onClick={() => setPreview({ url: r.receiptUrl, filename: fileBasename(r.file), tx, receipt: r, action: 'unmatched' })} />
                            <RescanButton onClick={() => rescanReceipt(r.file)} disabled={rescanning.has(r.file)} spinning={rescanning.has(r.file)} />
                            <AssignButton onClick={() => assignReceipt(tx.id, r.file)} />
                          </div>
                        );
                      })}

                    {/* MATCHED: receipt rows */}
                    {tx.status === 'MATCHED' && !NO_RECEIPT_NOTES.has(tx.notes) && tx.receipt_meta.map((m) => {
                      const mismatch = amountMismatch(m.amount_cents, tx.abs_cents, m.currency);
                      return (
                        <div key={m.file} className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-base-content truncate block">{m.vendor ?? fileBasename(m.file)}</span>
                            <div className="flex items-center gap-2 text-xs text-base-content/50">
                              {m.vendor && <span className="truncate">{fileBasename(m.file)}</span>}
                              <span className="flex-shrink-0">{m.date ?? t('review.dateUnknown')}</span>
                            </div>
                          </div>
                          {m.confidence && m.confidence !== 'high' && <span className="badge badge-warning badge-sm">low</span>}
                          {tx.notes && <span className="text-xs text-base-content/50 flex-shrink-0 hidden sm:block">{matchReasonLabel(tx.notes)}</span>}
                          {m.amount_cents !== null && (
                            <span className={`text-sm font-medium flex-shrink-0 ${mismatch ? 'text-warning' : 'text-success'}`}>
                              {formatCents(m.amount_cents, m.currency)}
                            </span>
                          )}
                          <PreviewButton onClick={() => setPreview({ url: m.receiptUrl, filename: fileBasename(m.file), tx, receipt: m, action: 'matched' })} />
                          <RescanButton onClick={() => rescanReceipt(m.file)} disabled={rescanning.has(m.file)} spinning={rescanning.has(m.file)} />
                          <DisputeButton onClick={() => dispute(tx.id)} />
                        </div>
                      );
                    })}

                    {/* MATCHED: no-receipt category — single label row */}
                    {tx.status === 'MATCHED' && NO_RECEIPT_NOTES.has(tx.notes) && (
                      <div className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-base-content truncate block">{noReceiptLabel(tx.notes)}</span>
                        </div>
                        <DisputeButton onClick={() => dispute(tx.id)} />
                      </div>
                    )}

                    {/* MATCHED: no receipt at all */}
                    {tx.status === 'MATCHED' && !NO_RECEIPT_NOTES.has(tx.notes) && tx.receipt_meta.length === 0 && (
                      <div className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-base-content/60 truncate block">{t('review.noReceipt')}</span>
                        </div>
                        <DisputeButton onClick={() => dispute(tx.id)} />
                      </div>
                    )}

                  </div>

                  {/* UNMATCHED: no-receipt select below the pool list */}
                  {tx.status === 'UNMATCHED' && (
                    <div className="border-t border-base-200 px-4 pt-3 pb-3">
                      <select
                        value=""
                        onChange={(e) => { if (e.target.value) markAsNoReceipt(tx.id, e.target.value as NoReceiptCategory); }}
                        className="select select-bordered select-sm text-base-content/60"
                      >
                        <option value="" disabled>{t('common.select', 'Select…')}</option>
                        {NO_RECEIPT_CATEGORY_KEYS.map((key) => (
                          <option key={key} value={key}>{t(NO_RECEIPT_LABEL_KEYS[key])}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>

          {/* Reimbursements (read-only) — receipts paid personally on company VAT */}
          {data?.reimbursements && data.reimbursements.length > 0 && (() => {
            const reimbs = data.reimbursements!;
            const totalCents = reimbs.reduce((acc, r) => acc + (r.amount_cents || 0), 0);
            return (
              <details className="mt-4 border border-base-200 rounded-lg" open>
                <summary className="cursor-pointer select-none px-4 py-3 flex items-center justify-between gap-3">
                  <span className="font-semibold text-base-content">
                    {t('review.reimbursements.title')} ({reimbs.length})
                  </span>
                  <span className="text-sm font-semibold text-base-content/80 whitespace-nowrap">
                    {t('review.reimbursements.total')}: {formatCents(totalCents, 'EUR')}
                  </span>
                </summary>
                <div className="px-4 pb-3 pt-1 text-xs text-base-content/60">
                  {t('review.reimbursements.subtitle')}
                </div>
                <div className="divide-y divide-base-200 border-t border-base-200">
                  {reimbs.map((r) => (
                    <div key={r.file} className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-base-content truncate block">
                          {r.vendor ?? fileBasename(r.file)}
                        </span>
                        <div className="flex items-center gap-2 text-xs text-base-content/50">
                          {r.vendor && <span className="truncate">{fileBasename(r.file)}</span>}
                          <span>{r.date ?? t('review.dateUnknown')}</span>
                        </div>
                      </div>
                      {r.amount_cents !== null && (
                        <span className="text-sm font-semibold whitespace-nowrap">
                          {formatCents(r.amount_cents, r.currency)}
                        </span>
                      )}
                      <a
                        href={r.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-ghost btn-xs"
                        title={t('review.actions.preview')}
                      >
                        {t('review.actions.preview')}
                      </a>
                      <RescanButton
                        onClick={() => rescanReimbursement(r.file)}
                        disabled={rescanning.has(r.file)}
                        spinning={rescanning.has(r.file)}
                      />
                    </div>
                  ))}
                </div>
              </details>
            );
          })()}

          {/* Scan-dropped banner */}
          {scanBanner && scanBanner.length > 0 && (
            <div role="alert" className="alert alert-warning mt-3">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">
                {t('review.scanDroppedBanner', {
                  count: scanBanner.length,
                  names: scanBanner.map((d) => d.description).join(', '),
                })}
              </span>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setScanBanner(null)}>
                {t('review.scanDroppedDismiss')}
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="sticky bottom-0 z-20 bg-base-100 -mx-8 px-8 pt-4 pb-4 border-t border-base-200 mt-2 flex flex-wrap items-center gap-3">
            <button
              className="btn btn-secondary btn-sm !text-white"
              onClick={saveChanges}
              disabled={changes.size === 0 || saving || applying}
            >
              {saving ? <span className="loading loading-spinner loading-xs" /> : <Save className="w-4 h-4" />}
              {t('review.save')}
            </button>
            <button
              className="btn btn-outline btn-sm hover:!bg-base-200 hover:!text-base-content hover:!border-base-content/20"
              onClick={scanReceipts}
              disabled={scanModalOpen || applying}
            >
              <ScanLine className="w-4 h-4" />
              {t('review.scan')}
            </button>
            <a
              href={updatedReportUrl || `/report/${year}/${month}/report.xlsx?lang=${i18n.language}&ts=${Date.now()}`}
              download
              className="btn btn-outline btn-sm hover:!bg-base-200 hover:!text-base-content hover:!border-base-content/20"
            >
              <Download className="w-4 h-4" />
              {t('review.downloadReport')}
            </a>
            <div className="flex-1" />
            <button
              className="btn btn-primary btn-sm !text-white"
              onClick={() => { setFinalizeConsent(false); setFinalizeModalOpen(true); }}
              disabled={applying}
            >
              <Lock className="w-4 h-4" />
              {t('review.finalize')}
            </button>
          </div>
        </div>
      </div>

      {/* Scan progress modal */}
      {scanModalOpen && (
        <div className="modal modal-open">
          <div className="modal-box max-w-2xl">
            <h3 className="font-semibold text-lg mb-1">{t('review.scanModal.title')}</h3>
            <p className="text-sm text-base-content/60 mb-4">{t('review.scanModal.subtitle')}</p>
            <ProgressCard events={scanEvents} />
            {scanError && (
              <div role="alert" className="alert alert-error mt-3">
                <span className="text-sm">{t('review.scanFailed', { msg: scanError })}</span>
              </div>
            )}
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-sm"
                onClick={cancelScan}
                disabled={!scanError && !scanEvents.some((e) => e.step === 'done')}
              >
                {t('review.scanModal.close')}
              </button>
            </div>
          </div>
          <div className="modal-backdrop" />
        </div>
      )}

      {/* Finalize confirmation modal */}
      {finalizeModalOpen && (
        <div className="modal modal-open">
          <div className="modal-box max-w-lg">
            <h3 className="font-semibold text-lg mb-2">{t('review.finalizeConfirm.title')}</h3>
            <p className="text-sm text-base-content/80 mb-4">{t('review.finalizeConfirm.body')}</p>
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={finalizeConsent}
                onChange={(e) => setFinalizeConsent(e.target.checked)}
              />
              <span className="label-text">{t('review.finalizeConfirm.checkbox')}</span>
            </label>
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => { setFinalizeModalOpen(false); setFinalizeConsent(false); }}
                disabled={applying}
              >
                {t('review.finalizeConfirm.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm !text-white"
                onClick={finalize}
                disabled={!finalizeConsent || applying}
              >
                {applying && <span className="loading loading-spinner loading-xs" />}
                {t('review.finalizeConfirm.cta')}
              </button>
            </div>
          </div>
          <div className="modal-backdrop" />
        </div>
      )}

      {preview && renderPreview()}
    </>
  );
}
