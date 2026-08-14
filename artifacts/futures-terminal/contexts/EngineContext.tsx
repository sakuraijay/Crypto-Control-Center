import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export enum EngineState {
  OFFLINE = 'OFFLINE',
  MONITORING = 'MONITORING',
  PAPER_TRADING = 'PAPER_TRADING',
  LIVE_READY = 'LIVE_READY',
  LIVE_TRADING = 'LIVE_TRADING',
  RISK_LOCKED = 'RISK_LOCKED',
  EMERGENCY_STOP = 'EMERGENCY_STOP',
}

const STATE_KEY = '@ft_engine_state';

interface EngineContextType {
  engineState: EngineState;
  stopNewOrdersActive: boolean;
  setEngineState: (state: EngineState) => void;
  toggleStopNewOrders: () => void;
  cancelOpenOrders: () => Promise<void>;
  closeAllPositions: () => Promise<void>;
  triggerEmergencyStop: () => void;
  resetFromEmergency: () => void;
}

const EngineContext = createContext<EngineContextType | undefined>(undefined);

export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [engineState, setEngineStateRaw] = useState<EngineState>(EngineState.PAPER_TRADING);
  const [stopNewOrdersActive, setStopNewOrdersActive] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STATE_KEY).then(s => {
      if (s && Object.values(EngineState).includes(s as EngineState)) {
        const saved = s as EngineState;
        // Safety: never auto-resume live trading on startup
        if (saved === EngineState.LIVE_TRADING) {
          setEngineStateRaw(EngineState.LIVE_READY);
        } else {
          setEngineStateRaw(saved);
        }
      }
    });
  }, []);

  const setEngineState = useCallback((state: EngineState) => {
    // Guard: live trading requires being in LIVE_READY first
    if (state === EngineState.LIVE_TRADING && engineState !== EngineState.LIVE_READY) return;
    setEngineStateRaw(state);
    AsyncStorage.setItem(STATE_KEY, state);
  }, [engineState]);

  const toggleStopNewOrders = useCallback(() => {
    setStopNewOrdersActive(v => !v);
  }, []);

  const cancelOpenOrders = useCallback(async () => {
    // Paper mode: simulate latency
    await new Promise<void>(r => setTimeout(r, 600));
  }, []);

  const closeAllPositions = useCallback(async () => {
    // Paper mode: simulate latency
    await new Promise<void>(r => setTimeout(r, 800));
  }, []);

  const triggerEmergencyStop = useCallback(() => {
    setEngineStateRaw(EngineState.EMERGENCY_STOP);
    setStopNewOrdersActive(true);
    AsyncStorage.setItem(STATE_KEY, EngineState.EMERGENCY_STOP);
  }, []);

  const resetFromEmergency = useCallback(() => {
    setEngineStateRaw(EngineState.PAPER_TRADING);
    setStopNewOrdersActive(false);
    AsyncStorage.setItem(STATE_KEY, EngineState.PAPER_TRADING);
  }, []);

  return (
    <EngineContext.Provider value={{
      engineState, stopNewOrdersActive,
      setEngineState, toggleStopNewOrders,
      cancelOpenOrders, closeAllPositions,
      triggerEmergencyStop, resetFromEmergency,
    }}>
      {children}
    </EngineContext.Provider>
  );
}

export function useEngine() {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngine must be used within EngineProvider');
  return ctx;
}
