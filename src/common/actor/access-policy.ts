import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { UserActor } from './actor';

export const mcpScopes = [
  'projects:read',
  'documents:read',
  'context:read',
  'history:read',
  'changes:read',
  'changes:propose',
  'uploads:stage',
  'compile:run',
  'compile:read',
] as const;
export type McpScope = (typeof mcpScopes)[number];

export function requireWeb(actor: UserActor): void {
  if (actor.channel !== 'web') throw new ForbiddenException('A web session is required');
}
export function hasScope(actor: UserActor, scope: McpScope): boolean {
  return actor.channel === 'web' || (actor.scopes?.includes(scope) ?? false);
}
export function requireScope(actor: UserActor, ...scopes: McpScope[]): void {
  if (scopes.some((scope) => !hasScope(actor, scope)))
    throw new ForbiddenException({
      code: 'INSUFFICIENT_SCOPE',
      message: 'This credential does not grant this operation',
      details: { requiredScopes: scopes },
    });
}
export function requireProject(actor: UserActor, projectId: number): void {
  if (actor.channel === 'web') return;
  if (!actor.projectIds) requireWeb(actor);
  if (!actor.projectIds?.includes(projectId)) throw new NotFoundException('Project not found');
}
