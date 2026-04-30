import { Download, RotateCcw, AlertTriangle, ClipboardCheck } from 'lucide-react';
import type { Summary } from '../App';
import { useTranslation } from 'react-i18next';

interface Props {
  summary: Summary | null;
  reportUrl: string | null;
  error: string | null;
  onReset: () => void;
  onReview: () => void;
}

export function ResultsCard({ summary, reportUrl, error, onReset, onReview }: Props) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="card bg-base-100 border border-error/50 shadow-sm">
        <div className="card-body">
          <div role="alert" className="alert alert-error">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              <p className="font-medium text-sm">{t('results.failed')}</p>
              <p className="text-sm mt-0.5">{error}</p>
            </div>
          </div>
          <div className="mt-2">
            <button className="btn btn-outline btn-sm" onClick={onReset}>
              <RotateCcw className="w-4 h-4" />
              {t('results.tryAgain')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="card bg-base-100 border border-base-200 shadow-sm">
      <div className="card-body">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="card-title">{t('results.title')}</h2>
            <p className="text-sm text-base-content/60 -mt-1">
              {t('results.subtitle', { totalTransactions: summary.totalTransactions, totalReceipts: summary.totalReceipts })}
            </p>
          </div>
        </div>

        <div className="stats stats-horizontal shadow-none border border-base-200 rounded-box w-full mt-2">
          <div className="stat">
            <div className="stat-title">{t('results.matched')}</div>
            <div className="stat-value text-success text-2xl">{summary.matched}</div>
            <div className="stat-desc">{t('results.matchRate', { matchRate: summary.matchRate })}</div>
          </div>
          <div className="stat">
            <div className="stat-title">{t('results.review')}</div>
            <div className="stat-value text-warning text-2xl">{summary.review}</div>
            <div className="stat-desc">{t('results.needsAttention')}</div>
          </div>
          <div className="stat">
            <div className="stat-title">{t('results.unmatched')}</div>
            <div className="stat-value text-error text-2xl">{summary.unmatched}</div>
            <div className="stat-desc">{t('results.noReceipt')}</div>
          </div>
          {summary.bankFees > 0 && (
            <div className="stat">
              <div className="stat-title">{t('results.bankFees')}</div>
              <div className="stat-value text-base-content/60 text-2xl">{summary.bankFees}</div>
              <div className="stat-desc">{t('results.autoDetected')}</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap mt-2">
          {reportUrl && (
            <a href={reportUrl} download className="btn btn-primary btn-sm">
              <Download className="w-4 h-4" />
              {t('results.downloadReport')}
            </a>
          )}
          <button className="btn btn-outline btn-sm" onClick={onReview}>
            <ClipboardCheck className="w-4 h-4" />
            {t('results.reviewAndValidate')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onReset}>
            <RotateCcw className="w-4 h-4" />
            {t('results.newReconciliation')}
          </button>
        </div>
      </div>
    </div>
  );
}
