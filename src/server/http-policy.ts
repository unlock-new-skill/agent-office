import type { AppConfig } from './config.js';

type PolicyConfig = Pick<AppConfig, 'host' | 'port' | 'containerMode' | 'publicOrigin'>;

/**
 * Hosts and origins the daemon answers to. Locally that is the bind address (plus loopback aliases in a container);
 * behind a reverse proxy the public origin is added. Shared by the Hono app, the static handler and the WS upgrade.
 */
export const allowedHostsAndOrigins = (config: PolicyConfig): { hosts: Set<string>; origins: Set<string> } => {
  const local = [`${config.host}:${config.port}`, ...(config.containerMode ? [`127.0.0.1:${config.port}`, `localhost:${config.port}`] : [])];
  const origins = new Set(local.map(host => `http://${host}`)); const hosts = new Set(local);
  if (config.publicOrigin) { origins.add(config.publicOrigin); hosts.add(new URL(config.publicOrigin).host); }
  return { hosts, origins };
};

export const isHttpsPublic = (config: Pick<AppConfig, 'publicOrigin'>): boolean => config.publicOrigin?.startsWith('https:') ?? false;

/** Response headers applied to every HTTP answer (API and static client). */
export const securityHeaders = (config: Pick<AppConfig, 'publicOrigin'>): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(isHttpsPublic(config) ? { 'strict-transport-security': 'max-age=31536000' } : {}),
});

/** Client address used for login throttling: the socket peer, or the proxy-appended X-Forwarded-For hop when trusted. */
export const clientPeer = (forwardedFor: string | string[] | undefined, socketAddress: string | undefined, trustProxy: boolean): string => {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const hop = trustProxy ? header?.split(',').map(part => part.trim()).filter(Boolean).at(-1) : undefined;
  return hop ?? socketAddress ?? 'unknown';
};
