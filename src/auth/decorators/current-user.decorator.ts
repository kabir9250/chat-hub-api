import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Pulls the AuthenticatedUser JwtAuthGuard attached to `req.user`.
 * Only meaningful behind JwtAuthGuard — used to keep controller code
 * from reaching into `@Req() req` and casting `req.user` by hand.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
