import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { Position } from '@/contexts/TradingContext';

interface Props {
  position: Position;
  onClose: (id: string) => void;
}

function fmtPrice(p: number) {
  if (p >= 10000) return p.toFixed(0);
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

export function PositionCard({ position, onClose }: Props) {
  const colors = useColors();
  const isLong = position.side === 'LONG';
  const sideColor = isLong ? colors.long : colors.short;
  const pnlColor = position.unrealizedPnl >= 0 ? colors.long : colors.short;
  const hasRiskOrders = position.tpPrice || position.slPrice;

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onClose(position.id);
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.accent, { backgroundColor: sideColor }]} />
      <View style={styles.body}>
        {/* Header row */}
        <View style={styles.headerRow}>
          <Text style={[styles.symbol, { color: colors.foreground }]}>{position.symbol}</Text>
          <View style={[styles.sidePill, { backgroundColor: sideColor + '22', borderColor: sideColor + '55' }]}>
            <Text style={[styles.sideText, { color: sideColor }]}>{position.side}</Text>
          </View>
          <View style={[styles.lvPill, { backgroundColor: colors.secondary }]}>
            <Text style={[styles.lvText, { color: colors.mutedForeground }]}>{position.leverage}x</Text>
          </View>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={handleClose} style={[styles.closeBtn, { backgroundColor: colors.destructive + '20' }]}>
            <Feather name="x" size={13} color={colors.destructive} />
          </TouchableOpacity>
        </View>

        {/* Prices row */}
        <View style={styles.pricesRow}>
          {[
            { label: 'ENTRY', value: fmtPrice(position.entryPrice), color: colors.foreground },
            { label: 'MARK',  value: fmtPrice(position.markPrice),  color: colors.primary },
            { label: 'LIQ',   value: fmtPrice(position.liquidationPrice), color: colors.warning },
          ].map(col => (
            <View key={col.label}>
              <Text style={[styles.priceLabel, { color: colors.mutedForeground }]}>{col.label}</Text>
              <Text style={[styles.priceVal, { color: col.color }]}>{col.value}</Text>
            </View>
          ))}
        </View>

        {/* TP/SL row — shown only when set */}
        {hasRiskOrders && (
          <View style={[styles.riskRow, { borderTopColor: colors.border }]}>
            {position.tpPrice ? (
              <View style={styles.riskItem}>
                <Feather name="target" size={10} color={colors.long} />
                <Text style={[styles.riskLabel, { color: colors.mutedForeground }]}>TP</Text>
                <Text style={[styles.riskVal, { color: colors.long }]}>{fmtPrice(position.tpPrice)}</Text>
              </View>
            ) : null}
            {position.slPrice ? (
              <View style={styles.riskItem}>
                <Feather name="shield" size={10} color={colors.short} />
                <Text style={[styles.riskLabel, { color: colors.mutedForeground }]}>SL</Text>
                <Text style={[styles.riskVal, { color: colors.short }]}>{fmtPrice(position.slPrice)}</Text>
              </View>
            ) : null}
          </View>
        )}

        {/* Footer row */}
        <View style={styles.footerRow}>
          <Text style={[styles.sizeText, { color: colors.mutedForeground }]}>
            ${position.sizeInUsd.toFixed(0)} · ${position.collateralUsd.toFixed(2)} collateral
          </Text>
          <View style={styles.pnlRow}>
            <Text style={[styles.pnlAmt, { color: pnlColor }]}>
              {position.unrealizedPnl >= 0 ? '+' : ''}${position.unrealizedPnl.toFixed(2)}
            </Text>
            <Text style={[styles.pnlRoe, { color: pnlColor }]}>
              {position.roe >= 0 ? '+' : ''}{position.roe.toFixed(2)}%
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    overflow: 'hidden',
  },
  accent: { width: 3 },
  body: { flex: 1, padding: 14, gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  sidePill: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, borderWidth: 1,
  },
  sideText: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 0.5 },
  lvPill: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  lvText: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  closeBtn: { width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  pricesRow: { flexDirection: 'row', gap: 20 },
  priceLabel: { fontFamily: 'Inter_500Medium', fontSize: 9, letterSpacing: 0.4, marginBottom: 2 },
  priceVal: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  riskRow: {
    flexDirection: 'row', gap: 16,
    paddingTop: 8, borderTopWidth: 1, marginTop: -2,
  },
  riskItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  riskLabel: { fontFamily: 'Inter_500Medium', fontSize: 10 },
  riskVal: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sizeText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  pnlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pnlAmt: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  pnlRoe: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
});
