import type { Database } from '../db/database.js';
import type { CollabEvent, Seat, Task, TaskStatus } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { forbidden, invalid, notFound } from './office-error.js';
import { LEADERS_CHANNEL_ID, OUTPUTS_CHANNEL_ID, type OrgService } from './org-service.js';

export type TaskEvent = { taskId: string; actorKind: string; actorId: string; fromStatus: TaskStatus | null; toStatus: TaskStatus; note: string; createdAt: number };
type TaskFilter = { departmentId?: string | undefined; status?: TaskStatus | undefined; assignee?: string | undefined };
type TaskPlan = { estimateMinutes?: number | null | undefined; dependsOn?: string[] | undefined };
const TASK_COLUMNS = 'id,department_id AS departmentId,number,assignee_seat_id AS assigneeSeatId,requester_seat_id AS requesterSeatId,created_by_kind AS createdByKind,created_by_id AS createdById,title,body,status,created_at AS createdAt,updated_at AS updatedAt,estimate_minutes AS estimateMinutes,depends_on AS dependsOn';
const toTask = (row: Omit<Task, 'dependsOn'> & { dependsOn: string }): Task => ({ ...row, dependsOn: JSON.parse(row.dependsOn) as string[] });
const MAX_ESTIMATE = 7 * 24 * 60; const MAX_DEPENDENCIES = 20;
/** Agents must write what the task needs (goal, inputs, expected output, acceptance) so the manager can follow it. */
const MIN_REQUIREMENT = 20;
/** Short human estimate for system lines: 45m, 2h, 1h 30m. */
export const estimateLabel = (minutes: number): string => minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
const actorId = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : actor.seatId;
const actorLabel = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : `@${actor.seatId}`;

/**
 * Department tasks. Leaders (or the manager) create and assign within one department; the assignee or the leader moves
 * status. Every change posts a system line in the department channel whose mentions decide who gets woken:
 * new/reassigned → assignee, blocked/done → leader, leader/manager status change → assignee. The actor is never mentioned.
 * Planning: every task carries the assignee's estimate and the tasks it waits for (any department). A task cannot move
 * to doing while one of those is open, and finishing the last one tells the waiting assignee to start. The coordinator
 * seat (the PM) has leader rights over the tasks of every department so it can order the work across teams.
 */
export class TaskService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly emit: (event: CollabEvent) => void, private readonly coordinatorSeatId: string | null = null, private readonly onDoneByAssignee: (task: Task) => void = () => undefined) {}

  list(actor: Actor, filter: TaskFilter): Task[] {
    let departmentId = filter.departmentId;
    if (actor.kind === 'seat' && !this.isCoordinator(actor)) {
      const own = this.org.seat(actor.seatId).departmentId;
      if (departmentId && departmentId !== own) throw forbidden('forbidden_task');
      departmentId = own;
    }
    const assignee = filter.assignee === 'me' && actor.kind === 'seat' ? actor.seatId : filter.assignee;
    const clauses: string[] = []; const params: string[] = [];
    if (departmentId) { clauses.push('department_id=?'); params.push(departmentId); }
    if (filter.status) { clauses.push('status=?'); params.push(filter.status); }
    if (assignee) { clauses.push('assignee_seat_id=?'); params.push(assignee); }
    return (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY status='done',updated_at DESC LIMIT 500`).all(...params) as Array<Omit<Task, 'dependsOn'> & { dependsOn: string }>).map(toTask);
  }

  get(taskId: string): Task {
    const row = this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id=?`).get(taskId) as (Omit<Task, 'dependsOn'> & { dependsOn: string }) | undefined;
    if (!row) throw notFound('task');
    return toTask(row);
  }

  history(taskId: string): TaskEvent[] {
    return this.db.raw.prepare('SELECT task_id AS taskId,actor_kind AS actorKind,actor_id AS actorId,from_status AS fromStatus,to_status AS toStatus,note,created_at AS createdAt FROM task_events WHERE task_id=? ORDER BY id').all(taskId) as TaskEvent[];
  }

  create(actor: Actor, input: { departmentId?: string | undefined; title: string; body: string; assigneeSeatId: string; requestedBy?: string | undefined } & TaskPlan): Task {
    if (input.title.trim().length === 0 || input.title.length > 200 || input.body.length > 8000) throw invalid('invalid_task');
    const assignee = this.org.seat(input.assigneeSeatId);
    let departmentId = input.departmentId ?? assignee.departmentId;
    if (actor.kind === 'seat' && !this.isCoordinator(actor)) {
      const creator = this.org.seat(actor.seatId);
      if (creator.role !== 'leader' && !this.isDeputy(creator)) throw forbidden('leader_only');
      departmentId = creator.departmentId;
    }
    if (actor.kind === 'seat' && input.body.trim().length < MIN_REQUIREMENT) throw invalid('requirement_required: write the requirement in body (goal, inputs, expected output, acceptance criteria)');
    if (assignee.departmentId !== departmentId) throw forbidden('assignee_outside_department');
    // A cross-department request is tracked by naming the asking leader; the result is reported back to them.
    const requester = input.requestedBy ? this.org.seat(input.requestedBy.replace(/^@/, '')) : null;
    if (requester && (requester.role !== 'leader' || requester.departmentId === departmentId)) throw invalid('requester_must_be_other_department_leader');
    const estimate = this.checkEstimate(input.estimateMinutes); const dependsOn = this.checkDependencies(null, input.dependsOn ?? []);
    const timestamp = Date.now();
    const task = this.db.transaction(() => {
      const number = (this.db.raw.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM tasks WHERE department_id=?').get(departmentId) as { next: number }).next;
      const id = `t-${departmentId}-${number}`;
      this.db.raw.prepare('INSERT INTO tasks(id,department_id,number,assignee_seat_id,requester_seat_id,created_by_kind,created_by_id,title,body,status,created_at,updated_at,estimate_minutes,depends_on) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, departmentId, number, assignee.id, requester?.id ?? null, actor.kind, actorId(actor), input.title, input.body, 'todo', timestamp, timestamp, estimate, JSON.stringify(dependsOn));
      this.record(id, actor, null, 'todo', '');
      return this.get(id);
    });
    this.announce(task, `Task ${task.id} "${task.title}" assigned to @${assignee.id} by ${actorLabel(actor)}.${requester ? ` Requested by @${requester.id}.` : ''}${this.planLine(task)}${task.body ? ` Details: ${task.body}` : ''}`, [assignee.id]);
    if (requester) {
      const accepted = this.messages.postSystem(LEADERS_CHANNEL_ID, `Request from @${requester.id} accepted as task ${task.id} "${task.title}" (assignee @${assignee.id}). You will be told in this thread when it is blocked or done.`, [requester.id]);
      this.db.raw.prepare('UPDATE tasks SET request_thread_seq=? WHERE id=?').run(accepted.seq, task.id);
    }
    return task;
  }

  update(actor: Actor, taskId: string, patch: { status?: TaskStatus | undefined; note?: string | undefined; assigneeSeatId?: string | undefined } & TaskPlan): Task {
    const task = this.get(taskId); const leader = this.leaderOf(task.departmentId); const note = patch.note ?? '';
    if (note.length > 2000) throw invalid('invalid_task');
    const isLeader = actor.kind === 'manager' || actor.seatId === leader?.id || this.isCoordinator(actor) || this.isDeputy(this.org.seat(actor.seatId), task.departmentId);
    if (!isLeader && (actor.kind !== 'seat' || actor.seatId !== task.assigneeSeatId)) throw forbidden('forbidden_task');
    if (patch.assigneeSeatId !== undefined && !isLeader) throw forbidden('leader_only');
    if (task.status === 'done' && patch.status && patch.status !== 'done' && !isLeader) throw forbidden('reopen_requires_leader');
    const assignee = patch.assigneeSeatId !== undefined ? this.org.seat(patch.assigneeSeatId) : null;
    if (assignee && assignee.departmentId !== task.departmentId) throw forbidden('assignee_outside_department');
    // Order of work across teams is the leaders' call; the assignee owns the estimate.
    if (patch.dependsOn !== undefined && !isLeader) throw forbidden('leader_only');
    const estimate = patch.estimateMinutes !== undefined ? this.checkEstimate(patch.estimateMinutes) : task.estimateMinutes;
    const dependsOn = patch.dependsOn !== undefined ? this.checkDependencies(taskId, patch.dependsOn) : task.dependsOn;
    const status = patch.status ?? task.status;
    if (status === 'doing' && task.status !== 'doing' && actor.kind === 'seat') {
      const waiting = this.openDependencies(dependsOn);
      if (waiting.length > 0) throw invalid(`waiting_for_dependencies: ${waiting.join(', ')} not done yet; ask your leader or the PM to reorder`);
    }
    const replanned = estimate !== task.estimateMinutes || JSON.stringify(dependsOn) !== JSON.stringify(task.dependsOn);
    const updated = this.db.transaction(() => {
      this.db.raw.prepare('UPDATE tasks SET status=?,assignee_seat_id=?,estimate_minutes=?,depends_on=?,updated_at=? WHERE id=?').run(status, assignee?.id ?? task.assigneeSeatId, estimate, JSON.stringify(dependsOn), Date.now(), taskId);
      this.record(taskId, actor, task.status, status, note);
      return this.get(taskId);
    });
    const mentions = new Set<string>();
    if (assignee && assignee.id !== task.assigneeSeatId) mentions.add(assignee.id);
    if ((status === 'blocked' || status === 'done') && status !== task.status && leader) mentions.add(leader.id);
    if (isLeader && (status !== task.status || replanned) && updated.assigneeSeatId) mentions.add(updated.assigneeSeatId);
    if (actor.kind === 'seat') mentions.delete(actor.seatId);
    const change = status !== task.status ? `${task.status} → ${status}` : 'updated';
    const reassigned = assignee && assignee.id !== task.assigneeSeatId ? ` Reassigned to @${assignee.id}.` : '';
    this.announce(updated, `Task ${task.id} "${task.title}" ${change} by ${actorLabel(actor)}.${reassigned}${replanned ? this.planLine(updated) : ''}${note ? ` Note: ${note}` : ''}`, [...mentions]);
    if (status === 'done' && task.status !== 'done') {
      this.releaseDependents(updated);
      this.postOutput(updated, actor, note);
      if (actor.kind === 'seat' && actor.seatId === updated.assigneeSeatId) this.onDoneByAssignee(updated);
    }
    // Close the loop for cross-department requests without the serving leader having to relay it.
    if (updated.requesterSeatId && (status === 'blocked' || status === 'done') && status !== task.status) {
      this.messages.postSystem(LEADERS_CHANNEL_ID, `@${updated.requesterSeatId} your request ${task.id} "${task.title}" is ${status}${note ? `: ${note}` : '.'}`.slice(0, 16_000), [updated.requesterSeatId], this.threadOf(task.id, 'request_thread_seq'));
    }
    return updated;
  }

  /** Every finished task lands in #outputs with its result (the done note), so the manager reads outputs in one place. */
  private postOutput(task: Task, actor: Actor, note: string): void {
    const department = this.org.department(task.departmentId).name;
    const who = task.assigneeSeatId ? `@${task.assigneeSeatId}` : actorLabel(actor);
    const by = actor.kind === 'seat' && actor.seatId !== task.assigneeSeatId ? ` (closed by ${actorLabel(actor)})` : '';
    const output = note.trim() || '(no output written — ask the assignee to put the result in the done note)';
    if (this.db.raw.prepare('SELECT 1 FROM channels WHERE id=?').get(OUTPUTS_CHANNEL_ID)) this.messages.postSystem(OUTPUTS_CHANNEL_ID, `✅ ${task.id} "${task.title}" · ${department} · ${who}${by}\nOutput: ${output}`.slice(0, 16_000), []);
  }

  /** Tells the assignee of each open task that was waiting only on `done` that it can start now. */
  private releaseDependents(done: Task): void {
    const waiting = (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE status!='done' AND depends_on LIKE ?`).all(`%"${done.id}"%`) as Array<Omit<Task, 'dependsOn'> & { dependsOn: string }>).map(toTask);
    for (const task of waiting) {
      if (!task.dependsOn.includes(done.id) || this.openDependencies(task.dependsOn).length > 0) continue;
      this.postInTaskThread(task, `Task ${task.id} "${task.title}" is ready to start: ${task.dependsOn.join(', ')} done (last: ${done.id}).${task.assigneeSeatId ? ` @${task.assigneeSeatId} move it to doing when you pick it up.` : ''}`, task.assigneeSeatId ? [task.assigneeSeatId] : []);
    }
  }

  private openDependencies(ids: string[]): string[] {
    if (ids.length === 0) return [];
    return (this.db.raw.prepare(`SELECT id FROM tasks WHERE status!='done' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string }>).map(row => row.id);
  }

  private checkEstimate(minutes: number | null | undefined): number | null {
    if (minutes === undefined || minutes === null) return null;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ESTIMATE) throw invalid('invalid_estimate');
    return minutes;
  }

  /** Dependencies must exist, be unique and not loop back to this task. */
  private checkDependencies(taskId: string | null, ids: string[]): string[] {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_DEPENDENCIES || (taskId && unique.includes(taskId))) throw invalid('invalid_dependencies');
    for (const id of unique) this.get(id);
    if (taskId) {
      const seen = new Set<string>(); const stack = [...unique];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === taskId) throw invalid('dependency_cycle');
        if (seen.has(id)) continue;
        seen.add(id); stack.push(...this.get(id).dependsOn);
      }
    }
    return unique;
  }

  private planLine(task: Task): string {
    const estimate = task.estimateMinutes !== null ? ` Estimate: ${estimateLabel(task.estimateMinutes)}.` : task.assigneeSeatId ? ` No estimate yet: @${task.assigneeSeatId} set estimateMinutes with agent_office_update_task.` : '';
    const open = this.openDependencies(task.dependsOn);
    return `${estimate}${task.dependsOn.length ? ` Waits for: ${task.dependsOn.join(', ')}${open.length ? ` (open: ${open.join(', ')})` : ' (all done)'}.` : ''}`;
  }

  private isCoordinator(actor: Actor): boolean { return actor.kind === 'seat' && actor.seatId === this.coordinatorSeatId; }

  /** The department's deputy acts with the leader's task rights inside that department. */
  private isDeputy(seat: Seat, departmentId = seat.departmentId): boolean { return seat.departmentId === departmentId && this.org.department(departmentId).deputySeatId === seat.id; }

  private leaderOf(departmentId: string): Seat | null { return this.org.view().seats.find(seat => seat.departmentId === departmentId && seat.role === 'leader') ?? null; }

  private record(taskId: string, actor: Actor, from: TaskStatus | null, to: TaskStatus, note: string): void {
    this.db.raw.prepare('INSERT INTO task_events(task_id,actor_kind,actor_id,from_status,to_status,note,created_at) VALUES (?,?,?,?,?,?,?)').run(taskId, actor.kind, actorId(actor), from, to, note, Date.now());
  }

  private announce(task: Task, body: string, mentions: string[]): void {
    this.emit({ type: 'collab', kind: 'task', task });
    this.postInTaskThread(task, body, mentions);
  }

  /**
   * Lines about one task share one thread in its department channel: the first line is the root, every later change
   * (status, reassign, ready to start) a reply. Mentions in replies still wake, the channel itself stays readable.
   */
  private postInTaskThread(task: Task, body: string, mentions: string[]): void {
    const posted = this.messages.postSystem(task.departmentId, body.slice(0, 16_000), mentions, this.threadOf(task.id, 'thread_seq'));
    if (posted.threadSeq === null) this.db.raw.prepare('UPDATE tasks SET thread_seq=? WHERE id=?').run(posted.seq, task.id);
  }

  private threadOf(taskId: string, column: 'thread_seq' | 'request_thread_seq'): number | undefined {
    return (this.db.raw.prepare(`SELECT ${column} AS seq FROM tasks WHERE id=?`).get(taskId) as { seq: number | null } | undefined)?.seq ?? undefined;
  }
}
