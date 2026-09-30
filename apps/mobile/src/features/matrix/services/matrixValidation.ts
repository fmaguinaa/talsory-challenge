import type { Matrix } from './apiClient';

/**
 * Client-side matrix validation.
 *
 * These rules mirror `qr-api` exactly. That duplication is intentional: the
 * server must never be trusted to be the only thing standing between a typo and
 * a round trip, and a user who types a ragged matrix should learn about it
 * before the spinner appears, not from a 422 ten seconds later.
 *
 * The server still validates everything it receives. A check here is a courtesy
 * and a latency saving, never a security boundary.
 */

/** Mirrors `MAX_MATRIX_DIM` on the backends. */
export const MAX_MATRIX_DIM = 100;

/** Why a matrix cannot be sent. */
export interface MatrixValidationError {
  /** The message shown under the editor. */
  readonly message: string;
  /** The offending cell, when the problem is in one. */
  readonly cell?: { readonly row: number; readonly col: number };
}

/** The result of validating a draft matrix. */
export type MatrixValidationResult =
  | { readonly ok: true; readonly matrix: Matrix }
  | { readonly ok: false; readonly error: MatrixValidationError };

/** A single cell as the editor holds it: the raw text the user typed. */
export type CellValue = string;

/** A draft matrix: `rows` of `cols` text cells. */
export type DraftMatrix = CellValue[][];

/** The example matrix from the challenge, used by "Load example". */
export const EXAMPLE_MATRIX: Matrix = [
  [12, -51, 4],
  [6, 167, -68],
  [-4, 24, -41],
];

/** Parses one cell, returning a reason when it is not a usable number. */
function parseCell(raw: CellValue): { ok: true; value: number } | { ok: false; reason: string } {
  const text = raw.trim();

  if (text.length === 0) return { ok: false, reason: 'is empty' };
  // Number() accepts '', 'Infinity' and whitespace-only input, all of which are
  // rejected here first, and also hex literals like '0x10', which are not what
  // someone entering matrix data means.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) {
    return { ok: false, reason: `"${text}" is not a number` };
  }

  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `"${text}" is out of range` };
  }
  return { ok: true, value };
}

/**
 * Validates a draft matrix and, when it is sound, returns the numeric matrix.
 *
 * @param draft the editor contents
 * @param maxDim the dimension limit to enforce
 */
export function validateDraft(draft: DraftMatrix, maxDim: number = MAX_MATRIX_DIM): MatrixValidationResult {
  if (draft.length === 0) {
    return { ok: false, error: { message: 'The matrix must have at least one row.' } };
  }

  const cols = draft[0]?.length ?? 0;
  if (cols === 0) {
    return { ok: false, error: { message: 'Each row must have at least one number.' } };
  }

  if (draft.length > maxDim) {
    return {
      ok: false,
      error: { message: `The matrix has ${draft.length} rows; the maximum is ${maxDim}.` },
    };
  }
  if (cols > maxDim) {
    return {
      ok: false,
      error: { message: `The matrix has ${cols} columns; the maximum is ${maxDim}.` },
    };
  }

  const matrix: Matrix = [];
  for (let i = 0; i < draft.length; i += 1) {
    const row = draft[i] ?? [];
    if (row.length !== cols) {
      return {
        ok: false,
        error: { message: `Row ${i + 1} has ${row.length} values; every row must have ${cols}.` },
      };
    }

    const parsedRow: number[] = [];
    for (let j = 0; j < row.length; j += 1) {
      const parsed = parseCell(row[j] ?? '');
      if (!parsed.ok) {
        return {
          ok: false,
          error: {
            message: `Row ${i + 1}, column ${j + 1} ${parsed.reason}.`,
            cell: { row: i, col: j },
          },
        };
      }
      parsedRow.push(parsed.value);
    }
    matrix.push(parsedRow);
  }

  return { ok: true, matrix };
}

/** Builds an empty draft of the given shape, every cell blank. */
export function emptyDraft(rows: number, cols: number): DraftMatrix {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
}

/** Builds a draft from a numeric matrix. */
export function draftFromMatrix(matrix: Matrix): DraftMatrix {
  return matrix.map((row) => row.map((value) => String(value)));
}

/**
 * Formats a number for display.
 *
 * Full float64 output is unreadable and the user asked for a QR decomposition,
 * not for a proof. Four decimals is enough to see the structure; the exact value
 * is one tap away, which matters because a user checking Q * R = A needs the
 * digits that a 4-decimal display would hide.
 */
export function formatNumber(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';

  const magnitude = Math.abs(value);
  // Very large or very small values lose everything to an exponent-free fixed
  // rendering, so they are shown in exponential form instead of "0.0000".
  if (magnitude >= 1e6 || magnitude < 1e-4) return value.toExponential(4);

  const rounded = value.toFixed(decimals);
  // Drop a trailing ".0000" so an exact integer reads as an integer.
  return rounded.replace(/\.?0+$/, '') || '0';
}

/** Whether a matrix is square and its off-diagonal entries are near zero. */
export function looksDiagonal(matrix: Matrix, epsilon = 1e-9): boolean {
  if (matrix.length === 0) return false;
  const cols = matrix[0]?.length ?? 0;
  if (cols === 0 || matrix.length !== cols) return false;

  return matrix.every((row, i) =>
    row.every((value, j) => i === j || Math.abs(value) <= epsilon),
  );
}
