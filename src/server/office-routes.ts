import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { agentGuide } from '../shared/agent-guide.js';
import { BLOCKER_KINDS, DepartmentInputSchema, SeatInputSchema, TASK_RESULTS, type SeatActivity } from '../shared/contracts.js';
import type { AuthService, Credential } from './auth/auth-service.js';
import type { ServiceScope } from './auth/service-token-service.js';
import type { Actor } from './collaboration/message-service.js';
import type { Office } from './collaboration/office.js';
import { MAX_ARCHIVE_BATCH } from './collaboration/task-service.js';
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
    if (error instanceof OfficeError) return Response.json({ ...error.details, error: error.code }, { status: error.status });
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

  const AfterTaskSchema = z.enum(['compact', 'clear', 'off']);
  app.put('/v1/seats/:id/after-task', c => managerOnly(c, async () => c.json(office.org.setAfterTask(c.req.param('id'), z.object({ mode: AfterTaskSchema.nullable() }).strict().parse(await c.req.json()).mode))));
  app.get('/v1/settings/after-task', c => managerOnly(c, () => c.json({ mode: office.afterTaskDefault() })));
  app.put('/v1/settings/after-task', c => managerOnly(c, async () => c.json({ mode: office.setAfterTaskDefault(z.object({ mode: AfterTaskSchema.nullable() }).strict().parse(await c.req.json()).mode) })));
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
  /** The read-only service token of the request (validated and limited to read routes by app.ts), if any. */
  const serviceOf = (request: Request): ServiceScope | null => {
    const authorization = request.headers.get('authorization') ?? '';
    return authorization.startsWith('Bearer aos_') ? office.serviceTokens.authenticate(authorization.slice('Bearer '.length)) : null;
  };
  const inScope = (scope: ServiceScope, departmentId: string): boolean => scope.departments === null || scope.departments.includes(departmentId);
  /** Runs a read for a service token; departmentId, when given, must be inside the token's scope. */
  const asService = (c: Context, run: (scope: ServiceScope) => Response): Promise<Response> | null => {
    const scope = serviceOf(c.req.raw);
    if (!scope) return null;
    return handle(() => {
      const departmentId = c.req.query('departmentId');
      if (departmentId && !inScope(scope, departmentId)) return json('outside_token_scope', 403);
      return run(scope);
    });
  };
  const PageQuery = z.object({ departmentId: z.string().max(64).optional(), status: TaskStatusSchema.optional(), assignee: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(400).optional(), includeArchived: z.enum(['true', 'false', '1', '0']).optional() });
  /** Archived tasks are left out unless the caller asks for them (old clients never do, so they keep seeing live work only). */
  const withArchived = (value: string | undefined): boolean => value === 'true' || value === '1';
  app.get('/v1/tasks', c => asService(c, scope => {
    const query = PageQuery.parse(c.req.query());
    return c.json(office.tasks.page({ departments: scope.departments, departmentId: query.departmentId, status: query.status, includeArchived: withArchived(query.includeArchived) }, query.limit ?? 100, query.cursor));
  }) ?? withActor(c, ({ actor }) => {
    const query = PageQuery.parse(c.req.query());
    // The manager may page the whole office (stable snapshot); without limit/cursor the classic list is returned.
    if (actor.kind === 'manager' && (query.limit !== undefined || query.cursor !== undefined)) return c.json(office.tasks.page({ departments: null, departmentId: query.departmentId, status: query.status, includeArchived: withArchived(query.includeArchived) }, query.limit ?? 100, query.cursor));
    return c.json({ tasks: office.tasks.list(actor, { departmentId: query.departmentId, status: query.status, assignee: query.assignee, includeArchived: withArchived(query.includeArchived) }) });
  }));
  /** Departments and seats (names for ids) in the caller's scope. */
  app.get('/v1/directory', c => {
    const view = (departments: string[] | null): Response => {
      const org = office.org.view(); const keep = (id: string): boolean => departments === null || departments.includes(id);
      return c.json({ departments: org.departments.filter(department => keep(department.id)).map(({ id, name, color }) => ({ id, name, color })), seats: org.seats.filter(seat => keep(seat.departmentId)).map(({ id, title, departmentId, role, coordinator }) => ({ id, title, departmentId, role, coordinator })) });
    };
    return asService(c, scope => view(scope.departments)) ?? withActor(c, () => view(null));
  });
  const TaskKindSchema = z.enum(['execution', 'tracking']);
  const TaskIdList = z.array(z.string().min(1).max(80)).max(20);
  const sourceOf = (actor: Actor): 'ui' | 'mcp' => actor.kind === 'manager' ? 'ui' : 'mcp';
  app.post('/v1/tasks', c => withActor(c, async ({ actor }) => {
    const input = z.object({ departmentId: z.string().max(64).optional(), title: z.string().max(200), body: z.string().max(8000).default(''), assigneeSeatId: z.string().min(1).max(64), requestedBy: z.string().min(1).max(64).optional(), parentId: z.string().min(1).max(80).optional(), parallel: z.boolean().optional(), kind: TaskKindSchema.optional(), passRequired: TaskIdList.optional(), projectId: z.string().min(1).max(40).optional(), ...TaskPlanSchema }).strict().parse(await c.req.json());
    return c.json(office.tasks.create(actor, input), 201);
  }));
  /**
   * Projects (orders): the manager or a coordinator files and edits them; every seat reads them. Tasks join a project
   * through projectId on task create/update; the detail shows each visible task's state, owner and delivered output.
   */
  const ProjectFields = { goal: z.string().max(4000).optional(), spec: z.string().max(20_000).optional(), requirements: z.string().max(20_000).optional(), acceptance: z.string().max(8000).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), links: z.array(z.string().max(500)).max(20).optional() };
  app.get('/v1/projects', c => withActor(c, ({ actor }) => c.json({ projects: office.projects.list(actor) })));
  app.get('/v1/projects/:id', c => withActor(c, ({ actor }) => c.json(office.projects.detail(actor, c.req.param('id')))));
  app.post('/v1/projects', c => withActor(c, async ({ actor }) => c.json(office.projects.create(actor, z.object({ title: z.string().max(200), ...ProjectFields }).strict().parse(await c.req.json())), 201)));
  app.patch('/v1/projects/:id', c => withActor(c, async ({ actor }) => c.json(office.projects.update(actor, c.req.param('id'), z.object({ title: z.string().max(200).optional(), status: z.enum(['open', 'closed']).optional(), expectedRevision: z.number().int().min(0).optional(), ...ProjectFields }).strict().parse(await c.req.json())))));
  /**
   * Bulk archive / restore of exact task ids (manager, coordinators, a leader or deputy in their department). Without
   * confirm: a dry run listing eligible ids with their revision and refused ids with the reason. With confirm: applied
   * only if nothing is refused and every eligible id comes with its previewed revision (409 otherwise, nothing written).
   */
  const ArchiveBody = z.object({ taskIds: z.array(z.string().min(1).max(80)).min(1).max(MAX_ARCHIVE_BATCH).optional(), confirm: z.boolean().optional(), expectedRevisions: z.record(z.string().max(80), z.number().int().min(0)).optional(), revisions: z.array(z.object({ id: z.string().min(1).max(80), revision: z.number().int().min(0), status: z.string().max(20).optional() })).max(MAX_ARCHIVE_BATCH).optional(), reason: z.string().max(2000).optional() }).strict();
  app.post('/v1/tasks/archive', c => withActor(c, async ({ actor }) => c.json(office.tasks.archive(actor, 'archive', ArchiveBody.parse(await c.req.json()), sourceOf(actor)))));
  app.post('/v1/tasks/restore', c => withActor(c, async ({ actor }) => c.json(office.tasks.archive(actor, 'restore', ArchiveBody.parse(await c.req.json()), sourceOf(actor)))));
  const taskDetail = (actor: Actor, taskId: string, keep: (departmentId: string) => boolean, withProgress = true): Record<string, unknown> => {
    const read = office.tasks.read(actor, taskId);
    const blockers = office.blockers.list({ taskId }).map(blocker => ({ ...blocker, taskIds: blocker.taskIds.filter(id => keep(office.tasks.get(id).departmentId)) }));
    const detail = { ...read, task: office.tasks.withActivity([read.task])[0], readiness: office.dispatch.readiness(taskId), blockers };
    // Participant notes and output evidence stay inside the Office: read-only service tokens do not get them.
    return !withProgress ? detail : { ...detail, participants: office.progress.participants(taskId), outputs: office.progress.outputs(taskId) };
  };
  app.get('/v1/tasks/:id', c => asService(c, scope => {
    const task = office.tasks.get(c.req.param('id'));
    if (!inScope(scope, task.departmentId)) return json('task_not_found', 404);
    return c.json(taskDetail({ kind: 'manager' }, task.id, departmentId => inScope(scope, departmentId), false));
  }) ?? withActor(c, ({ actor }) => c.json(taskDetail(actor, c.req.param('id'), () => true))));
  app.post('/v1/tasks/:id/start', c => withActor(c, async ({ actor }) => {
    const input = z.object({ generation: z.number().int().min(0).optional(), expectedRevision: z.number().int().min(0).optional(), estimateMinutes: z.number().int().min(1).max(10_080).optional() }).strict().parse(await c.req.json());
    return c.json(office.dispatch.start(actor, c.req.param('id'), input, sourceOf(actor)));
  }));
  const BoardQuery = z.object({ departmentId: z.string().max(64).optional(), assignee: z.string().max(64).optional(), resolver: z.string().max(65).optional() });
  const boardFor = (actor: Actor, query: z.infer<typeof BoardQuery>): Record<string, unknown> => {
    const board = office.dispatch.board(actor, query);
    return { ...board, alerts: board.dispatch === 'off' ? [] : office.alerts.current(Date.now(), board.scope.departmentId) };
  };
  app.get('/v1/board', c => asService(c, scope => {
    const query = BoardQuery.parse(c.req.query());
    // A token scoped to departments reads one department's board at a time.
    const departmentId = query.departmentId ?? (scope.departments?.length === 1 ? scope.departments[0] : undefined);
    if (scope.departments && !departmentId) return json('department_required', 400);
    return c.json(boardFor({ kind: 'manager' }, { ...query, departmentId }));
  }) ?? withActor(c, ({ actor }) => c.json(boardFor(actor, BoardQuery.parse(c.req.query())))));
  /** Read-only service tokens for server integrations: manager only; the token is returned once, never listed again. */
  app.get('/v1/service-tokens', c => managerOnly(c, () => c.json({ serviceTokens: office.serviceTokens.list() })));
  app.post('/v1/service-tokens', c => managerOnly(c, async () => {
    const input = z.object({ label: z.string().min(1).max(80), departments: z.array(z.string().min(1).max(64)).max(50).nullable().optional(), expiresInDays: z.number().int().min(1).max(365).optional() }).strict().parse(await c.req.json());
    const created = office.serviceTokens.create(input);
    return new Response(JSON.stringify(created), { status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }));
  app.post('/v1/service-tokens/:id/revoke', c => managerOnly(c, () => c.json(office.serviceTokens.revoke(c.req.param('id')))));
  /**
   * Who works on what: participants and partial outputs of the tasks the caller sees, and every seat's activity derived
   * from them. A seat sees the activity of its own department's seats and of seats working on tasks it can read; titles
   * of tasks it cannot read are hidden.
   */
  app.get('/v1/progress', c => withActor(c, ({ actor }) => {
    const cache = new Map<string, boolean>();
    const readable = (taskId: string): boolean => {
      if (!cache.has(taskId)) { let ok = false; try { ok = office.tasks.canRead(actor, office.tasks.get(taskId)); } catch { ok = false; } cache.set(taskId, ok); }
      return cache.get(taskId)!;
    };
    const seesAll = actor.kind === 'manager' || office.org.seat(actor.seatId).coordinator;
    const home = actor.kind === 'seat' ? office.org.seat(actor.seatId).departmentId : null;
    const departmentOf = new Map(office.org.view().seats.map(seat => [seat.id, seat.departmentId]));
    const activity = office.progress.activity()
      .filter(entry => seesAll || departmentOf.get(entry.seatId) === home || (entry.taskId !== null && readable(entry.taskId)))
      .map((entry): SeatActivity => entry.taskId && !readable(entry.taskId) ? { ...entry, taskId: null, taskTitle: null, phase: '', reasons: [], also: entry.also.filter(item => readable(item.taskId)) } : { ...entry, also: entry.also.filter(item => readable(item.taskId)) });
    return c.json({ participants: office.progress.participants().filter(row => readable(row.taskId)), outputs: office.progress.outputs().filter(row => readable(row.taskId)), activity });
  }));
  const RoleSchema = z.enum(['executor', 'reviewer', 'intake']);
  app.put('/v1/tasks/:id/participants', c => withActor(c, async ({ actor }) => {
    const input = z.object({ seatId: z.string().min(1).max(65), role: RoleSchema, state: z.enum(['active', 'waiting', 'done', 'stopped']), phase: z.string().max(200).optional(), note: z.string().max(500).optional() }).strict().parse(await c.req.json());
    return c.json(office.progress.setParticipant(actor, c.req.param('id'), input, sourceOf(actor)));
  }));
  app.delete('/v1/tasks/:id/participants/:seatId/:role', c => withActor(c, ({ actor }) => { office.progress.removeParticipant(actor, c.req.param('id'), c.req.param('seatId'), RoleSchema.parse(c.req.param('role')), sourceOf(actor)); return c.json({ ok: true }); }));
  app.post('/v1/tasks/:id/outputs', c => withActor(c, async ({ actor }) => {
    const input = z.object({ name: z.string().min(1).max(200), scope: z.string().max(80).optional(), evidence: z.string().max(1000).optional(), result: z.enum(TASK_RESULTS).optional(), missing: z.string().max(1000).optional() }).strict().parse(await c.req.json());
    return c.json(office.progress.recordOutput(actor, c.req.param('id'), input, sourceOf(actor)), 201);
  }));
  app.post('/v1/tasks/:id/outputs/:outputId/accept', c => withActor(c, async ({ actor }) => {
    const input = z.object({ note: z.string().max(1000).optional(), missing: z.string().max(1000).optional(), accept: z.boolean().optional() }).strict().parse(await c.req.json());
    return c.json(office.progress.acceptOutput(actor, c.req.param('id'), c.req.param('outputId'), input, sourceOf(actor)));
  }));
  // Manager approval requests: seats ask, only the manager decides (web here, or the paired private Telegram chat).
  const ApprovalFields = { action: z.string().min(1).max(200), scope: z.string().min(1).max(500), reason: z.string().min(1).max(1000), consequences: z.string().max(500).optional(), target: z.string().max(200).optional(), expiresInMinutes: z.number().int().min(5).max(10_080).optional() };
  app.get('/v1/approvals', c => withActor(c, ({ actor }) => {
    const status = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).optional().parse(c.req.query('status') || undefined);
    return c.json({ approvals: office.approvals.list(actor, status) });
  }));
  app.post('/v1/approvals', c => withActor(c, async ({ actor }) => {
    const input = z.object({ taskId: z.string().min(1).max(80).optional(), channelId: z.string().min(1).max(128).optional(), threadSeq: z.number().int().min(1).optional(), ...ApprovalFields }).strict().parse(await c.req.json());
    const result = office.approvals.request(actor, input);
    return c.json(result, result.duplicate ? 200 : 201);
  }));
  app.get('/v1/approvals/:id', c => withActor(c, ({ actor }) => c.json(office.approvals.get(actor, c.req.param('id')))));
  app.patch('/v1/approvals/:id', c => withActor(c, async ({ actor }) => {
    const input = z.object({ action: ApprovalFields.action.optional(), scope: ApprovalFields.scope.optional(), reason: ApprovalFields.reason.optional(), consequences: ApprovalFields.consequences, target: ApprovalFields.target, expiresInMinutes: ApprovalFields.expiresInMinutes }).strict().parse(await c.req.json());
    return c.json(office.approvals.update(actor, c.req.param('id'), input));
  }));
  app.post('/v1/approvals/:id/cancel', c => withActor(c, async ({ actor }) => {
    const input = z.object({ note: z.string().max(500).optional() }).strict().parse(await c.req.json().catch(() => ({})));
    return c.json(office.approvals.cancel(actor, c.req.param('id'), input.note));
  }));
  app.post('/v1/approvals/:id/decision', c => managerOnly(c, async () => {
    const input = z.object({ decision: z.enum(['approve', 'reject']), revision: z.number().int().min(1), note: z.string().max(500).optional() }).strict().parse(await c.req.json());
    return c.json(office.approvals.decide({ kind: 'manager' }, c.req.param('id'), input.decision, input.revision, input.note));
  }));
  app.post('/v1/approvals/:id/resend', c => managerOnly(c, () => c.json(office.approvals.resend({ kind: 'manager' }, c.req.param('id')))));
  app.get('/v1/settings/dispatch', c => managerOnly(c, () => c.json({ mode: office.dispatch.mode() })));
  app.put('/v1/settings/dispatch', c => managerOnly(c, async () => c.json({ mode: office.dispatch.setMode(z.object({ mode: z.enum(['off', 'suggest', 'on']) }).strict().parse(await c.req.json()).mode) })));

  const BlockerFields = { description: z.string().min(1).max(500), resolverSeatId: z.string().min(1).max(65).nullable().optional(), resolverRole: z.string().max(80).nullable().optional(), nextStep: z.string().max(1000).optional(), dueAt: z.number().int().positive().nullable().optional(), refs: z.array(z.string().min(1).max(300)).max(10).optional(), scope: z.enum(['task', 'step']).optional() };
  /** Seats see blockers on tasks they can see; coordinators and the manager see all. */
  app.get('/v1/blockers', c => asService(c, scope => {
    const filter = z.object({ status: z.enum(['open', 'resolved']).optional(), taskId: z.string().max(80).optional(), departmentId: z.string().max(64).optional() }).parse(c.req.query());
    const keep = (taskId: string): boolean => inScope(scope, office.tasks.get(taskId).departmentId) && (!filter.departmentId || office.tasks.get(taskId).departmentId === filter.departmentId);
    const blockers = office.blockers.list({ status: filter.status, taskId: filter.taskId }).map(blocker => ({ ...blocker, taskIds: blocker.taskIds.filter(keep) })).filter(blocker => blocker.taskIds.length > 0);
    return c.json({ blockers });
  }) ?? withActor(c, ({ actor }) => {
    const filter = z.object({ status: z.enum(['open', 'resolved']).optional(), taskId: z.string().max(80).optional() }).parse(c.req.query());
    const visible = office.blockers.list(filter).filter(blocker => blocker.taskIds.some(taskId => office.tasks.canRead(actor, office.tasks.get(taskId))));
    return c.json({ blockers: visible });
  }));
  app.post('/v1/blockers', c => withActor(c, async ({ actor }) => {
    const input = z.object({ kind: z.enum(BLOCKER_KINDS), taskIds: z.array(z.string().min(1).max(80)).min(1).max(50), originTaskId: z.string().max(80).nullable().optional(), ...BlockerFields }).strict().parse(await c.req.json());
    return c.json(office.blockers.open(actor, input), 201);
  }));
  app.patch('/v1/blockers/:id', c => withActor(c, async ({ actor }) => c.json(office.blockers.update(actor, c.req.param('id'), z.object(BlockerFields).partial().strict().parse(await c.req.json())))));
  app.post('/v1/blockers/:id/link', c => withActor(c, async ({ actor }) => c.json(office.blockers.link(actor, c.req.param('id'), z.object({ taskIds: z.array(z.string().min(1).max(80)).min(1).max(50) }).strict().parse(await c.req.json()).taskIds))));
  app.post('/v1/blockers/:id/unlink', c => withActor(c, async ({ actor }) => c.json(office.blockers.unlink(actor, c.req.param('id'), z.object({ taskId: z.string().min(1).max(80) }).strict().parse(await c.req.json()).taskId))));
  app.post('/v1/blockers/:id/resolve', c => withActor(c, async ({ actor }) => {
    const input = z.object({ resolution: z.string().max(1000), validUntil: z.number().int().positive().nullable().optional() }).strict().parse(await c.req.json());
    return c.json(office.blockers.resolve(actor, c.req.param('id'), input.resolution, input.validUntil ?? null));
  }));
  app.post('/v1/blockers/:id/reopen', c => withActor(c, async ({ actor }) => c.json(office.blockers.reopen(actor, c.req.param('id'), z.object({ reason: z.string().max(1000) }).strict().parse(await c.req.json()).reason))));
  app.post('/v1/tasks/:id/thread', c => withActor(c, ({ actor }) => c.json(office.tasks.thread(actor, c.req.param('id')))));
  app.patch('/v1/tasks/:id', c => withActor(c, async ({ actor }) => {
    const patch = z.object({ status: TaskStatusSchema.optional(), note: z.string().max(2000).optional(), assigneeSeatId: z.string().min(1).max(64).nullable().optional(), title: z.string().min(1).max(200).optional(), body: z.string().max(8000).optional(), kind: TaskKindSchema.optional(), expectedRevision: z.number().int().min(0).optional(), reason: z.string().max(2000).optional(), handoffNote: z.string().max(2000).optional(), passRequired: TaskIdList.optional(), result: z.enum(TASK_RESULTS).optional(), projectId: z.string().min(1).max(40).nullable().optional(), ...TaskPlanSchema }).strict().parse(await c.req.json());
    // The web UI acts as the manager; agents call through their MCP tools with a bearer token.
    return c.json(office.tasks.update(actor, c.req.param('id'), patch, sourceOf(actor)));
  }));

  /** Leaders and coordinators join (or leave) another department's channel to talk with its members directly. */
  app.post('/v1/channels/:id/join', c => withActor(c, ({ actor }) => actor.kind === 'seat' ? c.json(office.org.joinChannel(actor.seatId, c.req.param('id'))) : json('seat_only', 400)));
  app.post('/v1/channels/:id/leave', c => withActor(c, ({ actor }) => { if (actor.kind !== 'seat') return json('seat_only', 400); office.org.leaveChannel(actor.seatId, c.req.param('id')); return c.json({ ok: true }); }));
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
