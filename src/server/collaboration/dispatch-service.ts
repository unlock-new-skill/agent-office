import type { Database } from '../db/database.js';
import { MAX_EXECUTION_MINUTES, type Blocker, type Board, type ChangeSource, type DispatchMode, type Readiness, type Task } from '../../shared/contracts.js';
import type { BlockerService } from './blocker-service.js';
import { estimateLabel, type TaskService } from './task-service.js';
import type { Actor } from './message-service.js';
import { conflict, forbidden, invalid } from './office-error.js';
import type { OrgService } from './org-service.js';
import { evaluate, groupReasons, type Evaluation } from './readiness.js';

const MODE_KEY = 'dispatch.mode';
const MODES: DispatchMode[] = ['off', 'suggest', 'on'];
const DONE_ON_BOARD = 50;
type ReadinessRow = { taskId: string; ready: number; generation: number; gateOk: number; readySince: number | null };
type Snapshot = { tasks: Task[]; byId: Map<string, Task>; open: Map<string, Blocker[]>; blockers: Map<string, Blocker>; evals: Map<string, Evaluation> };

/**
 * Turns readiness into work without a chain of PM acknowledgements. After any change (task, result, blocker,
 * assignee) and once at start (reconcile), every task is re-evaluated and its readiness persisted: a real
 * not-ready → ready transition bumps the task's generation. With dispatch `on`, a ready execution task is offered to
 * its owner with exactly one line per (task, generation, owner), written in the same transaction as the ledger row,
 * so replays and restarts never repeat or lose it. An owner already doing an execution task gets the offer when free
 * (oldest ready first, one open offer at a time). START re-checks everything and claims atomically. A task in progress
 * whose dependency reopens or whose blocker returns only triggers a warning to its owner and leader: nothing is stopped.
 * Modes: off = legacy behaviour only; suggest = readiness and queues shown, no offers; on = offers sent.
 * The dispatcher never runs commands, tests, deploys or logins: a ready notice is not an operating permission.
 */
export class DispatchService {
  private refreshing = false;

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly tasks: TaskService, private readonly blockers: BlockerService) {}

  mode(): DispatchMode { return ((this.db.raw.prepare('SELECT value FROM app_settings WHERE key=?').get(MODE_KEY) as { value: DispatchMode } | undefined)?.value ?? 'suggest'); }

  /** Rollback is switching to suggest/off: tasks, history and running work stay as they are. */
  setMode(mode: DispatchMode): DispatchMode {
    if (!MODES.includes(mode)) throw invalid('invalid_dispatch_mode');
    this.db.raw.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(MODE_KEY, mode);
    this.refresh();
    return this.mode();
  }

  /** Re-evaluates every task, persists readiness, warns on broken gates and (mode on) sends pending offers. Idempotent. */
  refresh(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.db.transaction(() => {
        const snapshot = this.snapshot(); const now = Date.now();
        const rows = new Map((this.db.raw.prepare('SELECT task_id AS taskId,ready,generation,gate_ok AS gateOk,ready_since AS readySince FROM task_readiness').all() as ReadinessRow[]).map(row => [row.taskId, row]));
        const upsert = this.db.raw.prepare('INSERT INTO task_readiness(task_id,ready,generation,gate_ok,ready_since,reasons,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET ready=excluded.ready,generation=excluded.generation,gate_ok=excluded.gate_ok,ready_since=excluded.ready_since,reasons=excluded.reasons,updated_at=excluded.updated_at');
        for (const task of snapshot.tasks) {
          const evaluation = snapshot.evals.get(task.id)!; const previous = rows.get(task.id);
          const ready = evaluation.state === 'ready'; const gateOk = evaluation.gate.length === 0;
          const becameReady = ready && previous?.ready !== 1;
          const generation = (previous?.generation ?? 0) + (becameReady ? 1 : 0);
          const readySince = ready ? (becameReady ? now : previous?.readySince ?? now) : null;
          if (task.status === 'doing' && previous?.gateOk === 1 && !gateOk) this.warn(task, evaluation);
          const unchanged = previous && previous.ready === Number(ready) && previous.gateOk === Number(gateOk) && previous.generation === generation;
          if (!unchanged) upsert.run(task.id, ready ? 1 : 0, generation, gateOk ? 1 : 0, readySince, JSON.stringify(evaluation.reasons), now);
        }
        if (this.mode() === 'on') this.offerPending(snapshot);
      });
    } finally { this.refreshing = false; }
  }

  /** Readiness of one task now, with the reasons it is not ready and whether it waits in its owner's queue. */
  readiness(taskId: string): Readiness {
    const snapshot = this.snapshot(); const evaluation = snapshot.evals.get(taskId);
    if (!evaluation) return { taskId, state: 'needs-action', reasons: [], generation: 0, queued: false };
    return this.toReadiness(snapshot, taskId, evaluation);
  }

  /** Called by TaskService before an execution task moves to doing: refuses with the reason when it is not ready. */
  gate(candidate: Task): void {
    const snapshot = this.snapshot();
    const evaluation = evaluate({ ...candidate, status: 'todo' }, { task: id => snapshot.byId.get(id), openBlockers: id => snapshot.open.get(id) ?? [] });
    const blocking = evaluation.reasons.filter(reason => reason.code !== 'blocked_without_record');
    if (blocking.length > 0) throw invalid(`not_ready: ${blocking.map(reason => reason.text).join('; ')}`);
    const busy = snapshot.tasks.find(task => task.id !== candidate.id && task.kind === 'execution' && task.status === 'doing' && task.assigneeSeatId === candidate.assigneeSeatId);
    if (busy) throw conflict(`owner_busy: @${candidate.assigneeSeatId} is already doing ${busy.id}; finish or hand it over first`);
  }

  /**
   * START: the owner claims a ready execution task. With `generation`, an offer that is no longer current (readiness
   * lost, or lost and regained) is refused. Two competing STARTs: the first wins, the other gets already_started.
   */
  start(actor: Actor, taskId: string, options: { generation?: number | undefined; expectedRevision?: number | undefined }, source: ChangeSource): Task {
    const task = this.tasks.get(taskId);
    if (task.kind !== 'execution') throw invalid('start_needs_execution_task: classify the task as execution first');
    if (actor.kind === 'seat' && actor.seatId !== task.assigneeSeatId) throw forbidden('start_by_assignee_only');
    if (task.status === 'doing') throw conflict('already_started', { task });
    if (task.status === 'done') throw invalid('task_done');
    this.refresh();
    const row = this.db.raw.prepare('SELECT ready,generation FROM task_readiness WHERE task_id=?').get(taskId) as { ready: number; generation: number } | undefined;
    if (options.generation !== undefined && (row?.ready !== 1 || row.generation !== options.generation)) throw conflict('readiness_changed', { readiness: this.readiness(taskId) });
    this.gate(task);
    return this.tasks.update(actor, taskId, { status: 'doing', note: 'START', ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}) }, source);
  }

  /**
   * Manager / PM board: tasks grouped by root cause (needs action vs waiting for dependencies), then ready, doing,
   * done and tracking. Seats other than coordinators see their own department only.
   */
  board(actor: Actor, filter: { departmentId?: string | undefined; assignee?: string | undefined; resolver?: string | undefined }): Board {
    let departmentId = filter.departmentId ?? null;
    if (actor.kind === 'seat' && !this.org.seat(actor.seatId).coordinator) {
      const own = this.org.seat(actor.seatId).departmentId;
      if (departmentId && departmentId !== own) throw forbidden('forbidden_task_read');
      departmentId = own;
    }
    const snapshot = this.snapshot();
    const scoped = snapshot.tasks.filter(task => (!departmentId || task.departmentId === departmentId) && (!filter.assignee || task.assigneeSeatId === filter.assignee));
    const open = scoped.filter(task => task.status !== 'done' && task.kind !== 'tracking');
    const entries = open.filter(task => task.status !== 'doing').map(task => ({ task, reasons: snapshot.evals.get(task.id)!.reasons }));
    const resolver = filter.resolver ? `@${filter.resolver.replace(/^@/, '')}` : null;
    const keep = (groups: ReturnType<typeof groupReasons>): ReturnType<typeof groupReasons> => resolver ? groups.filter(group => group.resolver === resolver) : groups;
    const needsAction = keep(groupReasons(entries, 'needs-action', id => snapshot.blockers.get(id), id => snapshot.byId.get(id)));
    const waiting = keep(groupReasons(entries, 'waiting', id => snapshot.blockers.get(id), id => snapshot.byId.get(id)));
    const stateOf = (task: Task): string => snapshot.evals.get(task.id)!.state;
    const ready = open.filter(task => stateOf(task) === 'ready').map(task => task.id);
    const doing = open.filter(task => task.status === 'doing').map(task => task.id);
    const done = scoped.filter(task => task.status === 'done' && task.kind !== 'tracking').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DONE_ON_BOARD).map(task => task.id);
    const tracking = scoped.filter(task => task.kind === 'tracking').map(task => task.id);
    const shown = new Set([...needsAction, ...waiting].flatMap(group => group.taskIds).concat(ready, doing, done, tracking));
    const unique = (groups: ReturnType<typeof groupReasons>): number => new Set(groups.flatMap(group => group.taskIds)).size;
    return {
      snapshotAt: Date.now(), scope: { departmentId, assignee: filter.assignee ?? null, resolver }, dispatch: this.mode(), needsAction, waiting, ready, doing, done, tracking,
      tasks: Object.fromEntries([...shown].map(id => [id, snapshot.byId.get(id)!])),
      readiness: Object.fromEntries([...shown].map(id => [id, this.toReadiness(snapshot, id, snapshot.evals.get(id)!)])),
      totals: { tasks: shown.size, needsActionTasks: unique(needsAction), waitingTasks: unique(waiting), readyTasks: ready.length, blockers: new Set([...needsAction, ...waiting].map(group => group.blockerId).filter(Boolean)).size, groups: needsAction.length + waiting.length },
    };
  }

  private snapshot(): Snapshot {
    const tasks = this.tasks.all(); const byId = new Map(tasks.map(task => [task.id, task]));
    const all = this.blockers.list(); const blockers = new Map(all.map(blocker => [blocker.id, blocker]));
    const open = new Map<string, Blocker[]>();
    for (const blocker of all.filter(candidate => candidate.status === 'open')) for (const taskId of blocker.taskIds) open.set(taskId, [...open.get(taskId) ?? [], blocker]);
    const evals = new Map(tasks.map(task => [task.id, evaluate(task, { task: id => byId.get(id), openBlockers: id => open.get(id) ?? [] })]));
    return { tasks, byId, open, blockers, evals };
  }

  private toReadiness(snapshot: Snapshot, taskId: string, evaluation: Evaluation): Readiness {
    const row = this.db.raw.prepare('SELECT generation FROM task_readiness WHERE task_id=?').get(taskId) as { generation: number } | undefined;
    const task = snapshot.byId.get(taskId)!;
    const queued = evaluation.state === 'ready' && this.offerFor(snapshot, task.assigneeSeatId) !== taskId;
    return { taskId, state: evaluation.state, reasons: evaluation.reasons, generation: row?.generation ?? 0, queued };
  }

  /** The task an owner should be offered now: none while it does an execution task, else its oldest ready task. */
  private offerFor(snapshot: Snapshot, owner: string | null): string | null {
    if (!owner) return null;
    if (snapshot.tasks.some(task => task.kind === 'execution' && task.status === 'doing' && task.assigneeSeatId === owner)) return null;
    const rows = this.db.raw.prepare("SELECT r.task_id AS taskId FROM task_readiness r JOIN tasks t ON t.id=r.task_id WHERE r.ready=1 AND t.assignee_seat_id=? AND t.kind='execution' AND t.status IN ('todo','blocked') ORDER BY r.ready_since,t.id").all(owner) as Array<{ taskId: string }>;
    return rows.map(row => row.taskId).find(id => snapshot.evals.get(id)?.state === 'ready') ?? null;
  }

  private offerPending(snapshot: Snapshot): void {
    const owners = new Set(snapshot.tasks.filter(task => task.kind === 'execution' && task.assigneeSeatId).map(task => task.assigneeSeatId!));
    const record = this.db.raw.prepare("INSERT OR IGNORE INTO task_notifications(task_id,kind,generation,recipient,created_at) VALUES (?,'ready',?,?,?)");
    for (const owner of owners) {
      const taskId = this.offerFor(snapshot, owner); if (!taskId) continue;
      const { generation } = this.db.raw.prepare('SELECT generation FROM task_readiness WHERE task_id=?').get(taskId) as { generation: number };
      if (Number(record.run(taskId, generation, owner, Date.now()).changes) === 0) continue;
      this.offer(snapshot, snapshot.byId.get(taskId)!, generation);
    }
  }

  private offer(snapshot: Snapshot, task: Task, generation: number): void {
    const inputs = task.dependsOn.map(id => { const dependency = snapshot.byId.get(id); return `${id} ${dependency?.status ?? '?'}${task.passRequired.includes(id) ? `/${dependency?.result ?? '?'}` : ''}`; });
    const cleared = this.blockers.list({ taskId: task.id }).filter(blocker => blocker.status === 'resolved').map(blocker => `${blocker.id} (${blocker.resolution})`);
    const scope = task.body.length > 400 ? `${task.body.slice(0, 400)}…` : task.body;
    this.tasks.postLine(task, `@${task.assigneeSeatId} ready to start: ${task.id} "${task.title}" (estimate ${estimateLabel(task.estimateMinutes ?? MAX_EXECUTION_MINUTES)}).${inputs.length ? ` Inputs: ${inputs.join(', ')}.` : ''}${cleared.length ? ` Cleared: ${cleared.join('; ')}.` : ''} Scope: ${scope} — Start with agent_office_start_task { taskId: "${task.id}", generation: ${generation} }; the server re-checks everything at START. No PM acknowledgement needed. This notice does not grant shell, deploy, login or data permissions.`, [task.assigneeSeatId!]);
  }

  private warn(task: Task, evaluation: Evaluation): void {
    const leader = this.org.view().seats.find(seat => seat.departmentId === task.departmentId && seat.role === 'leader');
    const mentions = [...new Set([task.assigneeSeatId, leader?.id].filter((id): id is string => Boolean(id)))];
    this.tasks.postLine(task, `⚠ ${task.id} "${task.title}" is in progress but its conditions changed: ${evaluation.gate.map(reason => reason.text).join('; ')}. ${mentions.map(id => `@${id}`).join(' ')} decide whether to continue or pause under your granted stop policy; Agent Office changed nothing and stopped nothing.`, mentions);
  }
}
