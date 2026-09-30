import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '../src/features/auth/AuthProvider';
import { colors } from '../src/shared/theme';

/**
 * Root layout.
 *
 * It does exactly two things: it provides the safe-area context every screen
 * relies on, and it provides the session. Routing between login and analyze is
 * decided by the index screen, which is where the "am I signed in?" question
 * belongs -- doing it in a layout effect would render the wrong screen once
 * before correcting itself, which is a visible flash on every cold start.
 */
export default function RootLayout(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
