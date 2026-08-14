import React, { useMemo, useState } from 'react';
import {
  FlatList, Platform, Share, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useTrading } from '@/contexts/TradingContext';
import type { Trade } from '@/contexts/TradingContext';

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDate(d: Date) {
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function formatTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function pad2(n: number) { return String(n).padStart(2, '0'); }
function isoDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function buildCSV(trades: Trade[]): string {
  const header = 'Date,Symbol,Side,SizeUSD,Close Price,Realized PnL,Strategy';
  const rows = trades.map(t =>
    [
      isoDate(new Date(t.timestamp)),
      t.displaySymbol ?? t.symbol, t.side, (t.sizeInUsd ?? 0).toFixed(2),
      t.price.toFixed(2), t.pnl.toFixed(2), t.strategy,
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

// ── TradeRow ──────────────────────────────────────────────────────────────

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
            {trade.displaySymbol ?? trade.symbol}
          </Text>
          <View style={[styles.sidePill, { backgroundColor: sideColor + '22', borderColor: sideColor + '44' }]}>
            <Text style={[styles.sideText, { color: sideColor }]}>{trade.side}</Text>
          </View>
        </View>
        <Text style={[styles.tradeMeta, { color: colors.mutedForeground }]}>
          {trade.strategy} · {formatDate(new Date(trade.timestamp))} {formatTime(new Date(trade.timestamp))}
        </Text>
      </View>
      <View style={styles.tradeRight}>
        <Text style={[styles.tradePnl, { color: pnlColor }]}>
          {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
        </Text>
        <Text style={[styles.tradeDetail, { color: colors.mutedForeground }]}>
          @ {trade.price.toFixed(2)} · ${(trade.sizeInUsd ?? 0).toFixed(0)}
        </Text>
      </View>
    </View>
  );
}

// ── ActivityRow (log derived from trades) ─────────────────────────────────

function ActivityRow({ trade }: { trade: Trade }) {
  const colors = useColors();
  const isClose = trade.action === 'CLOSE';
  const levelColor = isClose
    ? (trade.pnl >= 0 ? colors.long : colors.short)
    : colors.primary;
  const label = isClose ? (trade.pnl >= 0 ? 'WIN' : 'LOSS') : 'OPEN';
  const msg = isClose
    ? `[PAPER] CLOSED ${trade.displaySymbol ?? trade.symbol} ${trade.side} @ ${trade.price.toFixed(2)} — PnL $${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`
    : `[PAPER] OPENED ${trade.displaySymbol ?? trade.symbol} ${trade.side} $${(trade.sizeInUsd ?? 0).toFixed(0)} @ ${trade.price.toFixed(2)} (${trade.strategy})`;

  return (
    <View style={[styles.logRow, { borderBottomColor: colors.border }]}>
      <View style={[styles.logPill, { backgroundColor: levelColor + '22' }]}>
        <Text style={[styles.logLabel, { color: levelColor }]}>{label}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.logMsg, { color: colors.foreground }]}>{msg}</Text>
        <Text style={[styles.logTime, { color: colors.mutedForeground }]}>
          {formatDate(new Date(trade.timestamp))} {formatTime(new Date(trade.timestamp))}
        </Text>
      </View>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────

type SideFilter = 'ALL' | 'LONG' | 'SHORT';

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { trades } = useTrading();

  const [activeTab, setActiveTab] = useState<'trades' | 'logs'>('trades');
  const [filterSide, setFilterSide] = useState<SideFilter>('ALL');
  const [filterSymbol, setFilterSymbol] = useState('ALL');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  // Only CLOSE trades go in history
  const closedTrades = useMemo(
    () => trades.filter(t => t.action === 'CLOSE'),
    [trades]
  );

  const uniqueSymbols = useMemo(
    () => ['ALL', ...Array.from(new Set(closedTrades.map(t => t.displaySymbol ?? t.symbol)))],
    [closedTrades]
  );

  const filtered = useMemo(() => {
    return closedTrades.filter(t => {
      if (filterSide !== 'ALL' && t.side !== filterSide) return false;
      if (filterSymbol !== 'ALL' && !t.symbol.startsWith(filterSymbol)) return false;
      return true;
    });
  }, [closedTrades, filterSide, filterSymbol]);

  const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const wins = filtered.filter(t => t.pnl > 0).length;
  const winRate = filtered.length > 0 ? (wins / filtered.length) * 100 : 0;

  const handleExportCSV = async () => {
    try {
      const csv = buildCSV(filtered);
      await Share.share({
        message: csv,
        title: `trades-${new Date().toISOString().slice(0, 10)}.csv`,
      });
    } catch {}
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>History</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {filterSide !== 'ALL' || filterSymbol !== 'ALL'
              ? `${filtered.length} of ${closedTrades.length} trades`
              : `${closedTrades.length} trades`
            } · Win {winRate.toFixed(0)}% · ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.exportBtn, { backgroundColor: colors.primary + '22', borderColor: colors.primary + '44' }]}
          onPress={handleExportCSV}
          disabled={filtered.length === 0}
        >
          <Feather name="download" size={14} color={colors.primary} />
          <Text style={[styles.exportTxt, { color: colors.primary }]}>CSV</Text>
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        {(['trades', 'logs'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tabBtn, activeTab === tab && { borderBottomColor: colors.primary }]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabTxt, { color: activeTab === tab ? colors.primary : colors.mutedForeground }]}>
              {tab === 'trades' ? `Trades (${filtered.length})` : `Activity (${trades.length})`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Filters — trades tab */}
      {activeTab === 'trades' && (
        <View style={[styles.filterBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          {/* Side toggle */}
          <View style={[styles.sideToggle, { borderColor: colors.border }]}>
            {(['ALL', 'LONG', 'SHORT'] as SideFilter[]).map(s => {
              const active = filterSide === s;
              const ac = s === 'LONG' ? colors.long : s === 'SHORT' ? colors.short : colors.primary;
              return (
                <TouchableOpacity
                  key={s}
                  style={[styles.sideBtn, active && { backgroundColor: ac + '22' }]}
                  onPress={() => setFilterSide(s)}
                >
                  <Text style={[styles.sideBtnTxt, { color: active ? ac : colors.mutedForeground }]}>{s}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Symbol chips */}
          <FlatList
            horizontal
            data={uniqueSymbols}
            keyExtractor={s => s}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
            renderItem={({ item }) => {
              const active = filterSymbol === item;
              return (
                <TouchableOpacity
                  style={[styles.symChip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + '22' : 'transparent' }]}
                  onPress={() => setFilterSymbol(item)}
                >
                  <Text style={[styles.symChipTxt, { color: active ? colors.primary : colors.mutedForeground }]}>{item}</Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>
      )}

      {/* Content */}
      {activeTab === 'trades' ? (
        <FlatList
          data={filtered}
          renderItem={({ item }) => <TradeRow trade={item} />}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: botPad + 16 }]}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="clock" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyTxt, { color: colors.mutedForeground }]}>
                {closedTrades.length === 0 ? 'No closed trades yet' : 'No trades match filters'}
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={[...trades].reverse()}
          renderItem={({ item }) => <ActivityRow trade={item} />}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: botPad + 16 }]}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="activity" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyTxt, { color: colors.mutedForeground }]}>No activity yet</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1,
  },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 2 },
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1,
  },
  exportTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1 },
  tabBtn: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },

  filterBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1,
  },
  sideToggle: {
    flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden',
  },
  sideBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  sideBtnTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  symChip: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 20, borderWidth: 1,
  },
  symChipTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },

  list: { paddingTop: 4 },
  tradeRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1,
  },
  tradeLeft: { flex: 1, gap: 4 },
  tradeSymbolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tradeSymbol: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  sidePill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  sideText: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  tradeMeta: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  tradeRight: { alignItems: 'flex-end', gap: 4 },
  tradePnl: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  tradeDetail: { fontFamily: 'Inter_400Regular', fontSize: 10 },

  logRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1,
  },
  logPill: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4, marginTop: 1, minWidth: 44, alignItems: 'center' },
  logLabel: { fontFamily: 'Inter_700Bold', fontSize: 9, letterSpacing: 0.5 },
  logMsg: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
  logTime: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 3 },

  empty: { paddingTop: 80, alignItems: 'center', gap: 12 },
  emptyTxt: { fontFamily: 'Inter_400Regular', fontSize: 14 },
});
