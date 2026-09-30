/**
 * Colours and spacing.
 *
 * A single source of truth so a screen never invents a shade: inconsistent
 * greys across three screens is the kind of thing nobody notices in review and
 * everybody notices when they use the app.
 */
export const colors = {
  /** Page background, dark enough that the accent reads clearly. */
  background: '#0B1220',
  /** Raised surfaces: cards, inputs, the matrix grid. */
  surface: '#141C2B',
  surfaceAlt: '#1C2637',
  border: '#2A3547',
  /** Primary text. */
  text: '#E8EDF5',
  /** Secondary text: labels, hints. */
  textMuted: '#93A1B8',
  /** Accent, used for primary actions. */
  primary: '#4C8DFF',
  primaryText: '#FFFFFF',
  danger: '#FF6B6B',
  success: '#4ADE80',
  warning: '#FBBF24',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;
