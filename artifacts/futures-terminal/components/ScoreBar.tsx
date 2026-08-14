import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface Props {
  score: number; // -100 to 100
  label: string;
  width?: number;
}

export function ScoreBar({ score, label, width = 56 }: Props) {
  const colors = useColors();
  const isPos = score > 0;
  const color = isPos ? colors.long : score < 0 ? colors.short : colors.mutedForeground;
  const barW = (Math.abs(score) / 100) * (width / 2);
  const barLeft = isPos ? width / 2 : width / 2 - barW;

  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={[styles.track, { width, backgroundColor: colors.border }]}>
        {score !== 0 && (
          <View style={[styles.fill, { width: barW, left: barLeft, backgroundColor: color }]} />
        )}
      </View>
      <Text style={[styles.val, { color, width: 28 }]}>
        {score > 0 ? '+' : ''}{Math.round(score)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  label: {
    fontFamily: 'Inter_500Medium',
    fontSize: 9,
    letterSpacing: 0.3,
    width: 18,
  },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    position: 'relative',
  },
  fill: {
    position: 'absolute',
    top: 0,
    height: '100%',
    borderRadius: 2,
  },
  val: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 10,
    textAlign: 'right',
  },
});
