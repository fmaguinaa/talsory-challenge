import { Module } from '@nestjs/common';

import { MatrixModule } from '../matrix/matrix.module';
import { AuthController } from './AuthController';

/**
 * Login module.
 *
 * It imports MatrixModule only to reuse the AuthClient provider: the token
 * adapter is shared, and duplicating it would mean two caches and two
 * connection pools for the same service.
 */
@Module({
  imports: [MatrixModule],
  controllers: [AuthController],
})
export class AuthModule {}
