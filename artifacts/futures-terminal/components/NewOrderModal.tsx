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
  const [sizeUsd, setSizeUsd]     = useState('500');
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

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* Cannot trade banner */}
            {cannotTrade && (
              <View style={[styles.errorBox, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '44' }]}>
                <Feather name="alert-octagon" size={14} color={colors.destructive} />
                <Text style={[styles.errorTxt, { color: colors.destructive }]}>{cannotTrade}</Text>
              </View>
            )}

            {/* Symbol */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>MARKET</Text>
              <TextInput
                value={symbol}
                onChangeText={t => setSymbol(t.toUpperCase())}
                placeholder="e.g. BTC, ETH, SOL"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="characters"
                style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
                {POPULAR.map(s => (
                  <TouchableOpacity
                    key={s}
                    onPress={() => setSymbol(s)}
                    style={[styles.chip, {
                      backgroundColor: sym === s ? colors.primary + '22' : colors.secondary,
                      borderColor:     sym === s ? colors.primary         : colors.border,
                    }]}
                  >
                    <Text style={[styles.chipTxt, { color: sym === s ? colors.primary : colors.mutedForeground }]}>{s}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Direction */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>DIRECTION</Text>
              <View style={styles.dirRow}>
                {(['LONG', 'SHORT'] as const).map(d => (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setSide(d)}
                    style={[styles.dirBtn, {
                      backgroundColor: side === d ? (d === 'LONG' ? colors.long : colors.short) + '22' : colors.secondary,
                      borderColor:     side === d ? (d === 'LONG' ? colors.long : colors.short)      : colors.border,
                      flex: 1,
                    }]}
                  >
                    <Feather name={d === 'LONG' ? 'trending-up' : 'trending-down'} size={14}
                      color={side === d ? (d === 'LONG' ? colors.long : colors.short) : colors.mutedForeground} />
                    <Text style={[styles.dirTxt, { color: side === d ? (d === 'LONG' ? colors.long : colors.short) : colors.mutedForeground }]}>
                      {d === 'LONG' ? 'LONG / BUY' : 'SHORT / SELL'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Order type */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>ORDER TYPE</Text>
              <View style={styles.dirRow}>
                {(['MarketIncrease', 'LimitIncrease'] as const).map(t => (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setOrderType(t)}
                    style={[styles.dirBtn, {
                      backgroundColor: orderType === t ? colors.primary + '22' : colors.secondary,
                      borderColor:     orderType === t ? colors.primary         : colors.border,
                      flex: 1,
                    }]}
                  >
                    <Text style={[styles.dirTxt, { color: orderType === t ? colors.primary : colors.mutedForeground }]}>
                      {t === 'MarketIncrease' ? 'Market' : 'Limit'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Size */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>POSITION SIZE (USD)</Text>
              <TextInput
                value={sizeUsd}
                onChangeText={setSizeUsd}
                placeholder="500"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
              />
              {collateralUsd > 0 && (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  Collateral (USDC): ${collateralUsd.toFixed(2)} · Available: ${account.availableBalance.toFixed(2)}
                </Text>
              )}
            </View>

            {/* Leverage */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>LEVERAGE (MAX {MAX_LEVERAGE}×)</Text>
              <View style={styles.levRow}>
                <TouchableOpacity
                  onPress={() => setLeverage(String(Math.max(1, levNum - 1)))}
                  style={[styles.levBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                >
                  <Text style={[styles.levBtnTxt, { color: colors.foreground }]}>−</Text>
                </TouchableOpacity>
                <TextInput
                  value={leverage}
                  onChangeText={setLeverage}
                  keyboardType="number-pad"
                  style={[styles.levInput, { color: sideColor, backgroundColor: colors.secondary, borderColor: colors.border }]}
                />
                <TouchableOpacity
                  onPress={() => setLeverage(String(Math.min(MAX_LEVERAGE, levNum + 1)))}
                  style={[styles.levBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                >
                  <Text style={[styles.levBtnTxt, { color: colors.foreground }]}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Limit price (only for limit orders) */}
            {orderType === 'LimitIncrease' && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>LIMIT PRICE</Text>
                <TextInput
                  value={limitPrice}
                  onChangeText={setLimitPrice}
                  placeholder="Enter limit price"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                  style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                />
              </View>
            )}

            {/* TP/SL */}
            <TouchableOpacity onPress={() => setShowRiskOrders(s => !s)} style={styles.riskToggle}>
              <Feather name={showRiskOrders ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
              <Text style={[styles.riskToggleTxt, { color: colors.primary }]}>
                {showRiskOrders ? 'Hide' : 'Set'} Take Profit / Stop Loss
              </Text>
            </TouchableOpacity>

            {showRiskOrders && (
              <View style={styles.riskRow}>
                <View style={[styles.section, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.mutedForeground }]}>TAKE PROFIT</Text>
                  <TextInput
                    value={tpPrice}
                    onChangeText={setTpPrice}
                    placeholder="TP price"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="decimal-pad"
                    style={[styles.input, { color: colors.long, backgroundColor: colors.secondary, borderColor: colors.border }]}
                  />
                </View>
                <View style={[styles.section, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.mutedForeground }]}>STOP LOSS</Text>
                  <TextInput
                    value={slPrice}
                    onChangeText={setSlPrice}
                    placeholder="SL price"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="decimal-pad"
                    style={[styles.input, { color: colors.short, backgroundColor: colors.secondary, borderColor: colors.border }]}
                  />
                </View>
              </View>
            )}

            {/* Error / Success */}
            {error ? (
              <View style={[styles.errorBox, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '44' }]}>
                <Feather name="alert-triangle" size={14} color={colors.destructive} />
                <Text style={[styles.errorTxt, { color: colors.destructive }]}>{error}</Text>
              </View>
            ) : success ? (
              <View style={[styles.errorBox, { backgroundColor: colors.long + '18', borderColor: colors.long + '44' }]}>
                <Feather name="check-circle" size={14} color={colors.long} />
                <Text style={[styles.errorTxt, { color: colors.long }]}>{success}</Text>
              </View>
            ) : null}

            <View style={{ height: 16 }} />
          </ScrollView>

          {/* Footer */}
          <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.card }]}>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.cancelBtn, { borderColor: colors.border, backgroundColor: colors.secondary }]}
              activeOpacity={0.8}
            >
              <Text style={[styles.cancelTxt, { color: colors.mutedForeground }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!!cannotTrade || !!success}
              style={[styles.submitBtn, { backgroundColor: sideColor, opacity: (cannotTrade || success) ? 0.5 : 1 }]}
              activeOpacity={0.85}
            >
              <Text style={styles.submitTxt}>
                {isLong ? 'BUY / LONG' : 'SELL / SHORT'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay:    { flex: 1, justifyContent: 'flex-end' },
  backdrop:   { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet:      { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, maxHeight: '92%' },
  handle:     { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  header:     { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  title:      { fontFamily: 'Inter_700Bold', fontSize: 17 },
  sub:        { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 3 },
  closeBtn:   { padding: 8, borderRadius: 20 },
  body:       { padding: 20 },
  section:    { gap: 6, marginBottom: 16 },
  label:      { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  input:      { fontFamily: 'Inter_400Regular', fontSize: 15, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  hint:       { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 2 },
  chipRow:    { marginTop: 6 },
  chip:       { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, marginRight: 6 },
  chipTxt:    { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  dirRow:     { flexDirection: 'row', gap: 10 },
  dirBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 11, borderRadius: 10, borderWidth: 1 },
  dirTxt:     { fontFamily: 'Inter_700Bold', fontSize: 13 },
  levRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  levBtn:     { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1 },
  levBtnTxt:  { fontFamily: 'Inter_700Bold', fontSize: 18 },
  levInput:   { flex: 1, textAlign: 'center', fontFamily: 'Inter_700Bold', fontSize: 18, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  riskToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  riskToggleTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  riskRow:    { flexDirection: 'row', gap: 12 },
  errorBox:   { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 12 },
  errorTxt:   { fontFamily: 'Inter_500Medium', fontSize: 12, flex: 1 },
  footer:     { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 1 },
  cancelBtn:  { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 12, borderWidth: 1 },
  cancelTxt:  { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  submitBtn:  { flex: 2, alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 12 },
  submitTxt:  { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff', letterSpacing: 0.5 },
});
