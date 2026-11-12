import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan, MoreThan, type EntityManager } from 'typeorm';
import { mcpScopes, requireWeb, type McpScope } from '../../common/actor/access-policy';
import type { UserActor } from '../../common/actor/actor';
import { parseEntityId } from '../../common/ids/numeric-id';
import { createToken, hashToken, matchesToken } from '../identity/domain/tokens';
import { User } from '../identity/infrastructure/persistence/entities/user.entity';
import { Project } from '../projects/infrastructure/persistence/entities/project.entity';
import { AccessGrant } from './access-grant.entity';
import type { AccessGrantDto, AccessGrantListDto, CreatePatDto, CreatedPatDto } from './access.dto';

const day = 86_400_000;

@Injectable()
export class AccessService {
  constructor(private readonly database: DataSource) {}

  async createPat(
    actor: UserActor,
    authVersion: number,
    input: CreatePatDto,
  ): Promise<CreatedPatDto> {
    requireWeb(actor);
    const secret = createToken();
    const grant = await this.create(
      actor.userId,
      authVersion,
      input,
      { kind: 'pat', secretHash: hashToken(secret), oauthGrantId: null, clientId: null },
      input.expiresInDays ?? 30,
    );
    return { ...this.dto(grant, authVersion), token: `tp_pat_${grant.id}.${secret}` };
  }

  async createConnection(
    user: User,
    clientId: string,
    grantId: string,
    input: Pick<CreatePatDto, 'name' | 'scopes' | 'projectIds'>,
  ): Promise<void> {
    await this.create(
      user.id,
      user.authVersion,
      input,
      { kind: 'oauth', secretHash: null, oauthGrantId: grantId, clientId },
      30,
    );
  }

  async list(
    actor: UserActor,
    authVersion: number,
    kind: AccessGrant['kind'],
    limit: number,
    cursor?: number,
  ): Promise<AccessGrantListDto> {
    requireWeb(actor);
    const rows = await this.database.manager.find(AccessGrant, {
      where: {
        userId: actor.userId,
        kind,
        ...(cursor === undefined ? {} : { id: LessThan(cursor) }),
      },
      order: { id: 'DESC' },
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map((row) => this.dto(row, authVersion));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async revoke(actor: UserActor, kind: AccessGrant['kind'], id: number): Promise<void> {
    requireWeb(actor);
    const result = await this.database.manager.update(
      AccessGrant,
      { userId: actor.userId, kind, id },
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

  async resolvePat(token: string): Promise<UserActor | undefined> {
    const match = /^tp_pat_([1-9][0-9]{0,9})\.([\w-]{43})$/.exec(token);
    const id = match ? parseEntityId(match[1]!) : undefined;
    if (!id || !match) return;
    const grant = await this.database
      .getRepository(AccessGrant)
      .createQueryBuilder('grant')
      .addSelect('grant.secretHash')
      .where('grant.id = :id AND grant.kind = :kind', { id, kind: 'pat' })
      .getOne();
    if (!grant?.secretHash || !matchesToken(match[2]!, grant.secretHash)) return;
    return this.actor(grant);
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

  private async create(
    userId: number,
    authVersion: number,
    input: Pick<CreatePatDto, 'name' | 'scopes' | 'projectIds'>,
    target: Pick<AccessGrant, 'kind' | 'secretHash' | 'oauthGrantId' | 'clientId'>,
    days: number,
  ) {
    return this.database.transaction(async (manager) => {
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
        kind: target.kind,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      });
      if (count >= 30)
        throw new HttpException(
          {
            code: 'ACCESS_GRANT_QUOTA',
            message: 'Revoke an existing credential before creating another (max 30 per type)',
          },
          429,
        );
      return manager.save(
        AccessGrant,
        manager.create(AccessGrant, {
          ...target,
          userId,
          authVersion,
          ...input,
          expiresAt: new Date(Date.now() + days * day),
          revokedAt: null,
        }),
      );
    });
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
  private dto(grant: AccessGrant, authVersion: number): AccessGrantDto {
    return {
      id: grant.id,
      name: grant.name,
      clientId: grant.clientId,
      scopes: grant.scopes,
      projectIds: grant.projectIds,
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
