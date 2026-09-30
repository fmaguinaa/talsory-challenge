import { Global, Module } from '@nestjs/common';

import { CONFIG_TOKEN, loadConfig, type OrchestratorConfig } from '../config/config';
import { ProblemDetailsFilter } from './ProblemDetailsFilter';

/**
 * Common module: configuration and the global exception filter.
 *
 * Global because the configuration is needed by every feature module and
 * passing it down explicitly would add a provider to every constructor for no
 * benefit. The filter is registered here so that it applies to every route
 * without each controller having to remember.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG_TOKEN,
      // The factory runs once at startup and throws on invalid configuration,
      // which aborts the boot with a message naming the variable.
      useFactory: (): OrchestratorConfig => loadConfig(),
    },
    ProblemDetailsFilter,
  ],
  exports: [CONFIG_TOKEN, ProblemDetailsFilter],
})
export class CommonModule {}
