import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { ChangeSource, CollabEvent, ParticipantRole, ParticipantState, SeatActivity, Task, TaskOutput, TaskParticipant, TaskResult } from '../../shared/contracts.js';
import type { DispatchService } from './dispatch-service.js';
import type { Actor } from './message-service.js';
import { conflict, forbidden, invalid, notFound } from './office-error.js';
import type { OrgService } from './org-service.js';
import { doingTime, type TaskService } from './task-service.js';

/**
 * A role or a doing run with no update for this long no longer proves anything: the seat shows as unknown (stale) with
 * the time of its last signal. One hour matches the cadence agents report at; documented in docs/architecture.md.
 */
export const ACTIVITY_STALE_MS = 60 * 60_000;
const ROLES: ParticipantRole[] = ['executor', 'reviewer', 'intake'];
const STATES: ParticipantState[] = ['active', 'waiting', 'done', 'stopped'];
const actorId = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : actor.seatId;
type ParticipantRow = Omit<TaskParticipant, never>;
const PARTICIPANT_COLUMNS = 'task_id AS taskId,seat_id AS seatId,role,state,phase,note,updated_at AS updatedAt,updated_by AS updatedBy,source';
const OUTPUT_COLUMNS = 'id,task_id AS taskId,name,scope,evidence,result,missing,recorded_by AS recordedBy,recorded_at AS recordedAt,source,accepted_by AS acceptedBy,accepted_at AS acceptedAt,acceptance_note AS acceptanceNote';

/**
 * Who really works on a task and what it already produced, apart from its status and blockers:
 * - participants: executor / reviewer / intake seats with their current phase and state (active, waiting, done,
 *   stopped). The assignee stays the owner; a participant never reassigns the task. The leaders of the task and its
 *   assignee add or change executors and intakes; only leaders name reviewers (an owner cannot review its own work);
 *   a seat reports its own role's phase and state.
 * - outputs: partial results (name, scope such as local or real-env, evidence, result, what acceptance is still
 *   missing). Received is not accepted: the task's leaders or one of its reviewers accept an output — a reviewer never
 *   accepts an output it recorded itself or one of a task it owns; only leaders revoke an acceptance. Outputs never
 *   change the task's status, result or dependencies.
 * Every change lands in the task audit (task_changes) with actor, source, before and after.
 * Seat activity is derived only from these records and from doing runs, never from being online.
 */
export class ProgressService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly tasks: TaskService, private readonly dispatch: DispatchService, private readonly emit: (event: CollabEvent) => void) {}

  participants(taskId?: string): TaskParticipant[] {
    return (taskId
      ? this.db.raw.prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM task_participants WHERE task_id=? ORDER BY role,seat_id`).all(taskId)
      : this.db.raw.prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM task_participants ORDER BY task_id,role,seat_id`).all()) as ParticipantRow[];
  }

  outputs(taskId?: string): TaskOutput[] {
    return (taskId
      ? this.db.raw.prepare(`SELECT ${OUTPUT_COLUMNS} FROM task_outputs WHERE task_id=? ORDER BY recorded_at,id`).all(taskId)
      : this.db.raw.prepare(`SELECT ${OUTPUT_COLUMNS} FROM task_outputs ORDER BY task_id,recorded_at,id`).all()) as TaskOutput[];
  }

  /** Adds or updates a seat's role on a task. */
  setParticipant(actor: Actor, taskId: string, input: { seatId: string; role: ParticipantRole; state: ParticipantState; phase?: string | undefined; note?: string | undefined }, source: ChangeSource): TaskParticipant {
    const task = this.live(taskId); const seat = this.org.seat(input.seatId.replace(/^@/, ''));
    if (!ROLES.includes(input.role) || !STATES.includes(input.state)) throw invalid('invalid_participant');
    const phase = (input.phase ?? '').trim(); const note = (input.note ?? '').trim();
    if (phase.length > 200 || note.length > 500) throw invalid('invalid_participant');
    const before = this.participants(taskId).find(row => row.seatId === seat.id && row.role === input.role) ?? null;
    const self = actor.kind === 'seat' && actor.seatId === seat.id;
    if (!this.manages(actor, task, input.role === 'reviewer') && !(self && before)) throw forbidden('forbidden_progress');
    const now = Date.now();
    const row = this.db.transaction(() => {
      this.db.raw.prepare(`INSERT INTO task_participants(task_id,seat_id,role,state,phase,note,updated_at,updated_by,source) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id,seat_id,role) DO UPDATE SET state=excluded.state,phase=excluded.phase,note=excluded.note,updated_at=excluded.updated_at,updated_by=excluded.updated_by,source=excluded.source`)
        .run(taskId, seat.id, input.role, input.state, phase, note, now, actorId(actor), source);
      const after = this.participants(taskId).find(candidate => candidate.seatId === seat.id && candidate.role === input.role)!;
      this.audit(task, actor, source, `participant:${seat.id}:${input.role}`, before && { state: before.state, phase: before.phase }, { state: after.state, phase: after.phase }, note);
      return after;
    });
    this.changed(taskId);
    return row;
  }

  removeParticipant(actor: Actor, taskId: string, rawSeatId: string, role: ParticipantRole, source: ChangeSource): void {
    const task = this.tasks.get(taskId); const seatId = rawSeatId.replace(/^@/, '');
    if (!this.manages(actor, task, role === 'reviewer')) throw forbidden('forbidden_progress');
    const before = this.participants(taskId).find(row => row.seatId === seatId && row.role === role);
    if (!before) throw notFound('participant');
    this.db.transaction(() => {
      this.db.raw.prepare('DELETE FROM task_participants WHERE task_id=? AND seat_id=? AND role=?').run(taskId, seatId, role);
      this.audit(task, actor, source, `participant:${seatId}:${role}`, { state: before.state, phase: before.phase }, null, '');
    });
    this.changed(taskId);
  }

  /** Records a partial output (received, not accepted). The task's managers, its assignee and its participants record. */
  recordOutput(actor: Actor, taskId: string, input: { name: string; scope?: string | undefined; evidence?: string | undefined; result?: TaskResult | undefined; missing?: string | undefined }, source: ChangeSource): TaskOutput {
    const task = this.live(taskId);
    if (!this.manages(actor, task) && !this.participates(actor, taskId)) throw forbidden('forbidden_progress');
    const fields = this.outputFields(input);
    const id = `o-${randomBytes(5).toString('hex')}`; const now = Date.now();
    const output = this.db.transaction(() => {
      this.db.raw.prepare('INSERT INTO task_outputs(id,task_id,name,scope,evidence,result,missing,recorded_by,recorded_at,source) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, taskId, fields.name, fields.scope, fields.evidence, fields.result, fields.missing, actorId(actor), now, source);
      const created = this.output(id);
      this.audit(task, actor, source, `output:${id}`, null, { name: created.name, scope: created.scope, result: created.result, missing: created.missing }, '');
      return created;
    });
    this.changed(taskId);
    return output;
  }

  /**
   * Updates what acceptance is still missing and, when `accept` is given, accepts (true) or revokes (false) the output.
   * Leaders accept and revoke; a reviewer participant accepts outputs it did not record of a task it does not own.
   * Never changes the task's status, result or dependencies.
   */
  acceptOutput(actor: Actor, taskId: string, outputId: string, input: { note?: string | undefined; missing?: string | undefined; accept?: boolean | undefined }, source: ChangeSource): TaskOutput {
    const task = this.tasks.get(taskId); const before = this.output(outputId);
    if (before.taskId !== taskId) throw notFound('output');
    const leader = this.manages(actor, task, true);
    const reviewer = actor.kind === 'seat' && actor.seatId !== task.assigneeSeatId && actor.seatId !== before.recordedBy
      && this.participants(taskId).some(row => row.seatId === actor.seatId && row.role === 'reviewer');
    if (!leader && !(reviewer && input.accept !== false)) throw forbidden('acceptance_by_lead_pm_or_reviewer');
    const note = (input.note ?? '').trim(); const missing = input.missing === undefined ? before.missing : input.missing.trim();
    if (note.length > 1000 || missing.length > 1000) throw invalid('invalid_output');
    const now = Date.now();
    const acceptedBy = input.accept === undefined ? before.acceptedBy : input.accept ? actorId(actor) : null;
    const acceptedAt = input.accept === undefined ? before.acceptedAt : input.accept ? now : null;
    const output = this.db.transaction(() => {
      this.db.raw.prepare('UPDATE task_outputs SET accepted_by=?,accepted_at=?,acceptance_note=?,missing=? WHERE id=?').run(acceptedBy, acceptedAt, input.accept === undefined ? before.acceptanceNote : note, missing, outputId);
      const after = this.output(outputId);
      this.audit(task, actor, source, `output:${outputId}`, { acceptedBy: before.acceptedBy, missing: before.missing }, { acceptedBy: after.acceptedBy, missing: after.missing }, note);
      return after;
    });
    this.changed(taskId);
    return output;
  }

  /**
   * What every seat is doing, from records only:
   * - executing / reviewing: an active executor / reviewer role updated within ACTIVITY_STALE_MS (executor wins);
   *   a task without any participant falls back to its owner's current doing run (legacy), never its first start;
   * - waiting: a recent waiting role, or an active one claimed before its task was blocked (with readiness reasons);
   *   an active role reported after the block stays executing / reviewing, with the task's blockers in `reasons`;
   * - available: never derived — finishing or stopping a phase is not a confirmation of availability (reserved state);
   * - unknown: nothing recent, or the last role is done / stopped — the last signal and its time are shown. Online state is reported apart, never here.
   * Owning a blocked task says nothing about the person: it is listed under `also`, not used as the state.
   */
  activity(now = Date.now()): SeatActivity[] {
    // Archived tasks are not live work: they never make a seat look busy or blocked.
    const tasks = new Map(this.tasks.all().filter(task => task.archivedAt === null).map(task => [task.id, task]));
    const open = (taskId: string): boolean => { const task = tasks.get(taskId); return Boolean(task) && task!.status !== 'done'; };
    const rows = this.participants();
    const withParticipants = new Set(rows.map(row => row.taskId));
    let evaluations: Map<string, { reasons: { text: string }[] }> | null = null;
    const reasonsOf = (taskId: string): string[] => {
      evaluations ??= new Map(this.dispatch.evaluations().map(entry => [entry.task.id, entry.evaluation]));
      return (evaluations.get(taskId)?.reasons ?? []).map(reason => reason.text);
    };
    const doingLegacy = [...tasks.values()].filter(task => task.status === 'doing' && task.assigneeSeatId && !withParticipants.has(task.id));
    const runs = doingTime(this.db, doingLegacy.map(task => task.id), now);
    const fresh = (at: number): boolean => now - at <= ACTIVITY_STALE_MS;
    const blockedIds = [...tasks.values()].filter(task => task.status === 'blocked').map(task => task.id);
    const blockedAt = new Map<string, number>(blockedIds.length === 0 ? [] : (this.db.raw.prepare(`SELECT task_id AS taskId, MAX(created_at) AS at FROM task_events WHERE to_status='blocked' AND task_id IN (${blockedIds.map(() => '?').join(',')}) GROUP BY task_id`).all(...blockedIds) as Array<{ taskId: string; at: number }>).map(row => [row.taskId, row.at]));
    const title = (taskId: string | null): string | null => (taskId ? tasks.get(taskId)?.title ?? null : null);
    return this.org.view().seats.map(seat => {
      const mine = rows.filter(row => row.seatId === seat.id);
      // On a blocked task, an active role claimed before the block is waiting; one reported after it is real work on
      // an independent phase and keeps its state (the task's blockers are attached, the task itself is unchanged).
      const live = mine.filter(row => open(row.taskId) && (row.state === 'active' || row.state === 'waiting'))
        .map(row => row.state === 'active' && tasks.get(row.taskId)!.status === 'blocked' && row.updatedAt <= (blockedAt.get(row.taskId) ?? Infinity) ? { ...row, state: 'waiting' as const } : row);
      const blockedNote = (row: ParticipantRow): string[] => tasks.get(row.taskId)!.status === 'blocked' ? [`task blocked: ${reasonsOf(row.taskId).join('; ') || 'see task blockers'}`] : [];
      const legacy = doingLegacy.filter(task => task.assigneeSeatId === seat.id).map(task => ({ task, since: runs.get(task.id)?.runStart ?? task.updatedAt }));
      const also = [
        ...live.map(row => ({ taskId: row.taskId, role: row.role as ParticipantRole | 'owner', state: row.state as string })),
        ...[...tasks.values()].filter(task => task.assigneeSeatId === seat.id && task.status !== 'done').map(task => ({ taskId: task.id, role: 'owner' as const, state: task.status as string })),
      ];
      const base = { seatId: seat.id, also };
      const pick = (role: ParticipantRole): ParticipantRow | undefined => live.filter(row => row.role === role && row.state === 'active' && fresh(row.updatedAt)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const executing = pick('executor');
      if (executing) return { ...base, state: 'executing' as const, taskId: executing.taskId, taskTitle: title(executing.taskId), role: 'executor' as const, phase: executing.phase, since: executing.updatedAt, source: `${executing.source} by ${executing.updatedBy}`, stale: false, reasons: blockedNote(executing) };
      const freshLegacy = legacy.filter(entry => fresh(entry.since)).sort((a, b) => b.since - a.since)[0];
      if (freshLegacy) return { ...base, state: 'executing' as const, taskId: freshLegacy.task.id, taskTitle: freshLegacy.task.title, role: 'owner' as const, phase: '', since: freshLegacy.since, source: 'task status doing (no participants recorded)', stale: false, reasons: [] };
      const reviewing = pick('reviewer') ?? pick('intake');
      if (reviewing) return { ...base, state: 'reviewing' as const, taskId: reviewing.taskId, taskTitle: title(reviewing.taskId), role: reviewing.role, phase: reviewing.phase, since: reviewing.updatedAt, source: `${reviewing.source} by ${reviewing.updatedBy}`, stale: false, reasons: blockedNote(reviewing) };
      const waiting = live.filter(row => row.state === 'waiting' && fresh(row.updatedAt)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (waiting) {
        const reasons = [...(waiting.note ? [waiting.note] : []), ...reasonsOf(waiting.taskId)];
        return { ...base, state: 'waiting' as const, taskId: waiting.taskId, taskTitle: title(waiting.taskId), role: waiting.role, phase: waiting.phase, since: waiting.updatedAt, source: `${waiting.source} by ${waiting.updatedBy}`, stale: false, reasons };
      }
      const lastActive = [...live.map(row => ({ taskId: row.taskId, role: row.role as ParticipantRole | 'owner', phase: row.phase, at: row.updatedAt, source: `${row.source} by ${row.updatedBy}` })), ...legacy.map(entry => ({ taskId: entry.task.id, role: 'owner' as const, phase: '', at: entry.since, source: 'task status doing (no participants recorded)' }))].sort((a, b) => b.at - a.at)[0];
      if (lastActive) return { ...base, state: 'unknown' as const, taskId: lastActive.taskId, taskTitle: title(lastActive.taskId), role: lastActive.role, phase: lastActive.phase, since: lastActive.at, source: lastActive.source, stale: true, reasons: [`no update for ${Math.round((now - lastActive.at) / 60_000)}m`] };
      // A finished or stopped phase says what the seat last did, not that it is free: unknown, with that last signal.
      const finished = mine.filter(row => row.state === 'done' || row.state === 'stopped').sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (finished) return { ...base, state: 'unknown' as const, taskId: finished.taskId, taskTitle: title(finished.taskId), role: finished.role, phase: finished.phase, since: finished.updatedAt, source: `last role ${finished.role} ${finished.state} (${finished.source} by ${finished.updatedBy})`, stale: !fresh(finished.updatedAt), reasons: ['no availability confirmed'] };
      return { ...base, state: 'unknown' as const, taskId: null, taskTitle: null, role: null, phase: '', since: null, source: 'no activity recorded', stale: false, reasons: [] };
    });
  }

  /** A task that still takes new progress: an archived task is read-only until it is restored. */
  private live(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (task.archivedAt !== null) throw conflict('task_archived', { task });
    return task;
  }

  /** The task's leaders (manager, PM, department leader/deputy, parent lead) and, unless leadersOnly, its assignee. */
  private manages(actor: Actor, task: Task, leadersOnly = false): boolean {
    const authority = this.tasks.authority(actor, task);
    return authority === 'leader' || (!leadersOnly && authority === 'assignee');
  }

  private participates(actor: Actor, taskId: string): boolean { return actor.kind === 'seat' && this.participants(taskId).some(row => row.seatId === actor.seatId); }

  private outputFields(input: { name: string; scope?: string | undefined; evidence?: string | undefined; result?: TaskResult | undefined; missing?: string | undefined }): { name: string; scope: string; evidence: string; result: TaskResult; missing: string } {
    const name = input.name.trim(); const scope = (input.scope ?? '').trim(); const evidence = (input.evidence ?? '').trim(); const missing = (input.missing ?? '').trim();
    if (name.length === 0 || name.length > 200 || scope.length > 80 || evidence.length > 1000 || missing.length > 1000) throw invalid('invalid_output');
    return { name, scope, evidence, result: input.result ?? 'unknown', missing };
  }

  private output(id: string): TaskOutput {
    const row = this.db.raw.prepare(`SELECT ${OUTPUT_COLUMNS} FROM task_outputs WHERE id=?`).get(id) as TaskOutput | undefined;
    if (!row) throw notFound('output');
    return row;
  }

  private audit(task: Task, actor: Actor, source: ChangeSource, field: string, before: unknown, after: unknown, reason: string): void {
    this.db.raw.prepare('INSERT INTO task_changes(task_id,revision,actor_kind,actor_id,source,field,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(task.id, task.revision, actor.kind, actorId(actor), source, field, JSON.stringify(before), JSON.stringify(after), reason, Date.now());
  }

  /** Clients refresh the task (and the activity derived from it). */
  private changed(taskId: string): void { this.emit({ type: 'collab', kind: 'progress', taskId }); }
}
