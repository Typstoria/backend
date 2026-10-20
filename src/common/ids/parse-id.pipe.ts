import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseEntityId } from './numeric-id';

@Injectable()
export class ParseIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = typeof value === 'string' ? parseEntityId(value) : undefined;
    if (id === undefined) throw new BadRequestException('ID must be a positive 32-bit integer');
    return id;
  }
}

// Preserve the original string: global ValidationPipe would turn "1e2" into 100
// for a normal @Param() annotated as number before the ID pipe sees it.
const rawIdParam = createParamDecorator(
  (name: string, context: ExecutionContext): unknown =>
    context.switchToHttp().getRequest<Request>().params[name],
);

export const IdParam = (name: string) => rawIdParam(name, ParseIdPipe);
