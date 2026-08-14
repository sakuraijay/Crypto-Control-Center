import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Dev bypass
// Auth is skipped automatically in the Vite dev server (import.meta.env.DEV).
// To re-enable auth during development, add VITE_AUTH_ENABLED=true to .env.
// Production builds always enforce auth (import.meta.env.DEV is false there).
// ---------------------------------------------------------------------------
const DEV_AUTH_BYPASS =
  import.meta.env.DEV && import.meta.env.VITE_AUTH_ENABLED !== 'true';

interface AuthContextType {
  isAuthenticated: boolean;
  login: (pin: string) => boolean;
  logout: () => void;
  isFirstVisit: boolean;
  setupPin: (pin: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [storedPin, setStoredPin] = useState<string | null>(() =>
    DEV_AUTH_BYPASS ? '__dev__' : localStorage.getItem('futures_pin')
  );
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(DEV_AUTH_BYPASS);

  const login = useCallback((pin: string) => {
    if (DEV_AUTH_BYPASS || pin === storedPin) {
      setIsAuthenticated(true);
      return true;
    }
    return false;
  }, [storedPin]);

  const logout = useCallback(() => {
    if (DEV_AUTH_BYPASS) return; // no-op in dev mode
    setIsAuthenticated(false);
  }, []);

  const setupPin = useCallback((pin: string) => {
    localStorage.setItem('futures_pin', pin);
    setStoredPin(pin);
    setIsAuthenticated(true);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout, isFirstVisit: !storedPin, setupPin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider');
  return ctx;
}
