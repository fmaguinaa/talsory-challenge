import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../../../shared/theme';
import type { Matrix } from '../services/apiClient';
import { formatNumber, looksDiagonal } from '../services/matrixValidation';

/** Props of {@link MatrixView}. */
export interface MatrixViewProps {
  readonly label: string;
  readonly matrix: Matrix;
  /** Whether the matrix is diagonal, as reported by the server. */
  readonly isDiagonal?: boolean;
}

/**
 * Renders one matrix as a readable table.
 *
 * Numbers are shown to four decimals by default and the exact value on tap,
 * because both matter: the short form makes the structure of Q and R legible,
 * and a user verifying Q * R = A needs the digits the short form hides.
 */
export function MatrixView({ label, matrix, isDiagonal }: MatrixViewProps): React.ReactElement {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        {isDiagonal === undefined ? null : (
          <View style={[styles.badge, isDiagonal ? styles.badgeYes : styles.badgeNo]}>
            <Text style={[styles.badgeText, isDiagonal ? styles.badgeTextYes : styles.badgeTextNo]}>
              {isDiagonal ? 'diagonal' : 'not diagonal'}
            </Text>
          </View>
        )}
      </View>

      <MatrixTable matrix={matrix} />
      <Text style={styles.caption}>
        {matrix.length} \u00d7 {matrix[0]?.length ?? 0}
        {looksDiagonal(matrix) ? ' \u00b7 diagonal' : ''}
      </Text>
    </View>
  );
}

/** Props of {@link MatrixTable}. */
interface MatrixTableProps {
  readonly matrix: Matrix;
}

/**
 * The grid itself.
 *
 * Horizontally scrollable, because a wide matrix must not be squeezed until the
 * numbers are unreadable. Rows are not scrollable independently: a table that
 * scrolls in two directions at once is hard to read on a phone.
 */
function MatrixTable({ matrix }: MatrixTableProps): React.ReactElement {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.scroll}>
      <View>
        {matrix.map((row, rowIndex) => (
          <View key={`row-${rowIndex}`} style={styles.row}>
            {row.map((value, colIndex) => (
              <MatrixCell key={`cell-${rowIndex}-${colIndex}`} value={value} />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** Props of {@link MatrixCell}. */
interface MatrixCellProps {
  readonly value: number;
}

/**
 * One number.
 *
 * The tap-to-reveal behaviour is what makes the short display honest: nothing
 * is hidden without a way to see it.
 */
function MatrixCell({ value }: MatrixCellProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  // A value that already fits the short form has nothing to reveal, so it is
  // not focusable and does not pretend to be interactive.
  const short = formatNumber(value);
  const hasMore = expanded && short !== String(value);

  return (
    <Pressable
      onPress={hasMore || short !== String(value) ? toggle : undefined}
      accessibilityRole={short !== String(value) ? 'button' : 'text'}
      accessibilityLabel={`${value}`}
      accessibilityHint={short !== String(value) ? 'Double tap for the full value' : undefined}
      style={styles.cell}
    >
      <Text style={styles.cellText} numberOfLines={1}>
        {expanded ? String(value) : short}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.text, fontSize: 18, fontWeight: '700' },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, overflow: 'hidden' },
  badgeYes: { backgroundColor: 'rgba(74, 222, 128, 0.15)' },
  badgeNo: { backgroundColor: 'rgba(147, 161, 184, 0.15)' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  badgeTextYes: { color: colors.success },
  badgeTextNo: { color: colors.textMuted },
  scroll: {
    // React Native has no overflow style for a nested scroll view; the parent
    // clips instead, which is the supported way to keep the grid contained.
    borderRadius: radius.sm,
  },
  row: { flexDirection: 'row' },
  cell: {
    minWidth: 84,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'flex-end',
  },
  // Tabular figures keep the decimal points aligned down the column, which is
  // what makes a matrix readable at a glance.
  cellText: {
    color: colors.text,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  caption: { color: colors.textMuted, fontSize: 12 },
});
