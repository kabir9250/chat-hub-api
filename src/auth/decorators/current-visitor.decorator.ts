import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedVisitor } from '../guards/visitor-auth.guard';

interface VisitorRequest extends Request {
  visitor?: AuthenticatedVisitor;
}

/**
 * Pulls the AuthenticatedVisitor VisitorAuthGuard attached to `req.visitor`.
 * The Visitor-token counterpart to `CurrentUser` — only meaningful behind
 * `VisitorAuthGuard`.
 */
export const CurrentVisitor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedVisitor => {
    const request = ctx.switchToHttp().getRequest<VisitorRequest>();
    return request.visitor as AuthenticatedVisitor;
  },
);
