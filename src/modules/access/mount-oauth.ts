import { parseOAuthScopes } from './access.service';
import { oauthRateLimit } from './oauth-rate-limit';
import type { INestApplication } from '@nestjs/common';
import { Router, json } from 'express';
import { OAuthService } from './oauth.service';

/** OIDC owns its request body, protocol errors and redirects; mount before Express body parsing. */
export function mountOAuth(app: INestApplication): void {
  const oauth = app.get(OAuthService);
  const provider = oauth.start();
  if (!provider) return;
  const issuer = new URL(oauth.issuer!);
  const expectedHost = issuer.host;
  const router = Router();
  router.use((req, res, next) => {
    if (req.get('host')?.toLowerCase() !== expectedHost) {
      res.sendStatus(403);
      return;
    }
    // The canonical issuer controls generated URLs; do not trust forwarded values.
    req.headers['x-forwarded-host'] = expectedHost;
    req.headers['x-forwarded-proto'] = issuer.protocol.slice(0, -1);
    next();
  });
  router.use(oauthRateLimit());
  router.get('/interaction/:uid', (req, res) => oauth.interaction(req, res, 'page'));
  router.get('/interaction/:uid/details', (req, res) => oauth.interaction(req, res, 'details'));
  router.post('/interaction/:uid', json({ limit: '8kb' }), (req, res) =>
    oauth.interaction(req, res, 'finish'),
  );
  const handle = provider.callback();
  router.use((req, res) => {
    oauth.schedulePrune();
    if (req.path === '/auth' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      if (!url.searchParams.has('scope'))
        url.searchParams.set('scope', 'projects:read documents:read context:read history:read');
      const requested = url.searchParams.get('scope') ?? '';
      const scopes = new Set(
        requested
          .trim()
          .split(/\s+/)
          .filter((scope) => scope && scope !== 'offline_access'),
      );
      if (
        !scopes.size ||
        parseOAuthScopes(requested).length !== scopes.size ||
        (url.searchParams.has('response_mode') && url.searchParams.get('response_mode') !== 'query')
      ) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      req.url = url.pathname + url.search;
    }
    return handle(req, res);
  });
  app.use('/oauth', router);
}
