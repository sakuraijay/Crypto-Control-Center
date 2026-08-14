import React from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useTrading } from '@/contexts/TradingContext';
import { PositionCard } from '@/components/PositionCard';
import type { Position } from '@/contexts/TradingContext';

export default function PositionsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { positions, account, closePosition } = useTrading();

  const unrealColor = account.unrealizedPnl >= 0 ? colors.long : colors.short;
  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);

  const renderItem = ({ item }: { item: Position }) => (
    <PositionCard position={item} onClose={closePosition} />
  );

  const EmptyState = () => (
    <View style={styles.empty}>
      <Feather name="briefcase" size={40} color={colors.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Open Positions</Text>
      <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
        The engine will open positions when signals align with strategy rules.
      </Text>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Positions</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {positions.length} open · Paper trading
          </Text>
        </View>
        <View style={styles.pnlBlock}>
          <Text style={[styles.pnlLabel, { color: colors.mutedForeground }]}>TOTAL UNREALIZED</Text>
          <Text style={[styles.pnlValue, { color: unrealColor }]}>
            {account.unrealizedPnl >= 0 ? '+' : ''}${account.unrealizedPnl.toFixed(2)}
          </Text>
        </View>
      </View>

      <FlatList
        data={positions}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 0) + 16 },
        ]}
        ListEmptyComponent={<EmptyState />}
        showsVerticalScrollIndicator={false}
        scrollEnabled={positions.length > 0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 2 },
  pnlBlock: { alignItems: 'flex-end' },
  pnlLabel: { fontFamily: 'Inter_500Medium', fontSize: 9, letterSpacing: 0.4 },
  pnlValue: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  list: { padding: 16, gap: 0 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17 },
  emptySub: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'center', lineHeight: 20 },
});
