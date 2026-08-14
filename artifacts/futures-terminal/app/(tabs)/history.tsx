import React, { useState } from 'react';
import { FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTrading } from '@/contexts/TradingContext';
import { MOCK_LOGS } from '@/constants/mockData';
import type { Trade } from '@/contexts/TradingContext';

type LogEntry = { id: string; level: 'INFO' | 'WARN' | 'TRADE'; message: string; timestamp: Date };

function formatTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatDate(d: Date) {
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function TradeRow({ trade }: { trade: Trade }) {
  const colors = useColors();
  const isLong = trade.side === 'LONG';
  const pnlColor = trade.pnl >= 0 ? colors.long : colors.short;
  const sideColor = isLong ? colors.long : colors.short;
  return (
    <View style={[styles.tradeRow, { borderBottomColor: colors.border }]}>
      <View style={styles.tradeLeft}>
        <View style={styles.tradeSymbolRow}>
          <Text style={[styles.tradeSymbol, { color: colors.foreground }]}>
            {trade.symbol.replace('USDT', '')}
          </Text>
          <View style={[styles.tradeSidePill, { backgroundColor: sideColor + '22', borderColor: sideColor + '44' }]}>
            <Text style={[styles.tradeSideText, { color: sideColor }]}>{trade.side}</Text>
          </View>
        </View>
        <Text style={[styles.tradeStrategy, { color: colors.mutedForeground }]}>
          {trade.strategy} · {formatDate(trade.timestamp)} {formatTime(trade.timestamp)}
        </Text>
      </View>
      <View style={styles.tradeRight}>
        <Text style={[styles.tradePnl, { color: pnlColor }]}>
          {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
        </Text>
        <Text style={[styles.tradeSize, { color: colors.mutedForeground }]}>
          @ {trade.price.toFixed(2)} · {trade.size}
        </Text>
      </View>
    </View>
  );
}

function LogRow({ log }: { log: LogEntry }) {
  const colors = useColors();
  const levelColor = log.level === 'WARN' ? colors.warning
    : log.level === 'TRADE' ? colors.primary
    : colors.mutedForeground;
  return (
    <View style={[styles.logRow, { borderBottomColor: colors.border }]}>
      <View style={[styles.logLevelPill, { backgroundColor: levelColor + '22' }]}>
        <Text style={[styles.logLevel, { color: levelColor }]}>{log.level}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.logMsg, { color: colors.foreground }]}>{log.message}</Text>
        <Text style={[styles.logTime, { color: colors.mutedForeground }]}>
          {formatDate(log.timestamp)} {formatTime(log.timestamp)}
        </Text>
      </View>
    </View>
  );
}

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { trades } = useTrading();
  const [activeTab, setActiveTab] = useState<'trades' | 'logs'>('trades');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>History</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            Win rate {winRate.toFixed(0)}% · Total ${totalPnl.toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Tab selector */}
      <View style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        {(['trades', 'logs'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[
              styles.tabBtn,
              activeTab === tab && { borderBottomColor: colors.primary },
            ]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[
              styles.tabTxt,
              { color: activeTab === tab ? colors.primary : colors.mutedForeground },
            ]}>
              {tab === 'trades' ? `Trades (${trades.length})` : 'Strategy Logs'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {activeTab === 'trades' ? (
        <FlatList
          data={trades}
          renderItem={({ item }) => <TradeRow trade={item} />}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: botPad + 16 }]}
          showsVerticalScrollIndicator={false}
          scrollEnabled={trades.length > 0}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={[styles.emptyTxt, { color: colors.mutedForeground }]}>No trade history yet</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={MOCK_LOGS as LogEntry[]}
          renderItem={({ item }) => <LogRow log={item} />}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: botPad + 16 }]}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 2 },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1 },
  tabBtn: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  list: { paddingTop: 4 },
  tradeRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1,
  },
  tradeLeft: { flex: 1, gap: 4 },
  tradeSymbolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tradeSymbol: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  tradeSidePill: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1,
  },
  tradeSideText: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  tradeStrategy: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  tradeRight: { alignItems: 'flex-end', gap: 4 },
  tradePnl: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  tradeSize: { fontFamily: 'Inter_400Regular', fontSize: 10 },
  logRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1,
  },
  logLevelPill: {
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4,
    marginTop: 1, minWidth: 44, alignItems: 'center',
  },
  logLevel: { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.5 },
  logMsg: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
  logTime: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 3 },
  empty: { paddingTop: 80, alignItems: 'center' },
  emptyTxt: { fontFamily: 'Inter_400Regular', fontSize: 14 },
});
