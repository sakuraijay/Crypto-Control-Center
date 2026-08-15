import React from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { Icon, Label, NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';

function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <Label>Dashboard</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="positions">
        <Icon sf={{ default: 'briefcase', selected: 'briefcase.fill' }} />
        <Label>Positions</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="watchlist">
        <Icon sf={{ default: 'eye', selected: 'eye.fill' }} />
        <Label>Watchlist</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="strategy">
        <Icon sf={{ default: 'slider.horizontal.3', selected: 'slider.horizontal.3' }} />
        <Label>Strategy</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ai-log">
        <Icon sf={{ default: 'cpu', selected: 'cpu' }} />
        <Label>AI Log</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ai-history">
        <Icon sf={{ default: 'clock.arrow.circlepath', selected: 'clock.arrow.circlepath' }} />
        <Label>AI History</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="backtest">
        <Icon sf={{ default: 'chart.xyaxis.line', selected: 'chart.xyaxis.line' }} />
        <Label>Backtest</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="history">
        <Icon sf={{ default: 'clock', selected: 'clock.fill' }} />
        <Label>History</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} />
        <Label>Settings</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.card,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.card }]} />
          ) : null,
        tabBarLabelStyle: {
          fontFamily: 'Inter_500Medium',
          fontSize: 10,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="house" tintColor={color} size={22} /> : <Feather name="home" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="positions"
        options={{
          title: 'Positions',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="briefcase" tintColor={color} size={22} /> : <Feather name="briefcase" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="watchlist"
        options={{
          title: 'Watchlist',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="eye" tintColor={color} size={22} /> : <Feather name="eye" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="strategy"
        options={{
          title: 'Strategy',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="slider.horizontal.3" tintColor={color} size={22} /> : <Feather name="sliders" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="ai-log"
        options={{
          title: 'AI Log',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="cpu" tintColor={color} size={22} /> : <Feather name="cpu" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="ai-history"
        options={{
          title: 'AI History',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="clock.arrow.circlepath" tintColor={color} size={22} /> : <Feather name="clock" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="backtest"
        options={{
          title: 'Backtest',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="chart.xyaxis.line" tintColor={color} size={22} /> : <Feather name="bar-chart-2" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="clock" tintColor={color} size={22} /> : <Feather name="clock" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="gearshape" tintColor={color} size={22} /> : <Feather name="settings" size={20} color={color} />,
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
