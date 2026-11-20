import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan, MoreThan, type EntityManager } from 'typeorm';
import { mcpScopes, requireWeb, type McpScope } from '../../common/actor/access-policy';
import type { UserActor } from '../../common/actor/actor';
import { User } from '../identity/infrastructure/persistence/entities/user.entity';
import { Project } from '../projects/infrastructure/persistence/entities/project.entity';
import { AccessGrant } from './access-grant.entity';
import type { AccessGrantDto, AccessGrantListDto, ConnectionProjectDto } from './access.dto';

const connectionTtl = 30 * 86_400_000;
type ConnectionInput = { name: string; scopes: McpScope[]; projectIds: number[] };

@Injectable()
export class AccessService {
  constructor(private readonly database: DataSource) {}

  async createConnection(
    owner: User,
    clientId: string,
    grantId: string,
    input: ConnectionInput,
  ): Promise<void> {
    const { id: userId, authVersion } = owner;
    await this.database.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user?.emailVerifiedAt || user.authVersion !== authVersion)
        throw new NotFoundException('Active account not found');
      await this.checkProjects(manager, userId, input.projectIds);
      const count = await manager.countBy(AccessGrant, {
        userId,
        authVersion,
        kind: 'oauth',
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      });
      if (count >= 30)
        throw new HttpException(
          {
            code: 'ACCESS_GRANT_QUOTA',
            message: 'Revoke an existing connection before creating another (max 30)',
          },
          429,
        );
      await manager.save(
        AccessGrant,
        manager.create(AccessGrant, {
          userId,
          authVersion,
          kind: 'oauth',
          oauthGrantId: grantId,
          clientId,
          ...input,
          expiresAt: new Date(Date.now() + connectionTtl),
          revokedAt: null,
        }),
      );
    });
  }

  async list(
    actor: UserActor,
    authVersion: number,
    limit: number,
    cursor?: number,
  ): Promise<AccessGrantListDto> {
    requireWeb(actor);
    const rows = await this.database.manager.find(AccessGrant, {
      where: {
        userId: actor.userId,
        kind: 'oauth',
        ...(cursor === undefined ? {} : { id: LessThan(cursor) }),
      },
      order: { id: 'DESC' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const projectIds = [...new Set(page.flatMap((row) => row.projectIds))];
    const projects = projectIds.length
      ? await this.database.manager.find(Project, {
          where: { id: In(projectIds), ownerId: actor.userId, deletedAt: IsNull() },
          select: { id: true, title: true },
        })
      : [];
    const byId = new Map(projects.map(({ id, title }) => [id, { id, title }]));
    const items = page.map((row) => this.dto(row, authVersion, byId));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async revoke(actor: UserActor, id: number): Promise<void> {
    requireWeb(actor);
    const result = await this.database.manager.update(
      AccessGrant,
      { userId: actor.userId, kind: 'oauth', id },
      { revokedAt: () => 'COALESCE(revoked_at, now())' },
    );
    if (!result.affected) throw new NotFoundException('Access grant not found');
  }

  async invalidateOAuth(grantId: string): Promise<void> {
    await this.database.manager.update(
      AccessGrant,
      { oauthGrantId: grantId, kind: 'oauth' },
      { revokedAt: () => 'COALESCE(revoked_at, now())' },
    );
  }

  async resolveOAuth(
    grantId: string,
    accountId: string,
    clientId: string,
    scopes: ReadonlySet<string>,
  ): Promise<UserActor | undefined> {
    const grant = await this.database.manager.findOneBy(AccessGrant, {
      oauthGrantId: grantId,
      clientId,
      kind: 'oauth',
    });
    if (!grant || String(grant.userId) !== accountId) return;
    const actor = await this.actor(grant);
    return actor && { ...actor, scopes: grant.scopes.filter((scope) => scopes.has(scope)) };
  }

  private async checkProjects(manager: EntityManager, userId: number, ids: number[]) {
    const count = await manager.countBy(Project, {
      id: In(ids),
      ownerId: userId,
      deletedAt: IsNull(),
    });
    if (!ids.length || count !== ids.length) throw new NotFoundException('Project not found');
  }
  private async actor(grant: AccessGrant): Promise<UserActor | undefined> {
    if (grant.revokedAt || grant.expiresAt.getTime() <= Date.now()) return;
    const user = await this.database.manager.findOneBy(User, {
      id: grant.userId,
      authVersion: grant.authVersion,
    });
    if (!user?.emailVerifiedAt) return;
    return {
      userId: grant.userId,
      channel: 'mcp',
      credentialId: grant.id,
      scopes: grant.scopes,
      projectIds: grant.projectIds,
    };
  }
  private dto(
    grant: AccessGrant,
    authVersion: number,
    projects: ReadonlyMap<number, ConnectionProjectDto>,
  ): AccessGrantDto {
    return {
      id: grant.id,
      name: grant.name,
      clientId: grant.clientId,
      scopes: grant.scopes,
      projectIds: grant.projectIds,
      projects: grant.projectIds.flatMap((id) => projects.get(id) ?? []),
      status:
        grant.revokedAt || grant.authVersion !== authVersion
          ? 'revoked'
          : grant.expiresAt.getTime() <= Date.now()
            ? 'expired'
            : 'active',
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
      revokedAt: grant.revokedAt?.toISOString() ?? null,
    };
  }
}

export function parseOAuthScopes(scope: string): McpScope[] {
  return [...new Set(scope.split(/\s+/))].filter((value): value is McpScope =>
    mcpScopeSet.has(value),
  );
}
const mcpScopeSet = new Set<string>(mcpScopes);
