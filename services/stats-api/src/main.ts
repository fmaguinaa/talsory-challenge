import { createServer } from 'node:http';

import pino from 'pino';

import { ComputeStatsUseCase } from './application/ComputeStatsUseCase';
import { HttpTokenValidator } from './adapters/authclient/HttpTokenValidator';
import { buildApp } from './adapters/http/router';
import { loadConfig } from './config';

/**
 * Composition root for stats-api.
 *
 * Every dependency is constructed here and injected downwards. Nothing below
 * this file reads `process.env` or opens a socket, which is what lets the
 * application layer be tested with plain objects.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Structured JSON on stdout, which is what a container runtime collects.
  // Pretty-printing is an explicit opt-in because pino-pretty is a
  // devDependency and is deliberately absent from the runtime image; inferring
  // it from the log level would make a debug run of a production image fail to
  // boot for no good reason.
  const pretty = process.env.LOG_PRETTY === 'true';
  const logger = pino({
    level: config.logLevel,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });

  const validator = new HttpTokenValidator({
    baseUrl: config.authServiceUrl,
    serviceKey: config.authServiceKey,
    timeoutMs: config.authValidateTimeoutMs,
    cacheTtlSeconds: config.authCacheTtlSeconds,
  });

  const useCase = new ComputeStatsUseCase({
    validator,
    limits: {
      maxMatrices: config.maxMatrices,
      maxTotalElements: config.maxTotalElements,
      maxMatrixDim: config.maxMatrixDim,
    },
    epsilon: config.diagonalEpsilon,
  });

  const app = buildApp({
    useCase,
    logger,
    maxBodyBytes: config.maxBodyBytes,
    limits: {
      maxMatrices: config.maxMatrices,
      maxTotalElements: config.maxTotalElements,
      maxMatrixDim: config.maxMatrixDim,
    },
  });

  const server = createServer(app);

  // Without an explicit timeout, a slow client can hold a socket open
  // indefinitely; these bound both halves of the conversation.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 15_000;

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });

  logger.info(
    {
      port: config.port,
      host: config.host,
      authServiceUrl: config.authServiceUrl,
      authCacheTtlSeconds: config.authCacheTtlSeconds,
      diagonalEpsilon: config.diagonalEpsilon,
      maxMatrices: config.maxMatrices,
      maxTotalElements: config.maxTotalElements,
      maxMatrixDim: config.maxMatrixDim,
    },
    'stats-api listening',
  );

  // SIGTERM is what a container orchestrator sends; SIGINT is Ctrl-C during
  // local development. Both must drain in-flight requests, otherwise a rolling
  // deploy drops calls mid-flight.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');

    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownGraceMs);
    // The timer must not hold the event loop open on its own.
    timer.unref();

    server.close((error) => {
      clearTimeout(timer);
      if (error) {
        logger.error({ err: error }, 'error while closing the server');
        process.exit(1);
      }
      logger.info('stats-api stopped cleanly');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// The top-level catch turns a startup failure into a single clear line on
// stderr and a non-zero exit, rather than an unhandled rejection stack.
main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
