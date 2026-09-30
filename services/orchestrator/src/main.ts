import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { CONFIG_TOKEN, type OrchestratorConfig } from './config/config';
import { ProblemDetailsFilter } from './common/ProblemDetailsFilter';
import { requestIdMiddleware } from './common/requestContext';

/**
 * Composition root for the orchestrator.
 *
 * Everything that touches the outside world is wired here: the HTTP adapter,
 * the global pipes, CORS, the exception filter and the documentation. Below this
 * file, code deals in plain values.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // The configuration provider is resolved here so the access log level and the
  // CORS allow-list come from the same validated source as everything else.
  const config = app.get<OrchestratorConfig>(CONFIG_TOKEN);
  const logger = new Logger('Bootstrap');

  // helmet first, so even a response produced by the exception filter carries
  // the security headers.
  app.use(helmet());
  // Advertising the framework is free reconnaissance. The cast is confined to
  // this one call: `getInstance()` is typed as `any` by Nest, and the only
  // property used is a documented Express method.
  const expressApp = app.getHttpAdapter().getInstance() as { disable?(name: string): void };
  expressApp.disable?.('x-powered-by');

  // The correlation id is established before any route runs, so the guard, the
  // controller and the exception filter all see the same value.
  app.use(requestIdMiddleware);

  app.enableCors({
    // An explicit list, never a wildcard: this service is the only public
    // backend, so its CORS policy is the whole system's policy.
    origin: [...config.corsOrigins],
    methods: [RequestMethod.GET, RequestMethod.POST, RequestMethod.OPTIONS],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    credentials: false,
    maxAge: 3600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // A body that cannot be parsed at all is a 400, not a 500: it is the
      // client's mistake and should read as one.
      stopAtFirstError: false,
    }),
  );

  app.useGlobalFilters(new ProblemDetailsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Interseguro orchestrator API')
    .setDescription(
      'Backend-for-frontend and the only surface the Expo app talks to. Owns the workflow: validate the token, call qr-api, feed Q and R to stats-api, and return one aggregated response.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    // The generated document must match contracts/orchestrator.yaml; a contract
    // test in test/contract.test.ts keeps the two from drifting.
    jsonDocumentUrl: 'docs/openapi.json',
  });

  // SIGTERM is what a container orchestrator sends. Shutdown hooks close the
  // HTTP server so in-flight requests drain rather than being cut off.
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);

  logger.log(`orchestrator listening on ${config.host}:${config.port}`);
  logger.log(`swagger UI at /docs, CORS limited to ${config.corsOrigins.join(', ')}`);
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
