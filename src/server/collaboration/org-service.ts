import type { Database } from '../db/database.js';
import type { Channel, CollabEvent, Department, OfficeConfig, OrgView, Seat, SeatRole } from '../../shared/contracts.js';
import { conflict, invalid, notFound, slugify } from './office-error.js';

export const LEADERS_CHANNEL_ID = 'leaders';
type SeatRow = { id: string; departmentId: string; title: string; description: string; role: SeatRole; sort: number; agentId: string | null; consecutiveWakes: number };
const SEAT_COLUMNS = 'id,department_id AS departmentId,title,description,role,sort,agent_id AS agentId,consecutive_wakes AS consecutiveWakes';

/** Departments, seats and channel membership. Membership is always derived: department channel = its seats, leaders channel = all leader seats. */
/**
 * A session counts as running while it has not ended and reached the daemon recently: live sessions always do, since
 * their Stop-hook listener asks for work at least once a minute. A crashed or abandoned terminal stops holding its seat.
 */
export const LIVE_SESSION_MS = 5 * 60_000;
export const isLiveSession = (agent: { endedAt: string | null; lastContactAt: number | null }, now = Date.now()): boolean =>
  agent.endedAt === null && agent.lastContactAt !== null && now - agent.lastContactAt < LIVE_SESSION_MS;

export class OrgService {
  /** Seats whose session is currently parked in a Stop-hook long-poll. */
  readonly listening = new Set<string>();
  /** Invoked after structural changes (not after publish-only refreshes) so parked waiters can re-evaluate. */
  onMutated: () => void = () => undefined;

  constructor(private readonly db: Database, private readonly emit: (event: CollabEvent) => void, private readonly maxAutoWakes: number) {
    this.db.raw.prepare("INSERT OR IGNORE INTO channels(id,name,kind,department_id) VALUES (?,?,'leaders',NULL)").run(LEADERS_CHANNEL_ID, LEADERS_CHANNEL_ID);
  }

  view(): OrgView {
    const departments = (this.db.raw.prepare('SELECT id,name,color,sort,paused,deputy_seat_id AS deputySeatId FROM departments ORDER BY sort,name').all() as Array<Omit<Department, 'paused'> & { paused: number }>).map(row => ({ ...row, paused: row.paused === 1 }));
    const seats = (this.db.raw.prepare(`SELECT ${SEAT_COLUMNS} FROM seats ORDER BY role='member',sort,title`).all() as SeatRow[]).map(row => this.toSeat(row));
    const members = this.db.raw.prepare('SELECT channel_id AS channelId,seat_id AS seatId FROM channel_members').all() as Array<{ channelId: string; seatId: string }>;
    const order = new Map(departments.map((department, index) => [department.id, index]));
    const channels = (this.db.raw.prepare('SELECT c.id,c.name,c.kind,c.department_id AS departmentId,COALESCE(MAX(m.seq),0) AS lastSeq FROM channels c LEFT JOIN messages m ON m.channel_id=c.id GROUP BY c.id').all() as Array<Omit<Channel, 'memberSeatIds'>>)
      .map(channel => ({ ...channel, memberSeatIds: members.filter(member => member.channelId === channel.id).map(member => member.seatId) }))
      .sort((a, b) => (a.kind === 'leaders' ? -1 : (order.get(a.departmentId ?? '') ?? 0)) - (b.kind === 'leaders' ? -1 : (order.get(b.departmentId ?? '') ?? 0)));
    return { departments, seats, channels };
  }

  department(id: string): Department {
    const row = this.db.raw.prepare('SELECT id,name,color,sort,paused,deputy_seat_id AS deputySeatId FROM departments WHERE id=?').get(id) as (Omit<Department, 'paused'> & { paused: number }) | undefined;
    if (!row) throw notFound('department');
    return { ...row, paused: row.paused === 1 };
  }

  seat(id: string): Seat {
    const row = this.db.raw.prepare(`SELECT ${SEAT_COLUMNS} FROM seats WHERE id=?`).get(id) as SeatRow | undefined;
    if (!row) throw notFound('seat');
    return this.toSeat(row);
  }

  seatForAgent(agentId: string): Seat | null {
    const row = this.db.raw.prepare(`SELECT ${SEAT_COLUMNS} FROM seats WHERE agent_id=?`).get(agentId) as SeatRow | undefined;
    return row ? this.toSeat(row) : null;
  }

  channel(id: string): Channel {
    const channel = this.view().channels.find(candidate => candidate.id === id);
    if (!channel) throw notFound('channel');
    return channel;
  }

  isMember(channelId: string, seatId: string): boolean { return Boolean(this.db.raw.prepare('SELECT 1 FROM channel_members WHERE channel_id=? AND seat_id=?').get(channelId, seatId)); }

  seedIfEmpty(config: OfficeConfig): boolean {
    if ((this.db.raw.prepare('SELECT COUNT(*) AS count FROM departments').get() as { count: number }).count > 0) return false;
    this.seed(config); return true;
  }

  seed(config: OfficeConfig): void {
    this.mutate(() => config.departments.forEach((department, index) => {
      this.insertDepartment(department.id, department.name, department.color, index);
      department.seats.forEach((seat, seatIndex) => this.insertSeat(department.id, seat.id, seat.title, seat.description, seat.role, seatIndex));
    }));
  }

  createDepartment(input: { id?: string | undefined; name: string; color: string }): Department {
    const id = input.id ?? this.uniqueId('departments', slugify(input.name));
    if (id === LEADERS_CHANNEL_ID) throw conflict('department_id_reserved');
    const sort = (this.db.raw.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS next FROM departments').get() as { next: number }).next;
    this.mutate(() => this.insertDepartment(id, input.name, input.color, sort));
    return this.department(id);
  }

  updateDepartment(id: string, patch: { name?: string | undefined; color?: string | undefined; paused?: boolean | undefined; deputySeatId?: string | null | undefined }): Department {
    const current = this.department(id);
    if (patch.deputySeatId) {
      const deputy = this.seat(patch.deputySeatId);
      if (deputy.departmentId !== id || deputy.role !== 'member') throw invalid('deputy_must_be_member_of_department');
    }
    const deputySeatId = patch.deputySeatId === undefined ? current.deputySeatId : patch.deputySeatId;
    this.mutate(() => {
      this.db.raw.prepare('UPDATE departments SET name=?,color=?,paused=?,deputy_seat_id=? WHERE id=?').run(patch.name ?? current.name, patch.color ?? current.color, (patch.paused ?? current.paused) ? 1 : 0, deputySeatId, id);
      if (patch.paused === false) this.db.raw.prepare('UPDATE seats SET consecutive_wakes=0 WHERE department_id=?').run(id);
    });
    return this.department(id);
  }

  deleteDepartment(id: string): void {
    this.department(id);
    if (this.db.raw.prepare('SELECT 1 FROM seats WHERE department_id=? AND agent_id IS NOT NULL').get(id)) throw conflict('department_has_seated_agents');
    this.mutate(() => this.db.raw.prepare('DELETE FROM departments WHERE id=?').run(id));
  }

  createSeat(departmentId: string, input: { id?: string | undefined; title: string; description: string; role: SeatRole }): Seat {
    this.department(departmentId);
    const id = input.id ?? this.uniqueId('seats', slugify(input.title));
    const sort = (this.db.raw.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS next FROM seats WHERE department_id=?').get(departmentId) as { next: number }).next;
    this.mutate(() => this.insertSeat(departmentId, id, input.title, input.description, input.role, sort));
    return this.seat(id);
  }

  updateSeat(id: string, patch: { title?: string | undefined; description?: string | undefined; role?: SeatRole | undefined }): Seat {
    const current = this.seat(id);
    if (patch.role === 'leader' && current.role !== 'leader') this.assertNoLeader(current.departmentId);
    this.mutate(() => this.db.raw.prepare('UPDATE seats SET title=?,description=?,role=? WHERE id=?').run(patch.title ?? current.title, patch.description ?? current.description, patch.role ?? current.role, id));
    return this.seat(id);
  }

  deleteSeat(id: string): void { this.seat(id); this.mutate(() => this.db.raw.prepare('DELETE FROM seats WHERE id=?').run(id)); }

  /** Binds a registered session (agent) to a seat, or unbinds it with null. */
  assignAgent(seatId: string, agentId: string | null): Seat {
    this.seat(seatId);
    if (agentId !== null) {
      if (!this.db.raw.prepare('SELECT 1 FROM agents WHERE id=?').get(agentId)) throw notFound('agent');
      const holder = this.seatForAgent(agentId);
      if (holder && holder.id !== seatId) throw conflict('agent_already_seated');
    }
    this.mutate(() => this.db.raw.prepare('UPDATE seats SET agent_id=?,consecutive_wakes=0 WHERE id=?').run(agentId, seatId));
    this.listening.delete(seatId);
    return this.seat(seatId);
  }

  /**
   * Self-service seat claim by a session: allowed when the seat is vacant, already held by this agent, or held by a
   * session that exited or went quiet (see isLiveSession). A live occupant wins (seat_occupied). Claiming releases the agent's previous seat.
   */
  claimSeat(seatId: string, agentId: string): Seat {
    const seat = this.seat(seatId);
    if (seat.agentId && seat.agentId !== agentId) {
      const occupant = this.db.raw.prepare('SELECT ended_at AS endedAt,last_contact_at AS lastContactAt FROM agents WHERE id=?').get(seat.agentId) as { endedAt: string | null; lastContactAt: number | null } | undefined;
      if (occupant && isLiveSession(occupant)) throw conflict('seat_occupied');
    }
    if (seat.agentId === agentId) return seat;
    const previous = this.seatForAgent(agentId);
    this.mutate(() => {
      this.db.raw.prepare('UPDATE seats SET agent_id=NULL WHERE agent_id=?').run(agentId);
      this.db.raw.prepare('UPDATE seats SET agent_id=?,consecutive_wakes=0 WHERE id=?').run(agentId, seatId);
    });
    if (previous) this.listening.delete(previous.id);
    this.listening.delete(seatId);
    return this.seat(seatId);
  }

  /** Frees whatever seat the agent holds (no-op when unseated). */
  releaseAgent(agentId: string): void {
    const seat = this.seatForAgent(agentId);
    if (!seat) return;
    this.mutate(() => this.db.raw.prepare('UPDATE seats SET agent_id=NULL WHERE id=?').run(seat.id));
    this.listening.delete(seat.id);
  }

  /** Publishes the current org view; used when only derived state (e.g. listening) changed. */
  publish(): void { this.emit({ type: 'collab', kind: 'org', org: this.view() }); }

  private mutate(operation: () => void): void {
    try { this.db.transaction(() => { operation(); this.syncMembership(); }); }
    catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: seats.department_id/.test(error.message)) throw conflict('department_has_leader');
      if (error instanceof Error && /UNIQUE constraint failed: (departments|seats|channels)\.(id|name)/.test(error.message)) throw conflict('duplicate_id_or_name');
      throw error;
    }
    this.publish(); this.onMutated();
  }

  private syncMembership(): void {
    this.db.raw.exec(`
      DELETE FROM channel_members;
      INSERT INTO channel_members(channel_id,seat_id) SELECT c.id,s.id FROM channels c JOIN seats s ON s.department_id=c.department_id WHERE c.kind='department';
      INSERT INTO channel_members(channel_id,seat_id) SELECT '${LEADERS_CHANNEL_ID}',id FROM seats WHERE role='leader';
      UPDATE departments SET deputy_seat_id=NULL WHERE deputy_seat_id IN (SELECT id FROM seats WHERE role='leader' OR department_id<>departments.id);
      INSERT OR IGNORE INTO channel_members(channel_id,seat_id) SELECT '${LEADERS_CHANNEL_ID}',deputy_seat_id FROM departments WHERE deputy_seat_id IS NOT NULL;
    `);
  }

  private insertDepartment(id: string, name: string, color: string, sort: number): void {
    this.db.raw.prepare('INSERT INTO departments(id,name,color,sort) VALUES (?,?,?,?)').run(id, name, color, sort);
    this.db.raw.prepare("INSERT INTO channels(id,name,kind,department_id) VALUES (?,?,'department',?)").run(id, id, id);
  }

  private insertSeat(departmentId: string, id: string, title: string, description: string, role: SeatRole, sort: number): void {
    if (role === 'leader') this.assertNoLeader(departmentId);
    this.db.raw.prepare('INSERT INTO seats(id,department_id,title,description,role,sort) VALUES (?,?,?,?,?,?)').run(id, departmentId, title, description, role, sort);
  }

  private assertNoLeader(departmentId: string): void {
    if (this.db.raw.prepare("SELECT 1 FROM seats WHERE department_id=? AND role='leader'").get(departmentId)) throw conflict('department_has_leader');
  }

  private uniqueId(table: 'departments' | 'seats', base: string): string {
    const taken = (candidate: string): boolean => Boolean(this.db.raw.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(candidate)) || (table === 'departments' && candidate === LEADERS_CHANNEL_ID);
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix++) if (!taken(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }

  private toSeat(row: SeatRow): Seat {
    const wakeState = row.consecutiveWakes >= this.maxAutoWakes ? 'wake_limited' : this.listening.has(row.id) ? 'listening' : 'idle';
    return { ...row, wakeState };
  }
}
