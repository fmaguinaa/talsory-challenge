import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { MatrixEditor } from '../MatrixEditor';
import type { DraftMatrix } from '../../services/matrixValidation';

/**
 * Matrix editor tests.
 *
 * The editor is where a mistyped matrix is caught before it costs a round trip,
 * so what is under test is the wiring between the inputs, the draft state and
 * the resize controls -- not the layout.
 */

/** Renders the editor with a draft and captures every change. */
function renderEditor(initial: DraftMatrix, errorCell?: { row: number; col: number }) {
  const changes: DraftMatrix[] = [];
  const view = render(
    <MatrixEditor
      value={initial}
      onChange={(next) => changes.push(next)}
      errorCell={errorCell}
    />,
  );
  return { ...view, changes };
}

/** A 2x2 draft. */
const DRAFT_2X2: DraftMatrix = [
  ['1', '2'],
  ['3', '4'],
];

describe('MatrixEditor', () => {
  it('renders one labelled input per cell', () => {
    renderEditor(DRAFT_2X2);

    for (const [row, col] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      expect(screen.getByLabelText(`Row ${row + 1}, column ${col + 1}`)).toBeTruthy();
    }
  });

  it('uses a numeric keyboard', () => {
    // Without this the user fights an alphabetic keyboard to type -51, which
    // is the single most common value in a QR example.
    renderEditor(DRAFT_2X2);

    const cell = screen.getByLabelText('Row 1, column 1');
    expect(cell.props.keyboardType).toBe('numbers-and-punctuation');
  });

  it('shows the current cell value', () => {
    renderEditor(DRAFT_2X2);

    expect(screen.getByLabelText('Row 1, column 1').props.value).toBe('1');
  });

  it('reports an edited cell', () => {
    const { changes } = renderEditor(DRAFT_2X2);

    fireEvent.changeText(screen.getByLabelText('Row 1, column 1'), '9');

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual([['9', '2'], ['3', '4']]);
  });

  it('reports the shape so the user can confirm what will be sent', () => {
    renderEditor(DRAFT_2X2);
    expect(screen.getByText('2 \u00d7 2')).toBeTruthy();
  });

  it('marks only the cell named by the validation error', () => {
    renderEditor(DRAFT_2X2, { row: 1, col: 0 });

    // The offending cell is the one the message points at, so the user does not
    // have to re-count rows themselves.
    expect(screen.getByTestId('cell-1-0-error')).toBeTruthy();
    expect(screen.queryByTestId('cell-0-0-error')).toBeNull();
  });

  it('adds a row and a column without losing the values that fit', () => {
    const { changes } = renderEditor(DRAFT_2X2);

    fireEvent.press(screen.getByLabelText('More rows'));
    expect(changes[0]).toEqual([['1', '2'], ['3', '4'], ['', '']]);

    fireEvent.press(screen.getByLabelText('More cols'));
    expect(changes[1]).toEqual([['1', '2', ''], ['3', '4', '']]);
  });

  it('removes a row', () => {
    const { changes } = renderEditor(DRAFT_2X2);

    fireEvent.press(screen.getByLabelText('Fewer rows'));

    expect(changes[0]).toEqual([['1', '2']]);
  });

  it('clears every cell while keeping the shape', () => {
    const { changes } = renderEditor(DRAFT_2X2);

    fireEvent.press(screen.getByText('Clear'));

    // Keeping the shape is deliberate: a user clearing a typo usually wants to
    // retype the same dimensions, not start from a 1x1 grid.
    expect(changes[0]).toEqual([['', ''], ['', '']]);
  });

  it('loads the challenge example', () => {
    const { changes } = renderEditor(DRAFT_2X2);

    fireEvent.press(screen.getByText('Load example'));

    expect(changes[0]).toEqual([
      ['12', '-51', '4'],
      ['6', '167', '-68'],
      ['-4', '24', '-41'],
    ]);
  });

  it('does not grow past the editor maximum', () => {
    const large = Array.from({ length: 12 }, () => ['0']);
    renderEditor(large);

    // The server accepts up to 100 dimensions, but a 100x100 grid on a phone
    // is unusable; the editor stops at a size a finger can actually reach.
    expect(screen.getByLabelText('More rows').props.accessibilityState.disabled).toBe(true);
  });

  it('does not shrink below 1x1', () => {
    renderEditor([['1']]);

    expect(screen.getByLabelText('Fewer rows').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText('Fewer cols').props.accessibilityState.disabled).toBe(true);
  });

  it('disables every control while a request is in flight', () => {
    render(
      <MatrixEditor value={DRAFT_2X2} onChange={() => undefined} disabled />,
    );

    // A user editing the matrix while it is being sent would be looking at a
    // result for something other than what they sent.
    expect(screen.getByLabelText('Row 1, column 1').props.editable).toBe(false);
    expect(screen.getByLabelText('Clear').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText('Load example').props.accessibilityState.disabled).toBe(true);
  });
});
