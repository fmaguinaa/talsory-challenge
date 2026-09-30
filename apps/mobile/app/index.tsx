import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import LoginScreen from '../src/features/auth/components/LoginScreen';
import AnalyzeScreen from '../src/features/matrix/components/AnalyzeScreen';
import { useAuth } from '../src/features/auth/AuthProvider';
import { colors } from '../src/shared/theme';

/**
 * Decides which screen to show.
 *
 * Three states, not two: while the stored token is still being read, neither
 * screen is correct, and rendering one of them first would flash the login form
 * at a user who is already signed in.
 */
export default function Index(): React.ReactElement {
  const { isAuthenticated, isRestoring } = useAuth();

  if (isRestoring) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (isAuthenticated) {
    return <AnalyzeScreen />;
  }

  return <LoginScreen />;
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
