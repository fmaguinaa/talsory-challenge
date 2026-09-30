import React, { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing } from '../../../shared/theme';
import {
  EXAMPLE_MATRIX,
  draftFromMatrix,
  emptyDraft,
  type CellValue,
  type DraftMatrix,
} from '../services/matrixValidation';

/** Props of {@link MatrixEditor}. */
export interface MatrixEditorProps {
  readonly value: DraftMatrix;
  readonly onChange: (next: DraftMatrix) => void;
  /** Marks the cell named by the validation error, if there is one. */
  readonly errorCell?: { readonly row: number; readonly col: number } | undefined;
  readonly disabled?: boolean;
}

/** Smallest matrix the editor will produce. */
const MIN_DIM = 1;
/** Largest matrix the editor will produce, matching the server limit. */
const MAX_DIM = 12;

/**
 * The matrix editor.
 *
 * A grid of numeric inputs rather than a single textarea, because a QR
 * decomposition is a two-dimensional object and reviewing it row by row is the
 * whole task. The grid scrolls horizontally on narrow screens instead of
 * shrinking the cells below a usable width.
 */
export function MatrixEditor({
  value,
  onChange,
  errorCell,
  disabled = false,
}: MatrixEditorProps): React.ReactElement {
  const rows = value.length;
  const cols = value[0]?.length ?? 0;

  /** Writes one cell, replacing the row it belongs to. */
  const setCell = useCallback(
    (row: number, col: number, cell: CellValue): void => {
      const next = value.map((current, index) =>
        index === row ? current.map((entry, position) => (position === col ? cell : entry)) : current,
      );
      onChange(next);
    },
    [value, onChange],
  );

  /** Resizes the grid, preserving whatever already fits. */
  const resize = useCallback(
    (newRows: number, newCols: number): void => {
      const clampedRows = Math.min(Math.max(newRows, MIN_DIM), MAX_DIM);
      const clampedCols = Math.min(Math.max(newCols, MIN_DIM), MAX_DIM);

      const next: DraftMatrix = Array.from({ length: clampedRows }, (_, r) =>
        Array.from({ length: clampedCols }, (_, c) => value[r]?.[c] ?? ''),
      );
      onChange(next);
    },
    [value, onChange],
  );

  const clear = useCallback(() => {
    onChange(emptyDraft(rows, cols));
  }, [onChange, rows, cols]);

  const loadExample = useCallback(() => {
    onChange(draftFromMatrix(EXAMPLE_MATRIX));
  }, [onChange]);

  /** Label shown for the current shape, e.g. "3 x 3". */
  const shapeLabel = useMemo(() => `${rows} \u00d7 ${cols}`, [rows, cols]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Matrix</Text>
        <Text style={styles.shape}>{shapeLabel}</Text>
      </View>

      <View style={styles.gridScroll}>
        <View style={styles.grid}>
          {value.map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={styles.row}>
              {row.map((cell, colIndex) => {
                const isError =
                  errorCell?.row === rowIndex && errorCell?.col === colIndex;
                return (
                  <TextInputForCell
                    key={`cell-${rowIndex}-${colIndex}`}
                    testID={`cell-${rowIndex}-${colIndex}${isError ? '-error' : ''}`}
                    value={cell}
                    rowIndex={rowIndex}
                    colIndex={colIndex}
                    isError={isError}
                    disabled={disabled}
                    onChange={(text) => setCell(rowIndex, colIndex, text)}
                  />
                );
              })}
            </View>
          ))}
        </View>
      </View>

      <View style={styles.controls}>
        {/* Each stepper is disabled at whichever end it has reached, so a
            button is never pressed and silently does nothing. */}
        <Stepper
          label="Rows"
          value={rows}
          onDecrease={() => resize(rows - 1, cols)}
          onIncrease={() => resize(rows + 1, cols)}
          disabled={disabled || rows >= MAX_DIM}
          decreaseDisabled={disabled || rows <= MIN_DIM}
        />
        <Stepper
          label="Cols"
          value={cols}
          onDecrease={() => resize(rows, cols - 1)}
          onIncrease={() => resize(rows, cols + 1)}
          disabled={disabled || cols >= MAX_DIM}
          decreaseDisabled={disabled || cols <= MIN_DIM}
        />
      </View>

      <View style={styles.actions}>
        <ActionButton label="Load example" onPress={loadExample} disabled={disabled} />
        <ActionButton label="Clear" onPress={clear} disabled={disabled} />
      </View>
    </View>
  );
}

/** Props of {@link TextInputForCell}. */
interface CellProps {
  /** Identifies the cell in tests; also useful for end-to-end selectors. */
  readonly testID?: string;
  readonly value: string;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly isError: boolean;
  readonly disabled: boolean;
  readonly onChange: (text: string) => void;
}

/**
 * One grid cell.
 *
 * Split out so the numeric keyboard and the error styling live next to the
 * markup that uses them, rather than inline in a nested map.
 */
function TextInputForCell({
  testID,
  value,
  rowIndex,
  colIndex,
  isError,
  disabled,
  onChange,
}: CellProps): React.ReactElement {
  return (
    <TextInput
      testID={testID}
      // A per-cell label is what a screen reader announces when focus lands
      // here, and "Row 2, column 3" is the only useful thing to announce.
      accessibilityLabel={`Row ${rowIndex + 1}, column ${colIndex + 1}`}
      value={value}
      onChangeText={onChange}
      // The numeric keypad is the whole point on a phone: without it the user
      // has to fight an alphabetic keyboard to type "-51".
      keyboardType="numbers-and-punctuation"
      inputMode="numeric"
      editable={!disabled}
      selectTextOnFocus
      placeholder="0"
      placeholderTextColor={colors.textMuted}
      style={[styles.cell, isError ? styles.cellError : null]}
    />
  );
}

/** Props of {@link Stepper}. */
interface StepperProps {
  readonly label: string;
  readonly value: number;
  readonly onDecrease: () => void;
  readonly onIncrease: () => void;
  /** Disables the increase button, e.g. at the maximum dimension. */
  readonly disabled: boolean;
  /** Disables the decrease button, e.g. at the minimum dimension. */
  readonly decreaseDisabled: boolean;
}

/** A labelled pair of buttons that changes a dimension by one. */
function Stepper({
  label,
  value,
  onDecrease,
  onIncrease,
  disabled,
  decreaseDisabled,
}: StepperProps): React.ReactElement {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <ActionButton
          label="-"
          onPress={onDecrease}
          disabled={decreaseDisabled}
          accessibilityLabel={`Fewer ${label.toLowerCase()}`}
          compact
        />
        <Text style={styles.stepperValue}>{value}</Text>
        <ActionButton label="+" onPress={onIncrease} disabled={disabled} accessibilityLabel={`More ${label.toLowerCase()}`} compact />
      </View>
    </View>
  );
}

/** Props of {@link ActionButton}. */
interface ActionButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled: boolean;
  readonly accessibilityLabel?: string;
  readonly compact?: boolean;
}

/** A small, quiet button used inside the editor. */
function ActionButton({
  label,
  onPress,
  disabled,
  accessibilityLabel,
  compact = false,
}: ActionButtonProps): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        compact ? styles.actionCompact : null,
        pressed && !disabled ? styles.actionPressed : null,
        disabled ? styles.actionDisabled : null,
      ]}
    >
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  shape: {
    color: colors.textMuted,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  // The grid scrolls sideways rather than squeezing the cells: below about
  // 64 points a cell is too small to aim at with a finger.
  gridScroll: {},
  grid: { gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  cell: {
    width: 96,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: 16,
    textAlign: 'center',
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  cellError: { borderColor: colors.danger, borderWidth: 2 },
  controls: { flexDirection: 'row', gap: spacing.lg },
  stepper: { gap: spacing.xs, flex: 1 },
  stepperLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepperValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionCompact: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minWidth: 48, alignItems: 'center' },
  actionPressed: { opacity: 0.7 },
  actionDisabled: { opacity: 0.4 },
  actionLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
