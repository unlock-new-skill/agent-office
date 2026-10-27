import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { daemonCall } from '../src/connector/hook-runner.js';
import { SessionStore } from '../src/connector/session-store.js';
import { DurableSpool } from '../src/connector/spool.js';
import { assertSupportedRuntime } from '../src/server/runtime.js';

// Manually drains telemetry spooled while the daemon was down; hooks also drain opportunistically on their next event.
assertSupportedRuntime();
const store = new SessionStore(); const root = path.join(store.home, 'spool'); const results: Record<string, unknown> = {};
for (const sessionId of existsSync(root) ? readdirSync(root) : []) {
  const session = store.session(sessionId); if (!session) { results[sessionId] = 'no_session_credential'; continue; }
  results[sessionId] = await new DurableSpool(store.spoolDir(sessionId)).drain(async event => { try { await daemonCall(fetch, session.daemonUrl, session.token, '/v1/agents/events', { body: event }); return true; } catch { return false; } });
}
process.stdout.write(`${JSON.stringify(results)}\n`);
