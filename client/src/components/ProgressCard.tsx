import { Check, Circle, AlertCircle } from 'lucide-react';
import type { ProgressEvent } from '../App';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface Props {
  events: ProgressEvent[];
}

interface StepState {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

function buildSteps(events: ProgressEvent[], t: TFunction): StepState[] {
  const steps: StepState[] = [
    { label: t('progress.parsingStatements'), status: 'pending' },
    { label: t('progress.scanningReceipts'), status: 'pending' },
    { label: t('progress.extractingReceiptData'), status: 'pending' },
    { label: t('progress.matching'), status: 'pending' },
    { label: t('progress.generatingReport'), status: 'pending' },
  ];

  for (const evt of events) {
    if (evt.step === 'parsing') {
      steps[0].status = 'running';
      steps[0].detail = t('progress.filesFound', { count: evt.count });
    } else if (evt.step === 'receipts_found') {
      steps[0].status = 'done';
      steps[1].status = 'done';
      steps[1].detail = t('progress.receiptsFound', { count: evt.count });
      steps[2].status = 'running';
    } else if (evt.step === 'extracting') {
      steps[2].status = 'running';
      steps[2].detail = `${evt.current} / ${evt.total}`;
    } else if (evt.step === 'matching') {
      steps[2].status = 'done';
      steps[3].status = 'running';
    } else if (evt.step === 'exporting') {
      steps[3].status = 'done';
      steps[4].status = 'running';
    } else if (evt.step === 'done') {
      steps[0].status = steps[0].status === 'pending' ? 'done' : steps[0].status;
      steps[1].status = steps[1].status === 'pending' ? 'done' : steps[1].status;
      steps[2].status = steps[2].status === 'pending' ? 'done' : steps[2].status;
      steps[3].status = 'done';
      steps[4].status = 'done';
    } else if (evt.step === 'error') {
      for (const s of steps) {
        if (s.status === 'running') s.status = 'error';
      }
    }
  }

  return steps;
}

function extractionProgress(events: ProgressEvent[]): { current: number; total: number } | null {
  let last: { current: number; total: number } | null = null;
  for (const e of events) {
    if (e.step === 'extracting') last = { current: e.current, total: e.total };
  }
  return last;
}

export function ProgressCard({ events }: Props) {
  const { t } = useTranslation();
  const steps = buildSteps(events, t);
  const progress = extractionProgress(events);

  return (
    <div className="card bg-base-100 border border-base-200 shadow-sm">
      <div className="card-body">
        <h2 className="card-title">{t('progress.title')}</h2>
        <ul className="space-y-3 mt-1">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex-shrink-0">
                {step.status === 'done' && <Check className="w-5 h-5 text-success" />}
                {step.status === 'running' && <span className="loading loading-spinner loading-sm text-primary" />}
                {step.status === 'pending' && <Circle className="w-5 h-5 text-base-content/30" />}
                {step.status === 'error' && <AlertCircle className="w-5 h-5 text-error" />}
              </span>
              <div className="flex-1 min-w-0">
                <span className={`text-sm ${step.status === 'pending' ? 'text-base-content/60' : 'text-base-content'}`}>
                  {step.label}
                  {step.detail && <span className="text-base-content/60"> — {step.detail}</span>}
                </span>
                {step.status === 'running' && progress && i === 2 && (
                  <progress
                    className="progress progress-primary w-full mt-1.5"
                    value={progress.current}
                    max={progress.total}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
