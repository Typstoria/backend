import type { RequestHandler } from 'express';

/** OIDC is mounted before Nest's guards. Bound unauthenticated requests at that boundary. */
export function oauthRateLimit(): RequestHandler {
  const requests = new Map<string, number>();
  let reset = Date.now() + 60_000;
  let total = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now >= reset) {
      requests.clear();
      total = 0;
      reset = now + 60_000;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const group = req.path === '/reg' ? 'registration' : 'oauth';
    const key = group + ':' + ip;
    const count = (requests.get(key) ?? 0) + 1;
    if (total >= 2000 || count > (group === 'registration' ? 20 : 180)) {
      res.setHeader('Retry-After', String(Math.ceil((reset - now) / 1000)));
      res.status(429).json({ error: 'temporarily_unavailable' });
      return;
    }
    total++;
    requests.set(key, count);
    next();
  };
}
