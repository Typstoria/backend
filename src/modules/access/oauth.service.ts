import { Injectable, Logger } from '@nestjs/common';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import Provider, { errors, type AdapterFactory, type Configuration } from 'oidc-provider';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { mcpScopes } from '../../common/actor/access-policy';
import type { UserActor } from '../../common/actor/actor';
import { parseEntityId } from '../../common/ids/numeric-id';
import { AppConfigService } from '../../config/app-config.service';
import { SessionService } from '../identity/application/session.service';
import { User } from '../identity/infrastructure/persistence/entities/user.entity';
import { readBearerToken } from '../identity/http/auth-request';
import { AccessService, parseOAuthScopes } from './access.service';
import { OAuthAdapter } from './oauth-adapter';
import { consentPage } from './consent-page';

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const consentSchema = z.union([
  z.strictObject({ deny: z.literal(true) }),
  z.strictObject({
    projectIds: z
      .array(z.number().int().min(1).max(2147483647))
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);

@Injectable()
export class OAuthService {
  private provider?: Provider;
  private nextPruneAt = 0;
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DataSource,
    private readonly access: AccessService,
    private readonly sessions: SessionService,
  ) {}

  get issuer(): string | undefined {
    return this.config.mcpOrigin && this.config.mcpOAuthCookieKey
      ? this.config.mcpOrigin + '/oauth'
      : undefined;
  }
  get resource(): string | undefined {
    const origin = this.config.mcpOrigin;
    return origin && this.issuer ? origin + '/mcp' : undefined;
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: this.issuer ? [this.issuer] : [],
      bearer_methods_supported: ['header'],
      scopes_supported: mcpScopes,
    };
  }
  authorizationMetadata() {
    const issuer = this.issuer;
    if (!issuer) return undefined;
    return {
      issuer,
      authorization_endpoint: issuer + '/auth',
      token_endpoint: issuer + '/token',
      registration_endpoint: issuer + '/reg',
      revocation_endpoint: issuer + '/token/revocation',
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: mcpScopes,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    };
  }

  start(): Provider | undefined {
    if (!this.issuer || !this.resource) return;
    if (this.provider) return this.provider;
    const issuer = this.issuer,
      resource = this.resource;
    const adapter: AdapterFactory = (name) =>
      new OAuthAdapter(
        this.database,
        name,
        (id) => this.access.invalidateOAuth(id),
        () => new errors.InvalidGrant('Credential already used or expired'),
      );
    const settings: Configuration = {
      adapter,
      // The library requires a signing key; this OAuth-only provider issues opaque access tokens.
      jwks: {
        keys: [
          {
            ...generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
              format: 'jwk',
            }),
            alg: 'RS256',
            use: 'sig',
          },
        ],
      },
      // OAuth only. Client identities are authenticated by the existing verified web session.
      scopes: ['offline_access', ...mcpScopes],
      clientAuthMethods: ['none'],
      clientDefaults: {
        token_endpoint_auth_method: 'none',
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        application_type: 'native',
      },
      responseTypes: ['code'],
      pkce: { required: () => true },
      cookies: {
        keys: [this.config.mcpOAuthCookieKey!],
        short: {
          signed: true,
          httpOnly: true,
          sameSite: 'lax',
          secure: issuer.startsWith('https://'),
        },
        long: {
          signed: true,
          httpOnly: true,
          sameSite: 'lax',
          secure: issuer.startsWith('https://'),
        },
      },
      ttl: {
        Interaction: 600,
        Session: 900,
        Grant: 30 * 86400,
        AccessToken: 600,
        AuthorizationCode: 90,
        RefreshToken: 30 * 86400,
      },
      rotateRefreshToken: true,
      expiresWithSession: () => false,
      issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      loadExistingGrant: async (ctx) => {
        const id = ctx.oidc.result?.consent?.grantId;
        return id ? ctx.oidc.provider.Grant.find(id) : undefined;
      },
      findAccount: async (ctx, accountId) => {
        const id = parseEntityId(accountId);
        if (!id) return;
        const user = await this.database.manager.findOneBy(User, { id });
        if (!user?.emailVerifiedAt) return;
        const grant = ctx.oidc.entities.Grant;
        if (
          ctx.oidc.route === 'token' &&
          (!grant?.jti ||
            !grant.clientId ||
            !(await this.access.resolveOAuth(
              grant.jti,
              accountId,
              grant.clientId,
              new Set(mcpScopes),
            )))
        )
          return;
        return { accountId, claims: () => ({ sub: accountId }) };
      },
      features: {
        devInteractions: { enabled: false },
        userinfo: { enabled: false },
        rpInitiatedLogout: { enabled: false },
        registration: { enabled: true, issueRegistrationAccessToken: false },
        revocation: { enabled: true },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => resource,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, requested) => {
            if (requested !== resource)
              throw new errors.InvalidTarget('Expected the configured Typstoria MCP resource');
            return {
              scope: mcpScopes.join(' '),
              audience: resource,
              accessTokenFormat: 'opaque',
              accessTokenTTL: 600,
            };
          },
        },
      },
      extraClientMetadata: {
        properties: ['typstoria_policy'],
        validator: (_ctx, _key, _value, metadata) => {
          const uris = metadata.redirect_uris ?? [];
          if (
            !uris.length ||
            uris.length > 5 ||
            uris.some((raw) => {
              const url = URL.parse(raw);
              return (
                raw.length > 500 ||
                !url ||
                Boolean(url.username || url.password || url.hash) ||
                (url.protocol !== 'https:' &&
                  !(url.protocol === 'http:' && loopback.has(url.hostname)))
              );
            })
          )
            throw new errors.InvalidClientMetadata('Use HTTPS or loopback HTTP redirect URIs');
          if (
            (metadata.client_name?.length ?? 0) > 100 ||
            metadata.token_endpoint_auth_method !== 'none' ||
            metadata.response_types?.some((type) => type !== 'code') ||
            metadata.grant_types?.some(
              (type) => !['authorization_code', 'refresh_token'].includes(type),
            ) ||
            metadata.jwks_uri ||
            metadata.sector_identifier_uri
          )
            throw new errors.InvalidClientMetadata(
              'Only public authorization-code clients are supported',
            );
          delete (metadata as Record<string, unknown>).typstoria_policy;
        },
      },
      interactions: { url: (_ctx, interaction) => `${issuer}/interaction/${interaction.uid}` },
    };
    const provider = new Provider(issuer, settings);
    provider.proxy = issuer.startsWith('https://');
    provider.on('server_error', () => this.logger.error('OAuth provider request failed'));
    this.provider = provider;
    return provider;
  }

  async resolve(token: string): Promise<UserActor | undefined> {
    if (!this.provider || !this.resource || !/^[A-Za-z0-9_-]{25,128}$/.test(token)) return;
    const access = await this.provider.AccessToken.find(token);
    if (
      !access ||
      access.aud !== this.resource ||
      !access.grantId ||
      !access.accountId ||
      !access.clientId ||
      access.tokenType !== 'Bearer'
    )
      return;
    if (!(await this.provider.Grant.find(access.grantId))) return;
    return this.access.resolveOAuth(
      access.grantId,
      access.accountId,
      access.clientId,
      access.scopes,
    );
  }

  async interaction(
    req: Request,
    res: Response,
    kind: 'page' | 'details' | 'finish',
  ): Promise<void> {
    const provider = this.provider;
    if (!provider) {
      res.sendStatus(404);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (
      kind === 'finish' &&
      (req.get('origin') !== this.config.mcpOrigin || !req.is('application/json'))
    ) {
      res.status(403).json({ error: 'origin_denied' });
      return;
    }
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.uid !== req.params.uid) {
        res.sendStatus(404);
        return;
      }
      const clientId = String(details.params.client_id);
      const client = await provider.Client.find(clientId);
      const scope = String(details.params.scope ?? '');
      const scopes = parseOAuthScopes(scope);
      if (
        !client ||
        !scopes.length ||
        scopes.length !==
          new Set(scope.split(/\s+/).filter((s) => s && s !== 'offline_access')).size
      ) {
        res.status(400).json({ error: 'invalid_scope' });
        return;
      }
      if (kind === 'page') {
        const nonce = randomBytes(24).toString('base64');
        res.setHeader(
          'Content-Security-Policy',
          `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        );
        res.type('html').send(consentPage(nonce));
        return;
      }
      const name = (client.clientName?.replace(/\p{Cc}/gu, '').trim() || 'MCP client').slice(
        0,
        100,
      );
      if (kind === 'details') {
        res.json({ clientId, name, redirectUri: details.params.redirect_uri, scopes });
        return;
      }
      const parsed = consentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_project_selection' });
        return;
      }
      const input = parsed.data;
      const identity =
        'deny' in input ? undefined : await this.sessions.resolve(readBearerToken(req));
      if (!('deny' in input) && !identity?.user.emailVerifiedAt) {
        res.status(401).json({ error: 'login_required' });
        return;
      }
      // The atomic claim avoids holding a database connection while the provider saves its models.
      if (!(await OAuthAdapter.claimInteraction(this.database, details.uid))) {
        res.status(409).json({ error: 'interaction_already_completed' });
        return;
      }
      let resumeUrl: string;
      try {
        if ('deny' in input) {
          resumeUrl = await provider.interactionResult(
            req,
            res,
            { error: 'access_denied', error_description: 'The user declined access' },
            { mergeWithLastSubmission: false },
          );
        } else {
          const user = identity!.user;
          const grant = new provider.Grant({ accountId: String(user.id), clientId });
          grant.addResourceScope(this.resource!, scopes.join(' '));
          // DCR validates these against the server scopes as well as resource metadata.
          grant.addOIDCScope(scope);
          const grantId = await grant.save();
          try {
            await this.access.createConnection(user, clientId, grantId, {
              name,
              projectIds: input.projectIds,
              scopes,
            });
            resumeUrl = await provider.interactionResult(
              req,
              res,
              { login: { accountId: String(user.id), remember: false }, consent: { grantId } },
              { mergeWithLastSubmission: false },
            );
          } catch (error) {
            await grant.destroy();
            throw error;
          }
        }
      } catch (error) {
        await OAuthAdapter.releaseInteraction(this.database, details.uid);
        throw error;
      }
      res.json({ resumeUrl });
    } catch (error) {
      if (error instanceof errors.SessionNotFound) {
        res.status(400).json({ error: 'interaction_expired' });
        return;
      }
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 404 || error.status === 429)
      ) {
        res
          .status(error.status)
          .json({ error: error.status === 404 ? 'invalid_project_selection' : 'connection_limit' });
        return;
      }
      this.logger.error('OAuth consent request failed');
      res.status(500).json({ error: 'server_error' });
    }
  }

  schedulePrune(): void {
    if (Date.now() < this.nextPruneAt) return;
    this.nextPruneAt = Date.now() + 60 * 60 * 1000;
    void OAuthAdapter.prune(this.database).catch(() =>
      this.logger.warn('OAuth record cleanup failed'),
    );
  }
}
