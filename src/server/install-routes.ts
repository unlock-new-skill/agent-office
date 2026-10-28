import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AdmissionLimiter } from './admission.js';
import type { AuthService } from './auth/auth-service.js';

type Deps = { auth: AuthService; manager: (request: Request) => unknown; publicOrigin: string | null };
const json = (message: string, status: number): Response => Response.json({ error: message }, { status });
const SCRIPTS_DIR = path.resolve(process.cwd(), 'src/connector/install-scripts');
const CONNECTOR_BUNDLE = path.resolve(process.cwd(), 'dist/connector/agent-office.mjs');

/** One-line install commands for a code; the code travels as an argument/env var, never in a URL. */
export const installCommands = (origin: string, code: string): { unix: string; windows: string } => ({
  unix: `curl -fsSL ${origin}/install.sh | sh -s -- ${code}`,
  windows: `$env:AGENT_OFFICE_CODE='${code}'; irm ${origin}/install.ps1 | iex`,
});

/**
 * Self-service machine setup: the manager mints an install code, a new machine runs one command that downloads the
 * bundled connector (hook + MCP server) and trades the code for its own connector credential. Scripts and bundle are
 * public (no secrets); the code is the only credential and is limited in uses and lifetime.
 */
export const registerInstallRoutes = (app: Hono, deps: Deps): void => {
  const limiter = new AdmissionLimiter();
  const originOf = (c: Context): string => deps.publicOrigin ?? new URL(c.req.url).origin;
  const script = async (c: Context, file: string, contentType: string): Promise<Response> => {
    const text = (await readFile(path.join(SCRIPTS_DIR, file), 'utf8')).replaceAll('__ORIGIN__', originOf(c));
    return c.body(text, 200, { 'content-type': contentType, 'cache-control': 'no-store' });
  };

  app.get('/install.sh', c => script(c, 'install.sh', 'text/x-shellscript; charset=utf-8'));
  app.get('/install.ps1', c => script(c, 'install.ps1', 'text/plain; charset=utf-8'));
  app.get('/connector/agent-office.mjs', async c => {
    try { return c.body(await readFile(CONNECTOR_BUNDLE, 'utf8'), 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); }
    catch { return json('connector_not_built', 404); }
  });

  app.post('/v1/install-codes', async c => {
    if (!deps.manager(c.req.raw)) return json('unauthorized', 401);
    const parsed = z.object({ uses: z.number().int().min(1).max(50).default(1), hours: z.number().int().min(1).max(168).default(24) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return json('invalid_request', 400);
    const created = deps.auth.createInstallCode(parsed.data.uses, parsed.data.hours * 3_600_000);
    return c.json({ ...created, commands: installCommands(originOf(c), created.code) }, 201);
  });

  app.post('/v1/install/redeem', c => {
    // Guessing codes is the only attack surface here; 10 tries per client per minute is plenty for real installs.
    if (!limiter.allow(`redeem:${c.req.header('x-agent-office-peer') ?? 'local'}`, 10 / 60, 10)) return json('rate_limited', 429);
    const connector = deps.auth.redeemInstallCode(c.req.raw);
    return connector ? c.json({ daemonUrl: originOf(c), token: connector.token, machineId: connector.machineId }, 201) : json('invalid_install_code', 401);
  });
};
