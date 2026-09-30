import { ApiProperty } from '@nestjs/swagger';
import { IsArray } from 'class-validator';

/**
 * Body of `POST /api/v1/matrix/analyze`.
 *
 * Only the envelope is validated here. The matrix contents are checked by the
 * workflow, which can report the exact row and column at fault; a
 * class-validator constraint could only say "each item must be a number", which
 * is less useful and would have to be re-implemented per nested level.
 */
export class AnalyzeDto {
  /** The matrix to analyze. */
  @ApiProperty({
    description:
      'Rectangular array of finite numbers, with the same limits as qr-api (no dimension above MAX_MATRIX_DIM).',
    example: [
      [12, -51, 4],
      [6, 167, -68],
      [-4, 24, -41],
    ],
    type: 'array',
    items: { type: 'array', items: { type: 'number' } },
  })
  @IsArray()
  matrix!: unknown;
}
