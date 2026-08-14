import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PIN_LEN = 4;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { requiresSetup, setupPin, verifyPin } = useAuth();

  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);

  const complete = useCallback(async (entered: string) => {
    setProcessing(true);
    if (requiresSetup) {
      if (step === 'enter') {
        setConfirmPin(entered);
        setPin('');
        setStep('confirm');
      } else {
        if (entered === confirmPin) {
          await setupPin(entered);
        } else {
          setError('PINs do not match — try again');
          setPin('');
          setStep('enter');
          setConfirmPin('');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      }
    } else {
      const ok = await verifyPin(entered);
      if (!ok) {
        setError('Incorrect PIN');
        setPin('');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    }
    setProcessing(false);
  }, [requiresSetup, step, confirmPin, setupPin, verifyPin]);

  const handleKey = useCallback((key: string) => {
    if (!key || processing) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (key === 'del') {
      setPin(p => p.slice(0, -1));
      setError('');
      return;
    }
    if (pin.length >= PIN_LEN) return;
    const next = pin + key;
    setPin(next);
    if (next.length === PIN_LEN) {
      setTimeout(() => complete(next), 80);
    }
  }, [pin, processing, complete]);

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const instruction = requiresSetup
    ? step === 'enter' ? 'Set a 4-digit PIN' : 'Confirm your PIN'
    : 'Enter PIN';

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: topPad, paddingBottom: botPad }]}>
      {/* Branding */}
      <View style={styles.brand}>
        <Text style={[styles.brandTop, { color: colors.foreground }]}>FUTURES</Text>
        <Text style={[styles.brandBot, { color: colors.accent }]}>TERMINAL</Text>
        <View style={[styles.modeBadge, { backgroundColor: colors.accent + '22', borderColor: colors.accent + '44' }]}>
          <Text style={[styles.modeText, { color: colors.accent }]}>PAPER TRADING MODE</Text>
        </View>
      </View>

      {/* PIN dots */}
      <View style={styles.pinArea}>
        <Text style={[styles.instruction, { color: colors.mutedForeground }]}>{instruction}</Text>
        <View style={styles.dots}>
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  backgroundColor: i < pin.length ? colors.primary : 'transparent',
                  borderColor: i < pin.length ? colors.primary : colors.border,
                },
              ]}
            />
          ))}
        </View>
        {error ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
        ) : null}
      </View>

      {/* Keypad */}
      <View style={styles.keypad}>
        {KEYS.map((key, i) => {
          const isEmpty = key === '';
          const isDel = key === 'del';
          return (
            <TouchableOpacity
              key={i}
              style={[
                styles.key,
                isEmpty && styles.keyInvisible,
                !isEmpty && { backgroundColor: isDel ? colors.secondary : colors.card, borderColor: colors.border },
              ]}
              onPress={() => handleKey(key)}
              disabled={isEmpty || processing}
              activeOpacity={0.6}
            >
              {isDel ? (
                <Feather name="delete" size={20} color={colors.foreground} />
              ) : (
                <Text style={[styles.keyTxt, { color: colors.foreground }]}>{key}</Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: 32,
  },
  brand: { alignItems: 'center', gap: 4 },
  brandTop: { fontFamily: 'Inter_700Bold', fontSize: 30, letterSpacing: 7 },
  brandBot: { fontFamily: 'Inter_400Regular', fontSize: 14, letterSpacing: 7, marginTop: -4 },
  modeBadge: {
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  modeText: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1 },
  pinArea: { alignItems: 'center', gap: 20 },
  instruction: { fontFamily: 'Inter_400Regular', fontSize: 15 },
  dots: { flexDirection: 'row', gap: 20 },
  dot: {
    width: 16, height: 16, borderRadius: 8, borderWidth: 2,
  },
  error: { fontFamily: 'Inter_500Medium', fontSize: 13 },
  keypad: {
    width: '100%',
    maxWidth: 288,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
  },
  key: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  keyInvisible: { backgroundColor: 'transparent', borderWidth: 0 },
  keyTxt: { fontFamily: 'Inter_400Regular', fontSize: 26 },
});
