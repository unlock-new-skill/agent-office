import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionStore } from '../session-store.js';

/**
 * Values that end up on the `claude` command line. On Windows the CLI is a .cmd shim started through a shell, so
 * nothing that a shell would interpret (quotes, %, ^, &, |, <, >, newlines) is accepted.
 */
const SHELL_SAFE = /^[A-Za-z0-9_*:().,\-/ @=[\]]+$/;
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

const SeatConfigSchema = z.object({
  seatId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  cwd: z.string().min(1).refine(value => path.isAbsolute(value), 'cwd must be an absolute path'),
  permissionMode: z.enum(PERMISSION_MODES).default('acceptEdits'),
  model: z.string().max(80).regex(SHELL_SAFE).optional(),
  allowedTools: z.array(z.string().max(120).regex(SHELL_SAFE)).max(50).optional(),
  autoStart: z.boolean().default(true),
}).strict();
const RunnerConfigSchema = z.object({ seats: z.array(SeatConfigSchema).max(20) }).strict()
  .refine(config => new Set(config.seats.map(seat => seat.seatId)).size === config.seats.length, 'each seat may appear once');

export type SeatConfig = z.infer<typeof SeatConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export const runnerConfigFile = (store: SessionStore): string => path.join(store.home, 'runner.json');
const STATE_FILE = 'runner-state.json';

export const SAMPLE_CONFIG: RunnerConfig = {
  seats: [{ seatId: 'dev-be', cwd: process.platform === 'win32' ? 'C:\\Users\\me\\projects\\game-server' : '/Users/me/projects/game-server', permissionMode: 'acceptEdits', autoStart: true }],
};

/** Loads and validates runner.json; every seat's working directory must exist. Throws a readable error otherwise. */
export const loadRunnerConfig = (store: SessionStore): RunnerConfig => {
  const file = runnerConfigFile(store);
  if (!existsSync(file)) throw new Error(`no runner config at ${file}: run "agent-office.mjs runner init" and edit it`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON`); }
  const parsed = RunnerConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'} ${issue.message}`).join('; ')}`);
  for (const seat of parsed.data.seats) {
    if (!existsSync(seat.cwd) || !statSync(seat.cwd).isDirectory()) throw new Error(`${file}: cwd of seat ${seat.seatId} does not exist: ${seat.cwd}`);
  }
  return parsed.data;
};

/** Per-seat Claude session ids, so a restarted runner resumes the same conversation. */
export class RunnerState {
  constructor(private readonly store: SessionStore) {}

  sessionId(seatId: string): string | null { return this.read()[seatId]?.sessionId ?? null; }

  setSessionId(seatId: string, sessionId: string | null): void {
    const state = this.read();
    if (sessionId) state[seatId] = { sessionId }; else delete state[seatId];
    this.store.saveJson(STATE_FILE, state);
  }

  private read(): Record<string, { sessionId: string }> { return this.store.readJson<Record<string, { sessionId: string }>>(STATE_FILE) ?? {}; }
}
