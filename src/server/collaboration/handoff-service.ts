import type { Database } from '../db/database.js';
import type { SeatHandoff, TaskStatus } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { forbidden } from './office-error.js';
import type { OrgService } from './org-service.js';

const MAX_BRIEF = 4000; const MAX_NOTE_IN_BRIEF = 2500; const MAX_TASKS = 10;
const HANDOFF_COLUMNS = 'seat_id AS seatId,body,updated_at AS updatedAt,updated_by AS updatedBy';

const age = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
};

/**
 * Seat-scoped working memory. Context belongs to the seat, not the Claude session, so a fresh session on any machine
 * that takes the seat can continue: the agent keeps a handoff note, and the brief adds open tasks and unread counts.
 */
export class HandoffService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService) {}

  get(actor: Actor, seatId: string): SeatHandoff | null {
    this.authorize(actor, seatId);
    return this.db.raw.prepare(`SELECT ${HANDOFF_COLUMNS} FROM seat_handoffs WHERE seat_id=?`).get(seatId) as SeatHandoff | undefined ?? null;
  }

  /** Overwrites the seat's note. The manager may edit any seat; an agent only its own. */
  save(actor: Actor, seatId: string, body: string): SeatHandoff {
    this.authorize(actor, seatId);
    const handoff: SeatHandoff = { seatId, body: body.trim(), updatedAt: Date.now(), updatedBy: actor.kind === 'manager' ? 'manager' : this.org.seat(seatId).agentId ?? seatId };
    this.db.raw.prepare('INSERT INTO seat_handoffs(seat_id,body,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(seat_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .run(seatId, handoff.body, handoff.updatedAt, handoff.updatedBy);
    return handoff;
  }

  /** Bounded plain-text brief injected into a session's context when it takes (or resumes, or compacts in) a seat. */
  brief(seatId: string, now = Date.now()): string {
    const note = this.db.raw.prepare(`SELECT ${HANDOFF_COLUMNS} FROM seat_handoffs WHERE seat_id=?`).get(seatId) as SeatHandoff | undefined;
    const tasks = this.db.raw.prepare("SELECT id,number,title,status FROM tasks WHERE assignee_seat_id=? AND status<>'done' ORDER BY status='todo',updated_at DESC LIMIT ?").all(seatId, MAX_TASKS) as Array<{ id: string; number: number; title: string; status: TaskStatus }>;
    const unread = this.messages.channelsForSeat(seatId).filter(channel => channel.unread > 0);
    const lines = [`[Agent Office] Handoff for @${seatId} — what previous sessions on this seat left for you:`];
    if (note?.body) {
      const body = note.body.length > MAX_NOTE_IN_BRIEF ? `${note.body.slice(0, MAX_NOTE_IN_BRIEF)}… (truncated; full note via agent_office_whoami)` : note.body;
      lines.push(`Note (updated ${age(now - note.updatedAt)} ago by ${note.updatedBy}):`, body);
    } else lines.push('Note: none yet.');
    lines.push(tasks.length ? `Open tasks assigned to you:\n${tasks.map(task => `- ${task.id} #${task.number} [${task.status}] ${task.title}`).join('\n')}` : 'Open tasks assigned to you: none.');
    lines.push(...this.crossDepartment(seatId));
    lines.push(unread.length ? `Unread: ${unread.map(channel => `#${channel.id} ${channel.unread}`).join(', ')} — read them with agent_office_read_channel.` : 'Unread: none.');
    lines.push('Keep the note current with agent_office_save_handoff (what you are doing, decisions, next steps, where the code is) whenever you finish or pause a task.');
    const text = lines.join('\n');
    return text.length > MAX_BRIEF ? `${text.slice(0, MAX_BRIEF - 1)}…` : text;
  }

  /** For a leader (or its deputy): requests the department is serving for others, and its own requests still open elsewhere. */
  private crossDepartment(seatId: string): string[] {
    const seat = this.org.seat(seatId); const department = this.org.department(seat.departmentId);
    if (seat.role !== 'leader' && department.deputySeatId !== seatId) return [];
    const leaderId = seat.role === 'leader' ? seat.id : (this.db.raw.prepare("SELECT id FROM seats WHERE department_id=? AND role='leader'").get(seat.departmentId) as { id: string } | undefined)?.id;
    type Row = { id: string; title: string; status: TaskStatus; other: string };
    const serving = this.db.raw.prepare("SELECT id,title,status,requester_seat_id AS other FROM tasks WHERE department_id=? AND requester_seat_id IS NOT NULL AND status<>'done' ORDER BY updated_at DESC LIMIT ?").all(seat.departmentId, MAX_TASKS) as Row[];
    const waiting = leaderId ? this.db.raw.prepare("SELECT id,title,status,department_id AS other FROM tasks WHERE requester_seat_id=? AND status<>'done' ORDER BY updated_at DESC LIMIT ?").all(leaderId, MAX_TASKS) as Row[] : [];
    return [
      serving.length ? `Requests your department is serving:\n${serving.map(task => `- ${task.id} [${task.status}] ${task.title} ← @${task.other}`).join('\n')}` : 'Requests your department is serving: none.',
      waiting.length ? `Your requests still open in other departments:\n${waiting.map(task => `- ${task.id} [${task.status}] ${task.title} → ${task.other}`).join('\n')}` : 'Your requests still open in other departments: none.',
    ];
  }

  private authorize(actor: Actor, seatId: string): void {
    this.org.seat(seatId);
    if (actor.kind === 'seat' && actor.seatId !== seatId) throw forbidden('forbidden_handoff');
  }
}
