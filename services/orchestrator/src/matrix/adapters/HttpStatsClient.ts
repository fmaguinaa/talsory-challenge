import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';

import { CONFIG_TOKEN, type OrchestratorConfig } from '../../config/config';
import {
  buildRequestConfig,
  callWithRetry,
  toWorkflowError,
  downstreamHeaders,
} from '../../common/downstream';
import type { StatsClient } from '../application/AnalyzeWorkflow';
import type { LabeledMatrix, StatsResult } from '../domain/types';

/** Injection token for the stats client. */
export const STATS_CLIENT = Symbol('STATS_CLIENT');

/**
 * HTTP adapter for stats-api.
 *
 * Like the QR adapter, it forwards the caller's token so stats-api authorizes
 * independently.
 */
@Injectable()
export class HttpStatsClient implements StatsClient {
  // Explicit tokens rather than inferred ones: see HttpAuthClient for why.
  constructor(
    @Inject(HttpService) private readonly http: HttpService,
    @Inject(CONFIG_TOKEN) private readonly config: OrchestratorConfig,
  ) {}

  /**
   * Requests statistics over a list of labeled matrices.
   *
   * @throws WorkflowError carrying the classified cause
   */
  async compute(
    matrices: readonly LabeledMatrix[],
    token: string,
    requestId: string,
  ): Promise<StatsResult> {
    const options = this.config.statsApi;
    const config = buildRequestConfig(options);

    try {
      // Statistics are a pure function of their input, so replaying is safe.
      return await callWithRetry<StatsResult>(
        this.http,
        config,
        (client) =>
          client
            .post<StatsResult>(
              '/api/v1/stats',
              { matrices },
              { ...config, headers: downstreamHeaders(token, requestId) },
            )
            .then((response) => response.data),
        options,
        'statistics',
      );
    } catch (error) {
      throw toWorkflowError(error, 'statistics');
    }
  }
}
