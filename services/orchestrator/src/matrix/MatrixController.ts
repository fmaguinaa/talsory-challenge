import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { extractBearerToken } from '../common/requestContext';
import { AUTH_CLIENT } from './adapters/HttpAuthClient';
import { AnalyzeWorkflow, WorkflowError, type AuthClient } from './application/AnalyzeWorkflow';
import type { AnalyzeResponse } from './domain/types';
import { AnalyzeDto } from './dto/analyze.dto';

/**
 * Guard that rejects unauthenticated requests before they reach the controller.
 *
 * It exists as a separate decorator so the intent is visible on the route, and
 * because a controller method could otherwise forget to check. The workflow
 * validates the token again: the guard keeps unauthenticated traffic away from
 * the business logic, it is not meant to be the only check. The token is cached
 * inside the auth client (ADR-005), so the duplicate check costs a map lookup
 * rather than a network round trip.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(@Inject(AUTH_CLIENT) private readonly authClient: AuthClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId = (request.res?.locals.requestId as string | undefined) ?? '';
    const token = extractBearerToken(request.get('authorization'));

    if (token.length === 0) {
      throw new WorkflowError('unauthorized', 'A valid bearer token is required.');
    }

    await this.authClient.validate(token, requestId);
    return true;
  }
}

/**
 * The public analysis endpoint.
 *
 * The frontend talks only to this controller, and this controller owns the whole
 * workflow: validate, factorize, compute statistics, aggregate (ADR-002).
 */
@ApiTags('matrix')
@Controller('api/v1/matrix')
export class MatrixController {
  // The tokens are explicit because the dependencies are interface types, which
  // Nest could never infer from an emitted metadata type.
  constructor(
    @Inject(AnalyzeWorkflow) private readonly workflow: AnalyzeWorkflow,
    // Resolved to the same instance the workflow uses, so the guard and the
    // workflow share one token cache rather than two.
    @Inject(AUTH_CLIENT) private readonly authClient: AuthClient,
  ) {}

  /**
   * Factorizes a matrix and returns its QR factorization together with the
   * statistics of Q and R.
   */
  @Post('analyze')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Factorize a matrix and return its QR factorization plus statistics',
    description:
      "Orchestrates the workflow: the caller's bearer token is validated against auth-service and then propagated verbatim to qr-api and stats-api, so every service authorizes independently.",
  })
  @ApiResponse({ status: 200, description: 'QR factorization and the statistics of Q and R.' })
  @ApiResponse({ status: 401, description: 'Missing, malformed, expired or tampered token.' })
  @ApiResponse({ status: 422, description: 'The matrix is not acceptable.' })
  @ApiResponse({ status: 502, description: 'A downstream service replied with an error.' })
  @ApiResponse({ status: 503, description: 'auth-service is unreachable; the token is unverified.' })
  @ApiResponse({ status: 504, description: 'A downstream service did not answer in time.' })
  @UseGuards(BearerAuthGuard)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  )
  async analyze(@Body() body: AnalyzeDto, @Req() req: Request): Promise<AnalyzeResponse> {
    const requestId = (req.res?.locals.requestId as string | undefined) ?? '';
    const token = extractBearerToken(req.get('authorization'));

    const result = await this.workflow.execute(body.matrix, token, requestId);

    return { requestId, input: result.input, qr: result.qr, stats: result.stats };
  }
}

/**
 * Health endpoints.
 *
 * Both are dependency-free. Reporting this container unhealthy while
 * auth-service is down would be worse than useless: the orchestrator is the only
 * public entry point, so taking it out of rotation means nobody can reach any
 * service at all. Each service reports its own dependencies.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: string } {
    return { status: 'ok' };
  }
}
