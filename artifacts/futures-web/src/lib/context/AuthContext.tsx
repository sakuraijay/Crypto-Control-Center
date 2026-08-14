import { createContext, useContext, useState, ReactNode, useCallback, useEffect } from 'react';

interface AuthContextType {
  isAuthenticated: boolean;
  login: (pin: string) => boolean;
  logout: () => void;
  isFirstVisit: boolean;
  setupPin: (pin: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [storedPin, setStoredPin] = useState<string | null>(() => localStorage.getItem('futures_pin'));
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  const login = useCallback((pin: string) => {
    if (pin === storedPin) {
      setIsAuthenticated(true);
      return true;
    }
    return false;
  }, [storedPin]);

  const logout = useCallback(() => {
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
