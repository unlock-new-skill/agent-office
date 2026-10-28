import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { AuthService, clearedSessionCookie, sessionCookie } from './auth/auth-service.js';
import type { Database } from './db/database.js';
import { AgentRegistrationSchema, AUTO_TURN_SUMMARY, EnrollmentSchema, LoginSchema, TelemetrySchema } from '../shared/contracts.js';
import { EventStore } from './events/event-store.js';
import { AdmissionLimiter } from './admission.js';
import type { Office } from './collaboration/office.js';
import { registerOfficeRoutes } from './office-routes.js';
import { registerRunnerRoutes } from './runner-routes.js';
import { publicMap } from './public-map.js';
import { registerNotifyRoutes } from './notify/notify-routes.js';
import type { TelegramNotifier } from './notify/telegram-notifier.js';
import { registerInstallRoutes } from './install-routes.js';
import { logger } from './logger.js';
import { allowedHostsAndOrigins, isHttpsPublic, securityHeaders } from './http-policy.js';

export type AppContext = { config: AppConfig; db: Database; auth: AuthService; events: EventStore; office: Office; revokeSession?: (id: string) => void; notifier?: TelegramNotifier | null };
const jsonError = (message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503): Response => Response.json({ error: message }, { status });

export const createApp = (context: AppContext): Hono => {
  const app = new Hono();
  const eventLimiter = new AdmissionLimiter();
  const { hosts: allowedHosts, origins: allowedOrigins } = allowedHostsAndOrigins(context.config);
  const secureCookie = isHttpsPublic(context.config); const headers = securityHeaders(context.config);
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  });
  app.use('*', async (c, next) => {
    if (!allowedHosts.has(c.req.header('host') ?? '')) return jsonError('invalid_host', 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const isBearer = c.req.header('authorization')?.startsWith('Bearer ') ?? false;
      if (!isBearer && !allowedOrigins.has(c.req.header('origin') ?? '')) return jsonError('invalid_origin', 403);
    }
    await next();
  });
  app.use('*', cors({ origin: [...allowedOrigins], credentials: true }));

  const manager = (request: Request) => {
    const session = context.auth.authenticateRequest(request);
    if (!session || !context.auth.requireCsrf(request, session)) return null;
    return session;
  };

  app.get('/healthz', c => c.json({ ok: true, setupComplete: context.auth.isSetupComplete() }));

  app.post('/v1/auth/login', async c => {
    try {
      const body = LoginSchema.parse(await c.req.json());
      const result = context.auth.login(body.password, c.req.header('x-agent-office-peer') ?? 'local');
      c.header('Set-Cookie', sessionCookie(result.token, context.config.sessionTtlSeconds, secureCookie));
      return c.json({ csrfToken: result.csrfToken, expiresAt: result.expiresAt });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return jsonError('invalid_request', 400);
      if (error instanceof Error && error.message === 'setup_required') return jsonError('setup_required', 503);
      if (error instanceof Error && error.message === 'rate_limited') return jsonError('rate_limited', 429);
      if (error instanceof Error && error.message === 'invalid_credentials') return jsonError('invalid_credentials', 401);
      logger.error(error);
      return jsonError('internal_error', 500);
    }
  });

  app.post('/v1/auth/logout', c => {
    const session = manager(c.req.raw);
    if (!session) return jsonError('unauthorized', 401);
    context.auth.revokeRequest(c.req.raw); context.revokeSession?.(session.id);
    c.header('Set-Cookie', clearedSessionCookie(secureCookie));
    return c.json({ ok: true });
  });

  app.get('/v1/me', c => {
    const session = context.auth.authenticateRequest(c.req.raw);
    if (session) return c.json({ userId: 'manager', expiresAt: session.expiresAt, csrfToken: session.csrfToken });
    const credential = context.auth.authenticateBearer(c.req.raw);
    return credential ? c.json(context.office.whoami(credential.agentId, { afterCompaction: c.req.query('source') === 'compact' })) : jsonError('unauthorized', 401);
  });

  app.get('/v1/agents', c => context.auth.authenticateRequest(c.req.raw) ? c.json({ agents: context.events.snapshot().agents }) : jsonError('unauthorized', 401));
  app.post('/v1/agents/:id/dismiss', c => {
    if (!manager(c.req.raw)) return jsonError('unauthorized', 401);
    const changed = context.db.raw.prepare('UPDATE agents SET dismissed_at=? WHERE id=?').run(Date.now(), c.req.param('id'));
    return changed.changes === 1 ? c.json({ ok: true }) : jsonError('agent_not_found', 404);
  });
  // The office map is public: anyone may watch seats and their status, nothing else (see publicMap).
  let publicCache: { at: number; body: ReturnType<typeof publicMap> } | null = null;
  app.get('/v1/public/map', c => {
    if (!publicCache || Date.now() - publicCache.at > 2000) publicCache = { at: Date.now(), body: publicMap(context.office.org.view(), context.events.snapshot().agents) };
    c.header('cache-control', 'no-store');
    return c.json(publicCache.body);
  });
  registerOfficeRoutes(app, { auth: context.auth, office: context.office, manager, wakeWaitSeconds: context.config.wakeWaitSeconds, publicOrigin: context.config.publicOrigin });
  registerInstallRoutes(app, { auth: context.auth, manager, publicOrigin: context.config.publicOrigin });
  registerRunnerRoutes(app, { auth: context.auth, office: context.office, manager, publicOrigin: context.config.publicOrigin });
  registerNotifyRoutes(app, { manager, notifier: context.notifier ?? null });

  app.post('/v1/agents/enrollment', async c => {
    if (!manager(c.req.raw)) return jsonError('unauthorized', 401);
    try { const body = EnrollmentSchema.parse(await c.req.json()); return c.json(context.auth.createEnrollmentCredential(body), 201); }
    catch (error) { return error instanceof z.ZodError ? jsonError('invalid_request', 400) : jsonError('enrollment_failed', 500); }
  });

  app.post('/v1/agents/register', async c => {
    const enrollment = context.auth.authenticateEnrollment(c.req.raw);
    if (!enrollment) return jsonError('unauthorized', 401);
    try {
      const body = AgentRegistrationSchema.parse(await c.req.json());
      const result = context.auth.registerAgent(enrollment.id, body.nonce);
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return jsonError('invalid_request', 400);
      if (error instanceof Error && (error.message === 'invalid_enrollment' || error.message === 'invalid_enrollment_nonce')) return jsonError('unauthorized', 401);
      logger.error(error); return jsonError('registration_failed', 500);
    }
  });

  app.post('/v1/credentials/:credentialId/revoke', c => {
    if (!manager(c.req.raw)) return jsonError('unauthorized', 401);
    context.auth.revokeCredential(c.req.param('credentialId'));
    return c.json({ ok: true });
  });

  app.post('/v1/agents/events', async c => {
    const credential = context.auth.authenticateBearer(c.req.raw);
    if (!credential) return jsonError('unauthorized', 401);
    if (!eventLimiter.allow(`session:${credential.sessionId}`, 20, 200) || !eventLimiter.allow('global', 500, 2000)) { c.header('Retry-After', '1'); return jsonError('rate_limited', 429); }
    try {
      const body = TelemetrySchema.parse(await c.req.json());
      const event = context.events.append({ ...body, source: 'claude', producerId: credential.id, producerIncarnation: credential.incarnation, agentId: credential.agentId, sessionId: credential.sessionId, incarnation: credential.incarnation, project: credential.project });
      // A prompt written by Agent Office (runner wake) is not a human taking over: keep the auto-wake guard counting.
      if (body.kind === 'turn.start' && body.summary !== AUTO_TURN_SUMMARY) context.office.wake.resetGuardForAgent(credential.agentId);
      if (body.kind === 'turn.start' || body.kind === 'session.end') context.office.permissions.settleForAgent(credential.agentId);
      if (body.kind === 'session.end') context.office.runners.clearTakeover(credential.agentId);
      return c.json(event, 201);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return jsonError('invalid_request', 400);
      if (error instanceof Error && error.message === 'conflicting_event') return jsonError('conflicting_event', 409);
      if (error instanceof Error && error.message === 'stale_incarnation') return jsonError('stale_incarnation', 409);
      logger.error(error); return jsonError('event_failed', 500);
    }
  });

  app.get('/v1/events', c => {
    if (!context.auth.authenticateRequest(c.req.raw)) return jsonError('unauthorized', 401);
    const generation = c.req.query('generation'); const after = Number(c.req.query('after') ?? '0');
    if (!generation || !Number.isSafeInteger(after) || after < 0) return jsonError('invalid_cursor', 400);
    try { return c.json(context.events.replayPage(generation, after)); }
    catch (error) {
      if (error instanceof Error && error.message === 'cursor_invalid') return jsonError('invalid_cursor', 400);
      if (error instanceof Error && (error.message === 'cursor_generation_mismatch' || error.message === 'cursor_future')) return jsonError(error.message, 409);
      return jsonError('replay_failed', 500);
    }
  });

  app.notFound(() => jsonError('not_found', 404));
  app.onError((error) => { logger.error(error); return jsonError('internal_error', 500); });
  return app;
};
