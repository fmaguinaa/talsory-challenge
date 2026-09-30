import {
  EXAMPLE_MATRIX,
  draftFromMatrix,
  emptyDraft,
  formatNumber,
  looksDiagonal,
  validateDraft,
  type DraftMatrix,
} from '../matrixValidation';

/**
 * Matrix validation tests.
 *
 * The rules here mirror the server's. What is being protected is not the
 * arithmetic but the *messages*: a user who types a ragged matrix has to be told
 * which row, because "invalid input" sends them looking in the wrong place.
 */

/** Builds a draft from literal rows of text. */
function draft(...rows: string[][]): DraftMatrix {
  return rows;
}

describe('validateDraft', () => {
  it('accepts a rectangular matrix of numbers', () => {
    const result = validateDraft(draft(['1', '2'], ['3', '4']));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matrix).toEqual([[1, 2], [3, 4]]);
    }
  });

  it('accepts a single element matrix', () => {
    const result = validateDraft(draft(['5']));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matrix).toEqual([[5]]);
  });

  it('accepts negative, decimal and exponent notation', () => {
    const result = validateDraft(draft(['-1.5', '+2', '.5', '1e3']));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matrix).toEqual([[-1.5, 2, 0.5, 1000]]);
  });

  it('accepts surrounding whitespace', () => {
    // A phone keyboard adds spaces, and rejecting " 2 " would be pedantic.
    const result = validateDraft(draft([' 1 ', '2 ']));
    expect(result.ok).toBe(true);
  });

  it('rejects an empty draft', () => {
    const result = validateDraft([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('at least one row');
  });

  it('rejects a draft whose first row is empty', () => {
    const result = validateDraft([[]]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('at least one number');
  });

  it('rejects a ragged matrix and names the row', () => {
    const result = validateDraft(draft(['1', '2', '3'], ['4', '5']));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // One-based in the message, because that is how a person counts rows.
      expect(result.error.message).toBe('Row 2 has 2 values; every row must have 3.');
    }
  });

  it('names the offending cell for an empty entry', () => {
    const result = validateDraft(draft(['1', ''], ['3', '4']));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Row 1, column 2 is empty.');
      expect(result.error.cell).toEqual({ row: 0, col: 1 });
    }
  });

  it('names the offending cell for a non-numeric entry', () => {
    const result = validateDraft(draft(['1', 'abc']));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Row 1, column 2 "abc" is not a number.');
      expect(result.error.cell).toEqual({ row: 0, col: 1 });
    }
  });

  it.each([
    ['Infinity', 'out of range'],
    ['-Infinity', 'out of range'],
    ['NaN', 'not a number'],
  ])('rejects %s', (text) => {
    const result = validateDraft(draft([text]));
    expect(result.ok).toBe(false);
  });

  it('accepts a trailing dot, which people type on a numeric keypad', () => {
    // "1." is a normal way to enter one, and Number() reads it as 1. Rejecting
    // it would be pedantry that trains users to work around the app.
    const result = validateDraft(draft(['1.']));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matrix).toEqual([[1]]);
  });

  it.each([
    // Number('0x10') is 16 and Number('1,5') is NaN; neither is what someone
    // typing matrix data means, so the syntax is checked before converting.
    ['a hex literal', '0x10'],
    ['a bare dot', '.'],
    ['a trailing sign', '1-'],
    ['a double sign', '--1'],
    ['a comma decimal', '1,5'],
    ['a leading word', 'abc1'],
    ['an embedded space', '1 2'],
  ])('rejects %s, which Number() would otherwise accept or coerce', (_label, text) => {
    const result = validateDraft(draft([text]));
    expect(result.ok).toBe(false);
  });

  it('rejects more rows than the limit', () => {
    const rows = Array.from({ length: 5 }, () => ['1']);
    const result = validateDraft(rows, 4);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('5 rows');
  });

  it('rejects more columns than the limit', () => {
    const result = validateDraft(draft(['1', '2', '3']), 2);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('3 columns');
  });

  it('accepts a matrix exactly at the limit', () => {
    expect(validateDraft(draft(['1', '2']), 2).ok).toBe(true);
  });

  it('accepts the challenge example', () => {
    expect(validateDraft(draftFromMatrix(EXAMPLE_MATRIX)).ok).toBe(true);
  });

  it('reports the first problem, not all of them', () => {
    // One message at a time: three stacked errors is noise, and fixing them in
    // order is what the user would do anyway.
    const result = validateDraft(draft(['', 'x'], ['1']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cell).toEqual({ row: 0, col: 0 });
  });
});

describe('emptyDraft', () => {
  it('produces a blank grid of the requested shape', () => {
    expect(emptyDraft(2, 3)).toEqual([
      ['', '', ''],
      ['', '', ''],
    ]);
  });

  it('produces a 1x1 draft', () => {
    expect(emptyDraft(1, 1)).toEqual([['']]);
  });
});

describe('draftFromMatrix', () => {
  it('round-trips a matrix back to text', () => {
    expect(validateDraft(draftFromMatrix(EXAMPLE_MATRIX))).toMatchObject({
      ok: true,
      matrix: EXAMPLE_MATRIX,
    });
  });

  it('renders numbers without losing precision', () => {
    expect(draftFromMatrix([[0.1]])).toEqual([['0.1']]);
  });
});

describe('formatNumber', () => {
  it('renders an integer without a decimal part', () => {
    expect(formatNumber(14)).toBe('14');
  });

  it('renders a negative integer', () => {
    expect(formatNumber(-175)).toBe('-175');
  });

  it('truncates a long float to four decimals', () => {
    expect(formatNumber(0.123456789)).toBe('0.1235');
  });

  it('renders zero as "0" rather than "-0"', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
  });

  it('honours the requested precision', () => {
    expect(formatNumber(1.23456789, 2)).toBe('1.23');
    expect(formatNumber(1.23456789, 6)).toBe('1.234568');
  });

  it.each([
    [1e-7],
    [-1e-7],
    [1e9],
  ])('uses exponential notation for %s, where fixed notation says nothing', (value) => {
    // "0.0000" for 1e-7 conveys nothing; "1.0000e-7" conveys everything.
    expect(formatNumber(value)).toMatch(/e[+-]/);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    'renders the non-finite value %s verbatim',
    (value) => {
      // A silent fallback would hide a real bug: no matrix entry can be
      // non-finite, so seeing one displayed means something is wrong upstream.
      expect(formatNumber(value)).toBe(String(value));
    },
  );
});

describe('looksDiagonal', () => {
  it('recognises an exact diagonal matrix', () => {
    expect(
      looksDiagonal([
        [1, 0],
        [0, 2],
      ]),
    ).toBe(true);
  });

  it('tolerates floating-point noise, as the server does', () => {
    // This is why the epsilon exists (ADR-004): a QR output that is diagonal in
    // exact arithmetic arrives carrying rounding noise.
    expect(
      looksDiagonal([
        [14, 1e-16],
        [1e-16, 21],
      ]),
    ).toBe(true);
  });

  it('rejects a non-square matrix even when its off-diagonal entries are zero', () => {
    // Same shape as a diagonal matrix but not square: the definition requires
    // squareness, so zero entries elsewhere do not rescue it.
    expect(
      looksDiagonal([
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ).toBe(false);
  });

  it('rejects noise larger than the epsilon', () => {
    expect(
      looksDiagonal([
        [1, 1e-8],
        [0, 1],
      ]),
    ).toBe(false);
  });

  it('treats a 1x1 matrix as diagonal', () => {
    expect(looksDiagonal([[42]])).toBe(true);
  });

  it('rejects an empty matrix', () => {
    expect(looksDiagonal([])).toBe(false);
    expect(looksDiagonal([[]])).toBe(false);
  });
});
