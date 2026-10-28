import path from 'node:path';

const positiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export type AppConfig = {
  dataDir: string;
  host: string;
  port: number;
  sessionTtlSeconds: number;
  containerMode: boolean;
  maxAutoWakes: number;
  wakeWaitSeconds: number;
  /** Public https origin when served behind a reverse proxy (e.g. https://office.example.com); null = local only. */
  publicOrigin: string | null;
  /** Take the client address from the proxy's X-Forwarded-For (last hop). Only safe when the port is reachable solely via that proxy. */
  trustProxy: boolean;
  minPasswordLength: number;
  /** Lets agents' PermissionRequest hooks hand prompts to the manager UI. Enable only behind HTTPS + strong password. */
  remoteApproval: boolean;
  /** Telegram bot for manager notifications (off when null) and the proxy all Telegram traffic must use. Never logged. */
  telegramBotToken: string | null;
  telegramProxy: string | null;
};

/** Normalizes AGENT_OFFICE_PUBLIC_ORIGIN to a bare origin; rejects paths and non-http(s) schemes so a typo fails fast. */
const parseOrigin = (value: string | undefined): string | null => {
  if (!value) return null;
  const url = new URL(value);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('invalid_public_origin');
  return url.origin;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => ({
  dataDir: path.resolve(env.AGENT_OFFICE_DATA_DIR ?? path.join(process.cwd(), 'data')),
  host: env.AGENT_OFFICE_HOST ?? '127.0.0.1',
  port: positiveInteger(env.AGENT_OFFICE_PORT, 8080),
  sessionTtlSeconds: positiveInteger(env.AGENT_OFFICE_SESSION_TTL_SECONDS, 43_200),
  containerMode: env.AGENT_OFFICE_CONTAINER_MODE === 'true',
  maxAutoWakes: positiveInteger(env.AGENT_OFFICE_MAX_AUTO_WAKES, 15),
  wakeWaitSeconds: Math.min(positiveInteger(env.AGENT_OFFICE_WAKE_WAIT_SECONDS, 290), 3500),
  publicOrigin: parseOrigin(env.AGENT_OFFICE_PUBLIC_ORIGIN),
  trustProxy: env.AGENT_OFFICE_TRUST_PROXY === 'true',
  remoteApproval: env.AGENT_OFFICE_REMOTE_APPROVAL === 'true',
  telegramBotToken: env.AGENT_OFFICE_TELEGRAM_BOT_TOKEN?.trim() || null,
  telegramProxy: env.AGENT_OFFICE_TELEGRAM_PROXY?.trim() || null,
  minPasswordLength: Math.max(positiveInteger(env.AGENT_OFFICE_MIN_PASSWORD_LENGTH, 8), 8),
});
