import { Settings, SlidersHorizontal } from 'lucide-react';
import { ReconcileForm } from './components/ReconcileForm';
import { ProgressCard } from './components/ProgressCard';
import { ResultsCard } from './components/ResultsCard';
import { ReviewScreen } from './components/ReviewScreen';
import { RulesPanel } from './components/RulesPanel';
import { SettingsModal } from './components/SettingsModal';
import { UpdateBanner } from './components/UpdateBanner';
import { ToastProvider } from './components/ui/Toast';
import { pumpSSE } from './lib/sse';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ProgressEvent =
  | { step: 'parsing'; count: number }
  | { step: 'receipts_found'; count: number }
  | { step: 'extracting'; current: number; total: number }
  | { step: 'matching' }
  | { step: 'exporting' }
  | { step: 'done'; summary: Summary; reportUrl: string }
  | { step: 'error'; message: string };

export interface Summary {
  totalTransactions: number;
  matched: number;
  review: number;
  unmatched: number;
  bankFees: number;
  totalReceipts: number;
  matchedReceipts: number;
  reviewReceipts: number;
  unmatchedReceipts: number;
  matchRate: number;
}

type Phase = 'form' | 'running' | 'done' | 'error' | 'review';

function AppContent() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('form');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [reviewDirty, setReviewDirty] = useState(false);
  const reconcileAbortRef = useRef<AbortController | null>(null);

  // An in-flight reconcile fetch must not outlive the component.
  useEffect(() => {
    return () => reconcileAbortRef.current?.abort();
  }, []);

  const handleReviewDirtyChange = useCallback((dirty: boolean) => setReviewDirty(dirty), []);

  function handleStart(formData: FormData) {
    setPhase('running');
    setEvents([]);
    setSummary(null);
    setReportUrl(null);
    setErrorMessage(null);
    setYear(formData.get('year') as string);
    setMonth(formData.get('month') as string);

    const ctrl = new AbortController();
    reconcileAbortRef.current = ctrl;

    fetch('/api/reconcile', { method: 'POST', body: formData, signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`);
        const reader = res.body.getReader();
        const sawTerminal = await pumpSSE<ProgressEvent>(reader, (evt) => {
          setEvents((prev) => [...prev, evt]);
          if (evt.step === 'done') {
            setSummary(evt.summary);
            setReportUrl(evt.reportUrl);
            setPhase('done');
          } else if (evt.step === 'error') {
            setErrorMessage(evt.message);
            setPhase('error');
          }
        });
        if (!sawTerminal) {
          setErrorMessage(t('results.connectionClosed', 'Connection closed unexpectedly. Please try again.'));
          setPhase('error');
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setErrorMessage(err.message);
          setPhase('error');
        }
      });
  }

  function handleResume(resumeYear: string, resumeMonth: string) {
    setYear(resumeYear);
    setMonth(resumeMonth);
    setReviewDirty(false);
    setPhase('review');
  }

  function handleReset() {
    setPhase('form');
    setEvents([]);
    setSummary(null);
    setReportUrl(null);
    setErrorMessage(null);
    setYear('');
    setMonth('');
    setReviewDirty(false);
  }

  const breadcrumbLabel: Record<Phase, string> = {
    form: t('nav.start', 'Start'),
    running: t('nav.running', 'Processing'),
    done: t('nav.results', 'Results'),
    error: t('nav.results', 'Results'),
    review: t('nav.review', 'Review'),
  };

  const periodLabel = (year && month)
    ? `${t(`form.months.${month}`)} ${year}`
    : '';

  return (
    <div className="min-h-screen bg-base-100">
      <div className="sticky top-0 z-40">
      <UpdateBanner />
      <header className="bg-base-100 border-b border-base-200">
        <div className="max-w-6xl mx-auto px-8 py-3 flex items-center justify-end">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRulesOpen(true)}
              className="btn btn-ghost btn-sm gap-1.5"
            >
              <SlidersHorizontal className="w-4 h-4" />
              <span className="hidden sm:inline">{t('nav.rules')}</span>
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="btn btn-ghost btn-sm gap-1.5"
              aria-label="Settings"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">{t('nav.settings', 'Settings')}</span>
            </button>
          </div>
        </div>
      </header>

      <nav className="bg-base-100 border-b border-base-200">
        <div className="max-w-6xl mx-auto px-8 py-2 text-sm breadcrumbs">
          <ul>
            <li>
              <button
                type="button"
                onClick={() => {
                  if (phase === 'running') return;
                  if (phase === 'review' && reviewDirty
                    && !window.confirm(t('nav.discardReviewChanges', 'You have unsaved review changes. Leave without saving?'))) {
                    return;
                  }
                  handleReset();
                }}
                className="hover:underline disabled:opacity-50"
                disabled={phase === 'running'}
              >
                {t('nav.start', 'Start')}
              </button>
            </li>
            {phase !== 'form' && <li>{breadcrumbLabel[phase]}</li>}
            {phase === 'review' && periodLabel && <li>{periodLabel}</li>}
          </ul>
        </div>
      </nav>
      <div id="review-toolbar-slot" className="empty:hidden bg-base-100 border-b border-base-200" />
      </div>

      {rulesOpen && <RulesPanel onClose={() => setRulesOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <main className="max-w-6xl mx-auto space-y-6">
        {phase === 'form' && <ReconcileForm onSubmit={handleStart} onResume={handleResume} />}
        {phase === 'running' && <ProgressCard events={events} />}
        {(phase === 'done' || phase === 'error') && (
          <ResultsCard
            summary={summary}
            reportUrl={reportUrl}
            error={errorMessage}
            onReset={handleReset}
            onReview={() => setPhase('review')}
          />
        )}
        {phase === 'review' && (
          <ReviewScreen year={year} month={month} onDirtyChange={handleReviewDirtyChange} />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
