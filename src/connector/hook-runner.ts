import { z } from 'zod';
import { normalizeClaudeHook } from '../adapters/claude/normalize-event.js';
import { joinLinkSeat, seatIdFromJoin } from '../shared/join.js';
import { DurableSpool } from './spool.js';
import type { SessionRecord, SessionStore } from './session-store.js';

/** requestedSeat: seat id or join URL from AGENT_OFFICE_SEAT, claimed on SessionStart. */
export type HookDeps = { store: SessionStore; fetch: typeof fetch; wakeWaitSeconds: number; requestedSeat?: string | undefined; permissionWaitSeconds?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
export type HookOutput = Record<string, unknown>;
export type WhoAmI = { agentId: string; seat: { id: string; title: string; role: string; description: string } | null; department: { name: string; deputySeatId?: string | null } | null; channels: Array<{ id: string }>; handoffBrief?: string | null };

const HookInput = z.object({ session_id: z.string().min(1).max(128), hook_event_name: z.string(), cwd: z.string().optional() }).passthrough();
const SHORT_TIMEOUT_MS = 1500;
/** Wake states that mean "the daemon could not park us right now", as opposed to a real idle timeout or an intentional refusal. */
const RETRYABLE_WAKE_STATES = new Set(['shutdown', 'busy', 'aborted']);
const WAKE_BACKOFF_MS = [2000, 4000, 8000, 15_000, 30_000];
/** Prompts that need an answer typed by the user, not Allow/Deny: always left to the terminal. */
const TERMINAL_ONLY_TOOLS = new Set(['AskUserQuestion']);
/** One long-poll request never outlives this: proxies such as Cloudflare cut idle responses after 100 s. */
export const MAX_POLL_SECONDS = 90;

/** Calls the daemon with a bearer token; throws on network error or non-2xx. */
export const daemonCall = async <T>(fetchImpl: typeof fetch, daemonUrl: string, token: string, target: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> => {
  const response = await fetchImpl(`${daemonUrl}${target}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, host: new URL(daemonUrl).host, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeoutMs ?? SHORT_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(`daemon_${response.status}:${JSON.stringify(body)}`);
  return body;
};

/** HTTP status carried by a daemonCall error, or null for network/timeout failures. */
const daemonStatus = (error: unknown): number | null => {
  const status = error instanceof Error ? Number(/^daemon_(\d+)/.exec(error.message)?.[1]) : NaN;
  return Number.isInteger(status) ? status : null;
};

export const seatContext = (me: WhoAmI): string => me.seat
  ? `[Agent Office] You are seat @${me.seat.id} — ${me.seat.title} (${me.seat.role} of ${me.department?.name ?? 'unknown'}). Your specialty: ${me.seat.description || 'n/a'}\n`
    + `Your channels: ${me.channels.map(channel => `#${channel.id}`).join(', ')}. Read the rules once with agent_office_guide. Collaborate only through the agent_office_* MCP tools (read_channel, send_message, list_tasks, create_task, update_task). Mention teammates as @seat-id. `
    + (me.seat.role === 'leader'
      ? 'As leader, split work into tasks for your members and coordinate with other departments in #leaders: ask with one complete REQ message, accept requests by creating a task with requestedBy (results go back automatically), pass file paths not content (guide section 7).'
      : me.department?.deputySeatId === me.seat.id
        ? 'You are the deputy of your department: you are in #leaders and stand in for your leader when they are unavailable (guide section 7). Otherwise work as a member.'
        : 'Requests for other departments go through your leader.')
    + (me.handoffBrief ? `\n${me.handoffBrief}\n` : '')
  : `[Agent Office] This session is registered as agent ${me.agentId} but not seated yet. Read the rules with agent_office_guide. Join a seat with the agent_office_join tool (seat id or join URL), or the manager assigns one in the Org view; until then other agent_office_* tools return not_seated.`;

/**
 * Handles one Claude Code hook invocation. Never throws: any failure degrades to `{}` so Claude Code is never blocked
 * by Agent Office. Telemetry that cannot be delivered is spooled per session and drained on the next successful send.
 */
export const runHook = async (raw: unknown, deps: HookDeps): Promise<HookOutput> => {
  try {
    const input = HookInput.parse(raw);
    const session = await ensureSession(input.session_id, input.cwd, deps, input.hook_event_name === 'SessionStart');
    if (!session) return {};
    await sendTelemetry(raw, input.session_id, session, deps);
    if (input.hook_event_name === 'SessionStart') {
      const refused = deps.requestedSeat ? await claimSeat(session, seatIdFromJoin(deps.requestedSeat), deps) : '';
      const me = await daemonCall<WhoAmI>(deps.fetch, session.daemonUrl, session.token, '/v1/me');
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: refused + seatContext(me) } };
    }
    // A join link pasted into the prompt seats the session right here, without relying on the model to call a tool.
    const linkedSeat = input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string' ? joinLinkSeat(input.prompt, session.daemonUrl) : null;
    if (linkedSeat) {
      const refused = await claimSeat(session, linkedSeat, deps);
      const me = await daemonCall<WhoAmI>(deps.fetch, session.daemonUrl, session.token, '/v1/me');
      const joined = refused || `[Agent Office] This session joined seat @${linkedSeat} from the link in the message — no need to call agent_office_join or open the link.\n`;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: joined + seatContext(me) } };
    }
    if (input.hook_event_name === 'PermissionRequest' && (deps.permissionWaitSeconds ?? 0) > 0) return await askManager(input, session, deps);
    if (input.hook_event_name === 'Stop') {
      return await waitForWake(input.session_id, input.cwd, session, deps);
    }
    return {};
  } catch (error) {
    process.stderr.write(`agent-office hook: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return {};
  }
};

/** Claims a seat for this session; returns '' on success or a context line explaining why it was refused. */
const claimSeat = async (session: SessionRecord, seatId: string, deps: HookDeps): Promise<string> => {
  try { await daemonCall(deps.fetch, session.daemonUrl, session.token, `/v1/seats/${encodeURIComponent(seatId)}/claim`, { body: {} }); return ''; }
  catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    if (message.includes('seat_occupied')) return `[Agent Office] Seat @${seatId} is already taken by another live session, so this session was not seated.\n`;
    if (message.includes('seat_not_found')) return `[Agent Office] There is no seat @${seatId}; check the id in the Org view.\n`;
    return `[Agent Office] Could not claim seat @${seatId}: ${message}\n`;
  }
};

/**
 * Parks the stopping session until something addressed to its seat arrives; blocking the stop feeds it the items.
 * Network errors, 5xx/429, daemon restarts and a full waiter pool are retried with backoff until the original wait
 * window ends, so a short outage does not leave the seat asleep. A revoked token is re-registered once. The window is
 * covered by consecutive polls of at most MAX_POLL_SECONDS so no single request trips a proxy's idle timeout.
 */
const waitForWake = async (sessionId: string, cwd: string | undefined, initial: SessionRecord, deps: HookDeps): Promise<HookOutput> => {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + deps.wakeWaitSeconds * 1000;
  let session = initial; let reRegistered = false;
  for (let attempt = 0; ; attempt++) {
    const wait = Math.min(MAX_POLL_SECONDS, Math.max(0, Math.floor((deadline - now()) / 1000))); const started = now();
    try {
      const result = await daemonCall<{ wake: boolean; reason?: string; state?: string }>(deps.fetch, session.daemonUrl, session.token, `/v1/wake?wait=${wait}`, { timeoutMs: (wait + 15) * 1000 });
      if (result.wake && result.reason) return { decision: 'block', reason: result.reason.slice(0, 4000) };
      // Re-poll only after a poll that really waited; an instant timeout means the daemon will not park us.
      if (result.state === 'timeout' && deadline - now() >= 1000 && now() - started >= wait * 500) { attempt = -1; continue; }
      if (!result.state || !RETRYABLE_WAKE_STATES.has(result.state)) return {};
    } catch (error) {
      const status = daemonStatus(error);
      if (status === 401 && !reRegistered) {
        reRegistered = true;
        const fresh = await ensureSession(sessionId, cwd, deps, true);
        if (!fresh) return {};
        session = fresh; continue;
      }
      if (status !== null && status !== 429 && status < 500) return {};
    }
    const base = WAKE_BACKOFF_MS[Math.min(attempt, WAKE_BACKOFF_MS.length - 1)]!;
    // Jitter spreads reconnects when a daemon restart drops every parked seat at once.
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    if (now() + delay >= deadline) return {};
    await sleep(delay);
  }
};

/**
 * Hands a permission prompt to the manager UI and waits for Allow/Deny. Claude Code shows its own terminal dialog only
 * after this hook returns, so the wait is bounded (per machine: AGENT_OFFICE_PERMISSION_WAIT_SECONDS, 0 = off) and
 * every failure or timeout returns {} — the normal terminal prompt.
 */
const askManager = async (input: Record<string, unknown>, session: SessionRecord, deps: HookDeps): Promise<HookOutput> => {
  const wait = deps.permissionWaitSeconds ?? 0;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  if (TERMINAL_ONLY_TOOLS.has(tool)) return {};
  // Bounded values only: strings are cut, other values travel as short JSON so the manager still sees what will run.
  const toolInput = Object.fromEntries(Object.entries(input.tool_input && typeof input.tool_input === 'object' ? input.tool_input as Record<string, unknown> : {})
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 2000) : (JSON.stringify(value) ?? '').slice(0, 500)]));
  let id: string;
  try { id = (await daemonCall<{ id: string }>(deps.fetch, session.daemonUrl, session.token, '/v1/permissions', { body: { tool, input: toolInput }, timeoutMs: 3000 })).id; }
  catch { return {}; }
  const now = deps.now ?? Date.now; const deadline = now() + wait * 1000;
  let result: { status: string; message: string };
  for (;;) {
    const remaining = Math.max(0, Math.floor((deadline - now()) / 1000)); const chunk = Math.min(MAX_POLL_SECONDS, remaining);
    // Intermediate polls keep the request pending; the last one lets the daemon expire it.
    const final = chunk === remaining;
    result = await daemonCall<{ status: string; message: string }>(deps.fetch, session.daemonUrl, session.token, `/v1/permissions/${encodeURIComponent(id)}/decision?wait=${chunk}${final ? '' : '&final=false'}`, { timeoutMs: (chunk + 10) * 1000 });
    if (result.status !== 'pending' || final) break;
  }
  if (result.status === 'allowed') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (result.status === 'denied') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: result.message || 'Denied by the manager in Agent Office.' } } };
  return {};
};

/** Returns the stored credential, registering through the connector on SessionStart or when a session predates the hook install. */
const ensureSession = async (sessionId: string, cwd: string | undefined, deps: HookDeps, forceRegister: boolean): Promise<SessionRecord | null> => {
  const existing = deps.store.session(sessionId);
  if (existing && !forceRegister) return existing;
  const connector = deps.store.connector();
  if (!connector) return existing;
  const registered = await daemonCall<{ agentId: string; token: string }>(deps.fetch, connector.daemonUrl, connector.token, '/v1/sessions/register', { body: { sessionId, project: cwd ?? process.env.CLAUDE_PROJECT_DIR ?? 'unknown' }, timeoutMs: 3000 });
  const record = { daemonUrl: connector.daemonUrl, token: registered.token, agentId: registered.agentId };
  deps.store.saveSession(sessionId, record);
  return record;
};

const sendTelemetry = async (raw: unknown, sessionId: string, session: SessionRecord, deps: HookDeps): Promise<void> => {
  const event = normalizeClaudeHook(raw, { producerId: session.agentId, agentId: session.agentId, project: 'session', sessionId, incarnation: sessionId });
  if (!event) return;
  const spool = new DurableSpool(deps.store.spoolDir(sessionId));
  const send = async (value: unknown): Promise<boolean> => {
    try { await daemonCall(deps.fetch, session.daemonUrl, session.token, '/v1/agents/events', { body: value }); return true; }
    // Only network failures, 429 and 5xx are retryable; other rejections (duplicate, invalid) would wedge the spool forever.
    catch (error) { const status = daemonStatus(error); return status !== null && status !== 429 && status < 500; }
  };
  if (spool.size() > 0 && (await spool.drain(send)).remaining > 0) { spool.append(stripBinding(event)); return; }
  if (!(await send(stripBinding(event)))) spool.append(stripBinding(event));
};

/** The daemon derives identity from the bearer credential and rejects unknown keys, so only telemetry fields are sent. */
const stripBinding = (event: NonNullable<ReturnType<typeof normalizeClaudeHook>>): Record<string, unknown> => {
  const { id, ts, kind, turnId, invocationId, tool, summary } = event;
  return { id, ts, kind, ...(turnId ? { turnId } : {}), ...(invocationId ? { invocationId } : {}), ...(tool ? { tool } : {}), ...(summary ? { summary } : {}) };
};
