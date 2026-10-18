import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type ContextRequest = Request & { requestId?: string };

const logger = new Logger('HTTP');

export function requestContext(
  request: ContextRequest,
  response: Response,
  next: NextFunction,
): void {
  const providedId = request.header('x-request-id');
  request.requestId =
    providedId && /^[a-zA-Z0-9_-]{1,64}$/.test(providedId) ? providedId : randomUUID();
  response.setHeader('X-Request-Id', request.requestId);
  const startedAt = performance.now();

  response.once('finish', () => {
    // Deliberately exclude URLs, headers and bodies: they may contain private tokens or text.
    logger.log({
      requestId: request.requestId,
      method: request.method,
      statusCode: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });

  next();
}
