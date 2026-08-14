import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { ScoreBar } from './ScoreBar';
import type { WatchlistSymbol } from '@/contexts/WatchlistContext';

interface Props {
  item: WatchlistSymbol;
  onRemove: (symbol: string) => void;
}

function fmtPrice(p: number) {
  if (p === 0) return '---';
  if (p >= 10000) return p.toFixed(0);
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function fmtVol(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v}`;
}

export function WatchlistItem({ item, onRemove }: Props) {
  const colors = useColors();
  const changeColor = item.change24h >= 0 ? colors.long : colors.short;
  const score = item.combinedScore;
  const bias = score > 15 ? 'LONG' : score < -15 ? 'SHORT' : 'NEUTRAL';
  const biasColor = bias === 'LONG' ? colors.long : bias === 'SHORT' ? colors.short : colors.mutedForeground;

  return (
    <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Symbol */}
      <View style={styles.symBlock}>
        <Text style={[styles.sym, { color: colors.foreground }]}>
          {item.symbol.replace('USDT', '')}
        </Text>
        <Text style={[styles.symSub, { color: colors.mutedForeground }]}>PERP</Text>
      </View>

      {/* Price + change */}
      <View style={styles.priceBlock}>
        <Text style={[styles.price, { color: colors.foreground }]}>{fmtPrice(item.price)}</Text>
        <Text style={[styles.change, { color: changeColor }]}>
          {item.change24h >= 0 ? '+' : ''}{item.change24h.toFixed(2)}%
        </Text>
        <Text style={[styles.vol, { color: colors.mutedForeground }]}>{fmtVol(item.volume24h)}</Text>
      </View>

      {/* Score bars */}
      <View style={styles.bars}>
        <ScoreBar score={item.score1h} label="1H" width={52} />
        <ScoreBar score={item.score4h} label="4H" width={52} />
        <ScoreBar score={item.score1d} label="1D" width={52} />
      </View>

      {/* Bias + remove */}
      <View style={styles.rightCol}>
        <View style={[styles.biasPill, { backgroundColor: biasColor + '22' }]}>
          <Text style={[styles.biasText, { color: biasColor }]}>{bias}</Text>
        </View>
        <TouchableOpacity onPress={() => onRemove(item.symbol)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name="minus-circle" size={15} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    gap: 10,
  },
  symBlock: { width: 52 },
  sym: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  symSub: { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 1 },
  priceBlock: { width: 74 },
  price: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  change: { fontFamily: 'Inter_500Medium', fontSize: 11, marginTop: 2 },
  vol: { fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 2 },
  bars: { flex: 1, gap: 4 },
  rightCol: { alignItems: 'center', gap: 8 },
  biasPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  biasText: { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.4 },
});
