import { useEffect, useState } from 'react';
import { X, ArrowUpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UpdateCheckResult } from '../electron-bridge';

export function UpdateBanner() {
  const { t } = useTranslation();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = window.concilia?.checkUpdate;
    if (!check) return;
    check()
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (dismissed || !result?.updateAvailable || !result.latestVersion) return null;

  return (
    <div role="alert" className="alert alert-info rounded-none justify-center">
      <ArrowUpCircle className="w-4 h-4" />
      <span className="text-sm">
        {t('update.available', 'A new version ({{version}}) is available.', { version: result.latestVersion })}
      </span>
      {result.releaseUrl && (
        <a href={result.releaseUrl} target="_blank" rel="noreferrer" className="link link-hover font-medium text-sm">
          {t('update.viewRelease', 'View release')}
        </a>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="btn btn-ghost btn-xs btn-circle"
        aria-label={t('common.dismiss', 'Dismiss')}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
