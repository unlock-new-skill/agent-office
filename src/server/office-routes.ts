import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { agentGuide } from '../shared/agent-guide.js';
import { DepartmentInputSchema, SeatInputSchema } from '../shared/contracts.js';
import type { AuthService, Credential } from './auth/auth-service.js';
import type { Actor } from './collaboration/message-service.js';
import type { Office } from './collaboration/office.js';
import { OfficeError } from './collaboration/office-error.js';
import { logger } from './logger.js';

type Deps = { auth: AuthService; office: Office; manager: (request: Request) => unknown; wakeWaitSeconds: number; publicOrigin: string | null };
type Resolved = { actor: Actor; credential: Credential | null };
const json = (message: string, status: number): Response => Response.json({ error: message }, { status });
const PageSchema = z.object({ after: z.coerce.number().int().min(0).optional(), before: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), view: z.enum(['all', 'timeline']).default('all') });

/** Runs a handler, mapping domain/validation errors to stable JSON error responses. */
const handle = async (run: () => Promise<Response> | Response): Promise<Response> => {
  try { return await run(); }
  catch (error) {
    if (error instanceof OfficeError) return json(error.code, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json('invalid_request', 400);
    logger.error(error); return json('internal_error', 500);
  }
};

export const registerOfficeRoutes = (app: Hono, deps: Deps): void => {
  const { auth, office } = deps;

  /** Manager (cookie + CSRF) or a seated agent (bearer). Unseated agents get 403 not_seated. */
  const actorFor = (request: Request): Resolved | Response => {
    if (deps.manager(request)) return { actor: { kind: 'manager' }, credential: null };
    const credential = auth.authenticateBearer(request);
    if (!credential) return json('unauthorized', 401);
    const seat = office.org.seatForAgent(credential.agentId);
    return seat ? { actor: { kind: 'seat', seatId: seat.id }, credential } : json('not_seated', 403);
  };
  const managerOnly = (c: Context, run: () => Promise<Response> | Response): Promise<Response> => deps.manager(c.req.raw) ? handle(run) : Promise.resolve(json('unauthorized', 401));
  const withActor = (c: Context, run: (resolved: Resolved) => Promise<Response> | Response): Promise<Response> => {
    const resolved = actorFor(c.req.raw);
    return resolved instanceof Response ? Promise.resolve(resolved) : handle(() => run(resolved));
  };

  app.get('/v1/org', c => managerOnly(c, () => c.json(office.org.view())));
  app.post('/v1/departments', c => managerOnly(c, async () => c.json(office.org.createDepartment(DepartmentInputSchema.parse(await c.req.json())), 201)));
  app.patch('/v1/departments/:id', c => managerOnly(c, async () => {
    const patch = z.object({ name: z.string().min(1).max(80).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), paused: z.boolean().optional(), deputySeatId: z.string().min(1).max(64).nullable().optional() }).strict().parse(await c.req.json());
    return c.json(office.org.updateDepartment(c.req.param('id'), patch));
  }));
  app.delete('/v1/departments/:id', c => managerOnly(c, () => { office.org.deleteDepartment(c.req.param('id')); return c.json({ ok: true }); }));
  app.post('/v1/departments/:id/seats', c => managerOnly(c, async () => c.json(office.org.createSeat(c.req.param('id'), SeatInputSchema.parse(await c.req.json())), 201)));
  app.patch('/v1/seats/:id', c => managerOnly(c, async () => c.json(office.org.updateSeat(c.req.param('id'), SeatInputSchema.omit({ id: true }).partial().strict().parse(await c.req.json())))));
  app.delete('/v1/seats/:id', c => managerOnly(c, () => { office.org.deleteSeat(c.req.param('id')); return c.json({ ok: true }); }));

  app.post('/v1/seats/:id/reset-wakes', c => managerOnly(c, () => c.json(office.org.resetWakeLimit(c.req.param('id')))));
  app.put('/v1/seats/:id/agent', c => managerOnly(c, async () => {
    const { agentId } = z.object({ agentId: z.string().min(1).max(128).nullable() }).strict().parse(await c.req.json());
    return c.json(office.org.assignAgent(c.req.param('id'), agentId));
  }));

  app.post('/v1/seats/leave', c => {
    const credential = auth.authenticateBearer(c.req.raw);
    if (!credential) return Promise.resolve(json('unauthorized', 401));
    return handle(() => { office.org.releaseAgent(credential.agentId); return c.json({ ok: true }); });
  });
  app.post('/v1/seats/:id/claim', c => {
    const credential = auth.authenticateBearer(c.req.raw);
    if (!credential) return Promise.resolve(json('unauthorized', 401));
    return handle(() => c.json(office.org.claimSeat(c.req.param('id'), credential.agentId)));
  });
  // The request URL is what the proxy forwarded (plain http); links shown to people must use the public origin.
  const originOf = (c: Context): string => deps.publicOrigin ?? new URL(c.req.url).origin;
  /** Read-only pages for anyone authenticated: the manager (cookie, no CSRF on GET) or any registered agent session. */
  const signedIn = (c: Context): boolean => Boolean(auth.authenticateRequest(c.req.raw) ?? auth.authenticateBearer(c.req.raw));
  // Human-readable join instructions for a seat; the link itself is what agents pass to agent_office_join.
  app.get('/join/:id', c => signedIn(c) ? handle(() => {
    const seat = office.org.seat(c.req.param('id')); const department = office.org.department(seat.departmentId);
    const link = `${originOf(c)}/join/${encodeURIComponent(seat.id)}`;
    return c.text([
      `Agent Office seat: ${seat.title} (@${seat.id}) — ${seat.role} of ${department.name}`,
      `Specialty: ${seat.description || 'n/a'}`,
      `Status: ${seat.agentId ? 'taken (a new claim is refused while that session is alive)' : 'vacant'}`,
      '',
      'Join from a Claude Code session that has the Agent Office hooks + MCP installed:',
      `  Tell the agent: "Join Agent Office: ${link}"  (it calls the agent_office_join tool)`,
      'Or start a new session already seated:',
      `  AGENT_OFFICE_SEAT=${seat.id} claude`,
    ].join('\n'));
  }) : Promise.resolve(c.text([
    // Agents sometimes fetch the link instead of using the tool; tell them what to do without revealing seat details.
    'This is an Agent Office seat join link. It is not a web page to read.',
    'Inside a Claude Code session with Agent Office installed: call the agent_office_join tool with this URL as "seat",',
    'or paste the link into the prompt (the hook joins automatically). Sign in to the web UI to see seat details.',
  ].join('\n'), 401)));

  app.get('/v1/seats/:id/handoff', c => withActor(c, ({ actor }) => c.json({ handoff: office.handoffs.get(actor, c.req.param('id')) })));
  app.put('/v1/seats/:id/handoff', c => withActor(c, async ({ actor }) => {
    const { body } = z.object({ body: z.string().max(8000) }).strict().parse(await c.req.json());
    return c.json(office.handoffs.save(actor, c.req.param('id'), body));
  }));

  // PostCompact hook: keep the summary Claude Code wrote so the seat's next session (any machine) can continue.
  app.post('/v1/seats/me/compaction', c => withActor(c, async ({ actor, credential }) => {
    if (actor.kind !== 'seat' || !credential) return json('seat_only', 403);
    const { summary } = z.object({ summary: z.string().min(1).max(200_000) }).strict().parse(await c.req.json());
    office.handoffs.saveCompaction(actor.seatId, credential.agentId, summary);
    return c.json({ ok: true });
  }));

  app.post('/v1/connectors', c => managerOnly(c, () => c.json(auth.createConnectorCredential(), 201)));
  app.post('/v1/sessions/register', async c => {
    const connector = auth.authenticateConnector(c.req.raw);
    if (!connector) return json('unauthorized', 401);
    return handle(async () => {
      const input = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), project: z.string().min(1).max(512) }).strict().parse(await c.req.json());
      return c.json(auth.registerSession(input, connector.machine), 201);
    });
  });

  app.get('/v1/wake', c => {
    // A live session is one that keeps asking; a session picked on the web for a runner is told to close first.
    const credential = auth.authenticateBearer(c.req.raw);
    if (credential) {
      office.touchAgent(credential.agentId);
      // Listeners that understand takeovers close Claude themselves; older ones get one short turn, after which the
      // next Stop hook runs the current connector and closes it.
      if (office.runners.isTakenOver(credential.agentId)) return c.json(c.req.query('takeover') === '1' ? { wake: false, state: 'taken_over' } : { wake: true, reason: '[Agent Office] A runner is taking over this session. End your turn now without doing anything else.' });
    }
    return wakeRoute(c);
  });
  const wakeRoute = (c: Context): Promise<Response> => withActor(c, async ({ actor }) => {
    if (actor.kind !== 'seat') return json('seat_only', 403);
    const { wait } = z.object({ wait: z.coerce.number().int().min(0).max(deps.wakeWaitSeconds).default(0) }).parse(c.req.query());
    const result = await office.wake.wait(actor.seatId, wait * 1000, c.req.raw.signal);
    return c.json(result.wake ? { wake: true, reason: result.reason, items: result.items } : result);
  });

  // Remote permission approval: the agent's hook files a prompt and long-polls; the manager answers from the UI.
  app.post('/v1/permissions', async c => {
    const credential = auth.authenticateBearer(c.req.raw);
    if (!credential) return json('unauthorized', 401);
    return handle(async () => {
      const input = z.object({ tool: z.string().min(1).max(128), input: z.unknown() }).strict().parse(await c.req.json());
      return c.json(office.permissions.create(credential.agentId, input.tool, input.input), 201);
    });
  });
  app.get('/v1/permissions/:id/decision', async c => {
    const credential = auth.authenticateBearer(c.req.raw);
    if (!credential) return json('unauthorized', 401);
    return handle(async () => {
      const { wait, final } = z.object({ wait: z.coerce.number().int().min(0).max(600).default(0), final: z.enum(['true', 'false']).default('true') }).parse(c.req.query());
      return c.json(await office.permissions.wait(c.req.param('id'), credential.agentId, wait * 1000, c.req.raw.signal, final === 'true'));
    });
  });
  app.get('/v1/permissions', c => managerOnly(c, () => c.json({ enabled: office.permissions.enabled, pending: office.permissions.pending() })));
  app.post('/v1/permissions/:id/decision', c => managerOnly(c, async () => {
    const { behavior, message } = z.object({ behavior: z.enum(['allow', 'deny']), message: z.string().max(500).default('') }).strict().parse(await c.req.json());
    return c.json(office.permissions.decide(c.req.param('id'), behavior, message));
  }));

  const TaskStatusSchema = z.enum(['todo', 'doing', 'blocked', 'done']);
  const TaskPlanSchema = { estimateMinutes: z.number().int().min(1).max(10_080).nullable().optional(), dependsOn: z.array(z.string().min(1).max(80)).max(20).optional() };
  app.get('/v1/tasks', c => withActor(c, ({ actor }) => {
    const filter = z.object({ departmentId: z.string().max(64).optional(), status: TaskStatusSchema.optional(), assignee: z.string().max(64).optional() }).parse(c.req.query());
    return c.json({ tasks: office.tasks.list(actor, filter) });
  }));
  app.post('/v1/tasks', c => withActor(c, async ({ actor }) => {
    const input = z.object({ departmentId: z.string().max(64).optional(), title: z.string().max(200), body: z.string().max(8000).default(''), assigneeSeatId: z.string().min(1).max(64), requestedBy: z.string().min(1).max(64).optional(), ...TaskPlanSchema }).strict().parse(await c.req.json());
    return c.json(office.tasks.create(actor, input), 201);
  }));
  app.patch('/v1/tasks/:id', c => withActor(c, async ({ actor }) => {
    const patch = z.object({ status: TaskStatusSchema.optional(), note: z.string().max(2000).optional(), assigneeSeatId: z.string().min(1).max(64).optional(), ...TaskPlanSchema }).strict().parse(await c.req.json());
    return c.json(office.tasks.update(actor, c.req.param('id'), patch));
  }));

  app.get('/v1/channels', c => withActor(c, ({ actor }) => c.json({ channels: actor.kind === 'manager' ? office.org.view().channels : office.messages.channelsForSeat(actor.seatId) })));
  app.get('/v1/channels/:id/messages', c => withActor(c, ({ actor }) => {
    const { view, ...page } = PageSchema.parse(c.req.query());
    return c.json({ messages: office.messages.list(actor, c.req.param('id'), { ...page, topLevel: view === 'timeline' }) });
  }));
  app.post('/v1/channels/:id/messages', c => withActor(c, async ({ actor }) => {
    const { body, threadSeq } = z.object({ body: z.string().max(16_384), threadSeq: z.number().int().min(1).optional() }).strict().parse(await c.req.json());
    return c.json(office.messages.post(actor, c.req.param('id'), body, threadSeq), 201);
  }));
  app.get('/v1/channels/:id/threads/:seq', c => withActor(c, ({ actor }) => c.json(office.messages.thread(actor, c.req.param('id'), z.coerce.number().int().min(1).parse(c.req.param('seq'))))));
  const seqParam = (c: Context): number => z.coerce.number().int().min(1).parse(c.req.param('seq'));
  app.patch('/v1/channels/:id/messages/:seq', c => withActor(c, async ({ actor }) => {
    const { body } = z.object({ body: z.string().max(16_384) }).strict().parse(await c.req.json());
    return c.json(office.messages.edit(actor, c.req.param('id'), seqParam(c), body));
  }));
  app.delete('/v1/channels/:id/messages/:seq', c => withActor(c, ({ actor }) => c.json(office.messages.remove(actor, c.req.param('id'), seqParam(c)))));
  app.get('/agent-guide', c => signedIn(c) ? c.body(agentGuide(originOf(c)), 200, { 'content-type': 'text/markdown; charset=utf-8' }) : json('unauthorized', 401));

  app.post('/v1/channels/:id/read', c => withActor(c, async ({ actor }) => {
    const { seq } = z.object({ seq: z.number().int().min(0) }).strict().parse(await c.req.json());
    if (actor.kind === 'seat') office.messages.markRead(actor.seatId, c.req.param('id'), seq);
    return c.json({ ok: true });
  }));
};
