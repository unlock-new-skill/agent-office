import { socksDispatcher } from 'fetch-socks';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';

/** Dispatcher for `http(s)://user:pass@host:port` or `socks5://user:pass@host:port`; undefined means direct. */
export const proxyDispatcher = (proxyUrl: string | null): Dispatcher | undefined => {
  if (!proxyUrl) return undefined;
  const url = new URL(proxyUrl);
  if (url.protocol === 'socks5:' || url.protocol === 'socks4:' || url.protocol === 'socks:') {
    return socksDispatcher({
      type: url.protocol === 'socks4:' ? 4 : 5, host: url.hostname, port: Number(url.port || 1080),
      ...(url.username ? { userId: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    });
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return new ProxyAgent(proxyUrl);
  throw new Error('AGENT_OFFICE_TELEGRAM_PROXY must start with http://, https:// or socks5://');
};

/** Proxy URL with the credentials masked, for logs. */
export const describeProxy = (proxyUrl: string | null): string => {
  if (!proxyUrl) return 'direct';
  try { const url = new URL(proxyUrl); return `${url.protocol}//${url.username ? '***@' : ''}${url.host}`; } catch { return 'invalid'; }
};

export type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; dispatcher?: Dispatcher }) => Promise<{ json: () => Promise<unknown> }>;

/** Minimal Bot API client; every call goes through the configured proxy and errors never contain the bot token. */
export class TelegramClient {
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly token: string, proxyUrl: string | null, private readonly fetchImpl: TelegramFetch = undiciFetch as unknown as TelegramFetch) {
    this.dispatcher = proxyDispatcher(proxyUrl);
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
      const payload = await response.json() as { ok: boolean; result?: T; description?: string };
      if (!payload.ok) throw new Error(`telegram ${method}: ${payload.description ?? 'request failed'}`);
      return payload.result as T;
    } catch (error) {
      const message = error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ''}` : 'request failed';
      throw new Error(message.replaceAll(this.token, '***'));
    }
  }
}
