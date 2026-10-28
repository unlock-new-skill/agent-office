import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { CollabEvent, MachineConfig, MachineSeat, MachineSession, RunnerCommand, RunnerCommandKind, RunnerLogEntry, RunnerSeat, RunnerView } from '../../shared/contracts.js';
import { conflict, invalid, notFound } from './office-error.js';
import { isLiveSession, type OrgService } from './org-service.js';

/** A runner that polled within this window counts as online (its poll is the only presence signal). */
const ONLINE_MS = 90_000;
/** Commands nobody executed by then are dropped: a stale "restart" must not fire hours later. */
const COMMAND_TTL_MS = 2 * 60_000;
const LOG_RING = 300; const MAX_COMMANDS_PER_MINUTE = 30; const MAX_WAITERS = 64;
const COLUMNS = 'id,runner_id AS runnerId,seat_id AS seatId,kind,text,status,result,requested_by AS requestedBy,created_at AS createdAt,done_at AS doneAt';

type AgentRow = { id: string; sessionId: string; endedAt: string | null; lastContactAt: number | null };
type Row = { id: string; label: string | null; machine: string; seatsJson: string; lastSeenAt: number; configJson: string; configVersion: number };
const ROW = 'id,label,machine,seats_json AS seatsJson,last_seen_at AS lastSeenAt,config_json AS configJson,config_version AS configVersion';

/**
 * Per-machine runners (identified by their connector credential). A runner offers the seats of its local runner.json;
 * the manager sends start/stop/restart/interrupt/prompt commands for those seats, which the runner picks up by
 * long-polling. Commands are kept as an audit trail; the live log is an in-memory ring per seat.
 */
export class RunnerService {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly logs = new Map<string, RunnerLogEntry[]>();
  private readonly recent: number[] = [];
  private readonly online = new Set<string>();
  /** Interactive sessions asked to close so a runner can resume them (their Stop-hook listener ends the process). */
  private readonly takeovers = new Set<string>();

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly emit: (event: CollabEvent) => void) {}

  /** Records the runner and the seats it offers; returns unknown seat ids and the web-managed config to apply. */
  register(runnerId: string, machine: string, seats: RunnerSeat[]): { refused: string[]; config: MachineConfig } {
    const known = seats.filter(seat => this.seatExists(seat.seatId)); const refused = seats.filter(seat => !known.includes(seat)).map(seat => seat.seatId);
    this.db.raw.prepare('INSERT INTO runners(id,machine,seats_json,last_seen_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET machine=excluded.machine,seats_json=excluded.seats_json,last_seen_at=excluded.last_seen_at')
      .run(runnerId, machine.slice(0, 120), JSON.stringify(known), Date.now());
    this.touch(runnerId); this.publish();
    return { refused, config: this.config(runnerId) };
  }

  /** A machine created on the web before anything is installed on it; its install code binds the connector to this id. */
  createMachine(label: string): RunnerView {
    const id = `m-${randomBytes(6).toString('hex')}`;
    this.db.raw.prepare('INSERT INTO runners(id,label,machine,seats_json,last_seen_at) VALUES (?,?,?,?,0)').run(id, label.slice(0, 80), '', '[]');
    this.publish();
    return this.views().find(view => view.id === id)!;
  }

  renameMachine(id: string, label: string): void { this.row(id); this.db.raw.prepare('UPDATE runners SET label=? WHERE id=?').run(label.slice(0, 80), id); this.publish(); }

  deleteMachine(id: string): void { this.row(id); this.db.raw.prepare('DELETE FROM runners WHERE id=?').run(id); this.publish(); }

  config(id: string): MachineConfig {
    const row = this.row(id);
    return { version: row.configVersion, seats: this.configSeats(row) };
  }

  /**
   * Replaces a machine's seat list. Seats must exist and may run on one machine only. The runner is woken from its
   * command poll so it applies the change within seconds.
   */
  setConfig(id: string, seats: MachineSeat[]): MachineConfig {
    const row = this.row(id);
    const ids = seats.map(seat => seat.seatId);
    if (new Set(ids).size !== ids.length) throw invalid('duplicate_seat');
    for (const seatId of ids) if (!this.seatExists(seatId)) throw notFound('seat');
    for (const other of this.rows()) {
      if (other.id === id) continue;
      const taken = this.configSeats(other).find(seat => ids.includes(seat.seatId));
      if (taken) throw conflict(`seat_on_other_machine:${taken.seatId}`);
    }
    this.db.raw.prepare('UPDATE runners SET config_json=?,config_version=? WHERE id=?').run(JSON.stringify({ seats }), row.configVersion + 1, id);
    // A session picked for a seat that still runs in a terminal is asked to close; the runner resumes it afterwards.
    const runByRunners = new Set(this.rows().flatMap(other => this.seatsOf(other)).filter(seat => seat.sessionId && !['stopped', 'failed'].includes(seat.state)).map(seat => seat.sessionId));
    for (const seat of seats) {
      const agent = seat.sessionId && !runByRunners.has(seat.sessionId) ? this.agentBySession(seat.sessionId) : null;
      if (agent && this.isLive(agent)) this.takeovers.add(agent.id);
    }
    for (const wake of [...this.waiters.get(id) ?? []]) wake();
    this.publish();
    return this.config(id);
  }

  isTakenOver(agentId: string): boolean { return this.takeovers.has(agentId); }
  clearTakeover(agentId: string): void { this.takeovers.delete(agentId); }

  /**
   * What stops a runner from starting a seat now: the session it should resume still running elsewhere, or another
   * live session holding the seat. Either blocker clears by itself once that session ends or goes quiet.
   */
  seatCheck(runnerId: string, seatId: string, sessionId: string | null): { sessionLive: boolean; takeover: boolean; holder: string | null } {
    if (!this.offered(this.row(runnerId)).has(seatId)) throw notFound('seat');
    const own = sessionId ? this.agentBySession(sessionId) : null;
    const sessionLive = own ? this.isLive(own) : false;
    if (own && !sessionLive) this.takeovers.delete(own.id);
    const seat = this.db.raw.prepare('SELECT agent_id AS agentId FROM seats WHERE id=?').get(seatId) as { agentId: string | null } | undefined;
    const holderAgent = seat?.agentId ? this.db.raw.prepare('SELECT id,session_id AS sessionId,ended_at AS endedAt,last_contact_at AS lastContactAt FROM agents WHERE id=?').get(seat.agentId) as AgentRow | undefined : undefined;
    const holder = holderAgent && this.isLive(holderAgent) && holderAgent.sessionId !== sessionId ? holderAgent.sessionId : null;
    return { sessionLive, takeover: own ? this.takeovers.has(own.id) : false, holder };
  }

  /** Claude sessions the machine's hooks registered, newest first: candidates for a seat's repo and session id. */
  sessions(id: string): MachineSession[] {
    this.row(id);
    return (this.db.raw.prepare('SELECT a.id AS agentId,a.session_id AS sessionId,a.project,a.ended_at IS NOT NULL AS ended,s.id AS seatId,a.last_contact_at AS lastContactAt FROM agents a LEFT JOIN seats s ON s.agent_id=a.id WHERE a.machine_id=? ORDER BY a.last_contact_at DESC LIMIT 40').all(id) as Array<Omit<MachineSession, 'ended'> & { ended: number }>)
      .map(row => ({ ...row, ended: Boolean(row.ended) }));
  }

  updateSeats(runnerId: string, seats: RunnerSeat[]): void {
    const row = this.row(runnerId);
    const offered = this.offered(row);
    this.db.raw.prepare('UPDATE runners SET seats_json=?,last_seen_at=? WHERE id=?').run(JSON.stringify(seats.filter(seat => offered.has(seat.seatId))), Date.now(), runnerId);
    this.touch(runnerId); this.publish();
  }

  appendLog(runnerId: string, entries: RunnerLogEntry[]): void {
    const offered = this.offered(this.row(runnerId));
    const bySeat = new Map<string, RunnerLogEntry[]>();
    for (const entry of entries) if (offered.has(entry.seatId)) bySeat.set(entry.seatId, [...bySeat.get(entry.seatId) ?? [], entry]);
    for (const [seatId, added] of bySeat) {
      this.logs.set(seatId, [...this.logs.get(seatId) ?? [], ...added].slice(-LOG_RING));
      this.emit({ type: 'collab', kind: 'runner-log', seatId, entries: added });
    }
  }

  log(seatId: string): RunnerLogEntry[] { return this.logs.get(seatId) ?? []; }

  /** Manager command for a seat; goes to the online runner that offers it. */
  enqueue(seatId: string, kind: RunnerCommandKind, text: string | null, requestedBy: string): RunnerCommand {
    const owner = this.ownerOf(seatId);
    if (!owner) throw conflict('no_runner_for_seat');
    if (!this.isOnline(owner)) throw conflict('runner_offline');
    const now = Date.now();
    while (this.recent.length && now - this.recent[0]! > 60_000) this.recent.shift();
    if (this.recent.length >= MAX_COMMANDS_PER_MINUTE) throw conflict('too_many_commands');
    this.recent.push(now);
    const command: RunnerCommand = { id: randomUUID(), runnerId: owner.id, seatId, kind, text: kind === 'prompt' ? text : null, status: 'queued', result: null, requestedBy, createdAt: now, doneAt: null };
    this.db.raw.prepare('INSERT INTO runner_commands(id,runner_id,seat_id,kind,text,status,requested_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(command.id, command.runnerId, seatId, kind, command.text, 'queued', requestedBy, now);
    this.emit({ type: 'collab', kind: 'runner-command', command });
    for (const wake of [...this.waiters.get(owner.id) ?? []]) wake();
    return command;
  }

  /** Long-poll for the runner: hands over queued commands (marking them sent) or waits until one arrives or its config changes. */
  async poll(runnerId: string, timeoutMs: number, signal?: AbortSignal, knownVersion = -1): Promise<{ commands: RunnerCommand[]; configVersion: number }> {
    this.row(runnerId); this.touch(runnerId);
    let commands = this.take(runnerId);
    if (commands.length === 0 && this.row(runnerId).configVersion === knownVersion && timeoutMs > 0 && !signal?.aborted && this.waiterCount() < MAX_WAITERS) {
      await new Promise<void>(resolve => {
        const listeners = this.waiters.get(runnerId) ?? new Set<() => void>(); this.waiters.set(runnerId, listeners);
        const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); listeners.delete(done); if (listeners.size === 0) this.waiters.delete(runnerId); resolve(); };
        const timer = setTimeout(done, timeoutMs);
        listeners.add(done); signal?.addEventListener('abort', done, { once: true });
      });
      this.touch(runnerId);
      commands = this.take(runnerId);
    }
    return { commands, configVersion: this.row(runnerId).configVersion };
  }

  complete(runnerId: string, commandId: string, ok: boolean, message: string): RunnerCommand {
    const changed = this.db.raw.prepare("UPDATE runner_commands SET status=?,result=?,done_at=? WHERE id=? AND runner_id=? AND status='sent'").run(ok ? 'done' : 'failed', message.slice(0, 500), Date.now(), commandId, runnerId);
    const command = this.command(commandId);
    if (changed.changes === 0 && command.runnerId !== runnerId) throw notFound('command');
    this.emit({ type: 'collab', kind: 'runner-command', command });
    return command;
  }

  commands(seatId: string, limit = 20): RunnerCommand[] {
    return this.db.raw.prepare(`SELECT ${COLUMNS} FROM runner_commands WHERE seat_id=? ORDER BY created_at DESC LIMIT ?`).all(seatId, limit) as RunnerCommand[];
  }

  views(): RunnerView[] {
    return this.rows().map(row => ({ id: row.id, label: row.label, machine: row.machine, online: this.isOnline(row), lastSeenAt: row.lastSeenAt, seats: this.seatsOf(row), config: { version: row.configVersion, seats: this.configSeats(row) } }));
  }

  /** Periodic sweep: expires stale commands and announces runners that went quiet. */
  sweep(): void {
    const expired = this.db.raw.prepare(`UPDATE runner_commands SET status='expired',done_at=? WHERE status IN ('queued','sent') AND created_at<? RETURNING ${COLUMNS}`).all(Date.now(), Date.now() - COMMAND_TTL_MS) as RunnerCommand[];
    for (const command of expired) this.emit({ type: 'collab', kind: 'runner-command', command });
    let changed = false;
    for (const id of [...this.online]) { if (!this.waiters.has(id) && Date.now() - this.row(id).lastSeenAt > ONLINE_MS) { this.online.delete(id); changed = true; } }
    if (changed) this.publish();
  }

  waiterCount(): number { let count = 0; for (const listeners of this.waiters.values()) count += listeners.size; return count; }
  close(): void { for (const listeners of this.waiters.values()) for (const done of [...listeners]) done(); }

  private take(runnerId: string): RunnerCommand[] {
    return this.db.transaction(() => {
      const rows = this.db.raw.prepare(`SELECT ${COLUMNS} FROM runner_commands WHERE runner_id=? AND status='queued' AND created_at>=? ORDER BY created_at`).all(runnerId, Date.now() - COMMAND_TTL_MS) as RunnerCommand[];
      for (const row of rows) { this.db.raw.prepare("UPDATE runner_commands SET status='sent' WHERE id=?").run(row.id); row.status = 'sent'; }
      return rows;
    });
  }

  private touch(runnerId: string): void {
    this.db.raw.prepare('UPDATE runners SET last_seen_at=? WHERE id=?').run(Date.now(), runnerId);
    if (!this.online.has(runnerId)) { this.online.add(runnerId); this.publish(); }
  }

  /** The most recently seen runner offering the seat (a seat moved to another machine follows the newer runner). */
  private ownerOf(seatId: string): Row | null {
    const rows = [...this.rows()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return rows.find(row => this.offered(row).has(seatId)) ?? null;
  }

  /** Seats a runner may report on and take commands for: those it registered plus those the web assigned to it. */
  private offered(row: Row): Set<string> { return new Set([...this.seatsOf(row).map(seat => seat.seatId), ...this.configSeats(row).map(seat => seat.seatId)]); }
  private agentBySession(sessionId: string): AgentRow | null {
    return (this.db.raw.prepare('SELECT id,session_id AS sessionId,ended_at AS endedAt,last_contact_at AS lastContactAt FROM agents WHERE session_id=? ORDER BY last_contact_at DESC LIMIT 1').get(sessionId) as AgentRow | undefined) ?? null;
  }
  private isLive(agent: AgentRow): boolean { return isLiveSession(agent); }
  private rows(): Row[] { return this.db.raw.prepare(`SELECT ${ROW} FROM runners ORDER BY COALESCE(label,machine)`).all() as Row[]; }
  private configSeats(row: Row): MachineSeat[] { try { return (JSON.parse(row.configJson) as { seats: MachineSeat[] }).seats; } catch { return []; } }
  private isOnline(row: Row): boolean { return this.waiters.has(row.id) || Date.now() - row.lastSeenAt <= ONLINE_MS; }
  private seatsOf(row: Row): RunnerSeat[] { try { return JSON.parse(row.seatsJson) as RunnerSeat[]; } catch { return []; } }
  private seatExists(seatId: string): boolean { try { this.org.seat(seatId); return true; } catch { return false; } }
  private command(id: string): RunnerCommand {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM runner_commands WHERE id=?`).get(id) as RunnerCommand | undefined;
    if (!row) throw notFound('command');
    return row;
  }
  private row(runnerId: string): Row {
    const row = this.db.raw.prepare(`SELECT ${ROW} FROM runners WHERE id=?`).get(runnerId) as Row | undefined;
    if (!row) throw notFound('runner');
    return row;
  }
  private publish(): void { this.emit({ type: 'collab', kind: 'runners', runners: this.views() }); }
}
