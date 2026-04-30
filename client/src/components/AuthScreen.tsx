import { useState } from 'react';
import { Scale, LogIn, UserPlus, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';

type Mode = 'login' | 'register';

export function AuthScreen() {
  const { login, register } = useAuth();
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, password, email || undefined, displayName || undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.somethingWentWrong'));
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setUsername('');
    setPassword('');
    setEmail('');
    setDisplayName('');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-base-100 py-12 px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Scale className="w-7 h-7 text-primary" />
            <h1 className="text-3xl font-bold text-base-content">Concilia</h1>
          </div>
          <p className="text-base-content/60">
            {mode === 'login' ? t('auth.signInToAccount') : t('auth.createYourAccount')}
          </p>
        </div>

        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">
              {mode === 'login' ? <LogIn className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
              {mode === 'login' ? t('auth.signIn') : t('auth.register')}
            </h2>

            <form onSubmit={handleSubmit} className="space-y-4 mt-1">
              {error && (
                <div role="alert" className="alert alert-error">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
              )}

              <div className="form-control">
                <label className="label" htmlFor="username">
                  <span className="label-text font-medium">{t('auth.username')}</span>
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('auth.enterUsername')}
                  required
                  autoComplete="username"
                  autoFocus
                  minLength={mode === 'register' ? 3 : undefined}
                  maxLength={50}
                  className="input input-bordered w-full"
                />
              </div>

              {mode === 'register' && (
                <>
                  <div className="form-control">
                    <label className="label" htmlFor="email">
                      <span className="label-text font-medium">{t('auth.email')}</span>
                      <span className="label-text-alt">{t('common.optional')}</span>
                    </label>
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      autoComplete="email"
                      className="input input-bordered w-full"
                    />
                  </div>

                  <div className="form-control">
                    <label className="label" htmlFor="displayName">
                      <span className="label-text font-medium">{t('auth.displayName')}</span>
                      <span className="label-text-alt">{t('common.optional')}</span>
                    </label>
                    <input
                      id="displayName"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder={t('auth.displayName')}
                      autoComplete="name"
                      maxLength={100}
                      className="input input-bordered w-full"
                    />
                  </div>
                </>
              )}

              <div className="form-control">
                <label className="label" htmlFor="password">
                  <span className="label-text font-medium">{t('auth.password')}</span>
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'register' ? t('auth.passwordMinLength') : t('auth.enterPassword')}
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={mode === 'register' ? 8 : undefined}
                  className="input input-bordered w-full"
                />
              </div>

              <button type="submit" className="btn btn-primary w-full" disabled={loading}>
                {loading && <span className="loading loading-spinner loading-sm" />}
                {mode === 'login' ? t('auth.signIn') : t('auth.createAccount')}
              </button>

              <p className="text-center text-sm text-base-content/60">
                {mode === 'login' ? (
                  <>
                    {t('auth.noAccount')}{' '}
                    <button type="button" onClick={() => switchMode('register')} className="link link-primary">
                      {t('auth.createOne')}
                    </button>
                  </>
                ) : (
                  <>
                    {t('auth.alreadyHaveAccount')}{' '}
                    <button type="button" onClick={() => switchMode('login')} className="link link-primary">
                      {t('auth.signIn')}
                    </button>
                  </>
                )}
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
