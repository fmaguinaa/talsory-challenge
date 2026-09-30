import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';

import { CONFIG_TOKEN, type OrchestratorConfig } from '../../config/config';
import {
  buildRequestConfig,
  callWithRetry,
  toWorkflowError,
  downstreamHeaders,
} from '../../common/downstream';
import type { QrClient } from '../application/AnalyzeWorkflow';
import type { Matrix, QrFactorization } from '../domain/types';

/** Injection token for the QR client. */
export const QR_CLIENT = Symbol('QR_CLIENT');

/**
 * HTTP adapter for qr-api.
 *
 * The caller's token is forwarded verbatim. qr-api validates it against
 * auth-service itself rather than trusting that the orchestrator already did, so
 * a caller's revoked token is caught even if the orchestrator's cache said
 * otherwise (ADR-005).
 */
@Injectable()
export class HttpQrClient implements QrClient {
  // Explicit tokens rather than inferred ones: see HttpAuthClient for why.
  constructor(
    @Inject(HttpService) private readonly http: HttpService,
    @Inject(CONFIG_TOKEN) private readonly config: OrchestratorConfig,
  ) {}

  /**
   * Requests the QR factorization of a matrix.
   *
   * @throws WorkflowError carrying the classified cause
   */
  async factorize(
    matrix: Matrix,
    token: string,
    requestId: string,
  ): Promise<QrFactorization> {
    const options = this.config.qrApi;
    const config = buildRequestConfig(options);

    try {
      // Retries are safe here: QR factorization is a pure function of its input,
      // so a replayed call has no side effect.
      return await callWithRetry<QrFactorization>(
        this.http,
        config,
        (client) =>
          client.post<QrFactorization>(
            '/api/v1/qr/factorize',
            { matrix },
            { ...config, headers: downstreamHeaders(token, requestId) },
          ).then((response) => response.data),
        options,
        'QR',
      );
    } catch (error) {
      throw toWorkflowError(error, 'QR');
    }
  }
}
