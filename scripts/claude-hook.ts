import { readFileSync } from 'node:fs';
import { runHook } from '../src/connector/hook-runner.js';
import { SessionStore } from '../src/connector/session-store.js';

// Claude Code hook entry point: one JSON payload on stdin, one JSON decision on stdout, always exit 0.
let raw: unknown = null;
try { raw = JSON.parse(readFileSync(0, 'utf8')) as unknown; } catch { /* malformed input degrades to {} */ }
const wakeWaitSeconds = Number(process.env.AGENT_OFFICE_WAKE_WAIT_SECONDS ?? 290);
const permissionWaitSeconds = Number(process.env.AGENT_OFFICE_PERMISSION_WAIT_SECONDS ?? 120);
const output = await runHook(raw, {
  store: new SessionStore(), fetch, wakeWaitSeconds: Number.isFinite(wakeWaitSeconds) && wakeWaitSeconds > 0 ? wakeWaitSeconds : 290, requestedSeat: process.env.AGENT_OFFICE_SEAT || undefined,
  permissionWaitSeconds: Number.isFinite(permissionWaitSeconds) && permissionWaitSeconds >= 0 ? Math.min(permissionWaitSeconds, 580) : 120,
});
process.stdout.write(`${JSON.stringify(output)}\n`);
