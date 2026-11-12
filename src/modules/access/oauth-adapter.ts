import type { Adapter, AdapterPayload } from 'oidc-provider';
import { DataSource, LessThan, MoreThan } from 'typeorm';
import { hashToken } from '../identity/domain/tokens';
import { OAuthRecord } from './oauth-record.entity';

const oneYear = 365 * 24 * 60 * 60;
const bearerModels = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'RegistrationAccessToken',
]);
const grantModels = new Set(['AccessToken', 'AuthorizationCode', 'RefreshToken']);

export class OAuthAdapter implements Adapter {
  constructor(
    private readonly db: DataSource,
    private readonly model: string,
    private readonly invalidate: (grantId: string) => Promise<void>,
    private readonly invalidGrant: () => Error,
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn = oneYear): Promise<void> {
    const stored = { ...payload };
    if (bearerModels.has(this.model)) delete stored.jti;
    await this.db.manager.upsert(
      OAuthRecord,
      {
        ...this.key(id),
        payload: stored,
        grantId: payload.grantId ?? null,
        uid: payload.uid ?? null,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      },
      ['model', 'keyHash'],
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const row = await this.db.manager.findOneBy(OAuthRecord, {
      ...this.key(id),
      expiresAt: MoreThan(new Date()),
    });
    return row && bearerModels.has(this.model)
      ? { ...row.payload, jti: id }
      : (row?.payload as AdapterPayload | undefined);
  }
  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.db.manager.findOneBy(OAuthRecord, {
      model: this.model,
      uid,
      expiresAt: MoreThan(new Date()),
    });
    return row?.payload as AdapterPayload | undefined;
  }
  async findByUserCode(): Promise<undefined> {
    return undefined;
  } // Device flow is disabled.

  async consume(id: string): Promise<void> {
    const key = this.key(id);
    const result = await this.db
      .createQueryBuilder()
      .update(OAuthRecord)
      .set({
        payload: () =>
          `jsonb_set(payload, '{consumed}', to_jsonb(floor(extract(epoch from now()))::bigint))`,
      })
      .where(
        "model = :model AND key_hash = :keyHash AND expires_at > now() AND NOT (payload ? 'consumed')",
        key,
      )
      .execute();
    if (result.affected === 1) return;
    const existing = await this.find(id);
    if (existing?.grantId && this.model === 'RefreshToken') await this.invalidate(existing.grantId);
    throw this.invalidGrant();
  }

  async destroy(id: string): Promise<void> {
    if (this.model === 'Grant') await this.invalidate(id);
    await this.db.manager.delete(OAuthRecord, this.key(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    if (grantModels.has(this.model))
      await this.db.manager.delete(OAuthRecord, { model: this.model, grantId });
  }

  static async claimInteraction(db: DataSource, uid: string): Promise<boolean> {
    const result = await db
      .createQueryBuilder()
      .update(OAuthRecord)
      .set({ payload: () => `payload || '{"consentClaim":true}'::jsonb` })
      .where(
        `model = 'Interaction' AND key_hash = :keyHash AND expires_at > now()
        AND NOT (payload ? 'consentClaim') AND NOT (payload ? 'result')`,
        { keyHash: hashToken(uid) },
      )
      .execute();
    return result.affected === 1;
  }

  static async releaseInteraction(db: DataSource, uid: string): Promise<void> {
    await db
      .createQueryBuilder()
      .update(OAuthRecord)
      .set({ payload: () => `payload - 'consentClaim'` })
      .where(`model = 'Interaction' AND key_hash = :keyHash`, { keyHash: hashToken(uid) })
      .execute();
  }

  static async prune(db: DataSource): Promise<void> {
    await db.manager.delete(OAuthRecord, { expiresAt: LessThan(new Date()) });
  }

  private key(id: string) {
    return { model: this.model, keyHash: hashToken(id) };
  }
}
