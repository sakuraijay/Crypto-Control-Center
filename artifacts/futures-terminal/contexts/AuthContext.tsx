import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Dev bypass
// Auth is skipped automatically when running in the Metro dev server (__DEV__).
// To re-enable auth during development, add EXPO_PUBLIC_AUTH_ENABLED=true to .env.
// Production builds always enforce auth (__DEV__ is false there).
// ---------------------------------------------------------------------------
const DEV_AUTH_BYPASS =
  __DEV__ && process.env.EXPO_PUBLIC_AUTH_ENABLED !== 'true';

const PIN_KEY = '@ft_pin';

interface AuthContextType {
  isAuthenticated: boolean;
  requiresSetup: boolean;
  isLoading: boolean;
  setupPin: (pin: string) => Promise<void>;
  verifyPin: (pin: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(DEV_AUTH_BYPASS);
  const [requiresSetup, setRequiresSetup] = useState(false);
  // In dev-bypass mode, skip the AsyncStorage loading phase entirely
  const [isLoading, setIsLoading] = useState(!DEV_AUTH_BYPASS);

  useEffect(() => {
    if (DEV_AUTH_BYPASS) return; // skip PIN check in dev
    AsyncStorage.getItem(PIN_KEY).then(pin => {
      if (!pin) setRequiresSetup(true);
      setIsLoading(false);
    });
  }, []);

  const setupPin = useCallback(async (pin: string) => {
    await AsyncStorage.setItem(PIN_KEY, pin);
    setRequiresSetup(false);
    setIsAuthenticated(true);
  }, []);

  const verifyPin = useCallback(async (pin: string) => {
    if (DEV_AUTH_BYPASS) return true;
    const stored = await AsyncStorage.getItem(PIN_KEY);
    if (stored === pin) {
      setIsAuthenticated(true);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    if (DEV_AUTH_BYPASS) return; // no-op in dev mode
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, requiresSetup, isLoading, setupPin, verifyPin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
