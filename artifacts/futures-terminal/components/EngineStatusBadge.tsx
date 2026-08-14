import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { EngineState } from '@/contexts/EngineContext';

const STATE_LABELS: Record<EngineState, string> = {
  [EngineState.OFFLINE]: 'OFFLINE',
  [EngineState.MONITORING]: 'MONITORING',
  [EngineState.PAPER_TRADING]: 'PAPER TRADING',
  [EngineState.LIVE_READY]: 'LIVE READY',
  [EngineState.LIVE_TRADING]: 'LIVE TRADING',
  [EngineState.RISK_LOCKED]: 'RISK LOCKED',
  [EngineState.EMERGENCY_STOP]: 'EMERGENCY STOP',
};

type ColorSet = ReturnType<typeof useColors>;

function stateColor(state: EngineState, c: ColorSet): string {
  switch (state) {
    case EngineState.OFFLINE: return c.mutedForeground;
    case EngineState.MONITORING: return c.primary;
    case EngineState.PAPER_TRADING: return c.accent;
    case EngineState.LIVE_READY: return c.long;
    case EngineState.LIVE_TRADING: return c.long;
    case EngineState.RISK_LOCKED: return c.warning;
    case EngineState.EMERGENCY_STOP: return c.short;
  }
}

interface Props {
  state: EngineState;
  size?: 'sm' | 'md';
}

export function EngineStatusBadge({ state, size = 'md' }: Props) {
  const colors = useColors();
  const color = stateColor(state, colors);
  const isSmall = size === 'sm';

  return (
    <View style={[
      styles.badge,
      { backgroundColor: color + '22', borderColor: color + '55' },
      isSmall && styles.badgeSm,
    ]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color, fontSize: isSmall ? 9 : 10 }]}>
        {STATE_LABELS[state]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeSm: {
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.6,
  },
});
