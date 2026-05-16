import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { setAuthToken, getAuthToken, getAuthUser, clearAuth } from '../services/storage';
import { login as apiLogin } from '../services/api';

interface AuthValue {
  token: string | null;
  user: string | null;
  ready: boolean;
  signIn: (code: string, displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await getAuthToken();
      const u = await getAuthUser();
      if (t) setToken(t);
      if (u) setUser(u);
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (code: string, displayName?: string) => {
    const result = await apiLogin(code);
    await setAuthToken(result.token, displayName || 'Consultant');
    setToken(result.token);
    setUser(displayName || 'Consultant');
  }, []);

  const signOut = useCallback(async () => {
    await clearAuth();
    setToken(null);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ token, user, ready, signIn, signOut }}>{children}</Ctx.Provider>;
};

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
