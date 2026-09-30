import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body of `POST /auth/login`.
 *
 * The bounds mirror contracts/auth-service.yaml. They are repeated here so the
 * orchestrator rejects an oversized body before forwarding it: a 10 MB username
 * is not something to hand to another service, and the validation is free
 * compared to the round trip.
 */
export class LoginDto {
  /** The user's name. */
  @ApiProperty({ example: 'demo', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  username!: string;

  /** The user's password. Never logged, never echoed. */
  @ApiProperty({ example: 'demo-password', minLength: 1, maxLength: 256 })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}
