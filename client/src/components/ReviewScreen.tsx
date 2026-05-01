import { useState, useMemo, useEffect } from 'react';
import { Check, X, Eye, Download, RotateCcw, RefreshCw, Save } from 'lucide-react';
import type { ReviewData, TransactionResult, ReceiptMeta } from '../types';
import { SidePanel } from './ui/SidePanel';
import { useToast } from './ui/Toast';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

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

const NO_RECEIPT_CATEGORY_KEYS = ['bank_fee', 'salary', 'transfer', 'refund', 'other'] as const;
type NoReceiptCategory = typeof NO_RECEIPT_CATEGORY_KEYS[number];
const NO_RECEIPT_NOTES = new Set<string>(NO_RECEIPT_CATEGORY_KEYS);

const NO_RECEIPT_LABEL_KEYS: Record<NoReceiptCategory, string> = {
  bank_fee: 'review.noReceiptCategories.bankFee',
  salary: 'review.noReceiptCategories.salary',
  transfer: 'review.noReceiptCategories.transfer',
  refund: 'review.noReceiptCategories.refund',
  other: 'review.noReceiptCategories.other',
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
  if (notes === 'amount_match' || notes.startsWith('amount_match')) return t('review.matchReason.amountMatch');
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

function amountMismatch(receiptCents: number | null, txAbsCents: number): boolean {
  if (receiptCents === null) return false;
  return Math.abs(receiptCents - txAbsCents) > 5;
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
  const [changes, setChanges] = useState<Map<string, TransactionChange>>(new Map());
  const [applying, setApplying] = useState(false);
  const [updatedReportUrl, setUpdatedReportUrl] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{
    url: string;
    filename: string;
    tx: TransactionResult;
    receipt: ReceiptMeta | null;
    action: 'review' | 'unmatched' | 'matched';
  } | null>(null);
  const { showToast } = useToast();
  const { t } = useTranslation();
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

  const effectiveUnmatchedPool = useMemo<ReceiptMeta[]>(() => {
    if (!data) return [];
    const pool = new Map(data.unmatchedReceipts.map((r) => [r.file, r]));
    for (const [txId, change] of changes) {
      const origTx = data.transactions.find((t) => t.id === txId);
      if (!origTx) continue;
      if (origTx.status === 'REVIEW' && change.status === 'UNMATCHED') {
        for (const m of origTx.receipt_meta) pool.set(m.file, m);
      }
    }
    for (const file of claimedReceiptFiles) pool.delete(file);
    return Array.from(pool.values());
  }, [data, changes, claimedReceiptFiles]);

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
    const filtered = activeFilter === 'all'
      ? effectiveTransactions
      : effectiveTransactions.filter((tx) => tx.status.toLowerCase() === activeFilter);
    return [...filtered].sort((a, b) => {
      const dateDiff = a.date.localeCompare(b.date);
      return dateDiff !== 0 ? dateDiff : a.id.localeCompare(b.id);
    });
  }, [effectiveTransactions, activeFilter]);

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
    const tx = effectiveTransactions.find((t) => t.id === txId);
    if (!tx) return;
    applyChange(txId, { status: 'REVIEW', receipt_meta: tx.receipt_meta, receipt_files: tx.receipt_files, notes: tx.notes });
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

  async function applyChanges() {
    if (!data || changes.size === 0) return;
    setApplying(true);
    try {
      const updatedTransactions = data.transactions.map((tx) => {
        const change = changes.get(tx.id);
        return change ? { ...tx, ...change } : tx;
      });
      const res = await fetch(`/api/review/${year}/${month}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: updatedTransactions, unmatchedReceipts: effectiveUnmatchedPool }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error: ${res.status}`);
      }
      const result = await res.json();
      setUpdatedReportUrl(result.reportUrl);
      setChanges(new Map());
      setDirty(false);
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
    const mismatch = receipt ? amountMismatch(receipt.amount_cents, tx.abs_cents) : false;
    const header = (
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-base-content/50">{tx.date}</span>
          {tx.status === 'REVIEW' && <span className="badge badge-warning badge-sm">{t('review.filters.review')}</span>}
          {tx.status === 'UNMATCHED' && <span className="badge badge-error badge-sm">{t('review.filters.unmatched')}</span>}
          <span className="text-sm font-medium text-base-content flex-1 truncate">{tx.description}</span>
          <span className="text-sm font-semibold text-base-content">{formatCents(tx.amount_cents)}</span>
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
                  <button type="button" onClick={() => { confirmMatch(tx.id, receipt ?? undefined); setPreview(null); }} className="btn btn-primary btn-xs btn-circle" title={t('review.actions.accept')}><Check className="w-3 h-3" /></button>
                  <button type="button" onClick={() => { rejectMatch(tx.id); setPreview(null); }} className="btn btn-error btn-xs btn-circle" title={t('review.actions.reject')}><X className="w-3 h-3" /></button>
                </>
              )}
              {action === 'unmatched' && (
                <button type="button" onClick={() => { assignReceipt(tx.id, receipt.file); setPreview(null); }} className="btn btn-primary btn-xs btn-circle" title={t('review.actions.assign')}><Check className="w-3 h-3" /></button>
              )}
              {action === 'matched' && (
                <button type="button" onClick={() => { dispute(tx.id); setPreview(null); }} className="btn btn-warning btn-xs btn-circle" title={t('review.actions.dispute')}><RotateCcw className="w-3 h-3" /></button>
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
      <div className="card bg-base-100 rounded-none">
        <div className="card-body">
          {/* Filter tabs */}
          <div role="tablist" className="tabs tabs-boxed w-fit">
            {FILTER_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                onClick={() => setActiveFilter(key)}
                className={`tab gap-2 ${activeFilter === key ? 'tab-active' : ''}`}
              >
                {t(`review.filters.${key}`)}
                <span className={`badge badge-sm ${activeFilter === key ? 'badge-ghost' : 'badge-neutral'}`}>
                  {filterCounts[key]}
                </span>
              </button>
            ))}
          </div>

          {/* Transaction list */}
          <div className="space-y-3 mt-4">
            {visibleTransactions.length === 0 && (
              <p className="text-sm text-base-content/60 py-4 text-center">{t('review.noTransactions')}</p>
            )}

            {visibleTransactions.map((tx) => (
              <details
                key={tx.id}
                open={tx.status !== 'MATCHED'}
                className="collapse collapse-arrow rounded-lg border border-base-200 bg-base-100"
              >
                {/* Transaction header */}
                <summary className="collapse-title !min-h-0 !py-3 !pr-12 !flex items-center justify-between gap-4 cursor-pointer marker:content-none [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm text-base-content/60 whitespace-nowrap">{tx.date}</span>
                    {tx.status === 'REVIEW' && <span className="badge badge-warning">{t('review.filters.review')}</span>}
                    {tx.status === 'UNMATCHED' && <span className="badge badge-error">{t('review.filters.unmatched')}</span>}
                    {tx.status === 'MATCHED' && <span className="badge badge-success">{t('review.filters.matched')}</span>}
                    <span className="text-sm font-medium text-base-content truncate">{tx.description}</span>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <span className="text-sm font-semibold text-base-content whitespace-nowrap">
                      {formatCents(tx.amount_cents)}
                    </span>
                  </div>
                </summary>

                {/* Receipt / action area */}
                <div className="collapse-content !p-0">
                  <div className="border-t border-base-200 overflow-y-auto max-h-52 divide-y divide-base-200">

                    {/* REVIEW: one row per candidate receipt (excluding receipts claimed by another tx) */}
                    {tx.status === 'REVIEW' && tx.receipt_meta.filter((m) => !claimedReceiptFiles.has(m.file)).map((m) => {
                      const mismatch = amountMismatch(m.amount_cents, tx.abs_cents);
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
                          <button type="button" onClick={() => setPreview({ url: m.receiptUrl, filename: fileBasename(m.file), tx, receipt: m, action: 'review' })} className="btn btn-outline btn-xs btn-circle flex-shrink-0" title={t('review.actions.preview')}>
                            <Eye className="w-3 h-3" />
                          </button>
                          <button type="button" onClick={() => rescanReceipt(m.file)} disabled={rescanning.has(m.file)} className="btn btn-outline btn-xs btn-circle flex-shrink-0" title={t('review.actions.rescan')}>
                            <RefreshCw className={`w-3 h-3 ${rescanning.has(m.file) ? 'animate-spin' : ''}`} />
                          </button>
                          <button type="button" onClick={() => confirmMatch(tx.id, m)} className="btn btn-primary btn-xs btn-circle flex-shrink-0" title={t('review.actions.accept')}>
                            <Check className="w-3 h-3" />
                          </button>
                          <button type="button" onClick={() => rejectMatch(tx.id)} className="btn btn-error btn-xs btn-circle flex-shrink-0" title={t('review.actions.reject')}>
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}

                    {/* UNMATCHED: full pool, sorted by amount proximity (closest first). */}
                    {tx.status === 'UNMATCHED' && [...effectiveUnmatchedPool]
                      .sort((a, b) => {
                        const base = tx.abs_cents || 1;
                        const aDiff = a.amount_cents !== null ? Math.abs(a.amount_cents - tx.abs_cents) / base : 1;
                        const bDiff = b.amount_cents !== null ? Math.abs(b.amount_cents - tx.abs_cents) / base : 1;
                        return aDiff - bDiff;
                      })
                      .map((r) => {
                        const mismatch = amountMismatch(r.amount_cents, tx.abs_cents);
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
                            <button type="button" onClick={() => setPreview({ url: r.receiptUrl, filename: fileBasename(r.file), tx, receipt: r, action: 'unmatched' })} className="btn btn-outline btn-xs btn-circle flex-shrink-0" title={t('review.actions.preview')}>
                              <Eye className="w-3 h-3" />
                            </button>
                            <button type="button" onClick={() => rescanReceipt(r.file)} disabled={rescanning.has(r.file)} className="btn btn-outline btn-xs btn-circle flex-shrink-0" title={t('review.actions.rescan')}>
                              <RefreshCw className={`w-3 h-3 ${rescanning.has(r.file) ? 'animate-spin' : ''}`} />
                            </button>
                            <button type="button" onClick={() => assignReceipt(tx.id, r.file)} className="btn btn-primary btn-xs btn-circle flex-shrink-0" title={t('review.actions.assign')}>
                              <Check className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}

                    {/* MATCHED: receipt rows */}
                    {tx.status === 'MATCHED' && !NO_RECEIPT_NOTES.has(tx.notes) && tx.receipt_meta.map((m) => {
                      const mismatch = amountMismatch(m.amount_cents, tx.abs_cents);
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
                          <button type="button" onClick={() => setPreview({ url: m.receiptUrl, filename: fileBasename(m.file), tx, receipt: m, action: 'matched' })} className="btn btn-outline btn-xs btn-circle flex-shrink-0" title={t('review.actions.preview')}>
                            <Eye className="w-3 h-3" />
                          </button>
                          <button type="button" onClick={() => rescanReceipt(m.file)} disabled={rescanning.has(m.file)} className="btn btn-outline btn-xs btn-circle flex-shrink-0" title={t('review.actions.rescan')}>
                            <RefreshCw className={`w-3 h-3 ${rescanning.has(m.file) ? 'animate-spin' : ''}`} />
                          </button>
                          <button type="button" onClick={() => dispute(tx.id)} className="btn btn-warning btn-xs btn-circle flex-shrink-0" title={t('review.actions.dispute')}>
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}

                    {/* MATCHED: no-receipt category — single label row */}
                    {tx.status === 'MATCHED' && NO_RECEIPT_NOTES.has(tx.notes) && (
                      <div className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-base-content truncate block">{noReceiptLabel(tx.notes)}</span>
                        </div>
                        <button type="button" onClick={() => dispute(tx.id)} className="btn btn-warning btn-xs btn-circle flex-shrink-0" title={t('review.actions.dispute')}>
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    {/* MATCHED: no receipt at all */}
                    {tx.status === 'MATCHED' && !NO_RECEIPT_NOTES.has(tx.notes) && tx.receipt_meta.length === 0 && (
                      <div className="flex items-center gap-3 px-4 py-2 bg-base-100 hover:bg-base-200/40">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-base-content/60 truncate block">{t('review.noReceipt')}</span>
                        </div>
                        <button type="button" onClick={() => dispute(tx.id)} className="btn btn-warning btn-xs btn-circle flex-shrink-0" title={t('review.actions.dispute')}>
                          <RotateCcw className="w-3 h-3" />
                        </button>
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

          {/* Footer */}
          <div className="flex items-center gap-3 pt-2 border-t border-base-200 mt-2">
            <button className="btn btn-primary btn-sm" onClick={applyChanges} disabled={changes.size === 0 || applying}>
              {applying ? <span className="loading loading-spinner loading-xs" /> : <Save className="w-4 h-4" />}
              {t('review.applyChanges')}
            </button>
            {updatedReportUrl && (
              <a href={updatedReportUrl} download className="btn btn-outline btn-sm">
                <Download className="w-4 h-4" />
                {t('review.downloadReport')}
              </a>
            )}
          </div>
        </div>
      </div>

      {preview && renderPreview()}
    </>
  );
}
