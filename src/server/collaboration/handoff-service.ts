import type { Database } from '../db/database.js';
import type { SeatHandoff, TaskStatus } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { forbidden } from './office-error.js';
import type { OrgService } from './org-service.js';

const MAX_BRIEF = 6000; const MAX_NOTE_IN_BRIEF = 2500; const MAX_TASKS = 10; const MAX_SUMMARY_IN_BRIEF = 1500; const RECENT_LINES = 8; const RECENT_ITEM = 220;
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
  /** Stores the summary Claude Code wrote when it compacted this seat's session (latest one wins). */
  saveCompaction(seatId: string, agentId: string, summary: string): void {
    this.db.raw.prepare('INSERT INTO seat_compactions(seat_id,summary,agent_id,created_at) VALUES (?,?,?,?) ON CONFLICT(seat_id) DO UPDATE SET summary=excluded.summary,agent_id=excluded.agent_id,created_at=excluded.created_at')
      .run(seatId, summary.trim().slice(0, 6000), agentId, Date.now());
  }

  /**
   * `afterCompaction`: the session just compacted and already holds its own summary, so the stored one is skipped;
   * every other start (new session, other machine, resume) gets it when it is newer than the seat note.
   */
  brief(seatId: string, options: { afterCompaction?: boolean; now?: number } = {}): string {
    const now = options.now ?? Date.now();
    const note = this.db.raw.prepare(`SELECT ${HANDOFF_COLUMNS} FROM seat_handoffs WHERE seat_id=?`).get(seatId) as SeatHandoff | undefined;
    const tasks = this.db.raw.prepare("SELECT id,number,title,status FROM tasks WHERE assignee_seat_id=? AND status<>'done' ORDER BY status='todo',updated_at DESC LIMIT ?").all(seatId, MAX_TASKS) as Array<{ id: string; number: number; title: string; status: TaskStatus }>;
    const unread = this.messages.channelsForSeat(seatId).filter(channel => channel.unread > 0);
    const lines = [`[Agent Office] Handoff for @${seatId} — what previous sessions on this seat left for you:`];
    if (note?.body) {
      const body = note.body.length > MAX_NOTE_IN_BRIEF ? `${note.body.slice(0, MAX_NOTE_IN_BRIEF)}… (truncated; full note via agent_office_whoami)` : note.body;
      lines.push(`Note (updated ${age(now - note.updatedAt)} ago by ${note.updatedBy}):`, body);
    } else lines.push('Note: none yet.');
    const compaction = this.db.raw.prepare('SELECT summary,created_at AS createdAt FROM seat_compactions WHERE seat_id=?').get(seatId) as { summary: string; createdAt: number } | undefined;
    if (compaction && !options.afterCompaction && compaction.createdAt > (note?.updatedAt ?? 0)) {
      const summary = compaction.summary.length > MAX_SUMMARY_IN_BRIEF ? `${compaction.summary.slice(0, MAX_SUMMARY_IN_BRIEF)}…` : compaction.summary;
      lines.push(`Auto summary from the previous session's last context compaction (${age(now - compaction.createdAt)} ago):`, summary);
    }
    lines.push(tasks.length ? `Open tasks assigned to you:\n${tasks.map(task => `- ${task.id} #${task.number} [${task.status}] ${task.title}`).join('\n')}` : 'Open tasks assigned to you: none.');
    lines.push(...this.crossDepartment(seatId));
    lines.push(...this.recentConversation(seatId));
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

  /**
   * The last few messages this seat was part of — its own, ones mentioning it, and replies in threads it started or
   * joined — with [seq]/thread ids, so a session that lost its context (compaction, restart) can pick the thread back up.
   */
  private recentConversation(seatId: string): string[] {
    type Row = { channelId: string; seq: number; threadSeq: number | null; senderKind: string; senderId: string; body: string };
    // Threads the seat took part in are resolved once up front; a per-message correlated subquery here was O(n²) and
    // blocked the event loop for tens of seconds per whoami on a channel with a few thousand messages.
    const rows = this.db.raw.prepare(`WITH mine AS (SELECT DISTINCT channel_id,COALESCE(thread_seq,seq) AS root FROM messages WHERE sender_kind='seat' AND sender_id=?)
      SELECT m.channel_id AS channelId,m.seq,m.thread_seq AS threadSeq,m.sender_kind AS senderKind,m.sender_id AS senderId,m.body
      FROM messages m JOIN channel_members cm ON cm.channel_id=m.channel_id AND cm.seat_id=?
      WHERE m.deleted_at IS NULL AND (
        (m.sender_kind='seat' AND m.sender_id=?) OR m.mentions_json LIKE ? OR
        (m.thread_seq IS NOT NULL AND (m.channel_id,m.thread_seq) IN (SELECT channel_id,root FROM mine))
      ) ORDER BY m.created_at DESC LIMIT ?`).all(seatId, seatId, seatId, `%"${seatId}"%`, RECENT_LINES) as Row[];
    if (rows.length === 0) return ['Recent conversation: none.'];
    const line = (row: Row): string => {
      const where = row.threadSeq ? `#${row.channelId} thread [${row.threadSeq}]` : `#${row.channelId} [${row.seq}]`;
      const who = row.senderKind === 'seat' ? (row.senderId === seatId ? 'you' : `@${row.senderId}`) : row.senderKind;
      const body = row.body.replace(/\s+/g, ' ').trim();
      return `- ${where} ${who}: ${body.length > RECENT_ITEM ? `${body.slice(0, RECENT_ITEM)}…` : body}`;
    };
    return [`Recent conversation (newest last; continue a thread with agent_office_send_message threadSeq, full thread via agent_office_read_thread):\n${rows.reverse().map(line).join('\n')}`];
  }

  private authorize(actor: Actor, seatId: string): void {
    this.org.seat(seatId);
    if (actor.kind === 'seat' && actor.seatId !== seatId) throw forbidden('forbidden_handoff');
  }
}
