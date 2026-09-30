import { createServer } from 'node:http';

import pino from 'pino';

import { AuthService } from './application/AuthService';
import { Argon2PasswordPort } from './adapters/crypto/Argon2PasswordPort';
import { InMemoryUserDirectory } from './adapters/crypto/InMemoryUserDirectory';
import { JwtTokenPort } from './adapters/crypto/JwtTokenPort';
import { ServiceCredentials } from './adapters/crypto/ServiceCredentials';
import { buildApp } from './adapters/http/router';
import { loadConfig } from './config';

/**
 * Composition root for auth-service.
 *
 * Every dependency is constructed here and injected downwards. Nothing below
 * this file reads `process.env` or opens a socket, which is what lets the
 * authentication rules be tested against plain objects.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Pretty-printing is an explicit opt-in because pino-pretty is a
  // devDependency and is deliberately absent from the runtime image; inferring
  // it from the log level would make a debug run of a production image fail to
  // boot for no good reason.
  const pretty = process.env.LOG_PRETTY === 'true';
  const logger = pino({
    level: config.logLevel,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });

  // Fail fast and loudly rather than at the first login: an unparseable key
  // would otherwise look like a mysterious 500.
  const tokenPort = new JwtTokenPort(
    { privateKeyPem: config.jwtPrivateKeyPem, publicKeyPem: config.jwtPublicKeyPem, kid: config.jwtKid },
    {
      issuer: config.issuer,
      audience: config.audience,
      ttlSeconds: config.ttlSeconds,
      clockToleranceSeconds: config.clockToleranceSeconds,
    },
  );
  try {
    await tokenPort.init();
  } catch (error) {
    throw new Error(
      `the signing key pair could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const passwords = new Argon2PasswordPort(config.argon2);
  const users = new InMemoryUserDirectory(
    config.users.map((user) => ({
      username: user.username,
      passwordHash: user.passwordHash,
      scopes: user.scopes,
    })),
  );
  const serviceCredentials = new ServiceCredentials(config.serviceApiKeys);

  const authService = new AuthService(users, passwords, tokenPort, {
    issuer: config.issuer,
    audience: config.audience,
    ttlSeconds: config.ttlSeconds,
    defaultScopes: config.defaultScopes,
  });

  const app = buildApp({
    authService,
    serviceCredentials,
    logger,
    maxBodyBytes: config.maxBodyBytes,
    loginRateLimits: { windowMs: config.loginRateLimitWindowMs, max: config.loginRateLimitMax },
  });

  const server = createServer(app);

  // Without these, a slow client can hold a socket open indefinitely.
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
      issuer: config.issuer,
      audience: config.audience,
      ttlSeconds: config.ttlSeconds,
      kid: config.jwtKid,
      users: config.users.map((user) => user.username),
      // The count only, never the keys themselves.
      serviceKeysConfigured: config.serviceApiKeys.length,
    },
    'auth-service listening',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');

    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownGraceMs);
    timer.unref();

    server.close((error) => {
      clearTimeout(timer);
      if (error) {
        logger.error({ err: error }, 'error while closing the server');
        process.exit(1);
      }
      logger.info('auth-service stopped cleanly');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// A single clear line on stderr and a non-zero exit, rather than an unhandled
// rejection stack.
main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
