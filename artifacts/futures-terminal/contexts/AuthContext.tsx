import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [requiresSetup, setRequiresSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
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
    const stored = await AsyncStorage.getItem(PIN_KEY);
    if (stored === pin) {
      setIsAuthenticated(true);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
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
