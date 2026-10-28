import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
/**
 * Local file: optional seats (for machines not managed from the web) and `allowedRoots`, the directories web-managed
 * seats may run in (default: the home directory). The web can never widen these roots.
 */
const RunnerConfigSchema = z.object({ seats: z.array(SeatConfigSchema).max(20).default([]), allowedRoots: z.array(z.string().refine(value => path.isAbsolute(value), 'absolute path')).max(20).optional() }).strict()
  .refine(config => new Set(config.seats.map(seat => seat.seatId)).size === config.seats.length, 'each seat may appear once');

export type SeatConfig = z.infer<typeof SeatConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
export { SeatConfigSchema };

export const runnerConfigFile = (store: SessionStore): string => path.join(store.home, 'runner.json');
const STATE_FILE = 'runner-state.json';

/** Starting point for runner.json: seats normally come from the web, so only the folders web seats may use are set. */
export const sampleConfig = (): RunnerConfig => ({ seats: [], allowedRoots: [homedir()] });

/** Loads and validates runner.json (absent = no local seats). A local seat whose folder is missing is reported, not fatal. */
export const loadRunnerConfig = (store: SessionStore): RunnerConfig => {
  const file = runnerConfigFile(store);
  if (!existsSync(file)) return { seats: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON`); }
  const parsed = RunnerConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'} ${issue.message}`).join('; ')}`);
  return parsed.data;
};

/** Why a web-managed working directory cannot be used on this machine, or null when it can. */
export const cwdProblem = (cwd: string, roots: string[] = [homedir()]): string | null => {
  if (!path.isAbsolute(cwd)) return 'path is not absolute';
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return `folder not found on this machine: ${cwd}`;
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const real = fold(realpathSync(cwd));
  const inside = roots.some(root => {
    if (!existsSync(root)) return false;
    const relative = path.relative(fold(realpathSync(root)), real);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  return inside ? null : `outside the folders this machine allows (${roots.join(', ')}); add it to allowedRoots in runner.json on the machine`;
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
