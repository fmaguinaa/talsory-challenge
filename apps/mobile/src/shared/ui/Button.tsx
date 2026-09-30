import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { colors, radius, spacing } from '../theme';

/** Props of {@link Button}. */
export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  /** Shows a spinner and blocks presses. */
  readonly busy?: boolean;
  /** Renders the quieter, non-primary variant. */
  readonly secondary?: boolean;
  /** Renders the destructive variant. */
  readonly destructive?: boolean;
  /** Disables interaction and dims the button. */
  readonly disabled?: boolean;
  readonly style?: ViewStyle;
  /** Accessibility label, when the visible text is not descriptive enough. */
  readonly accessibilityLabel?: string;
}

/**
 * The one button in the app.
 *
 * `busy` and `disabled` are separate because they mean different things: a busy
 * button is working and must not be pressed again, while a disabled one is
 * unavailable. Both dim the button, and both set `accessibilityState` so a screen
 * reader says so too.
 */
export function Button({
  label,
  onPress,
  busy = false,
  secondary = false,
  destructive = false,
  disabled = false,
  style,
  accessibilityLabel,
}: ButtonProps): React.ReactElement {
  const isInert = disabled || busy;

  const background = destructive
    ? colors.danger
    : secondary
      ? colors.surfaceAlt
      : colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isInert, busy }}
      onPress={onPress}
      disabled={isInert}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: background },
        // Pressed feedback is opacity rather than a colour change so the
        // disabled and pressed states stay visually distinct.
        pressed && !isInert ? styles.pressed : null,
        isInert ? styles.inert : null,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={colors.primaryText} /> : null}
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    minHeight: 48,
  },
  pressed: { opacity: 0.8 },
  inert: { opacity: 0.45 },
  label: { color: colors.primaryText, fontSize: 16, fontWeight: '600' },
});
