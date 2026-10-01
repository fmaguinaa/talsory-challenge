import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../../shared/ui/Button';
import { Screen } from '../../../shared/ui/Screen';
import { colors, radius, spacing } from '../../../shared/theme';
import { MatrixEditor } from './MatrixEditor';
import { MatrixView } from './MatrixView';
import { StatsPanel } from './StatsPanel';
import { ApiError, analyze, type AnalyzeResponse } from '../services/apiClient';
import {
  emptyDraft,
  validateDraft,
  type DraftMatrix,
  type MatrixValidationError,
} from '../services/matrixValidation';

/**
 * The analyze screen: edit a matrix, send it, read the result.
 *
 * It is the only screen that talks to the API, and it holds no state that
 * outlives it. Validation happens before the request rather than being left to
 * the server, because a message naming the offending cell is far more useful
 * than a 422 that arrives a second later.
 */
export default function AnalyzeScreen(): React.ReactElement {
  const { accessToken, logout } = useAuth();

  const [draft, setDraft] = useState<DraftMatrix>(() => emptyDraft(3, 3));
  const [validationError, setValidationError] = useState<MatrixValidationError | undefined>();
  const [requestError, setRequestError] = useState<ApiError | undefined>();
  const [result, setResult] = useState<AnalyzeResponse | undefined>();
  const [busy, setBusy] = useState(false);

  /**
   * Runs the analysis.
   *
   * A 401 is handled by signing out rather than by showing an error: the token
   * is gone, and leaving the user on a screen whose every action will fail is
   * worse than returning them to the login screen.
   */
  const onAnalyze = useCallback(async (): Promise<void> => {
    setRequestError(undefined);
    setValidationError(undefined);

    const validated = validateDraft(draft);
    if (!validated.ok) {
      setValidationError(validated.error);
      return;
    }

    setBusy(true);
    try {
      const response = await analyze(validated.matrix, { token: accessToken ?? undefined });
      setResult(response);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.requiresLogin) {
          await logout();
          return;
        }
        setRequestError(caught);
      } else {
        setRequestError(new ApiError('unexpected', 'Something went wrong. Please try again.'));
      }
    } finally {
      setBusy(false);
    }
  }, [accessToken, draft, logout]);

  /** Whether the Analyze button should be enabled. */
  const canAnalyze = useMemo(() => !busy, [busy]);

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Analyze a matrix</Text>
          <Text style={styles.subtitle}>
            Factorizes the matrix and reports the statistics of both factors.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void logout()}
          style={styles.signOut}
        >
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
      </View>

      <MatrixEditor
        value={draft}
        onChange={setDraft}
        errorCell={validationError?.cell}
        disabled={busy}
      />

      {validationError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {validationError.message}
        </Text>
      ) : null}

      {requestError ? (
        <View style={styles.requestErrorBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {requestError.message}
          </Text>
          {requestError.detail ? (
            <Text style={styles.requestErrorDetail}>{requestError.detail}</Text>
          ) : null}
          {requestError.requestId ? (
            <Text style={styles.requestId}>requestId: {requestError.requestId}</Text>
          ) : null}
        </View>
      ) : null}

      <Button
        label="Analyze"
        onPress={() => void onAnalyze()}
        busy={busy}
        disabled={!canAnalyze}
      />

      {result ? <Results result={result} /> : null}
    </Screen>
  );
}

/** Props of {@link Results}. */
interface ResultsProps {
  readonly result: AnalyzeResponse;
}

/**
 * The result block.
 *
 * The correlation id is shown in a collapsible "details" section: it is needed
 * when reporting a problem and is noise the rest of the time.
 */
function Results({ result }: ResultsProps): React.ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const statsById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const entry of result.stats.perMatrix) {
      map.set(entry.id, entry.isDiagonal);
    }
    return map;
  }, [result.stats.perMatrix]);

  return (
    <View style={styles.results}>
      <Text style={styles.resultsTitle}>Result</Text>

      <MatrixView label="Q" matrix={result.qr.q} isDiagonal={statsById.get('Q') ?? false} />
      <MatrixView label="R" matrix={result.qr.r} isDiagonal={statsById.get('R') ?? false} />

      <StatsPanel stats={result.stats.global} />

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        accessibilityLabel="Details"
        onPress={() => setDetailsOpen((open) => !open)}
        style={styles.detailsToggle}
      >
        <Text style={styles.detailsToggleLabel}>
          {detailsOpen ? 'Hide details' : 'Show details'}
        </Text>
      </Pressable>

      {detailsOpen ? (
        <View style={styles.details}>
          <DetailRow label="Input shape" value={`${result.input.rows} x ${result.input.cols}`} />
          <DetailRow label="requestId" value={result.requestId} />
        </View>
      ) : null}
    </View>
  );
}

/** Props of {@link DetailRow}. */
interface DetailRowProps {
  readonly label: string;
  readonly value: string;
}

/** One label/value line inside the details section. */
function DetailRow({ label, value }: DetailRowProps): React.ReactElement {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  headerText: { flex: 1, gap: spacing.xs },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  signOut: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  signOutLabel: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
  requestErrorBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.xs,
  },
  requestErrorDetail: { color: colors.text, fontSize: 14 },
  // The correlation id is monospaced: it is an identifier to be copied, and
  // proportional digits make an exact copy harder to eyeball.
  requestId: { color: colors.textMuted, fontSize: 12, fontFamily: 'monospace' },
  results: { gap: spacing.md, marginTop: spacing.lg },
  resultsTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  detailsToggle: { alignSelf: 'flex-start', paddingVertical: spacing.sm },
  detailsToggleLabel: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  details: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: spacing.sm },
  detailRow: { gap: 2 },
  detailLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  detailValue: { color: colors.text, fontSize: 13, fontFamily: 'monospace' },
});
