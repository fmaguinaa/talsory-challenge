import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { CONFIG_TOKEN, type OrchestratorConfig } from '../config/config';

import { AnalyzeWorkflow } from './application/AnalyzeWorkflow';
import { AUTH_CLIENT, HttpAuthClient } from './adapters/HttpAuthClient';
import { QR_CLIENT, HttpQrClient } from './adapters/HttpQrClient';
import { STATS_CLIENT, HttpStatsClient } from './adapters/HttpStatsClient';
import { BearerAuthGuard, HealthController, MatrixController } from './MatrixController';

/**
 * Matrix module: the adapters, the workflow and the public routes.
 *
 * Each client is bound to its own injection token, so a test can replace any one
 * of the three without touching the others. The concrete class is also provided
 * under that token, which is what makes the token indirection worth having
 * rather than ceremony.
 */
@Module({
  // The bare HttpModule is imported, not HttpModule.register(): the registered
  // dynamic module overrides the axios instance but does not re-export
  // HttpService, which then fails to resolve. Per-service settings (base URL,
  // service key, retry policy) come from the configuration on each call, so the
  // shared instance needs no options of its own.
  imports: [HttpModule],
  controllers: [MatrixController, HealthController],
  providers: [
    HttpAuthClient,
    HttpQrClient,
    HttpStatsClient,
    { provide: AUTH_CLIENT, useExisting: HttpAuthClient },
    { provide: QR_CLIENT, useExisting: HttpQrClient },
    { provide: STATS_CLIENT, useExisting: HttpStatsClient },
    BearerAuthGuard,
    {
      // The workflow stays a plain class with no Nest decorators, so its tests
      // run without a container. This factory is the only place its
      // construction happens.
      provide: AnalyzeWorkflow,
      useFactory: (
        auth: HttpAuthClient,
        qr: HttpQrClient,
        stats: HttpStatsClient,
        config: OrchestratorConfig,
      ) =>
        new AnalyzeWorkflow({
          auth,
          qr,
          stats,
          limits: { maxMatrixDim: config.maxMatrixDim },
        }),
      inject: [HttpAuthClient, HttpQrClient, HttpStatsClient, CONFIG_TOKEN],
    },
  ],
  exports: [AUTH_CLIENT, AnalyzeWorkflow],
})
export class MatrixModule {}
