import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import type { MachineConfig, MachineSeat, RunnerCommand, RunnerLogEntry, RunnerSeat } from '../../shared/contracts.js';
import { daemonCall, KEEPALIVE_REASON, listenForWake } from '../hook-runner.js';
import type { SessionStore } from '../session-store.js';
import { spawnClaude, type SpawnClaude } from './claude-process.js';
import { cwdProblem, RunnerState, type RunnerConfig, type SeatConfig } from './runner-config.js';
import { SeatWorker, type CommandResult, type Listen } from './seat-worker.js';

export type RunnerDeps = {
  store: SessionStore; fetch: typeof fetch; config: RunnerConfig; out: (line: string) => void;
  spawn?: SpawnClaude; sleep?: (ms: number) => Promise<void>; machine?: string; checkCwd?: (cwd: string) => string | null;
  /** Desktop live-view window for a seat (`runner watch`); returns why none was opened, or null. */
  openWatch?: (seatId: string) => string | null; closeWatch?: (seatId: string) => void;
};

const POLL_SECONDS = 60; const FLUSH_MS = 1000; const MAX_QUEUED_LOGS = 500;
const BACKOFF_MS = [2000, 4000, 8000, 15_000, 30_000, 60_000];
/** Wakes are long-polled for one Claude session at a time; this window only bounds one listen call. */
const LISTEN_WINDOW_SECONDS = 3600;

/**
 * Runs this machine's seats headless and links them to the daemon over outbound HTTP only: registers, long-polls
 * manager commands and config changes, and pushes seat status and a live log in small batches. Seats come from the web
 * (live-synced) or, for machines not managed there, from the local runner.json. Web-managed working directories must
 * lie inside the machine's allowedRoots. Survives daemon restarts and network loss by retrying with backoff.
 */
export class Runner {
  private readonly workers = new Map<string, SeatWorker>();
  private readonly statuses = new Map<string, RunnerSeat>();
  /** Web config each seat last applied, to tell a real change from a repeat. */
  private readonly applied = new Map<string, MachineSeat>();
  private readonly state: RunnerState;
  private readonly listen: Listen;
  private logs: RunnerLogEntry[] = [];
  private registered = false;
  /** Last status batch the daemon acknowledged; cleared on (re)registration so the next flush resends it. */
  private lastStatus = '';
  private closed = false;
  private configVersion = 0;
  private applying: Promise<void> = Promise.resolve();
  /** Bumped per seat on every start/stop so an older wait-for-free-seat loop gives up. */
  private readonly launches = new Map<string, number>();
  private localStarted = false;

  constructor(private readonly deps: RunnerDeps) {
    this.state = new RunnerState(deps.store);
    this.listen = async (sessionId, cwd, alive) => {
      const session = deps.store.session(sessionId);
      if (!session) return null;
      const output = await listenForWake(sessionId, cwd, session, { store: deps.store, fetch: deps.fetch, wakeWaitSeconds: LISTEN_WINDOW_SECONDS, alive, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
      return output.decision === 'block' && typeof output.reason === 'string' && output.reason !== KEEPALIVE_REASON ? output.reason : null;
    };
    for (const seat of deps.config.seats) {
      if (existsSync(seat.cwd)) { this.addWorker(seat); continue; }
      // One bad local entry must not take the other seats down with it.
      this.statuses.set(seat.seatId, { seatId: seat.seatId, state: 'failed', sessionId: null, restarts: 0, permissionMode: seat.permissionMode, detail: `folder not found on this machine: ${seat.cwd} (fix runner.json)` });
    }
  }

  /** Starts auto-start seats, then keeps the command and report loops running until close(). */
  async run(): Promise<void> {
    if (this.workers.size === 0) this.deps.out('no seats yet: add them for this machine on the web (Machines)');
    await Promise.all([this.commandLoop(), this.flushLoop()]);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.applying;
    await Promise.all([...this.workers.values()].map(worker => worker.stop()));
    await this.flush().catch(() => undefined);
  }

  /** Applies the web-managed seat list: adds, restarts changed seats (repo, permissions, session), removes the rest. */
  applyConfig(config: MachineConfig): Promise<void> {
    this.applying = this.applying.then(async () => {
      if (config.version === this.configVersion || config.version === 0) return;
      this.configVersion = config.version;
      const wanted = new Map(config.seats.map(seat => [seat.seatId, seat]));
      for (const seatId of [...this.workers.keys(), ...this.statuses.keys()]) {
        if (wanted.has(seatId)) continue;
        await this.workers.get(seatId)?.stop(); this.workers.delete(seatId); this.statuses.delete(seatId); this.applied.delete(seatId);
        this.deps.out(`[${seatId}] removed from this machine`);
      }
      for (const seat of config.seats) {
        const before = this.applied.get(seat.seatId); this.applied.set(seat.seatId, seat);
        const worker = this.workers.get(seat.seatId);
        const changed = !before || before.cwd !== seat.cwd || before.permissionMode !== seat.permissionMode || before.sessionId !== seat.sessionId || (before.model ?? null) !== (seat.model ?? null);
        if (worker && !changed) {
          // Only the window switch changed: open or close the live view without touching the session.
          if (before?.showWindow !== seat.showWindow) {
            (worker.seat as { showWindow: boolean }).showWindow = seat.showWindow;
            if (!seat.showWindow) this.deps.closeWatch?.(seat.seatId);
            else if (!['stopped', 'failed'].includes(worker.snapshot().state)) this.openWatch(seat.seatId);
          }
          continue;
        }
        const problem = this.deps.checkCwd ? this.deps.checkCwd(seat.cwd) : cwdProblem(seat.cwd, this.deps.config.allowedRoots);
        const wasRunning = worker ? !['stopped', 'failed'].includes(worker.snapshot().state) : false;
        if (worker) { await worker.stop(); this.workers.delete(seat.seatId); }
        if (problem) {
          this.statuses.set(seat.seatId, { seatId: seat.seatId, state: 'failed', sessionId: null, restarts: 0, permissionMode: seat.permissionMode, detail: problem });
          this.deps.out(`[${seat.seatId}] ${problem}`); continue;
        }
        if (seat.sessionId && seat.sessionId !== before?.sessionId) this.state.setSessionId(seat.seatId, seat.sessionId);
        const added = this.addWorker({ seatId: seat.seatId, cwd: seat.cwd, permissionMode: seat.permissionMode, autoStart: seat.autoStart, showWindow: seat.showWindow, ...(seat.model ? { model: seat.model } : {}) });
        if (wasRunning || seat.autoStart) this.startSeat(added);
      }
      this.lastStatus = '';
    }).catch(error => this.deps.out(`could not apply the web config: ${error instanceof Error ? error.message : String(error)}`));
    return this.applying;
  }

  /**
   * Starts a seat once nothing blocks it: the session it resumes must not still run in a terminal (a takeover asks it
   * to close) and no other live session may hold the seat. While blocked the seat shows why; when the daemon cannot be
   * asked, the seat starts anyway. Opens the desktop live view when the seat's config asks for it.
   */
  private startSeat(worker: SeatWorker): CommandResult {
    const seatId = worker.seat.seatId; const launch = (this.launches.get(seatId) ?? 0) + 1;
    this.launches.set(seatId, launch);
    void this.launchWhenFree(worker, launch);
    return { ok: true, message: 'starting' };
  }

  private async launchWhenFree(worker: SeatWorker, launch: number): Promise<void> {
    const seatId = worker.seat.seatId;
    const current = (): boolean => !this.closed && this.workers.get(seatId) === worker && this.launches.get(seatId) === launch;
    while (current()) {
      const sessionId = this.state.sessionId(seatId);
      const check = await this.call<{ sessionLive: boolean; takeover: boolean; holder: string | null }>(`/v1/runners/me/seat-check?seatId=${seatId}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`).catch(() => null);
      if (!check || (!check.sessionLive && !check.holder)) break;
      const detail = check.sessionLive
        ? check.takeover ? `closing the terminal that still runs session ${sessionId!.slice(0, 8)} (it finishes its current turn first)` : `session ${sessionId!.slice(0, 8)} is still open in a terminal: close it, or save the seat again on the web to take it over`
        : `seat held by live session ${check.holder!.slice(0, 8)} in another terminal: close it, or pick it in the Session column to take it over`;
      const status: RunnerSeat = { ...worker.snapshot(), state: 'starting', detail };
      if (this.statuses.get(seatId)?.detail !== detail) { this.statuses.set(seatId, status); this.deps.out(`[${seatId}] waiting: ${detail}`); }
      await this.sleep(5000);
    }
    if (!current()) return;
    const result = worker.start();
    if (result.ok && worker.seat.showWindow) this.openWatch(seatId);
  }

  private openWatch(seatId: string): void {
    const why = this.deps.openWatch?.(seatId) ?? null;
    if (why && why !== 'already open') this.deps.out(`[${seatId}] no live-view window: ${why}`);
  }

  private addWorker(seat: SeatConfig): SeatWorker {
    const worker = new SeatWorker(seat, {
      spawn: this.deps.spawn ?? spawnClaude, state: this.state, listen: this.listen,
      onStatus: status => { this.statuses.set(status.seatId, status); this.deps.out(`[${status.seatId}] ${status.state}: ${status.detail}`); },
      onLog: entry => { this.logs.push(entry); if (this.logs.length > MAX_QUEUED_LOGS) this.logs = this.logs.slice(-MAX_QUEUED_LOGS); },
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.workers.set(seat.seatId, worker); this.statuses.set(seat.seatId, worker.snapshot());
    return worker;
  }

  /** Runs one manager command against a configured seat. */
  async execute(command: Pick<RunnerCommand, 'seatId' | 'kind' | 'text'>): Promise<CommandResult> {
    const worker = this.workers.get(command.seatId);
    if (!worker) return { ok: false, message: this.statuses.get(command.seatId)?.detail ?? `seat ${command.seatId} is not configured on this machine` };
    switch (command.kind) {
      case 'start': return this.startSeat(worker);
      case 'stop': this.launches.set(command.seatId, (this.launches.get(command.seatId) ?? 0) + 1); return worker.stop();
      case 'restart': await worker.stop(); return this.startSeat(worker);
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
    const { refused, config } = await this.call<{ refused: string[]; config: MachineConfig }>('/v1/runners/register', { body: { machine: this.deps.machine ?? hostname(), seats: [...this.statuses.values()] } });
    for (const seatId of refused) {
      this.deps.out(`[${seatId}] refused by the server (no such seat): stopping it`);
      await this.workers.get(seatId)?.stop(); this.workers.delete(seatId); this.statuses.delete(seatId);
    }
    this.registered = true; this.lastStatus = JSON.stringify([...this.statuses.values()]);
    // Local runner.json seats start after the first registration, so the daemon can say whether their seat is free.
    if (!this.localStarted) {
      this.localStarted = true;
      for (const seat of this.deps.config.seats) { const worker = this.workers.get(seat.seatId); if (seat.autoStart && worker) this.startSeat(worker); }
    }
    await this.applyConfig(config);
  }

  private async commandLoop(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      try {
        if (!this.registered) await this.register();
        const { commands, configVersion } = await this.call<{ commands: RunnerCommand[]; configVersion: number }>(`/v1/runners/me/commands?wait=${POLL_SECONDS}&version=${this.configVersion}`, { timeoutMs: (POLL_SECONDS + 15) * 1000 });
        failures = 0;
        if (configVersion !== this.configVersion) await this.applyConfig(await this.call<MachineConfig>('/v1/runners/me/config'));
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
