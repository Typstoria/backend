import type { Request } from 'express';
import type { UserActor } from '../../../common/actor/actor';
import type { User } from '../infrastructure/persistence/entities/user.entity';
import type { WebSession } from '../infrastructure/persistence/entities/web-session.entity';

export interface AuthRequest extends Request {
  identity?: { user: User; session: WebSession };
  actor?: UserActor;
}

/** Only the explicit Authorization header is accepted; never cookies, query or body. */
export function readBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || header.length > 512) return;
  const authorizationHeaders = request.rawHeaders.filter(
    (_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'authorization',
  );
  if (authorizationHeaders.length !== 1) return;
  return /^Bearer +([A-Za-z0-9._~-]+)$/i.exec(header)?.[1];
}
