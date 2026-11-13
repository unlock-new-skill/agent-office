import type { Database } from '../db/database.js';
import { MAX_EXECUTION_MINUTES, type ChangeSource, type CollabEvent, type Seat, type Task, type TaskChange, type TaskKind, type TaskResult, type TaskStatus } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { conflict, forbidden, invalid, notFound } from './office-error.js';
import { LEADERS_CHANNEL_ID, OUTPUTS_CHANNEL_ID, type OrgService } from './org-service.js';

export type TaskEvent = { taskId: string; actorKind: string; actorId: string; fromStatus: TaskStatus | null; toStatus: TaskStatus; note: string; createdAt: number };
type TaskFilter = { departmentId?: string | undefined; status?: TaskStatus | undefined; assignee?: string | undefined };
type TaskPlan = { estimateMinutes?: number | null | undefined; dependsOn?: string[] | undefined };
/** A field left out keeps its value; assigneeSeatId null unassigns; dependsOn [] clears (leaders only). */
export type TaskPatch = { status?: TaskStatus | undefined; note?: string | undefined; assigneeSeatId?: string | null | undefined; title?: string | undefined; body?: string | undefined; kind?: TaskKind | undefined;
  expectedRevision?: number | undefined; reason?: string | undefined; handoffNote?: string | undefined; passRequired?: string[] | undefined; result?: TaskResult | undefined } & TaskPlan;
type AuditField = 'title' | 'body' | 'assigneeSeatId' | 'estimateMinutes' | 'dependsOn' | 'passRequired' | 'kind' | 'status' | 'result';
type TaskRow = Omit<Task, 'dependsOn' | 'passRequired'> & { dependsOn: string; passRequired: string };
const TASK_COLUMNS = 'id,department_id AS departmentId,number,assignee_seat_id AS assigneeSeatId,requester_seat_id AS requesterSeatId,created_by_kind AS createdByKind,created_by_id AS createdById,title,body,status,created_at AS createdAt,updated_at AS updatedAt,estimate_minutes AS estimateMinutes,depends_on AS dependsOn,parent_id AS parentId,step,thread_seq AS threadSeq,revision,kind,pass_required AS passRequired,result,result_by AS resultBy,result_at AS resultAt,actual_start AS actualStart';
const toTask = (row: TaskRow): Task => ({ ...row, dependsOn: JSON.parse(row.dependsOn) as string[], passRequired: JSON.parse(row.passRequired) as string[] });
const MAX_ESTIMATE = 7 * 24 * 60; const MAX_DEPENDENCIES = 20;
/** Agents must write what the task needs (goal, inputs, expected output, acceptance) so the manager can follow it. */
const MIN_REQUIREMENT = 20;
const MAX_NOTE = 2000;
const stale = (task: Task): Error => conflict('stale_revision', { task });
export type Activity = { activeMs: number; runs: number; runStart: number };
/**
 * Time each task spent in doing, from its status history: summed over every doing period (time blocked, todo or done
 * never counts), the number of doing runs and the start of the current (or last) run.
 */
export const doingTime = (db: Database, taskIds: string[], now = Date.now()): Map<string, Activity> => {
  const result = new Map<string, Activity>();
  if (taskIds.length === 0) return result;
  const events = db.raw.prepare(`SELECT task_id AS taskId,from_status AS fromStatus,to_status AS toStatus,created_at AS createdAt FROM task_events WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id`).all(...taskIds) as Array<{ taskId: string; fromStatus: string | null; toStatus: string; createdAt: number }>;
  const open = new Map<string, number>();
  for (const event of events) {
    const entry = result.get(event.taskId) ?? { activeMs: 0, runs: 0, runStart: 0 };
    if (event.toStatus === 'doing' && event.fromStatus !== 'doing') { open.set(event.taskId, event.createdAt); entry.runs++; entry.runStart = event.createdAt; }
    else if (event.fromStatus === 'doing' && event.toStatus !== 'doing') { entry.activeMs += event.createdAt - (open.get(event.taskId) ?? event.createdAt); open.delete(event.taskId); }
    result.set(event.taskId, entry);
  }
  for (const [taskId, started] of open) result.get(taskId)!.activeMs += now - started;
  return result;
};
export type TaskWithActivity = Task & { activeMs: number; runs: number };
export type TaskPage = { tasks: TaskWithActivity[]; total: number; snapshotAt: number; nextCursor: string | null; changedSinceSnapshot: number };
const MAX_PAGE = 200;

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
 * seats (the PM, see Seat.coordinator) have leader rights over the tasks of every department so they can order the work across teams.
 * Edits are field-level (title, requirement, assignee, estimate, order, kind), guarded by the task revision and audited in task_changes.
 */
export class TaskService {
  /** Checks an execution task about to start (readiness, owner free); throws with the reason. Set by the dispatcher. */
  startGate: (candidate: Task, actor: Actor) => void = () => undefined;
  /** Invoked after every task change so readiness is recomputed. */
  onChanged: () => void = () => undefined;
  /** True while the dispatcher sends ready notices for execution tasks (the legacy "ready to start" line is then skipped for them). */
  dispatching: () => boolean = () => false;

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly emit: (event: CollabEvent) => void, private readonly onDoneByAssignee: (task: Task) => void = () => undefined) {}

  list(actor: Actor, filter: TaskFilter): Task[] {
    let departmentId = filter.departmentId;
    if (actor.kind === 'seat' && !this.isCoordinator(actor)) {
      const own = this.org.seat(actor.seatId).departmentId;
      if (departmentId && departmentId !== own) throw forbidden('forbidden_task_read');
      departmentId = own;
    }
    const assignee = filter.assignee === 'me' && actor.kind === 'seat' ? actor.seatId : filter.assignee;
    const clauses: string[] = []; const params: string[] = [];
    // Besides its department, a seat sees the steps of tasks it leads and the parent of steps it was given.
    if (departmentId && actor.kind === 'seat' && !this.isCoordinator(actor)) {
      clauses.push('(department_id=? OR parent_id IN (SELECT id FROM tasks WHERE assignee_seat_id=?) OR id IN (SELECT parent_id FROM tasks WHERE assignee_seat_id=? AND parent_id IS NOT NULL))'); params.push(departmentId, actor.seatId, actor.seatId);
    }
    else if (departmentId) { clauses.push('department_id=?'); params.push(departmentId); }
    if (filter.status) { clauses.push('status=?'); params.push(filter.status); }
    if (assignee) { clauses.push('assignee_seat_id=?'); params.push(assignee); }
    return (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY status='done',updated_at DESC LIMIT 500`).all(...params) as TaskRow[]).map(toTask);
  }

  /** Tasks with their time in doing. */
  withActivity(tasks: Task[], now = Date.now()): TaskWithActivity[] {
    const activity = doingTime(this.db, tasks.map(task => task.id), now);
    return tasks.map(task => ({ ...task, activeMs: activity.get(task.id)?.activeMs ?? 0, runs: activity.get(task.id)?.runs ?? 0 }));
  }

  /**
   * One page of tasks in a stable order (createdAt, id) over a snapshot: the first page fixes snapshotAt; tasks created
   * later are left out, so pages never shift and total stays the same. Tasks changed after snapshotAt still appear with
   * their current values; changedSinceSnapshot counts them so a reader can fetch again if it needs one consistent view.
   */
  page(scope: { departments: string[] | null; departmentId?: string | undefined; status?: TaskStatus | undefined }, limit = 100, cursor?: string, now = Date.now()): TaskPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw invalid('invalid_limit');
    let position: { s: number; c: number; i: string } | null = null;
    if (cursor) {
      try { position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s: number; c: number; i: string }; } catch { throw invalid('invalid_cursor'); }
      if (!position || !Number.isInteger(position.s) || !Number.isInteger(position.c) || typeof position.i !== 'string') throw invalid('invalid_cursor');
    }
    const snapshotAt = position?.s ?? now;
    const clauses = ['created_at<=?']; const params: Array<string | number> = [snapshotAt];
    const departments = scope.departmentId ? [scope.departmentId] : scope.departments;
    if (departments) { clauses.push(`department_id IN (${departments.map(() => '?').join(',')})`); params.push(...departments); }
    if (scope.status) { clauses.push('status=?'); params.push(scope.status); }
    const where = clauses.join(' AND ');
    const total = (this.db.raw.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...params) as { count: number }).count;
    const changedSinceSnapshot = (this.db.raw.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where} AND updated_at>?`).get(...params, snapshotAt) as { count: number }).count;
    const after = position ? ' AND (created_at>? OR (created_at=? AND id>?))' : '';
    const rows = (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE ${where}${after} ORDER BY created_at,id LIMIT ?`).all(...params, ...(position ? [position.c, position.c, position.i] : []), limit + 1) as TaskRow[]).map(toTask);
    const pageTasks = rows.slice(0, limit); const last = pageTasks.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ s: snapshotAt, c: last.createdAt, i: last.id })).toString('base64url') : null;
    return { tasks: this.withActivity(pageTasks, now), total, snapshotAt, nextCursor, changedSinceSnapshot };
  }

  get(taskId: string): Task {
    const row = this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id=?`).get(taskId) as TaskRow | undefined;
    if (!row) throw notFound('task');
    return toTask(row);
  }

  /** One task with its status history and field audit, for anyone who may see the task. */
  read(actor: Actor, taskId: string): { task: Task; history: TaskEvent[]; changes: TaskChange[] } {
    const task = this.get(taskId);
    if (!this.canRead(actor, task)) throw forbidden('forbidden_task_read');
    return { task, history: this.history(taskId), changes: this.changes(taskId) };
  }

  changes(taskId: string): TaskChange[] {
    return (this.db.raw.prepare('SELECT task_id AS taskId,revision,actor_kind AS actorKind,actor_id AS actorId,source,field,before_json AS beforeJson,after_json AS afterJson,reason,created_at AS createdAt FROM task_changes WHERE task_id=? ORDER BY id').all(taskId) as Array<Omit<TaskChange, 'before' | 'after'> & { beforeJson: string | null; afterJson: string | null }>)
      .map(({ beforeJson, afterJson, ...row }) => ({ ...row, before: beforeJson === null ? null : JSON.parse(beforeJson) as unknown, after: afterJson === null ? null : JSON.parse(afterJson) as unknown }));
  }

  history(taskId: string): TaskEvent[] {
    return this.db.raw.prepare('SELECT task_id AS taskId,actor_kind AS actorKind,actor_id AS actorId,from_status AS fromStatus,to_status AS toStatus,note,created_at AS createdAt FROM task_events WHERE task_id=? ORDER BY id').all(taskId) as TaskEvent[];
  }

  create(actor: Actor, input: { departmentId?: string | undefined; title: string; body: string; assigneeSeatId: string; requestedBy?: string | undefined; parentId?: string | undefined; parallel?: boolean | undefined; kind?: TaskKind | undefined; passRequired?: string[] | undefined } & TaskPlan): Task {
    if (input.title.trim().length === 0 || input.title.length > 200 || input.body.length > 8000) throw invalid('invalid_task');
    if (input.parentId !== undefined) return this.createStep(actor, { ...input, parentId: input.parentId });
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
    const passRequired = [...new Set(input.passRequired ?? [])];
    if (passRequired.some(id => !dependsOn.includes(id))) throw invalid('pass_required_not_in_depends_on');
    const timestamp = Date.now();
    const task = this.db.transaction(() => {
      const number = (this.db.raw.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM tasks WHERE department_id=?').get(departmentId) as { next: number }).next;
      const id = `t-${departmentId}-${number}`;
      this.db.raw.prepare('INSERT INTO tasks(id,department_id,number,assignee_seat_id,requester_seat_id,created_by_kind,created_by_id,title,body,status,created_at,updated_at,estimate_minutes,depends_on,kind,pass_required) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, departmentId, number, assignee.id, requester?.id ?? null, actor.kind, actorId(actor), input.title, input.body, 'todo', timestamp, timestamp, estimate, JSON.stringify(dependsOn), input.kind ?? null, JSON.stringify(passRequired));
      this.record(id, actor, null, 'todo', '');
      return this.get(id);
    });
    this.announce(task, `Task ${task.id} "${task.title}" assigned to @${assignee.id} by ${actorLabel(actor)}.${requester ? ` Requested by @${requester.id}.` : ''}${this.planLine(task)}${task.body ? ` Details: ${task.body}` : ''}`, [assignee.id]);
    if (requester) {
      const accepted = this.messages.postSystem(LEADERS_CHANNEL_ID, `Request from @${requester.id} accepted as task ${task.id} "${task.title}" (assignee @${assignee.id}). You will be told in this thread when it is blocked or done.`, [requester.id]);
      this.db.raw.prepare('UPDATE tasks SET request_thread_seq=? WHERE id=?').run(accepted.seq, task.id);
    }
    this.onChanged();
    return this.get(task.id);
  }

  /**
   * A step of a parent task, assignable to a seat of any department (the step lives in the assignee's department).
   * The manager, the PM and the parent's assignee (the lead who coordinates it) add steps. Steps run in order: each
   * waits for the previous one unless `parallel`. The step's assignee is invited into the parent's thread.
   */
  private createStep(actor: Actor, input: { title: string; body: string; assigneeSeatId: string; parentId: string; parallel?: boolean | undefined; kind?: TaskKind | undefined } & TaskPlan): Task {
    const parent = this.get(input.parentId);
    if (parent.parentId !== null) throw invalid('steps_are_one_level: add the step to the parent task');
    if (parent.status === 'done') throw invalid('parent_task_done');
    if (actor.kind === 'seat' && !this.isCoordinator(actor) && actor.seatId !== parent.assigneeSeatId) throw forbidden('only_task_lead_adds_steps');
    if (actor.kind === 'seat' && input.body.trim().length < MIN_REQUIREMENT) throw invalid('requirement_required: write what this step does and the expected output in body');
    const assignee = this.org.seat(input.assigneeSeatId); const departmentId = assignee.departmentId;
    const previous = this.steps(parent.id).at(-1);
    const dependsOn = this.checkDependencies(null, [...(input.dependsOn ?? []), ...(previous && !input.parallel ? [previous.id] : [])]);
    const estimate = this.checkEstimate(input.estimateMinutes); const timestamp = Date.now();
    const task = this.db.transaction(() => {
      const number = (this.db.raw.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM tasks WHERE department_id=?').get(departmentId) as { next: number }).next;
      const id = `t-${departmentId}-${number}`; const step = (previous?.step ?? 0) + 1;
      this.db.raw.prepare('INSERT INTO tasks(id,department_id,number,assignee_seat_id,requester_seat_id,created_by_kind,created_by_id,title,body,status,created_at,updated_at,estimate_minutes,depends_on,parent_id,step,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, departmentId, number, assignee.id, null, actor.kind, actorId(actor), input.title, input.body, 'todo', timestamp, timestamp, estimate, JSON.stringify(dependsOn), parent.id, step, input.kind ?? null);
      this.record(id, actor, null, 'todo', '');
      return this.get(id);
    });
    const lead = parent.assigneeSeatId ? ` Lead: @${parent.assigneeSeatId}.` : '';
    this.announce(task, `Step ${task.step} of ${parent.id} "${parent.title}": task ${task.id} "${task.title}" assigned to @${assignee.id} by ${actorLabel(actor)}.${lead}${this.planLine(task)}${task.body ? ` Expected: ${task.body}` : ''}`, [assignee.id]);
    const parentThread = this.ensureThread(parent);
    this.messages.invite(parent.departmentId, parentThread, [assignee.id]);
    this.postInTaskThread(parent, `Step ${task.step} added: ${task.id} "${task.title}" → @${assignee.id}${dependsOn.length ? ` (after ${dependsOn.join(', ')})` : ' (can start now)'}. Discuss the whole task here.`, []);
    this.emit({ type: 'collab', kind: 'task', task: this.get(parent.id) });
    this.onChanged();
    return this.get(task.id);
  }

  /** Steps of a parent task in order. */
  steps(parentId: string): Task[] {
    return (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE parent_id=? ORDER BY step`).all(parentId) as TaskRow[]).map(toTask);
  }

  /**
   * The task's discussion thread (created if the task has none yet), opened for chat from the task. A seat needs to be
   * in the task's department channel, or already invited into the thread (a mention, or a step of the task).
   */
  thread(actor: Actor, taskId: string): { channelId: string; seq: number } {
    const task = this.get(taskId); const seq = this.ensureThread(task);
    if (actor.kind === 'seat' && !this.org.isMember(task.departmentId, actor.seatId) && !this.messages.guests(task.departmentId, seq).includes(actor.seatId)) {
      const leadsParent = task.parentId !== null && this.get(task.parentId).assigneeSeatId === actor.seatId;
      if (!this.isCoordinator(actor) && !leadsParent && !this.steps(task.id).some(step => step.assigneeSeatId === actor.seatId)) throw forbidden('forbidden_task_read');
      this.messages.invite(task.departmentId, seq, [actor.seatId]);
    }
    return { channelId: task.departmentId, seq };
  }

  /**
   * Field-level edit of an existing task (never a copy): every field left out keeps its value. Everything is validated
   * before anything is written; with expectedRevision a stale edit conflicts (409 stale_revision + the current task).
   * The assignee moves status and sets the estimate; leaders, the deputy, the parent's lead and coordinators also edit
   * title, requirement, assignee, order and kind. A task in progress changes hands only with a handoff note and goes
   * back to todo for its new owner. An execution task starts only with an estimate of at most 4h.
   */
  update(actor: Actor, taskId: string, patch: TaskPatch, source: ChangeSource = 'api'): Task {
    const task = this.get(taskId); const leader = this.leaderOf(task.departmentId); const note = patch.note ?? ''; const reason = patch.reason ?? ''; const handoff = patch.handoffNote?.trim() ?? '';
    if (note.length > MAX_NOTE || reason.length > MAX_NOTE || handoff.length > MAX_NOTE) throw invalid('invalid_task');
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== task.revision) throw stale(task);
    const parent = task.parentId ? this.get(task.parentId) : null;
    const authority = this.authority(actor, task); const isLeader = authority === 'leader';
    if (!authority) throw forbidden('forbidden_task_change');
    // Order of work across teams and what the task is are the leaders' call; the assignee owns status, estimate and result.
    if (!isLeader && (['assigneeSeatId', 'dependsOn', 'passRequired', 'title', 'body', 'kind'] as const).some(field => patch[field] !== undefined)) throw forbidden('leader_only');
    if (task.status === 'done' && patch.status && patch.status !== 'done' && !isLeader) throw forbidden('reopen_requires_leader');
    const title = patch.title !== undefined ? patch.title.trim() : task.title; const body = patch.body ?? task.body;
    if (title.length === 0 || title.length > 200 || body.length > 8000) throw invalid('invalid_task');
    if (patch.body !== undefined && actor.kind === 'seat' && body.trim().length < MIN_REQUIREMENT) throw invalid('requirement_required: write the requirement in body (goal, inputs, expected output, acceptance criteria)');
    let assigneeId = task.assigneeSeatId;
    if (patch.assigneeSeatId !== undefined) {
      const seat = patch.assigneeSeatId === null ? null : this.org.seat(patch.assigneeSeatId);
      if (seat && seat.departmentId !== task.departmentId) throw forbidden('assignee_outside_department');
      assigneeId = seat?.id ?? null;
    }
    const reassigned = assigneeId !== task.assigneeSeatId;
    let status = patch.status ?? task.status;
    if (reassigned && task.status === 'doing') {
      if (!handoff) throw conflict('reassign_doing_requires_handoff', { task });
      if (patch.status === undefined) status = 'todo';
    }
    const kind = patch.kind ?? task.kind;
    const estimate = patch.estimateMinutes !== undefined ? this.checkEstimate(patch.estimateMinutes) : task.estimateMinutes;
    const dependsOn = patch.dependsOn !== undefined ? this.checkDependencies(taskId, patch.dependsOn) : task.dependsOn;
    // passRequired names the dependencies that need a PASS; dropping a dependency drops its condition too.
    const passRequired = patch.passRequired !== undefined ? [...new Set(patch.passRequired)] : task.passRequired.filter(id => dependsOn.includes(id));
    if (passRequired.some(id => !dependsOn.includes(id))) throw invalid('pass_required_not_in_depends_on');
    // A reopened task's old result no longer describes it: back to unknown unless one is recorded with the change.
    const result = patch.result ?? (task.status === 'done' && status !== 'done' ? 'unknown' : task.result);
    // A PASS opens the steps that need it, so it is the lead's or the PM's call; the assignee records it alone only when
    // no lead or PM oversees the task. Bad news (fail, inconclusive, not-applicable) is never blocked.
    if (result === 'pass' && task.result !== 'pass' && !isLeader && this.hasReviewer(task)) throw forbidden('pass_needs_review');
    if (status === 'done' && task.status !== 'done') {
      const open = this.steps(task.id).filter(step => step.status !== 'done').map(step => step.id);
      if (open.length > 0) throw invalid(`steps_open: ${open.join(', ')} not done yet`);
    }
    // The manager and coordinators (PM) may start a task without the readiness checks; the override is written in the thread.
    const starting = status === 'doing' && (task.status !== 'doing' || reassigned);
    const candidate: Task = { ...task, title, body, assigneeSeatId: assigneeId, estimateMinutes: estimate, dependsOn, passRequired, kind, result };
    let overrideLine = '';
    if (starting && (actor.kind === 'manager' || this.isCoordinator(actor))) {
      try { this.checkStart(actor, candidate); }
      catch (error) { overrideLine = ` Started by override of ${actorLabel(actor)} without the readiness check (${error instanceof Error ? error.message : 'not ready'}).`; }
    }
    else if (starting) this.checkStart(actor, candidate);
    const after: Record<AuditField, unknown> = { title, body, assigneeSeatId: assigneeId, estimateMinutes: estimate, dependsOn, passRequired, kind, status, result };
    const changed = (Object.keys(after) as AuditField[]).filter(field => JSON.stringify(after[field]) !== JSON.stringify(task[field]));
    const replanned = changed.includes('estimateMinutes') || changed.includes('dependsOn');
    const updated = this.db.transaction(() => {
      const now = Date.now(); const resultChanged = changed.includes('result');
      const written = this.db.raw.prepare('UPDATE tasks SET title=?,body=?,status=?,assignee_seat_id=?,estimate_minutes=?,depends_on=?,pass_required=?,kind=?,result=?,result_by=?,result_at=?,actual_start=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
        .run(title, body, status, assigneeId, estimate, JSON.stringify(dependsOn), JSON.stringify(passRequired), kind, result, resultChanged ? actorId(actor) : task.resultBy, resultChanged ? now : task.resultAt, status === 'doing' && task.actualStart === null ? now : task.actualStart, now, taskId, task.revision);
      if (Number(written.changes) === 0) throw stale(this.get(taskId));
      this.record(taskId, actor, task.status, status, handoff && reassigned ? `${note}${note ? ' · ' : ''}handoff: ${handoff}` : note);
      const audit = this.db.raw.prepare('INSERT INTO task_changes(task_id,revision,actor_kind,actor_id,source,field,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const field of changed) audit.run(taskId, task.revision + 1, actor.kind, actorId(actor), source, field, JSON.stringify(task[field]), JSON.stringify(after[field]), reason, Date.now());
      return this.get(taskId);
    });
    const edited = changed.filter(field => field === 'title' || field === 'body' || field === 'kind' || field === 'passRequired' || field === 'result');
    const mentions = new Set<string>();
    // The new owner is told once; the previous owner is told the work left them.
    if (reassigned && assigneeId) mentions.add(assigneeId);
    if (reassigned && task.assigneeSeatId) mentions.add(task.assigneeSeatId);
    if ((status === 'blocked' || status === 'done') && status !== task.status && leader) mentions.add(leader.id);
    if (isLeader && (status !== task.status || replanned || edited.length > 0) && updated.assigneeSeatId) mentions.add(updated.assigneeSeatId);
    if (actor.kind === 'seat') mentions.delete(actor.seatId);
    const change = status !== task.status ? `${task.status} → ${status}` : 'updated';
    const owner = reassigned ? (assigneeId ? ` Reassigned to @${assigneeId}${task.assigneeSeatId ? ` (was @${task.assigneeSeatId})` : ''}.` : ` Unassigned (was @${task.assigneeSeatId}).`) : '';
    const handoffLine = reassigned && handoff ? ` Handoff: ${handoff}` : '';
    const editLine = edited.length ? ` Edited: ${edited.map(field => field === 'body' ? 'requirement' : field === 'kind' ? `kind=${kind}` : field === 'result' ? `result=${result}` : field === 'passRequired' ? `needs pass from ${passRequired.join(', ') || 'none'}` : field).join(', ')}.` : '';
    const name = title !== task.title ? `"${task.title}" → "${title}"` : `"${task.title}"`;
    this.announce(updated, `Task ${task.id} ${name} ${change} by ${actorLabel(actor)}.${owner}${handoffLine}${editLine}${replanned ? this.planLine(updated) : ''}${overrideLine}${note ? ` Note: ${note}` : ''}${reason ? ` Reason: ${reason}` : ''}`, [...mentions]);
    if ((status === 'done' && task.status !== 'done') || (status === 'done' && result === 'pass' && task.result !== 'pass')) this.releaseDependents(updated);
    if (status === 'done' && task.status !== 'done') {
      this.postOutput(updated, actor, note);
      if (actor.kind === 'seat' && actor.seatId === updated.assigneeSeatId) this.onDoneByAssignee(updated);
    }
    if (parent && (status === 'blocked' || status === 'done') && status !== task.status) this.reportStep(parent, updated, actor, status, note);
    // Close the loop for cross-department requests without the serving leader having to relay it.
    if (updated.requesterSeatId && (status === 'blocked' || status === 'done') && status !== task.status) {
      this.messages.postSystem(LEADERS_CHANNEL_ID, `@${updated.requesterSeatId} your request ${task.id} "${task.title}" is ${status}${note ? `: ${note}` : '.'}`.slice(0, 16_000), [updated.requesterSeatId], this.threadOf(task.id, 'request_thread_seq'));
    }
    this.onChanged();
    return this.get(taskId);
  }

  /** A step blocked or done is reported in the parent's thread to its lead; the last step asks the lead to close it. */
  private reportStep(parent: Task, step: Task, actor: Actor, status: TaskStatus, note: string): void {
    const lead = parent.assigneeSeatId; const steps = this.steps(parent.id);
    const allDone = status === 'done' && steps.every(candidate => candidate.status === 'done');
    const mention = lead && !(actor.kind === 'seat' && actor.seatId === lead) ? [lead] : [];
    const next = allDone ? ` All ${steps.length} steps are done${lead ? `: @${lead} review the outputs and move ${parent.id} to done with the final output` : ''}.` : '';
    this.postInTaskThread(parent, `${lead ? `@${lead} ` : ''}step ${step.step} ${step.id} "${step.title}" is ${status} (by ${actorLabel(actor)})${note ? `: ${note}` : '.'}${next}`, allDone && lead ? [lead] : mention);
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
    const waiting = (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE status!='done' AND depends_on LIKE ?`).all(`%"${done.id}"%`) as TaskRow[]).map(toTask);
    for (const task of waiting) {
      if (!task.dependsOn.includes(done.id) || this.unmetDependencies(task.dependsOn, task.passRequired).length > 0) continue;
      if (task.kind === 'execution' && this.dispatching()) continue;
      this.postInTaskThread(task, `Task ${task.id} "${task.title}" is ready to start: ${task.dependsOn.join(', ')} done (last: ${done.id}).${task.assigneeSeatId ? ` @${task.assigneeSeatId} move it to doing when you pick it up.` : ''}`, task.assigneeSeatId ? [task.assigneeSeatId] : []);
    }
  }

  /** Dependencies not met yet: not done, or done without the PASS this task needs from them. */
  private unmetDependencies(ids: string[], passRequired: string[]): string[] {
    if (ids.length === 0) return [];
    return (this.db.raw.prepare(`SELECT id,status,result FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; status: string; result: string }>)
      .filter(row => row.status !== 'done' || (passRequired.includes(row.id) && row.result !== 'pass')).map(row => row.id);
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

  private isCoordinator(actor: Actor): boolean { return actor.kind === 'seat' && this.org.seat(actor.seatId).coordinator; }

  /**
   * Who may change a task: 'leader' (manager, the department's leader or deputy, the lead of the parent task, a
   * coordinator) edits everything; 'assignee' moves status, estimate and result; null may not change it.
   */
  authority(actor: Actor, task: Task): 'leader' | 'assignee' | null {
    if (actor.kind === 'manager' || this.isCoordinator(actor)) return 'leader';
    const seat = this.org.seat(actor.seatId);
    if (this.leaderOf(task.departmentId)?.id === seat.id || this.isDeputy(seat, task.departmentId)) return 'leader';
    if (task.parentId !== null && this.get(task.parentId).assigneeSeatId === seat.id) return 'leader';
    return task.assigneeSeatId === seat.id ? 'assignee' : null;
  }

  /** What must hold before a task moves to doing (dependencies, owner, estimate, readiness gate for execution tasks). */
  private checkStart(actor: Actor, candidate: Task): void {
    const waiting = this.unmetDependencies(candidate.dependsOn, candidate.passRequired);
    if (waiting.length > 0) throw invalid(`waiting_for_dependencies: ${waiting.join(', ')} not done yet; ask your leader or the PM to reorder`);
    if (candidate.kind !== 'execution') return;
    if (candidate.assigneeSeatId === null) throw invalid('assignee_required: an execution task needs an assignee before it starts');
    if (candidate.estimateMinutes === null || candidate.estimateMinutes > MAX_EXECUTION_MINUTES) throw invalid(`execution_estimate_required: set estimateMinutes (at most ${MAX_EXECUTION_MINUTES}) before starting; split bigger work into steps`);
    this.startGate(candidate, actor);
  }

  /** A lead or PM oversees the task: its department has a leader or deputy, it is a step of a lead's task, or the office has a coordinator. */
  private hasReviewer(task: Task): boolean {
    if (this.leaderOf(task.departmentId) || this.org.department(task.departmentId).deputySeatId) return true;
    if (task.parentId !== null && this.get(task.parentId).assigneeSeatId) return true;
    return this.org.view().seats.some(seat => seat.coordinator);
  }

  /** Posts a line in the task's thread (blockers and the dispatcher talk about a task there too). */
  postLine(task: Task, body: string, mentions: string[]): void { this.postInTaskThread(task, body, mentions); }

  /** All tasks (any department), for readiness. */
  all(): Task[] { return (this.db.raw.prepare(`SELECT ${TASK_COLUMNS} FROM tasks`).all() as TaskRow[]).map(toTask); }

  /** The manager, coordinators, the task's department, its assignee and participants, the lead of its parent and the assignees of its steps see a task. */
  canRead(actor: Actor, task: Task): boolean {
    if (actor.kind === 'manager' || this.isCoordinator(actor)) return true;
    if (this.org.seat(actor.seatId).departmentId === task.departmentId || task.assigneeSeatId === actor.seatId) return true;
    if (this.db.raw.prepare('SELECT 1 FROM task_participants WHERE task_id=? AND seat_id=?').get(task.id, actor.seatId)) return true;
    if (task.parentId !== null && this.get(task.parentId).assigneeSeatId === actor.seatId) return true;
    return this.steps(task.id).some(step => step.assigneeSeatId === actor.seatId);
  }

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

  /** Root seq of the task's thread, posting a root line first when the task has none (or it was deleted). */
  private ensureThread(task: Task): number {
    const seq = this.threadOf(task.id, 'thread_seq');
    if (seq !== undefined) { try { this.messages.thread({ kind: 'manager' }, task.departmentId, seq); return seq; } catch { /* root gone: start a new thread */ } }
    this.db.raw.prepare('UPDATE tasks SET thread_seq=NULL WHERE id=?').run(task.id);
    this.postInTaskThread(task, `Discussion of task ${task.id} "${task.title}".`, []);
    return this.threadOf(task.id, 'thread_seq')!;
  }

  private threadOf(taskId: string, column: 'thread_seq' | 'request_thread_seq'): number | undefined {
    return (this.db.raw.prepare(`SELECT ${column} AS seq FROM tasks WHERE id=?`).get(taskId) as { seq: number | null } | undefined)?.seq ?? undefined;
  }
}
