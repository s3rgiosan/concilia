import { useState } from 'react';
import { User, Mail, Lock, Save, AlertCircle, CheckCircle, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';

export function ProfileScreen() {
  const { t } = useTranslation();
  const { user, updateProfile, changePassword } = useAuth();

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [email, setEmail] = useState(user?.email || '');
  const [locale, setLocale] = useState<'en' | 'pt'>(user?.locale || 'en');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileSuccess(false);
    setProfileLoading(true);
    try {
      await updateProfile({
        displayName: displayName || null,
        email: email || undefined,
        locale,
      });
      setProfileSuccess(true);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t('profile.failedToUpdate'));
    } finally {
      setProfileLoading(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);
    if (newPassword !== confirmPassword) {
      setPasswordError(t('profile.newPasswordsNoMatch'));
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t('profile.newPasswordMinLength'));
      return;
    }
    setPasswordLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess(true);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : t('profile.failedToUpdatePassword'));
    } finally {
      setPasswordLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-base-content">{t('profile.title')}</h1>
        <p className="text-sm text-base-content/60">{t('profile.subtitle')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">
              <User className="h-5 w-5" />
              {t('profile.profileInfo')}
            </h2>
            <form onSubmit={handleProfileSubmit} className="space-y-3 mt-1">
              {profileError && (
                <div role="alert" className="alert alert-error">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">{profileError}</span>
                </div>
              )}
              {profileSuccess && (
                <div role="alert" className="alert alert-success">
                  <CheckCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">{t('profile.profileUpdated')}</span>
                </div>
              )}

              <div className="form-control">
                <label className="label" htmlFor="username">
                  <span className="label-text font-medium">{t('profile.username')}</span>
                </label>
                <input
                  id="username"
                  type="text"
                  value={user?.username || ''}
                  disabled
                  className="input input-bordered w-full bg-base-200"
                />
                <p className="text-xs text-base-content/50 mt-1">{t('profile.usernameCannotChange')}</p>
              </div>

              <div className="form-control">
                <label className="label" htmlFor="displayName">
                  <span className="label-text font-medium">{t('profile.displayName')}</span>
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t('profile.enterDisplayName')}
                  maxLength={100}
                  className="input input-bordered w-full"
                />
              </div>

              <div className="form-control">
                <label className="label" htmlFor="email">
                  <span className="label-text font-medium flex items-center gap-1">
                    <Mail className="h-4 w-4" />
                    {t('profile.email')}
                  </span>
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('profile.enterEmail')}
                  className="input input-bordered w-full"
                />
              </div>

              <div className="form-control">
                <label className="label" htmlFor="locale">
                  <span className="label-text font-medium flex items-center gap-1">
                    <Languages className="h-4 w-4" />
                    {t('profile.locale')}
                  </span>
                </label>
                <select
                  id="locale"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as 'en' | 'pt')}
                  className="select select-bordered w-full"
                >
                  <option value="en">{t('lang.en')}</option>
                  <option value="pt">{t('lang.pt')}</option>
                </select>
              </div>

              <button type="submit" className="btn btn-primary w-full" disabled={profileLoading}>
                {profileLoading ? <span className="loading loading-spinner loading-sm" /> : <Save className="h-4 w-4" />}
                {profileLoading ? t('common.saving') : t('profile.saveChanges')}
              </button>
            </form>
          </div>
        </div>

        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">
              <Lock className="h-5 w-5" />
              {t('profile.changePassword')}
            </h2>
            <form onSubmit={handlePasswordSubmit} className="space-y-3 mt-1">
              {passwordError && (
                <div role="alert" className="alert alert-error">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">{passwordError}</span>
                </div>
              )}
              {passwordSuccess && (
                <div role="alert" className="alert alert-success">
                  <CheckCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">{t('profile.passwordUpdated')}</span>
                </div>
              )}

              <div className="form-control">
                <label className="label" htmlFor="currentPassword">
                  <span className="label-text font-medium">{t('profile.currentPassword')}</span>
                </label>
                <input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder={t('profile.enterCurrentPassword')}
                  required
                  className="input input-bordered w-full"
                />
              </div>

              <div className="form-control">
                <label className="label" htmlFor="newPassword">
                  <span className="label-text font-medium">{t('profile.newPassword')}</span>
                </label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('profile.enterNewPassword')}
                  required
                  minLength={8}
                  className="input input-bordered w-full"
                />
              </div>

              <div className="form-control">
                <label className="label" htmlFor="confirmPassword">
                  <span className="label-text font-medium">{t('profile.confirmNewPassword')}</span>
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t('profile.confirmNewPasswordPlaceholder')}
                  required
                  className="input input-bordered w-full"
                />
              </div>

              <button type="submit" className="btn btn-primary w-full" disabled={passwordLoading}>
                {passwordLoading ? <span className="loading loading-spinner loading-sm" /> : <Lock className="h-4 w-4" />}
                {passwordLoading ? t('profile.updatingPassword') : t('profile.updatePassword')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
