import type { Database } from '../db/database.js';
import type { CollabEvent, Seat, Task, TaskStatus } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { forbidden, invalid, notFound } from './office-error.js';
import { LEADERS_CHANNEL_ID, type OrgService } from './org-service.js';

export type TaskEvent = { taskId: string; actorKind: string; actorId: string; fromStatus: TaskStatus | null; toStatus: TaskStatus; note: string; createdAt: number };
type TaskFilter = { departmentId?: string | undefined; status?: TaskStatus | undefined; assignee?: string | undefined };
const TASK_COLUMNS = 'id,department_id AS departmentId,number,assignee_seat_id AS assigneeSeatId,requester_seat_id AS requesterSeatId,created_by_kind AS createdByKind,created_by_id AS createdById,title,body,status,created_at AS createdAt,updated_at AS updatedAt';
const actorId = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : actor.seatId;
const actorLabel = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : `@${actor.seatId}`;

/**
 * Department tasks. Leaders (or the manager) create and assign within one department; the assignee or the leader moves
 * status. Every change posts a system line in the department channel whose mentions decide who gets woken:
 * new/reassigned → assignee, blocked/done → leader, leader/manager status change → assignee. The actor is never mentioned.
 */
export class TaskService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly emit: (event: CollabEvent) => void) {}

  list(actor: Actor, filter: TaskFilter): Task[] {
    let departmentId = filter.departmentId;
    if (actor.kind === 'seat') {
      const own = this.org.seat(actor.seatId).departmentId;
      if (departmentId && departmentId !== own) throw forbidden('forbidden_task');
      departmentId = own;
    }
    const assignee = filter.assignee === 'me' && actor.kind === 'seat' ? actor.seatId : filter.assignee;
    const clauses: string[] = []; const params: string[] = [];
    if (departmentId) { clauses.push('department_id=?'); params.push(departmentId); }
    if (filter.status) { clauses.push('status=?'); params.push(filter.status); }
    if (assignee) { clauses.push('assignee_seat_id=?'); params.push(assignee); }
    return this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY status='done',updated_at DESC LIMIT 500`).all(...params) as Task[];
  }

  get(taskId: string): Task {
    const task = this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id=?`).get(taskId) as Task | undefined;
    if (!task) throw notFound('task');
    return task;
  }

  history(taskId: string): TaskEvent[] {
    return this.db.raw.prepare('SELECT task_id AS taskId,actor_kind AS actorKind,actor_id AS actorId,from_status AS fromStatus,to_status AS toStatus,note,created_at AS createdAt FROM task_events WHERE task_id=? ORDER BY id').all(taskId) as TaskEvent[];
  }

  create(actor: Actor, input: { departmentId?: string | undefined; title: string; body: string; assigneeSeatId: string; requestedBy?: string | undefined }): Task {
    if (input.title.trim().length === 0 || input.title.length > 200 || input.body.length > 8000) throw invalid('invalid_task');
    const assignee = this.org.seat(input.assigneeSeatId);
    let departmentId = input.departmentId ?? assignee.departmentId;
    if (actor.kind === 'seat') {
      const creator = this.org.seat(actor.seatId);
      if (creator.role !== 'leader' && !this.isDeputy(creator)) throw forbidden('leader_only');
      departmentId = creator.departmentId;
    }
    if (assignee.departmentId !== departmentId) throw forbidden('assignee_outside_department');
    // A cross-department request is tracked by naming the asking leader; the result is reported back to them.
    const requester = input.requestedBy ? this.org.seat(input.requestedBy.replace(/^@/, '')) : null;
    if (requester && (requester.role !== 'leader' || requester.departmentId === departmentId)) throw invalid('requester_must_be_other_department_leader');
    const timestamp = Date.now();
    const task = this.db.transaction(() => {
      const number = (this.db.raw.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM tasks WHERE department_id=?').get(departmentId) as { next: number }).next;
      const id = `t-${departmentId}-${number}`;
      this.db.raw.prepare('INSERT INTO tasks(id,department_id,number,assignee_seat_id,requester_seat_id,created_by_kind,created_by_id,title,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, departmentId, number, assignee.id, requester?.id ?? null, actor.kind, actorId(actor), input.title, input.body, 'todo', timestamp, timestamp);
      this.record(id, actor, null, 'todo', '');
      return this.get(id);
    });
    this.announce(task, `Task ${task.id} "${task.title}" assigned to @${assignee.id} by ${actorLabel(actor)}.${requester ? ` Requested by @${requester.id}.` : ''}${task.body ? ` Details: ${task.body}` : ''}`, [assignee.id]);
    if (requester) this.messages.postSystem(LEADERS_CHANNEL_ID, `Request from @${requester.id} accepted as task ${task.id} "${task.title}" (assignee @${assignee.id}). You will be told here when it is blocked or done.`, [requester.id]);
    return task;
  }

  update(actor: Actor, taskId: string, patch: { status?: TaskStatus | undefined; note?: string | undefined; assigneeSeatId?: string | undefined }): Task {
    const task = this.get(taskId); const leader = this.leaderOf(task.departmentId); const note = patch.note ?? '';
    if (note.length > 2000) throw invalid('invalid_task');
    const isLeader = actor.kind === 'manager' || actor.seatId === leader?.id || (actor.kind === 'seat' && this.isDeputy(this.org.seat(actor.seatId), task.departmentId));
    if (!isLeader && (actor.kind !== 'seat' || actor.seatId !== task.assigneeSeatId)) throw forbidden('forbidden_task');
    if (patch.assigneeSeatId !== undefined && !isLeader) throw forbidden('leader_only');
    if (task.status === 'done' && patch.status && patch.status !== 'done' && !isLeader) throw forbidden('reopen_requires_leader');
    const assignee = patch.assigneeSeatId !== undefined ? this.org.seat(patch.assigneeSeatId) : null;
    if (assignee && assignee.departmentId !== task.departmentId) throw forbidden('assignee_outside_department');
    const status = patch.status ?? task.status;
    const updated = this.db.transaction(() => {
      this.db.raw.prepare('UPDATE tasks SET status=?,assignee_seat_id=?,updated_at=? WHERE id=?').run(status, assignee?.id ?? task.assigneeSeatId, Date.now(), taskId);
      this.record(taskId, actor, task.status, status, note);
      return this.get(taskId);
    });
    const mentions = new Set<string>();
    if (assignee && assignee.id !== task.assigneeSeatId) mentions.add(assignee.id);
    if ((status === 'blocked' || status === 'done') && status !== task.status && leader) mentions.add(leader.id);
    if (isLeader && status !== task.status && updated.assigneeSeatId) mentions.add(updated.assigneeSeatId);
    if (actor.kind === 'seat') mentions.delete(actor.seatId);
    const change = status !== task.status ? `${task.status} → ${status}` : 'updated';
    const reassigned = assignee && assignee.id !== task.assigneeSeatId ? ` Reassigned to @${assignee.id}.` : '';
    this.announce(updated, `Task ${task.id} "${task.title}" ${change} by ${actorLabel(actor)}.${reassigned}${note ? ` Note: ${note}` : ''}`, [...mentions]);
    // Close the loop for cross-department requests without the serving leader having to relay it.
    if (updated.requesterSeatId && (status === 'blocked' || status === 'done') && status !== task.status) {
      this.messages.postSystem(LEADERS_CHANNEL_ID, `@${updated.requesterSeatId} your request ${task.id} "${task.title}" is ${status}${note ? `: ${note}` : '.'}`.slice(0, 16_000), [updated.requesterSeatId]);
    }
    return updated;
  }

  /** The department's deputy acts with the leader's task rights inside that department. */
  private isDeputy(seat: Seat, departmentId = seat.departmentId): boolean { return seat.departmentId === departmentId && this.org.department(departmentId).deputySeatId === seat.id; }

  private leaderOf(departmentId: string): Seat | null { return this.org.view().seats.find(seat => seat.departmentId === departmentId && seat.role === 'leader') ?? null; }

  private record(taskId: string, actor: Actor, from: TaskStatus | null, to: TaskStatus, note: string): void {
    this.db.raw.prepare('INSERT INTO task_events(task_id,actor_kind,actor_id,from_status,to_status,note,created_at) VALUES (?,?,?,?,?,?,?)').run(taskId, actor.kind, actorId(actor), from, to, note, Date.now());
  }

  private announce(task: Task, body: string, mentions: string[]): void {
    this.emit({ type: 'collab', kind: 'task', task });
    this.messages.postSystem(task.departmentId, body.slice(0, 16_000), mentions);
  }
}
