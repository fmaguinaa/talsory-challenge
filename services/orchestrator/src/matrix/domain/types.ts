/**
 * Domain types for the analysis workflow.
 *
 * These mirror contracts/orchestrator.yaml. They are declared by hand rather
 * than generated so the build has no code-generation step, but the contract test
 * in test/contract.test.ts keeps them from drifting away from the spec.
 */

/** A rectangular matrix of finite numbers. */
export type Matrix = number[][];

/** A matrix together with the label stats-api echoes back. */
export interface LabeledMatrix {
  readonly id: string;
  readonly data: Matrix;
}

/** The QR factorization returned by qr-api. */
export interface QrFactorization {
  readonly q: Matrix;
  readonly r: Matrix;
}

/** Statistics over one matrix, as returned by stats-api. */
export interface MatrixStats {
  readonly id: string;
  readonly max: number;
  readonly min: number;
  readonly average: number;
  readonly sum: number;
  readonly isDiagonal: boolean;
}

/** Statistics over every matrix. */
export interface GlobalStats {
  readonly max: number;
  readonly min: number;
  readonly average: number;
  readonly sum: number;
  readonly anyDiagonal: boolean;
}

/** The statistics block returned by stats-api. */
export interface StatsResult {
  readonly global: GlobalStats;
  readonly perMatrix: readonly MatrixStats[];
}

/** Shape of the input matrix, reported back to the client. */
export interface InputShape {
  readonly rows: number;
  readonly cols: number;
}

/** The aggregated response the orchestrator returns. */
export interface AnalyzeResponse {
  readonly requestId: string;
  readonly input: InputShape;
  readonly qr: QrFactorization;
  readonly stats: StatsResult;
}

/** The token response returned by auth-service, proxied verbatim. */
export interface LoginResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}
