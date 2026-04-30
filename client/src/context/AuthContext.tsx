import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import i18n from '../i18n';

type Locale = 'en' | 'pt';

interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  locale: Locale;
  createdAt: string;
}

interface UpdateProfileInput {
  displayName?: string | null;
  email?: string;
  locale?: Locale;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email?: string, displayName?: string, locale?: Locale) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateProfile: (input: UpdateProfileInput) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

function syncLocale(user: User) {
  const locale = user.locale || 'en';
  i18n.changeLanguage(locale);
  localStorage.setItem('concilia-locale', locale);
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const u = data.success && data.data ? data.data : null;
        setUser(u);
        if (u) syncLocale(u);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Login failed');
    setUser(data.data.user);
    syncLocale(data.data.user);
  }, []);

  const register = useCallback(async (username: string, password: string, email?: string, displayName?: string, locale?: Locale) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, email, displayName, locale }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Registration failed');
    setUser(data.data.user);
    syncLocale(data.data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // ignore errors during logout
    }
    setUser(null);
  }, []);

  const updateProfile = useCallback(async (input: UpdateProfileInput) => {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to update profile');
    setUser(data.data);
    syncLocale(data.data);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to update password');
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, checkAuth, updateProfile, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
