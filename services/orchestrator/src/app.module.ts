import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { MatrixModule } from './matrix/matrix.module';

/**
 * Root module.
 *
 * The throttler lives here rather than in the feature modules because it is the
 * orchestrator's own defence: it is the only service reachable from the
 * internet, so this is the only place a rate limit can be applied to anonymous
 * traffic before it reaches a downstream.
 */
@Module({
  imports: [
    // CommonModule is @Global and provides the validated configuration.
    CommonModule,
    ThrottlerModule.forRoot([
      {
        // The values are read from the environment at bootstrap. Nest's module
        // factory runs before the config provider, so the values are read
        // directly here and validated again by loadConfig on first use.
        ttl: readNumber('THROTTLE_TTL_MS', 60_000),
        limit: readNumber('THROTTLE_LIMIT', 120),
      },
    ]),
    MatrixModule,
    AuthModule,
  ],
})
export class AppModule {}

/**
 * Reads a positive integer from the environment.
 *
 * Duplicated here because Nest's `forRoot` runs at module-definition time, before
 * the injected configuration exists. The same key is validated properly by
 * `loadConfig`, so a bad value still fails the boot with a message naming it.
 */
function readNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
