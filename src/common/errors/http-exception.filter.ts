import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ContextRequest } from '../http/request-context';
import type { ErrorResponseDto } from './error-response.dto';

const errorCodes: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'RESOURCE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<ContextRequest>();
    const response = context.getResponse<Response>();
    const requestId = request.requestId ?? randomUUID();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred';
    let code = 'INTERNAL_ERROR';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = errorCodes[status] ?? 'HTTP_ERROR';
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else {
        const payload = body as Record<string, unknown>;
        if (Array.isArray(payload.message)) {
          message = 'Request validation failed';
          code = 'VALIDATION_FAILED';
          details = { messages: payload.message };
        } else {
          message = typeof payload.message === 'string' ? payload.message : exception.message;
          if (
            payload.details !== null &&
            typeof payload.details === 'object' &&
            !Array.isArray(payload.details)
          ) {
            details = payload.details as Record<string, unknown>;
          }
        }
        if (typeof payload.code === 'string') code = payload.code;
      }
    } else if (this.isBodyParserError(exception)) {
      status = exception.type === 'entity.too.large' ? 413 : 400;
      code = errorCodes[status]!;
      message = status === 413 ? 'Request body exceeds the size limit' : 'Malformed JSON body';
    } else {
      this.logger.error({
        requestId,
        message: 'Unhandled request error',
        exceptionType: exception instanceof Error ? exception.name : 'UnknownError',
      });
    }

    const body: ErrorResponseDto = {
      error: { code, message, requestId, ...(details ? { details } : {}) },
    };
    response.setHeader('X-Request-Id', requestId);
    response.status(status).json(body);
  }

  private isBodyParserError(
    exception: unknown,
  ): exception is { type: 'entity.parse.failed' | 'entity.too.large' } {
    return (
      exception !== null &&
      typeof exception === 'object' &&
      'type' in exception &&
      (exception.type === 'entity.parse.failed' || exception.type === 'entity.too.large')
    );
  }
}
