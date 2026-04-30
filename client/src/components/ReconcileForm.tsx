import { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, X, Plus, Play, RotateCcw, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const BANKS = [
  { value: 'cgd', label: 'CGD' },
];

const currentYear = new Date().getFullYear();
const YEARS = [String(currentYear), String(currentYear - 1)];
const MONTH_VALUES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

interface StatementFile {
  id: string;
  file: File;
  bank: string;
}

interface PriorStatus {
  exists: boolean;
  applied: boolean;
}

interface Props {
  onSubmit: (formData: FormData) => void;
  onResume: (year: string, month: string) => void;
}

export function ReconcileForm({ onSubmit, onResume }: Props) {
  const { t } = useTranslation();
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1).padStart(2, '0'));
  const [statements, setStatements] = useState<StatementFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [priorStatus, setPriorStatus] = useState<PriorStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPriorStatus(null);
    fetch(`/api/status/${year}/${month}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: PriorStatus | null) => { if (data?.exists) setPriorStatus(data); })
      .catch(() => {});
  }, [year, month]);

  function addFiles(files: File[]) {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    setStatements((prev) => [
      ...prev,
      ...pdfs.map((f) => ({ id: crypto.randomUUID(), file: f, bank: BANKS[0].value })),
    ]);
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }, []);

  function removeStatement(id: string) {
    setStatements((prev) => prev.filter((s) => s.id !== id));
  }

  function updateBank(id: string, bank: string) {
    setStatements((prev) => prev.map((s) => (s.id === id ? { ...s, bank } : s)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (statements.length === 0) return;
    const fd = new FormData();
    fd.append('year', year);
    fd.append('month', month);
    for (const s of statements) {
      fd.append('statements', s.file);
      fd.append('banks', s.bank);
    }
    onSubmit(fd);
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <h2 className="card-title">{t('form.title')}</h2>
          <p className="text-sm text-base-content/60 -mt-1">{t('form.subtitle')}</p>

          <div className="space-y-6 mt-2">
            {/* Period selectors */}
            <div className="flex gap-4">
              <div className="form-control flex-1">
                <label className="label"><span className="label-text font-medium">{t('form.year')}</span></label>
                <select value={year} onChange={(e) => setYear(e.target.value)} className="select select-bordered select-sm w-full">
                  {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="form-control flex-1">
                <label className="label"><span className="label-text font-medium">{t('form.month')}</span></label>
                <select value={month} onChange={(e) => setMonth(e.target.value)} className="select select-bordered select-sm w-full">
                  {MONTH_VALUES.map((m) => <option key={m} value={m}>{t(`form.months.${m}`)}</option>)}
                </select>
              </div>
            </div>

            {/* Prior reconciliation banner */}
            {priorStatus && (
              <div role="alert" className="alert alert-warning">
                <div className="flex-1 space-y-1.5">
                  <p className="text-sm font-medium">
                    {priorStatus.applied
                      ? t('form.priorApplied')
                      : t('form.priorUnfinished')}
                  </p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      type="button"
                      onClick={() => onResume(year, month)}
                      className="inline-flex items-center gap-1.5 text-sm font-medium link"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                      {t('form.resumeReview')}
                    </button>
                    <span className="opacity-40">·</span>
                    <button
                      type="button"
                      onClick={() => {
                        const fd = new FormData();
                        fd.append('year', year);
                        fd.append('month', month);
                        fd.append('clearCache', 'true');
                        for (const s of statements) {
                          fd.append('statements', s.file);
                          fd.append('banks', s.bank);
                        }
                        onSubmit(fd);
                      }}
                      className="inline-flex items-center gap-1.5 text-sm font-medium link"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {priorStatus.applied ? t('form.rerunFromScratch') : t('form.rerun')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Drop zone */}
            <div className="form-control">
              <label className="label"><span className="label-text font-medium">{t('form.bankStatements')}</span></label>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-lg px-6 py-8 text-center cursor-pointer transition-colors ${
                  dragging ? 'border-primary bg-base-200' : 'border-base-300 hover:border-base-content/30 hover:bg-base-200/50'
                }`}
              >
                <Upload className="mx-auto w-8 h-8 text-base-content/40 mb-2" />
                <p className="text-sm text-base-content/60">
                  {t('form.dropzone')} <span className="text-primary font-medium">{t('form.browse')}</span>
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
                />
              </div>
            </div>

            {/* File list */}
            {statements.length > 0 && (
              <ul className="space-y-2">
                {statements.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 bg-base-200 rounded-md px-3 py-2">
                    <span className="flex-1 text-sm text-base-content truncate">{s.file.name}</span>
                    <select
                      value={s.bank}
                      onChange={(e) => updateBank(s.id, e.target.value)}
                      className="select select-bordered select-sm"
                    >
                      {BANKS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeStatement(s.id)}
                      className="btn btn-ghost btn-xs btn-circle"
                      aria-label={t('common.delete')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {statements.length === 0 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium"
              >
                <Plus className="w-4 h-4" />
                {t('form.addStatement')}
              </button>
            )}

            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={statements.length === 0}>
                <Play className="w-4 h-4" />
                {t('form.run')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
