import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthClient } from '../matrix/application/AnalyzeWorkflow';
import { AUTH_CLIENT } from '../matrix/adapters/HttpAuthClient';
import type { LoginResponse } from '../matrix/domain/types';
import { LoginDto } from './dto/login.dto';

/**
 * Login endpoint.
 *
 * A thin proxy: the orchestrator performs no credential handling of its own.
 * Login is the one operation where the orchestrator could shortcut validation,
 * but doing so would mean two implementations of "what counts as valid
 * credentials" and two places where a bug becomes a security hole. Forwarding is
 * one line and keeps auth-service the sole authority on identity.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AUTH_CLIENT) private readonly authClient: AuthClient) {}

  /**
   * Exchanges credentials for a token.
   *
   * @throws WorkflowError `unauthorized` for bad credentials, or
   *   `auth-unavailable` / `downstream-timeout` when auth-service is unreachable
   */
  @Post('login')
  // 201 is Nest's default for POST, but a login creates no resource; 200 is
  // what clients, proxies and the OpenAPI contract expect.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in and receive an access token' })
  @ApiResponse({ status: 200, description: 'Credentials accepted.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 503, description: 'The authentication service is unreachable.' })
  @UsePipes(
    new ValidationPipe({
      transform: true,
      // Unknown fields are stripped rather than rejected: a client sending extra
      // metadata should not be broken by a strictness the contract never
      // promised.
      whitelist: true,
    }),
  )
  async login(@Body() body: LoginDto, @Req() req: Request): Promise<LoginResponse> {
    const requestId = (req.res?.locals.requestId as string | undefined) ?? '';

    const token = await this.authClient.login(body.username, body.password, requestId);

    // A shared cache must never replay one user's token to another.
    req.res?.setHeader('Cache-Control', 'no-store');
    return token;
  }
}
