import type { Hono } from 'hono';
import type { TelegramNotifier } from './telegram-notifier.js';

type Deps = { manager: (request: Request) => unknown; notifier: TelegramNotifier | null };
const json = (message: string, status: number): Response => Response.json({ error: message }, { status });

/** Manager-only Telegram setup: status, pairing code, test message, unpair. Secrets never leave the server. */
export const registerNotifyRoutes = (app: Hono, deps: Deps): void => {
  const guard = (request: Request): Response | null => !deps.manager(request) ? json('unauthorized', 401) : null;
  app.get('/v1/notify/telegram', c => guard(c.req.raw) ?? c.json(deps.notifier?.status() ?? { enabled: false, paired: false, botUsername: null }));
  app.post('/v1/notify/telegram/pair', c => guard(c.req.raw) ?? (deps.notifier ? c.json(deps.notifier.startPairing(), 201) : json('telegram_disabled', 409)));
  app.post('/v1/notify/telegram/test', async c => {
    const denied = guard(c.req.raw); if (denied) return denied;
    if (!deps.notifier) return json('telegram_disabled', 409);
    try { await deps.notifier.sendTest(); return c.json({ ok: true }); }
    catch (error) { return json((error as Error).message === 'not_paired' ? 'not_paired' : 'telegram_unreachable', 502); }
  });
  app.delete('/v1/notify/telegram', c => guard(c.req.raw) ?? (deps.notifier ? (deps.notifier.unpair(), c.json({ ok: true })) : json('telegram_disabled', 409)));
};
