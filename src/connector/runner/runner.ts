import { hostname } from 'node:os';
import type { RunnerCommand, RunnerLogEntry, RunnerSeat } from '../../shared/contracts.js';
import { daemonCall, KEEPALIVE_REASON, listenForWake } from '../hook-runner.js';
import type { SessionStore } from '../session-store.js';
import { spawnClaude, type SpawnClaude } from './claude-process.js';
import { RunnerState, type RunnerConfig } from './runner-config.js';
import { SeatWorker, type CommandResult, type Listen } from './seat-worker.js';

export type RunnerDeps = {
  store: SessionStore; fetch: typeof fetch; config: RunnerConfig; out: (line: string) => void;
  spawn?: SpawnClaude; sleep?: (ms: number) => Promise<void>; machine?: string;
};

const POLL_SECONDS = 60; const FLUSH_MS = 1000; const MAX_QUEUED_LOGS = 500;
const BACKOFF_MS = [2000, 4000, 8000, 15_000, 30_000, 60_000];
/** Wakes are long-polled for one Claude session at a time; this window only bounds one listen call. */
const LISTEN_WINDOW_SECONDS = 3600;

/**
 * Runs the seats in runner.json headless and links them to the daemon over outbound HTTP only: registers the seats,
 * long-polls manager commands, and pushes seat status and a live log in small batches. Survives daemon restarts and
 * network loss by retrying with backoff; never accepts a seat, path or command line from the server.
 */
export class Runner {
  private readonly workers = new Map<string, SeatWorker>();
  private readonly statuses = new Map<string, RunnerSeat>();
  private logs: RunnerLogEntry[] = [];
  private registered = false;
  /** Last status batch the daemon acknowledged; cleared on (re)registration so the next flush resends it. */
  private lastStatus = '';
  private closed = false;

  constructor(private readonly deps: RunnerDeps) {
    const state = new RunnerState(deps.store);
    const listen: Listen = async (sessionId, cwd, alive) => {
      const session = deps.store.session(sessionId);
      if (!session) return null;
      const output = await listenForWake(sessionId, cwd, session, { store: deps.store, fetch: deps.fetch, wakeWaitSeconds: LISTEN_WINDOW_SECONDS, alive, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
      return output.decision === 'block' && typeof output.reason === 'string' && output.reason !== KEEPALIVE_REASON ? output.reason : null;
    };
    for (const seat of deps.config.seats) {
      const worker = new SeatWorker(seat, {
        spawn: deps.spawn ?? spawnClaude, state, listen,
        onStatus: status => { this.statuses.set(status.seatId, status); deps.out(`[${status.seatId}] ${status.state}: ${status.detail}`); },
        onLog: entry => { this.logs.push(entry); if (this.logs.length > MAX_QUEUED_LOGS) this.logs = this.logs.slice(-MAX_QUEUED_LOGS); },
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
      this.workers.set(seat.seatId, worker); this.statuses.set(seat.seatId, worker.snapshot());
    }
  }

  /** Starts auto-start seats, then keeps the command and report loops running until close(). */
  async run(): Promise<void> {
    for (const seat of this.deps.config.seats) if (seat.autoStart) this.workers.get(seat.seatId)!.start();
    await Promise.all([this.commandLoop(), this.flushLoop()]);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers.values()].map(worker => worker.stop()));
    await this.flush().catch(() => undefined);
  }

  /** Runs one manager command against a configured seat. */
  async execute(command: Pick<RunnerCommand, 'seatId' | 'kind' | 'text'>): Promise<CommandResult> {
    const worker = this.workers.get(command.seatId);
    if (!worker) return { ok: false, message: `seat ${command.seatId} is not in this machine's runner.json` };
    switch (command.kind) {
      case 'start': return worker.start();
      case 'stop': return worker.stop();
      case 'restart': return worker.restart();
      case 'interrupt': return worker.interrupt();
      case 'prompt': return command.text?.trim() ? worker.prompt(command.text) : { ok: false, message: 'empty prompt' };
      default: return { ok: false, message: 'unknown command' };
    }
  }

  private call<T>(target: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const connector = this.deps.store.connector();
    if (!connector) throw new Error('not installed: run the install command from the web UI first');
    return daemonCall<T>(this.deps.fetch, connector.daemonUrl, connector.token, target, { timeoutMs: 10_000, ...init });
  }

  private async register(): Promise<void> {
    const { refused } = await this.call<{ refused: string[] }>('/v1/runners/register', { body: { machine: this.deps.machine ?? hostname(), seats: [...this.statuses.values()] } });
    for (const seatId of refused) {
      this.deps.out(`[${seatId}] refused by the server (no such seat): stopping it`);
      await this.workers.get(seatId)?.stop(); this.workers.delete(seatId); this.statuses.delete(seatId);
    }
    this.registered = true; this.lastStatus = JSON.stringify([...this.statuses.values()]);
  }

  private async commandLoop(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      try {
        if (!this.registered) await this.register();
        const { commands } = await this.call<{ commands: RunnerCommand[] }>(`/v1/runners/me/commands?wait=${POLL_SECONDS}`, { timeoutMs: (POLL_SECONDS + 15) * 1000 });
        failures = 0;
        for (const command of commands) {
          this.deps.out(`command ${command.kind} ${command.seatId} (by ${command.requestedBy})`);
          const result = await this.execute(command).catch(error => ({ ok: false, message: error instanceof Error ? error.message : 'failed' }));
          await this.call(`/v1/runners/me/commands/${encodeURIComponent(command.id)}/result`, { body: result }).catch(() => undefined);
        }
      } catch (error) {
        // The daemon may have restarted or lost us: register again before the next poll.
        this.registered = false;
        const delay = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
        this.deps.out(`daemon unreachable (${error instanceof Error ? error.message.slice(0, 120) : 'error'}), retrying in ${delay / 1000} s`);
        await this.sleep(delay);
      }
    }
  }

  private async flushLoop(): Promise<void> {
    while (!this.closed) {
      await this.sleep(FLUSH_MS);
      if (this.registered) await this.flush().catch(() => undefined);
    }
  }

  private async flush(): Promise<void> {
    const seats = [...this.statuses.values()];
    const signature = JSON.stringify(seats);
    if (signature !== this.lastStatus) { await this.call('/v1/runners/me/status', { body: { seats } }); this.lastStatus = signature; }
    if (this.logs.length > 0) { const entries = this.logs.slice(0, 100); await this.call('/v1/runners/me/log', { body: { entries } }); this.logs = this.logs.slice(entries.length); }
  }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? (value => new Promise(resolve => setTimeout(resolve, value))))(ms); }
}
