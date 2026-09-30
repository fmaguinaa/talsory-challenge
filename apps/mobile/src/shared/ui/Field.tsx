import React from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, radius, spacing } from '../theme';

/** Props of {@link Field}. */
export interface FieldProps extends Omit<TextInputProps, 'style'> {
  readonly label: string;
  /** Shown under the input in the danger colour. */
  readonly error?: string;
  /** Shown under the input when there is no error. */
  readonly hint?: string;
}

/**
 * A labelled text input with room for a hint or an error.
 *
 * The input itself is a plain `TextInput` with no decoration: that is what makes
 * the numeric keypad appear for a matrix cell, which is the whole point of the
 * matrix editor.
 */
export function Field({ label, error, hint, ...inputProps }: FieldProps): React.ReactElement {
  const hasError = typeof error === 'string' && error.length > 0;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, hasError ? styles.inputError : null]}
        {...inputProps}
      />
      {hasError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  label: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 48,
  },
  inputError: { borderColor: colors.danger },
  error: { color: colors.danger, fontSize: 13 },
  hint: { color: colors.textMuted, fontSize: 13 },
});
