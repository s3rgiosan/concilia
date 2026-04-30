import { Scale, LogOut, Settings, User, ChevronDown } from 'lucide-react';
import { ReconcileForm } from './components/ReconcileForm';
import { ProgressCard } from './components/ProgressCard';
import { ResultsCard } from './components/ResultsCard';
import { ReviewScreen } from './components/ReviewScreen';
import { RulesPanel } from './components/RulesPanel';
import { AuthScreen } from './components/AuthScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { ToastProvider } from './components/ui/Toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { useState } from 'react';
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

type Phase = 'form' | 'running' | 'done' | 'error' | 'review' | 'profile';

function AppContent() {
  const { user, loading, logout } = useAuth();
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('form');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');

  if (loading) return null;
  if (!user) return <AuthScreen />;

  function handleStart(formData: FormData) {
    setPhase('running');
    setEvents([]);
    setSummary(null);
    setReportUrl(null);
    setErrorMessage(null);
    setYear(formData.get('year') as string);
    setMonth(formData.get('month') as string);

    const ctrl = new AbortController();

    fetch('/api/reconcile', { method: 'POST', body: formData, signal: ctrl.signal })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function pump(): Promise<void> {
          return reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data:')) continue;
              try {
                const evt: ProgressEvent = JSON.parse(line.slice(5).trim());
                setEvents((prev) => [...prev, evt]);
                if (evt.step === 'done') {
                  setSummary(evt.summary);
                  setReportUrl(evt.reportUrl);
                  setPhase('done');
                } else if (evt.step === 'error') {
                  setErrorMessage(evt.message);
                  setPhase('error');
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
        if (err.name !== 'AbortError') {
          setErrorMessage(err.message);
          setPhase('error');
        }
      });

    return () => ctrl.abort();
  }

  function handleResume(resumeYear: string, resumeMonth: string) {
    setYear(resumeYear);
    setMonth(resumeMonth);
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
  }

  return (
    <div className="min-h-screen bg-base-100">
      <header className="bg-base-100 border-b border-base-200">
        <div className={`${phase === 'review' ? 'max-w-6xl' : 'max-w-4xl'} mx-auto px-4 py-4 flex items-center justify-between`}>
          <a
            href="/"
            onClick={(e) => { e.preventDefault(); if (phase !== 'running') handleReset(); }}
            className="flex items-center gap-3 hover:opacity-70 transition-opacity"
            aria-label="Concilia home"
          >
            <Scale className="w-6 h-6 text-primary" />
            <span className="text-lg font-semibold text-base-content">Concilia</span>
          </a>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRulesOpen(true)}
              className="btn btn-ghost btn-sm gap-1.5"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">{t('nav.rules')}</span>
            </button>
            <div className="dropdown dropdown-end">
              <div tabIndex={0} role="button" className="btn btn-ghost btn-sm gap-1.5">
                <User className="w-4 h-4" />
                <span className="hidden sm:inline">{user.displayName ?? user.username}</span>
                <ChevronDown className="w-4 h-4" />
              </div>
              <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box z-[1] w-52 p-2 shadow border border-base-200 mt-1">
                <li>
                  <button type="button" onClick={() => { setPhase('profile'); (document.activeElement as HTMLElement)?.blur(); }}>
                    <User className="w-4 h-4" />
                    {t('profile.title')}
                  </button>
                </li>
                <div className="divider my-0" />
                <li>
                  <button type="button" onClick={logout} className="text-error">
                    <LogOut className="w-4 h-4" />
                    {t('common.signOut')}
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </header>

      {rulesOpen && <RulesPanel onClose={() => setRulesOpen(false)} />}

      <main className={`${phase === 'review' ? 'max-w-6xl' : 'max-w-4xl'} mx-auto px-4 py-8 space-y-6`}>
        {phase === 'form' && <ReconcileForm onSubmit={handleStart} onResume={handleResume} />}
        {phase === 'running' && <ProgressCard events={events} />}
        {(phase === 'done' || phase === 'error') && (
          <>
            <ProgressCard events={events} />
            <ResultsCard
              summary={summary}
              reportUrl={reportUrl}
              error={errorMessage}
              onReset={handleReset}
              onReview={() => setPhase('review')}
            />
          </>
        )}
        {phase === 'review' && (
          <ReviewScreen year={year} month={month} />
        )}
        {phase === 'profile' && (
          <ProfileScreen />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </AuthProvider>
  );
}
