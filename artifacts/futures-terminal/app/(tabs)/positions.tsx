import React, { useState } from 'react';
import { FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTrading } from '@/contexts/TradingContext';
import { PositionCard } from '@/components/PositionCard';
import { NewOrderModal } from '@/components/NewOrderModal';
import type { Position } from '@/contexts/TradingContext';

export default function PositionsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { positions, account, closePosition } = useTrading();
  const [orderModalOpen, setOrderModalOpen] = useState(false);

  const unrealColor = account.unrealizedPnl >= 0 ? colors.long : colors.short;
  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const renderItem = ({ item }: { item: Position }) => (
    <PositionCard position={item} onClose={closePosition} />
  );

  const EmptyState = () => (
    <View style={styles.empty}>
      <Feather name="briefcase" size={40} color={colors.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Open Positions</Text>
      <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
        Place a paper order to get started, or wait for the engine to open positions when signals align.
      </Text>
      <TouchableOpacity
        style={[styles.newOrderBtn, { backgroundColor: colors.primary }]}
        onPress={() => setOrderModalOpen(true)}
        activeOpacity={0.8}
      >
        <Feather name="plus" size={16} color="#000" />
        <Text style={styles.newOrderBtnTxt}>New Paper Order</Text>
      </TouchableOpacity>
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
        <View style={styles.headerRight}>
          <View style={styles.pnlBlock}>
            <Text style={[styles.pnlLabel, { color: colors.mutedForeground }]}>UNREALIZED</Text>
            <Text style={[styles.pnlValue, { color: unrealColor }]}>
              {account.unrealizedPnl >= 0 ? '+' : ''}${account.unrealizedPnl.toFixed(2)}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.newOrderHeaderBtn, { backgroundColor: colors.primary }]}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setOrderModalOpen(true); }}
            activeOpacity={0.8}
          >
            <Feather name="plus" size={16} color="#000" />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={positions}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: botPad + 16 },
        ]}
        ListEmptyComponent={<EmptyState />}
        showsVerticalScrollIndicator={false}
        scrollEnabled={positions.length > 0}
      />

      <NewOrderModal visible={orderModalOpen} onClose={() => setOrderModalOpen(false)} />
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
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pnlBlock: { alignItems: 'flex-end' },
  pnlLabel: { fontFamily: 'Inter_500Medium', fontSize: 9, letterSpacing: 0.4 },
  pnlValue: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  newOrderHeaderBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  list: { padding: 16 },
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingTop: 80, gap: 12, paddingHorizontal: 40,
  },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17 },
  emptySub: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  newOrderBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, marginTop: 8,
  },
  newOrderBtnTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#000' },
});
