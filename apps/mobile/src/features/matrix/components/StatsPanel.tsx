import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../../../shared/theme';
import type { GlobalStats } from '../services/apiClient';
import { formatNumber } from '../services/matrixValidation';

/** Props of {@link StatsPanel}. */
export interface StatsPanelProps {
  readonly stats: GlobalStats;
}

/**
 * The global statistics, as four cards.
 *
 * Numbers are formatted with the same helper the matrices use, so the two parts
 * of the results screen do not disagree about how a number is written.
 */
export function StatsPanel({ stats }: StatsPanelProps): React.ReactElement {
  const cards = [
    { label: 'Max', value: stats.max },
    { label: 'Min', value: stats.min },
    { label: 'Average', value: stats.average },
    { label: 'Sum', value: stats.sum },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Statistics</Text>
      <Text style={styles.subtitle}>Across the values of both factors.</Text>

      <View style={styles.grid}>
        {cards.map((card) => (
          <View key={card.label} style={styles.card}>
            <Text style={styles.cardLabel}>{card.label}</Text>
            <Text style={styles.cardValue} numberOfLines={1}>
              {formatNumber(card.value, 4)}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.flagRow}>
        <View
          style={[
            styles.flag,
            stats.anyDiagonal ? styles.flagYes : styles.flagNo,
          ]}
        >
          <Text
            style={[
              styles.flagText,
              stats.anyDiagonal ? styles.flagTextYes : styles.flagTextNo,
            ]}
          >
            {stats.anyDiagonal
              ? 'At least one factor is diagonal'
              : 'Neither factor is diagonal'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  card: {
    flexGrow: 1,
    flexBasis: '46%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cardLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  cardValue: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    // Tabular figures keep the decimal points aligned across the four cards.
    // A long sum is truncated at the Text level rather than the style level.
    fontVariant: ['tabular-nums'],
  },
  flagRow: { marginTop: spacing.xs },
  flag: { alignSelf: 'flex-start', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm, overflow: 'hidden' },
  flagYes: { backgroundColor: 'rgba(74, 222, 128, 0.15)' },
  flagNo: { backgroundColor: 'rgba(147, 161, 184, 0.15)' },
  flagText: { fontSize: 13, fontWeight: '600' },
  flagTextYes: { color: colors.success },
  flagTextNo: { color: colors.textMuted },
});
