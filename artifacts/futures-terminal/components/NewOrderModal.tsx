import React, { useState, useMemo } from 'react';
import {
  KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useTrading, NewOrderParams } from '@/contexts/TradingContext';
import { useEngine, EngineState } from '@/contexts/EngineContext';

interface Props {
  visible: boolean;
  onClose: () => void;
  defaultSymbol?: string;
}

// GMX V2 markets on Arbitrum One
const POPULAR = ['BTC', 'ETH', 'SOL', 'ARB', 'LINK', 'AVAX', 'DOGE'];
const MAX_LEVERAGE = 100;

export function NewOrderModal({ visible, onClose, defaultSymbol = 'ETH' }: Props) {
  const colors = useColors();
  const { placeOrder, account } = useTrading();
  const { engineState, stopNewOrdersActive } = useEngine();

  const [symbol, setSymbol]       = useState(defaultSymbol);
  const [side, setSide]           = useState<'LONG' | 'SHORT'>('LONG');
  const [orderType, setOrderType] = useState<'MarketIncrease' | 'LimitIncrease'>('MarketIncrease');
  const [sizeUsd, setSizeUsd]     = useState('500');   // USD position size
  const [leverage, setLeverage]   = useState('10');
  const [limitPrice, setLimitPrice] = useState('');
  const [tpPrice, setTpPrice]     = useState('');
  const [slPrice, setSlPrice]     = useState('');
  const [showRiskOrders, setShowRiskOrders] = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  const levNum      = Math.min(parseInt(leverage) || 1, MAX_LEVERAGE);
  const sizeUsdNum  = parseFloat(sizeUsd) || 0;

  // GMX: collateral = sizeInUsd / leverage
  const collateralUsd = sizeUsdNum > 0 && levNum > 0 ? sizeUsdNum / levNum : 0;

  // Normalise: uppercase, strip USDT/USD suffix if pasted
  const sym = symbol.toUpperCase().replace(/USDT$/, '').replace(/\/USD$/, '');

  const cannotTrade = useMemo(() => {
    if (engineState === EngineState.EMERGENCY_STOP) return 'Emergency stop is active';
    if (stopNewOrdersActive) return 'New orders are disabled';
    if (engineState === EngineState.OFFLINE) return 'Engine is offline';
    return null;
  }, [engineState, stopNewOrdersActive]);

  const handleSubmit = () => {
    setError('');
    setSuccess('');

    if (cannotTrade) { setError(cannotTrade); return; }
    if (!sym.trim()) { setError('Enter a symbol'); return; }
    if (sizeUsdNum <= 0) { setError('Position size must be > $0'); return; }
    if (levNum < 1 || levNum > MAX_LEVERAGE) { setError(`Leverage must be 1–${MAX_LEVERAGE}x`); return; }
    if (orderType === 'LimitIncrease' && !(parseFloat(limitPrice) > 0)) { setError('Set a limit price'); return; }
    if (collateralUsd > account.availableBalance) { setError('Insufficient available balance'); return; }

    const params: NewOrderParams = {
      symbol: sym,
      side,
      orderType,
      sizeInUsd: sizeUsdNum,
      leverage: levNum,
      limitPrice: orderType === 'LimitIncrease' ? parseFloat(limitPrice) : undefined,
      tpPrice: tpPrice ? parseFloat(tpPrice) : undefined,
      slPrice: slPrice ? parseFloat(slPrice) : undefined,
    };

    const result = placeOrder(params);
    if (result.success) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccess(`[PAPER] ${side} $${sizeUsdNum.toFixed(0)} ${sym}/USD placed ✓`);
      setTimeout(() => { setSuccess(''); onClose(); }, 1200);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(result.error ?? 'Order rejected');
    }
  };

  const isLong = side === 'LONG';
  const sideColor = isLong ? colors.long : colors.short;

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Handle */}
          <View style={[styles.handle, { backgroundColor: colors.border }]} />

          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View>
              <Text style={[styles.title, { color: colors.foreground }]}>New Paper Order</Text>
              <Text style={[styles.sub, { color: colors.mutedForeground }]}>GMX V2 · Arbitrum One · No real funds</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: colors.secondary }]}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.form} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* Symbol */}
            <View style={styles.field}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>MARKET</Text>
              <TextInput
                value={symbol}
                onChangeText={t => setSymbol(t.toUpperCase().replace(/USDT$/, '').replace(/\/USD$/, ''))}
                style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
                autoCapitalize="characters"
                placeholder="ETH"
                placeholderTextColor={colors.mutedForeground}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
                {POPULAR.map(s => (
                  <TouchableOpacity
                    key={s}
                    onPress={() => setSymbol(s)}
                    style={[styles.chip, {
                      backgroundColor: sym === s ? colors.primary + '22' : colors.secondary,
                      borderColor: sym === s ? colors.primary + '66' : colors.border,
                    }]}
                  >
                    <Text style={[styles.chipTxt, { color: sym === s ? colors.primary : colors.mutedForeground }]}>
                      {s}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Side */}
            <View style={styles.field}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>DIRECTION</Text>
              <View style={styles.toggleRow}>
                {(['LONG', 'SHORT'] as const).map(s => {
                  const active = side === s;
                  const c = s === 'LONG' ? colors.long : colors.short;
                  return (
                    <TouchableOpacity
                      key={s}
                      onPress={() => { setSide(s); Haptics.selectionAsync(); }}
                      style={[styles.toggleBtn, {
                        backgroundColor: active ? c + '22' : colors.secondary,
                        borderColor: active ? c + '88' : colors.border,
                        flex: 1,
                      }]}
                    >
                      <Feather name={s === 'LONG' ? 'trending-up' : 'trending-down'} size={14} color={active ? c : colors.mutedForeground} />
                      <Text style={[styles.toggleTxt, { color: active ? c : colors.mutedForeground }]}>{s}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Order type */}
            <View style={styles.field}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>ORDER TYPE</Text>
              <View style={styles.toggleRow}>
                {(['MarketIncrease', 'LimitIncrease'] as const).map(t => {
                  const active = orderType === t;
                  const label = t === 'MarketIncrease' ? 'MARKET' : 'LIMIT';
                  return (
                    <TouchableOpacity
                      key={t}
                      onPress={() => { setOrderType(t); Haptics.selectionAsync(); }}
                      style={[styles.toggleBtn, {
                        backgroundColor: active ? colors.primary + '22' : colors.secondary,
                        borderColor: active ? colors.primary + '66' : colors.border,
                        flex: 1,
                      }]}
                    >
                      <Text style={[styles.toggleTxt, { color: active ? colors.primary : colors.mutedForeground }]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Size (USD) + Leverage */}
            <View style={styles.row}>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>SIZE (USD)</Text>
                <TextInput
                  value={sizeUsd}
                  onChangeText={setSizeUsd}
                  keyboardType="decimal-pad"
                  style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
                  placeholder="500"
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>LEVERAGE (max {MAX_LEVERAGE}x)</Text>
                <View style={styles.stepperRow}>
                  <TouchableOpacity onPress={() => setLeverage(String(Math.max(1, levNum - 1)))} style={[styles.stepBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: 'bold' }}>−</Text>
                  </TouchableOpacity>
                  <TextInput
                    value={leverage}
                    onChangeText={setLeverage}
                    keyboardType="number-pad"
                    style={[styles.leverageInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
                    placeholder="10"
                    placeholderTextColor={colors.mutedForeground}
                  />
                  <TouchableOpacity onPress={() => setLeverage(String(Math.min(MAX_LEVERAGE, levNum + 1)))} style={[styles.stepBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: 'bold' }}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Limit price */}
            {orderType === 'LimitIncrease' && (
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>LIMIT PRICE</Text>
                <TextInput
                  value={limitPrice}
                  onChangeText={setLimitPrice}
                  keyboardType="decimal-pad"
                  style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
                  placeholder="Enter limit price"
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
            )}

            {/* Collateral estimate */}
            {collateralUsd > 0 && (
              <View style={[styles.marginInfo, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.marginLabel, { color: colors.mutedForeground }]}>Required Collateral (USDC)</Text>
                <Text style={[styles.marginValue, { color: colors.foreground }]}>${collateralUsd.toFixed(2)}</Text>
              </View>
            )}

            {/* TP/SL */}
            <TouchableOpacity onPress={() => setShowRiskOrders(p => !p)} style={styles.riskToggle}>
              <Feather name={showRiskOrders ? 'chevron-down' : 'chevron-right'} size={14} color={colors.primary} />
              <Text style={[styles.riskToggleTxt, { color: colors.primary }]}>
                {showRiskOrders ? 'Hide' : 'Set'} Take Profit / Stop Loss
              </Text>
            </TouchableOpacity>
            {showRiskOrders && (
              <View style={styles.row}>
                <View style={[styles.field, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.long }]}>TAKE PROFIT</Text>
                  <TextInput
                    value={tpPrice}
                    onChangeText={setTpPrice}
                    keyboardType="decimal-pad"
                    style={[styles.input, { color: colors.long, backgroundColor: colors.background, borderColor: colors.border }]}
                    placeholder="Optional"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>
                <View style={[styles.field, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.short }]}>STOP LOSS</Text>
                  <TextInput
                    value={slPrice}
                    onChangeText={setSlPrice}
                    keyboardType="decimal-pad"
                    style={[styles.input, { color: colors.short, backgroundColor: colors.background, borderColor: colors.border }]}
                    placeholder="Optional"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>
              </View>
            )}

            {/* Error / success */}
            {error ? (
              <View style={[styles.alert, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '44' }]}>
                <Feather name="alert-circle" size={13} color={colors.destructive} />
                <Text style={[styles.alertTxt, { color: colors.destructive }]}>{error}</Text>
              </View>
            ) : success ? (
              <View style={[styles.alert, { backgroundColor: colors.long + '18', borderColor: colors.long + '44' }]}>
                <Feather name="check-circle" size={13} color={colors.long} />
                <Text style={[styles.alertTxt, { color: colors.long }]}>{success}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Submit */}
          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <TouchableOpacity
              onPress={handleSubmit}
              style={[styles.submitBtn, { backgroundColor: sideColor }]}
              activeOpacity={0.85}
              disabled={!!success}
            >
              <Feather name={isLong ? 'trending-up' : 'trending-down'} size={18} color="#000" />
              <Text style={styles.submitTxt}>{isLong ? 'BUY / LONG' : 'SELL / SHORT'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)' } as any,
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, maxHeight: '90%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  sub: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  form: { padding: 20, gap: 16 },
  field: { gap: 6 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.6 },
  input: { height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, fontFamily: 'Inter_400Regular', fontSize: 14 },
  chips: { marginTop: 4 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1, marginRight: 6 },
  chipTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  toggleRow: { flexDirection: 'row', gap: 10 },
  toggleBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12, borderRadius: 10, borderWidth: 1 },
  toggleTxt: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  row: { flexDirection: 'row', gap: 12 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 36, height: 44, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  leverageInput: { flex: 1, height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, fontFamily: 'Inter_700Bold', fontSize: 15, textAlign: 'center' },
  marginInfo: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 10, borderWidth: 1 },
  marginLabel: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  marginValue: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  riskToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  riskToggleTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  alert: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 10, borderWidth: 1 },
  alertTxt: { fontFamily: 'Inter_500Medium', fontSize: 13, flex: 1 },
  footer: { padding: 20, paddingTop: 14, borderTopWidth: 1 },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16, borderRadius: 14 },
  submitTxt: { fontFamily: 'Inter_700Bold', fontSize: 17, color: '#000', letterSpacing: 0.5 },
});
