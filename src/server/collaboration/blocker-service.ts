import type { Database } from '../db/database.js';
import type { Blocker, BlockerKind, CollabEvent } from '../../shared/contracts.js';
import type { Actor } from './message-service.js';
import { forbidden, invalid, notFound } from './office-error.js';
import type { OrgService } from './org-service.js';
import type { TaskService } from './task-service.js';

type BlockerRow = Omit<Blocker, 'refs' | 'taskIds'> & { refs: string };
const COLUMNS = 'id,kind,description,resolver_seat_id AS resolverSeatId,resolver_role AS resolverRole,next_step AS nextStep,due_at AS dueAt,origin_task_id AS originTaskId,refs,status,opened_by AS openedBy,opened_at AS openedAt,updated_at AS updatedAt,resolved_by AS resolvedBy,resolved_at AS resolvedAt,resolution';
const MAX_TASKS = 50; const MAX_REFS = 10;
const actorId = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : actor.seatId;
const actorLabel = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : `@${actor.seatId}`;
export type BlockerInput = { kind: BlockerKind; description: string; taskIds: string[]; resolverSeatId?: string | null | undefined; resolverRole?: string | null | undefined; nextStep?: string | undefined; dueAt?: number | null | undefined; originTaskId?: string | null | undefined; refs?: string[] | undefined };
export type BlockerPatch = { [K in keyof Omit<BlockerInput, 'kind' | 'taskIds' | 'originTaskId'>]?: BlockerInput[K] | undefined };

/**
 * Root causes that stop tasks, one record shared by every task it affects (linked by id, never by similar text).
 * Opening and linking needs the right to change each task; the resolver, coordinators, the manager and the leaders of
 * an affected task may edit, resolve (with evidence or a reason) and reopen it (e.g. a grant revoked). Each change is
 * posted in the threads of the affected tasks, then readiness is recomputed.
 */
export class BlockerService {
  /** Invoked after every change so readiness (and the dispatcher) is recomputed. */
  onChanged: () => void = () => undefined;

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly tasks: TaskService, private readonly emit: (event: CollabEvent) => void) {}

  list(filter: { status?: 'open' | 'resolved' | undefined; taskId?: string | undefined } = {}): Blocker[] {
    const clauses: string[] = []; const params: string[] = [];
    if (filter.status) { clauses.push('status=?'); params.push(filter.status); }
    if (filter.taskId) { clauses.push('id IN (SELECT blocker_id FROM task_blockers WHERE task_id=?)'); params.push(filter.taskId); }
    const rows = this.db.raw.prepare(`SELECT ${COLUMNS} FROM blockers ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY number`).all(...params) as BlockerRow[];
    const links = this.db.raw.prepare('SELECT task_id AS taskId,blocker_id AS blockerId FROM task_blockers ORDER BY task_id').all() as Array<{ taskId: string; blockerId: string }>;
    return rows.map(row => ({ ...row, refs: JSON.parse(row.refs) as string[], taskIds: links.filter(link => link.blockerId === row.id).map(link => link.taskId) }));
  }

  get(id: string): Blocker {
    const found = this.list().find(blocker => blocker.id === id);
    if (!found) throw notFound('blocker');
    return found;
  }

  open(actor: Actor, input: BlockerInput): Blocker {
    const fields = this.validate({ ...input, nextStep: input.nextStep ?? '' });
    const taskIds = this.checkTasks(actor, input.taskIds);
    if (input.originTaskId) this.tasks.get(input.originTaskId);
    const now = Date.now();
    const blocker = this.db.transaction(() => {
      const number = (this.db.raw.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM blockers').get() as { next: number }).next; const id = `b-${number}`;
      this.db.raw.prepare('INSERT INTO blockers(id,number,kind,description,resolver_seat_id,resolver_role,next_step,due_at,origin_task_id,refs,status,opened_by,opened_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, number, input.kind, fields.description, fields.resolverSeatId, fields.resolverRole, fields.nextStep, fields.dueAt, input.originTaskId ?? null, JSON.stringify(fields.refs), 'open', actorId(actor), now, now);
      const link = this.db.raw.prepare('INSERT OR IGNORE INTO task_blockers(task_id,blocker_id) VALUES (?,?)');
      for (const taskId of taskIds) link.run(taskId, id);
      const created = this.get(id);
      this.tell(created, actor, `opened by ${actorLabel(actor)}`, taskIds);
      return created;
    });
    return this.changed(blocker);
  }

  update(actor: Actor, id: string, patch: BlockerPatch): Blocker {
    const current = this.get(id); this.assertManages(actor, current);
    const fields = this.validate({ description: patch.description ?? current.description, resolverSeatId: patch.resolverSeatId === undefined ? current.resolverSeatId : patch.resolverSeatId, resolverRole: patch.resolverRole === undefined ? current.resolverRole : patch.resolverRole, nextStep: patch.nextStep ?? current.nextStep, dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt, refs: patch.refs ?? current.refs });
    const blocker = this.db.transaction(() => {
      this.db.raw.prepare('UPDATE blockers SET description=?,resolver_seat_id=?,resolver_role=?,next_step=?,due_at=?,refs=?,updated_at=? WHERE id=?').run(fields.description, fields.resolverSeatId, fields.resolverRole, fields.nextStep, fields.dueAt, JSON.stringify(fields.refs), Date.now(), id);
      const updated = this.get(id);
      if (updated.resolverSeatId !== current.resolverSeatId || updated.nextStep !== current.nextStep || updated.dueAt !== current.dueAt) this.tell(updated, actor, `updated by ${actorLabel(actor)}`, updated.taskIds);
      return updated;
    });
    return this.changed(blocker);
  }

  /** Links more tasks to the same cause (needs the right to change each of them). */
  link(actor: Actor, id: string, taskIds: string[]): Blocker {
    const current = this.get(id); const added = this.checkTasks(actor, taskIds).filter(taskId => !current.taskIds.includes(taskId));
    if (current.taskIds.length + added.length > MAX_TASKS) throw invalid('too_many_tasks');
    const blocker = this.db.transaction(() => {
      const link = this.db.raw.prepare('INSERT OR IGNORE INTO task_blockers(task_id,blocker_id) VALUES (?,?)');
      for (const taskId of added) link.run(taskId, id);
      this.db.raw.prepare('UPDATE blockers SET updated_at=? WHERE id=?').run(Date.now(), id);
      const updated = this.get(id);
      if (added.length && updated.status === 'open') this.tell(updated, actor, `linked by ${actorLabel(actor)}`, added);
      return updated;
    });
    return this.changed(blocker);
  }

  unlink(actor: Actor, id: string, taskId: string): Blocker {
    const current = this.get(id); this.checkTasks(actor, [taskId]);
    if (!current.taskIds.includes(taskId)) throw notFound('blocker_link');
    if (current.taskIds.length === 1) throw invalid('last_task: resolve the blocker instead of unlinking its last task');
    this.db.raw.prepare('DELETE FROM task_blockers WHERE task_id=? AND blocker_id=?').run(taskId, id);
    return this.changed(this.get(id));
  }

  resolve(actor: Actor, id: string, resolution: string): Blocker { return this.setStatus(actor, id, 'resolved', resolution); }

  /** Reopens a resolved blocker (a revoked grant, a fix that did not hold): tasks lose readiness again. */
  reopen(actor: Actor, id: string, reason: string): Blocker { return this.setStatus(actor, id, 'open', reason); }

  private setStatus(actor: Actor, id: string, status: 'open' | 'resolved', text: string): Blocker {
    const current = this.get(id); this.assertManages(actor, current);
    if (text.trim().length < 5 || text.length > 1000) throw invalid(status === 'resolved' ? 'resolution_required: give the evidence or the reason it is resolved' : 'reason_required: say why it is open again');
    if (current.status === status) throw invalid(`already_${status}`);
    const blocker = this.db.transaction(() => {
      const now = Date.now();
      if (status === 'resolved') this.db.raw.prepare("UPDATE blockers SET status='resolved',resolved_by=?,resolved_at=?,resolution=?,updated_at=? WHERE id=?").run(actorId(actor), now, text.trim(), now, id);
      else this.db.raw.prepare("UPDATE blockers SET status='open',resolved_by=NULL,resolved_at=NULL,resolution='',updated_at=? WHERE id=?").run(now, id);
      const updated = this.get(id);
      this.tell(updated, actor, `${status === 'resolved' ? 'resolved' : 'reopened'} by ${actorLabel(actor)}: ${text.trim()}`, updated.taskIds);
      return updated;
    });
    return this.changed(blocker);
  }

  /** The manager, coordinators, the resolver seat and the leaders of any affected task manage a blocker. */
  private assertManages(actor: Actor, blocker: Blocker): void {
    if (actor.kind === 'manager' || this.org.seat(actor.seatId).coordinator || actor.seatId === blocker.resolverSeatId) return;
    if (blocker.taskIds.some(taskId => this.tasks.authority(actor, this.tasks.get(taskId)) === 'leader')) return;
    throw forbidden('forbidden_blocker');
  }

  private checkTasks(actor: Actor, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0 || unique.length > MAX_TASKS) throw invalid('blocker_needs_tasks');
    for (const taskId of unique) if (!this.tasks.authority(actor, this.tasks.get(taskId))) throw forbidden('forbidden_task_change');
    return unique;
  }

  private validate(input: { description: string; resolverSeatId?: string | null | undefined; resolverRole?: string | null | undefined; nextStep: string; dueAt?: number | null | undefined; refs?: string[] | undefined }): { description: string; resolverSeatId: string | null; resolverRole: string | null; nextStep: string; dueAt: number | null; refs: string[] } {
    const description = input.description.trim();
    if (description.length === 0 || description.length > 500 || input.nextStep.length > 1000) throw invalid('invalid_blocker');
    const resolverSeatId = input.resolverSeatId ? this.org.seat(input.resolverSeatId.replace(/^@/, '')).id : null;
    const resolverRole = input.resolverRole?.trim() || null;
    if (resolverRole && resolverRole.length > 80) throw invalid('invalid_blocker');
    const refs = [...new Set(input.refs ?? [])];
    if (refs.length > MAX_REFS || refs.some(ref => ref.length === 0 || ref.length > 300)) throw invalid('invalid_blocker_refs');
    const dueAt = input.dueAt ?? null;
    if (dueAt !== null && (!Number.isInteger(dueAt) || dueAt <= 0)) throw invalid('invalid_due_at');
    return { description, resolverSeatId, resolverRole, nextStep: input.nextStep.trim(), dueAt, refs };
  }

  /** One line in each affected task's thread; the resolver and the task's leader are mentioned (never the actor). */
  private tell(blocker: Blocker, actor: Actor, what: string, taskIds: string[]): void {
    const who = blocker.resolverSeatId ? `@${blocker.resolverSeatId}` : blocker.resolverRole ?? 'nobody yet — assign a resolver';
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId); const leader = this.org.view().seats.find(seat => seat.departmentId === task.departmentId && seat.role === 'leader');
      const mentions = new Set([...(blocker.resolverSeatId ? [blocker.resolverSeatId] : []), ...(leader ? [leader.id] : [])]);
      if (actor.kind === 'seat') mentions.delete(actor.seatId);
      const open = blocker.status === 'open' ? ` Resolver: ${who}. Next step: ${blocker.nextStep || '(not set)'}.${blocker.dueAt ? ` Due: ${new Date(blocker.dueAt).toISOString()}.` : ''}` : '';
      this.tasks.postLine(task, `Blocker ${blocker.id} (${blocker.kind}) on ${task.id} ${what}. ${blocker.description}.${open}`, [...mentions]);
    }
  }

  private changed(blocker: Blocker): Blocker {
    this.emit({ type: 'collab', kind: 'blocker', blocker });
    for (const taskId of blocker.taskIds) this.emit({ type: 'collab', kind: 'task', task: this.tasks.get(taskId) });
    this.onChanged();
    return blocker;
  }
}
