import { useState, useEffect } from 'react';
import { Plus, Trash2, Save, X } from 'lucide-react';
import { useToast } from './ui/Toast';
import { Drawer } from './ui/Drawer';
import { useTranslation } from 'react-i18next';

interface Rule {
  id: string;
  receiptVendor: string;
  transactionDescription: string;
}

interface Props {
  onClose: () => void;
}

export function RulesPanel({ onClose }: Props) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newVendor, setNewVendor] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const { showToast } = useToast();
  const { t } = useTranslation();

  const inElectron = typeof window !== 'undefined' && !!window.concilia;

  useEffect(() => {
    // The /api/rules endpoint is hosted by the Express server inside Electron.
    // The Vite dev server has no backend, so skip the fetch and render the
    // panel in read-only mode with a banner instead of throwing a toast.
    if (!inElectron) {
      setLoading(false);
      return;
    }
    fetch('/api/rules')
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: Rule[]) => setRules(data))
      .catch(() => showToast(t('rules.failedToLoad'), 'error'))
      .finally(() => setLoading(false));
  }, []);

  function addRule() {
    const vendor = newVendor.trim();
    const desc = newDesc.trim();
    if (!vendor || !desc) return;
    setRules((prev) => [...prev, { id: crypto.randomUUID(), receiptVendor: vendor, transactionDescription: desc }]);
    setNewVendor('');
    setNewDesc('');
    setDirty(true);
  }

  function removeRule(id: string) {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rules),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
      setDirty(false);
      showToast(t('rules.saved'), 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer onClose={onClose}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-base-200 flex-shrink-0">
          <h2 className="text-lg font-semibold">{t('rules.title')}</h2>
          <button onClick={onClose} className="btn btn-ghost btn-sm btn-square" aria-label={t('common.cancel')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {!inElectron && (
            <div className="alert alert-warning text-sm">
              {t('rules.notInElectron', 'Rules are only editable in the desktop app.')}
            </div>
          )}

          <p className="text-xs text-base-content/60">
            {t('rules.description')}
          </p>

          {loading && (
            <div className="flex justify-center py-4">
              <span className="loading loading-spinner loading-sm text-primary" />
            </div>
          )}

          {!loading && rules.length === 0 && (
            <p className="text-sm text-base-content/50 text-center py-4">{t('rules.noRules')}</p>
          )}

          {!loading && rules.length > 0 && (
            <div className="divide-y divide-base-200 rounded-btn border border-base-content/20">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-start gap-3 px-3 py-2">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-xs text-base-content/40 flex-shrink-0 w-28">{t('rules.transaction')}</span>
                      <span className="text-sm text-base-content truncate">{rule.transactionDescription}</span>
                    </div>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-xs text-base-content/40 flex-shrink-0 w-28">{t('rules.receipt')}</span>
                      <span className="text-sm text-base-content truncate">{rule.receiptVendor}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRule(rule.id)}
                    disabled={!inElectron}
                    className="btn btn-outline btn-xs btn-circle flex-shrink-0"
                    aria-label={t('rules.deleteRule')}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add rule form */}
          <div className="rounded-btn border border-base-content/20 p-3 space-y-2">
            <p className="text-xs font-medium text-base-content/70">{t('rules.addRule')}</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-base-content/40 flex-shrink-0 w-28">{t('rules.transaction')}</span>
                <input
                  type="text"
                  placeholder={t('rules.placeholderTransaction')}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
                  disabled={!inElectron}
                  className="input input-bordered input-sm flex-1 min-w-0"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-base-content/40 flex-shrink-0 w-28">{t('rules.receipt')}</span>
                <input
                  type="text"
                  placeholder={t('rules.placeholderReceipt')}
                  value={newVendor}
                  onChange={(e) => setNewVendor(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
                  disabled={!inElectron}
                  className="input input-bordered input-sm flex-1 min-w-0"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={addRule}
              disabled={!inElectron || !newVendor.trim() || !newDesc.trim()}
              className="btn btn-secondary btn-sm gap-1.5 !text-white"
            >
              <Plus className="w-4 h-4" />
              {t('common.add')}
            </button>
          </div>
        </div>

        <div className="flex-shrink-0 px-6 py-4 border-t border-base-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!inElectron || !dirty || saving}
            className="btn btn-primary btn-sm gap-1.5 !text-white"
          >
            {saving ? <span className="loading loading-spinner loading-xs" /> : <Save className="w-4 h-4" />}
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
    </Drawer>
  );
}
