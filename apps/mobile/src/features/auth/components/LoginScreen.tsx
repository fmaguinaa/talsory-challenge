import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../matrix/services/apiClient';
import { useAuth } from '../AuthProvider';
import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { Screen } from '../../../shared/ui/Screen';
import { colors, spacing } from '../../../shared/theme';

/**
 * Login screen.
 *
 * The only screen that knows about credentials. It never stores them: the token
 * that comes back goes straight into the platform store, and the password is
 * dropped as soon as the request resolves.
 */
export default function LoginScreen(): React.ReactElement {
  const { login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const canSubmit = useMemo(
    () => username.trim().length > 0 && password.length > 0 && !busy,
    [username, password, busy],
  );

  const onSubmit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    try {
      await login(username, password);
      // The password is cleared immediately: it has served its purpose, and
      // leaving it in component state keeps it in memory for no reason.
      setPassword('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        // A wrong password comes back as 401 with a generic message, and the
        // server deliberately does not say whether the username exists.
        setError(caught.detail ?? caught.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }, [login, username, password]);

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>QR Analyzer</Text>
        <Text style={styles.subtitle}>
          Sign in to factorize a matrix and inspect its QR decomposition.
        </Text>
      </View>

      <View style={styles.form}>
        <Field
          label="Username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          // Keeps iOS from autofilling the Apple ID password into the API
          // password field, which would be both confusing and wrong.
          textContentType="username"
          returnKeyType="next"
          editable={!busy}
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => {
            if (canSubmit) void onSubmit();
          }}
          editable={!busy}
          error={error}
        />
        <Button
          label="Sign in"
          onPress={() => void onSubmit()}
          busy={busy}
          disabled={!canSubmit}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.sm, marginTop: spacing.xxl },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  form: { gap: spacing.lg },
});
