import React, { useState } from 'react';
import { Alert, FlatList, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useWatchlist, StreamStatus } from '@/contexts/WatchlistContext';
import { WatchlistItem } from '@/components/WatchlistItem';
import type { WatchlistSymbol } from '@/contexts/WatchlistContext';

export default function WatchlistScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { symbols, streamStatus, addSymbol, removeSymbol } = useWatchlist();
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);

  const handleAdd = () => {
    const sym = input.trim().toUpperCase();
    if (!sym) return;
    const full = sym.endsWith('USDT') ? sym : sym + 'USDT';
    addSymbol(full);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInput('');
    setAdding(false);
  };

  const handleRemove = (symbol: string) => {
    Alert.alert(
      'Remove Symbol',
      `Remove ${symbol} from watchlist?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            removeSymbol(symbol);
          },
        },
      ],
    );
  };

  const renderItem = ({ item }: { item: WatchlistSymbol }) => (
    <WatchlistItem item={item} onRemove={handleRemove} />
  );

  const EmptyState = () => (
    <View style={styles.empty}>
      <Feather name="eye-off" size={40} color={colors.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Watchlist Empty</Text>
      <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
        Add symbols to monitor multi-timeframe scores and bias signals.
      </Text>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Watchlist</Text>
          <Text style={[styles.headerSub, {
            color: streamStatus === 'connected' ? colors.long : streamStatus === 'offline' ? colors.mutedForeground : colors.warning,
          }]}>
            {streamStatus === 'connected' ? '● LIVE' : streamStatus === 'connecting' || streamStatus === 'reconnecting' ? '◌ CONNECTING' : '○ SIMULATED'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.primary + '22', borderColor: colors.primary + '55' }]}
          onPress={() => setAdding(!adding)}
        >
          <Feather name={adding ? 'x' : 'plus'} size={16} color={colors.primary} />
          <Text style={[styles.addBtnTxt, { color: colors.primary }]}>{adding ? 'Cancel' : 'Add Symbol'}</Text>
        </TouchableOpacity>
      </View>

      {/* Add input */}
      {adding && (
        <View style={[styles.addRow, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <TextInput
            style={[styles.addInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
            placeholder="e.g. BTC or BTCUSDT"
            placeholderTextColor={colors.mutedForeground}
            value={input}
            onChangeText={setInput}
            autoCapitalize="characters"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleAdd}
          />
          <TouchableOpacity
            style={[styles.addConfirmBtn, { backgroundColor: colors.primary }]}
            onPress={handleAdd}
          >
            <Feather name="check" size={18} color={colors.primaryForeground} />
          </TouchableOpacity>
        </View>
      )}

      {/* Legend row */}
      <View style={[styles.legend, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <Text style={[styles.legendTxt, { color: colors.mutedForeground }]}>
          Scores: -100 (strong SHORT) → 0 (neutral) → +100 (strong LONG)
        </Text>
      </View>

      <FlatList
        data={symbols}
        renderItem={renderItem}
        keyExtractor={item => item.symbol}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 0) + 16 },
        ]}
        ListEmptyComponent={<EmptyState />}
        showsVerticalScrollIndicator={false}
        scrollEnabled={symbols.length > 0}
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
  headerSub: { fontFamily: 'Inter_600SemiBold', fontSize: 10, marginTop: 2, letterSpacing: 1 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  addBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  addRow: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderBottomWidth: 1,
  },
  addInput: {
    flex: 1,
    height: 42,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
  },
  addConfirmBtn: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legend: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  legendTxt: { fontFamily: 'Inter_400Regular', fontSize: 10 },
  list: { padding: 12 },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17 },
  emptySub: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'center', lineHeight: 20 },
});
