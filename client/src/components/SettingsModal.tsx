import { useEffect, useState } from 'react';
import { X, Save, FolderOpen, FileKey } from 'lucide-react';
import { Drawer } from './ui/Drawer';
import { useToast } from './ui/Toast';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Português' },
];

// Mirror of electron/config-schema.js. Keep in sync when adding fields.
interface Config {
  receiptsRoot: string;
  saKeyPath: string;
  geminiProject: string;
  geminiLocation: string;
  geminiModel: string;
  language: string;
}

interface Props {
  onClose: () => void;
}

const DEFAULTS: Config = {
  receiptsRoot: '',
  saKeyPath: '',
  geminiProject: '',
  geminiLocation: 'europe-west1',
  geminiModel: 'gemini-2.5-flash',
  language: 'en',
};

export function SettingsModal({ onClose }: Props) {
  const [cfg, setCfg] = useState<Config>({ ...DEFAULTS, language: i18n.language.split('-')[0] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { showToast } = useToast();
  const { t } = useTranslation();

  useEffect(() => {
    if (!window.concilia) {
      setLoading(false);
      return;
    }
    window.concilia.getConfig()
      .then((c) => setCfg({ ...DEFAULTS, ...c }))
      .catch(() => showToast(t('settings.failedToLoad', 'Failed to load settings'), 'error'))
      .finally(() => setLoading(false));
  }, []);

  function update<K extends keyof Config>(key: K, value: Config[K]) {
    setCfg((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  async function pickFolder() {
    if (!window.concilia) return;
    const path = await window.concilia.pickFolder();
    if (path) update('receiptsRoot', path);
  }

  async function pickKey() {
    if (!window.concilia) return;
    const path = await window.concilia.pickFile([{ name: 'JSON', extensions: ['json'] }]);
    if (path) update('saKeyPath', path);
  }

  async function save() {
    setSaving(true);
    try {
      // Persist FIRST. If save fails or main returns `busy`, leave the in-app
      // language untouched so the renderer stays in sync with what's stored.
      if (window.concilia) {
        const result = await window.concilia.setConfig(cfg as unknown as Record<string, unknown>) as { error?: string };
        if (result && result.error === 'busy') {
          showToast(i18n.t('settings.busy', 'Reconciliation in progress. Try again when it finishes.'), 'error');
          return;
        }
      }
      // Only switch the running app's language after the new config is on disk.
      if (cfg.language && cfg.language !== i18n.language.split('-')[0]) {
        await i18n.changeLanguage(cfg.language);
      }
      showToast(i18n.t('settings.saved', 'Settings saved'), 'success');
      setDirty(false);
      onClose();
    } catch (e) {
      showToast((e as Error).message || t('settings.failedToSave', 'Failed to save'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const inElectron = typeof window !== 'undefined' && !!window.concilia;

  return (
    <Drawer onClose={onClose}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-base-200">
        <h2 className="text-lg font-semibold">{t('settings.title', 'Settings')}</h2>
        <button type="button" onClick={onClose} className="btn btn-ghost btn-sm btn-square" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {!inElectron && (
          <div className="alert alert-warning text-sm">
            {t('settings.notInElectron', 'Settings are only editable in the desktop app.')}
          </div>
        )}

        <div>
          <label className="label">
            <span className="label-text font-medium">{t('settings.language', 'Language')}</span>
          </label>
          <select
            className="select select-bordered w-full text-sm"
            value={cfg.language}
            onChange={(e) => update('language', e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="text-sm text-base-content/60">{t('common.loading', 'Loading...')}</div>
        ) : (
          <>
            <div>
              <label className="label">
                <span className="label-text font-medium">{t('settings.receiptsRoot', 'Receipts folder')}</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="input input-bordered flex-1 text-sm"
                  value={cfg.receiptsRoot}
                  onChange={(e) => update('receiptsRoot', e.target.value)}
                  placeholder="/Users/.../Receipts"
                  disabled={!inElectron}
                />
                <button type="button" className="btn btn-ghost" onClick={pickFolder} disabled={!inElectron}>
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-base-content/60 mt-1">
                {t('settings.receiptsRootHint', 'Root folder containing year/month subfolders.')}
              </p>
            </div>

            <div>
              <label className="label">
                <span className="label-text font-medium">{t('settings.saKey', 'Gemini service account key')}</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="input input-bordered flex-1 text-sm"
                  value={cfg.saKeyPath}
                  onChange={(e) => update('saKeyPath', e.target.value)}
                  placeholder="/Users/.../sa-key.json"
                  disabled={!inElectron}
                />
                <button type="button" className="btn btn-ghost" onClick={pickKey} disabled={!inElectron}>
                  <FileKey className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div>
              <label className="label">
                <span className="label-text font-medium">{t('settings.geminiProject', 'Gemini project (optional)')}</span>
              </label>
              <input
                type="text"
                className="input input-bordered w-full text-sm"
                value={cfg.geminiProject}
                onChange={(e) => update('geminiProject', e.target.value)}
                placeholder="my-gcp-project"
                disabled={!inElectron}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">
                  <span className="label-text font-medium">{t('settings.geminiLocation', 'Location')}</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered w-full text-sm"
                  value={cfg.geminiLocation}
                  onChange={(e) => update('geminiLocation', e.target.value)}
                  disabled={!inElectron}
                />
              </div>
              <div>
                <label className="label">
                  <span className="label-text font-medium">{t('settings.geminiModel', 'Model')}</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered w-full text-sm"
                  value={cfg.geminiModel}
                  onChange={(e) => update('geminiModel', e.target.value)}
                  disabled={!inElectron}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="px-6 py-4 border-t border-base-200 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary gap-1.5"
          onClick={save}
          disabled={!dirty || saving}
        >
          <Save className="w-4 h-4" />
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
        </button>
      </div>
    </Drawer>
  );
}
