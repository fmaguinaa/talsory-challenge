import React from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme';

/** Props of {@link Screen}. */
export interface ScreenProps {
  readonly children: React.ReactNode;
  /** Renders inside a vertical scroll view. Off for screens that scroll themselves. */
  readonly scroll?: boolean;
  /** Extra style on the safe-area container. */
  readonly style?: ViewStyle;
}

/**
 * The page frame: safe-area insets, background colour and optional scrolling.
 *
 * Every screen uses it, so the padding and the safe-area handling are decided
 * once instead of per screen.
 */
export function Screen({ children, scroll = true, style }: ScreenProps): React.ReactElement {
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      // The matrix grid can be wide; letting it scroll horizontally is handled
      // by the grid itself, and this stops the page from bouncing sideways.
      style={styles.scroll}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.content}>{children}</View>
  );

  return (
    <SafeAreaView style={[styles.safe, style]} edges={['top', 'left', 'right']}>
      {content}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg, flexGrow: 1 },
});
