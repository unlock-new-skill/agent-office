import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from './auth/auth-service.js';
import { OfficeError } from './collaboration/office-error.js';
import type { Office } from './collaboration/office.js';
import { logger } from './logger.js';
import { RUNNER_COMMAND_KINDS } from '../shared/contracts.js';

type Deps = { auth: AuthService; office: Office; manager: (request: Request) => unknown };
const json = (message: string, status: number): Response => Response.json({ error: message }, { status });

const seatId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const RunnerSeatSchema = z.object({
  seatId, state: z.enum(['starting', 'running', 'idle', 'stopped', 'failed']), sessionId: z.string().max(128).nullable(),
  restarts: z.number().int().min(0).max(1_000_000), permissionMode: z.string().max(40), detail: z.string().max(300),
}).strict();
const LogEntrySchema = z.object({ seatId, ts: z.number().int().min(0), kind: z.enum(['text', 'tool', 'result', 'error', 'state', 'prompt']), summary: z.string().max(500) }).strict();

/**
 * Runner endpoints authenticate with the machine's connector credential (the runner id is that credential's id) and
 * only carry seat ids, states and log lines — never paths or command lines. Manager endpoints queue commands.
 */
export const registerRunnerRoutes = (app: Hono, deps: Deps): void => {
  const { office } = deps;
  const handle = async (run: () => Promise<Response> | Response): Promise<Response> => {
    try { return await run(); }
    catch (error) {
      if (error instanceof OfficeError) return json(error.code, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return json('invalid_request', 400);
      logger.error(error); return json('internal_error', 500);
    }
  };
  const asRunner = (c: Context, run: (runnerId: string) => Promise<Response> | Response): Promise<Response> => {
    const connector = deps.auth.authenticateConnector(c.req.raw);
    return connector ? handle(() => run(connector.id)) : Promise.resolve(json('unauthorized', 401));
  };
  const asManager = (c: Context, run: () => Promise<Response> | Response): Promise<Response> => deps.manager(c.req.raw) ? handle(run) : Promise.resolve(json('unauthorized', 401));

  app.post('/v1/runners/register', c => asRunner(c, async runnerId => {
    const body = z.object({ machine: z.string().min(1).max(120), seats: z.array(RunnerSeatSchema).max(20) }).strict().parse(await c.req.json());
    return c.json(office.runners.register(runnerId, body.machine, body.seats));
  }));
  app.get('/v1/runners/me/commands', c => asRunner(c, async runnerId => {
    const { wait } = z.object({ wait: z.coerce.number().int().min(0).max(60).default(0) }).parse(c.req.query());
    return c.json({ commands: await office.runners.poll(runnerId, wait * 1000, c.req.raw.signal) });
  }));
  app.post('/v1/runners/me/commands/:id/result', c => asRunner(c, async runnerId => {
    const body = z.object({ ok: z.boolean(), message: z.string().max(2000) }).strict().parse(await c.req.json());
    return c.json(office.runners.complete(runnerId, c.req.param('id'), body.ok, body.message));
  }));
  app.post('/v1/runners/me/status', c => asRunner(c, async runnerId => {
    const body = z.object({ seats: z.array(RunnerSeatSchema).max(20) }).strict().parse(await c.req.json());
    office.runners.updateSeats(runnerId, body.seats); return c.json({ ok: true });
  }));
  app.post('/v1/runners/me/log', c => asRunner(c, async runnerId => {
    const body = z.object({ entries: z.array(LogEntrySchema).max(200) }).strict().parse(await c.req.json());
    office.runners.appendLog(runnerId, body.entries); return c.json({ ok: true });
  }));

  app.get('/v1/runners', c => asManager(c, () => c.json({ runners: office.runners.views() })));
  app.post('/v1/seats/:id/runner-commands', c => asManager(c, async () => {
    const body = z.object({ kind: z.enum(RUNNER_COMMAND_KINDS), text: z.string().min(1).max(8000).optional() }).strict().parse(await c.req.json());
    if (body.kind === 'prompt' && !body.text?.trim()) return json('prompt_required', 400);
    return c.json(office.runners.enqueue(seatId.parse(c.req.param('id')), body.kind, body.text ?? null, 'manager'), 201);
  }));
  app.get('/v1/seats/:id/runner-commands', c => asManager(c, () => c.json({ commands: office.runners.commands(seatId.parse(c.req.param('id'))) })));
  app.get('/v1/seats/:id/runner-log', c => asManager(c, () => c.json({ entries: office.runners.log(seatId.parse(c.req.param('id'))) })));
};
