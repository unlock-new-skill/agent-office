import type { Database } from '../db/database.js';
import type { AfterTask, CollabEvent, Department, Seat, SeatHandoff, Task } from '../../shared/contracts.js';
import { logger } from '../logger.js';
import { ServiceTokenService } from '../auth/service-token-service.js';
import { AlertService } from './alert-service.js';
import { ApprovalService } from './approval-service.js';
import { ProgressService } from './progress-service.js';
import { BlockerService } from './blocker-service.js';
import { DispatchService } from './dispatch-service.js';
import { HandoffService } from './handoff-service.js';
import { PermissionService } from './permission-service.js';
import { RunnerService } from './runner-service.js';
import { MessageService, type ChannelSummary } from './message-service.js';
import { OrgService } from './org-service.js';
import { TaskService } from './task-service.js';
import { StatusCheck, type StatusCheckOptions } from './status-check.js';
import { WakeService } from './wake-service.js';

/** Longest gap between two events of an active session that still counts as work. */
export const WORK_GAP_MS = 15 * 60_000;
export type OfficeOptions = { maxAutoWakes: number; emit: (event: CollabEvent) => void; remoteApproval?: boolean; statusCheck?: StatusCheckOptions | null; coordinatorSeatId?: string | null; afterTask?: AfterTask; telegram?: boolean };
export type { AfterTask };
const AFTER_TASK_KEY = 'after_task.default';
/** handoff = the seat's raw note; handoffBrief = note + open tasks + unread, ready to inject into a session's context. */
export type WhoAmI = { agentId: string; seat: Seat | null; department: Department | null; channels: ChannelSummary[]; handoff: SeatHandoff | null; handoffBrief: string | null };
export type Office = { org: OrgService; messages: MessageService; wake: WakeService; tasks: TaskService; blockers: BlockerService; dispatch: DispatchService; alerts: AlertService; serviceTokens: ServiceTokenService; progress: ProgressService; approvals: ApprovalService; handoffs: HandoffService; permissions: PermissionService; runners: RunnerService; whoami: (agentId: string, options?: { afterCompaction?: boolean }) => WhoAmI; touchAgent: (agentId: string) => void; trackWork: (agentId: string, kind: string, ts: string) => void; onTurnStop: (agentId: string) => void;
  /** Office-wide default for what members do after a task (manager setting, else the env default). */
  afterTaskDefault: () => AfterTask; setAfterTaskDefault: (mode: AfterTask | null) => AfterTask; close: () => void };

/** Wires the collaboration services around one database and one realtime emitter. */
export const createOffice = (db: Database, options: OfficeOptions): Office => {
  const org = new OrgService(db, options.emit, options.maxAutoWakes, options.coordinatorSeatId ?? null);
  let wake: WakeService | null = null;
  const messages = new MessageService(db, org, options.emit, message => wake?.onPosted(message), () => wake?.notify());
  wake = new WakeService(db, org, messages, options.maxAutoWakes);
  const wakeService = wake; org.onMutated = () => wakeService.notify();
  /**
   * Members (not leaders or deputies) start each task with a light context: when the assignee itself marks a task done,
   * its runner seat compacts (`/compact`, keeping a summary) or restarts in a new session (handoff note, tasks and unread
   * messages carry over) as soon as that turn ends. Seats run from a terminal, or with another task in progress, are left alone.
   */
  const afterTaskDefault = (): AfterTask => ((db.raw.prepare('SELECT value FROM app_settings WHERE key=?').get(AFTER_TASK_KEY) as { value: AfterTask } | undefined)?.value ?? options.afterTask ?? 'off');
  const setAfterTaskDefault = (mode: AfterTask | null): AfterTask => {
    if (mode) db.raw.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(AFTER_TASK_KEY, mode);
    else db.raw.prepare('DELETE FROM app_settings WHERE key=?').run(AFTER_TASK_KEY);
    return afterTaskDefault();
  };
  const afterTaskOf = (seat: Seat): AfterTask => seat.afterTask ?? afterTaskDefault();
  const clearPending = new Map<string, string>();
  const markForClear = (task: Task): void => {
    if (!task.assigneeSeatId) return;
    const seat = org.seat(task.assigneeSeatId);
    if (afterTaskOf(seat) === 'off' || seat.role === 'leader' || org.department(seat.departmentId).deputySeatId === seat.id) return;
    clearPending.set(seat.id, task.id);
  };
  const tasks = new TaskService(db, org, messages, options.emit, markForClear);
  const blockers = new BlockerService(db, org, tasks, options.emit);
  const dispatch = new DispatchService(db, org, tasks, blockers);
  tasks.startGate = candidate => dispatch.gate(candidate); tasks.dispatching = () => dispatch.mode() === 'on';
  // The change itself is committed already: a failed recompute is logged (and redone on the next change or restart), not returned as an error.
  const refresh = (): void => { try { dispatch.refresh(); } catch (error) { logger.error(error); } };
  tasks.onChanged = refresh; blockers.onChanged = refresh;
  // A removed seat unassigns its tasks: readiness follows org changes too.
  org.onMutated = () => { wakeService.notify(); refresh(); };
  // Reconcile at start: readiness and offers missed while the server was down are computed again (idempotent).
  dispatch.refresh();
  const alerts = new AlertService(db, org, messages, blockers, dispatch, tasks);
  const serviceTokens = new ServiceTokenService(db, org);
  const progress = new ProgressService(db, org, tasks, dispatch, options.emit);
  const approvals = new ApprovalService(db, org, tasks, messages, options.emit, () => options.telegram ?? false);
  const approvalTimer = setInterval(() => { try { approvals.expireDue(); } catch (error) { logger.error(error); } }, 60_000); approvalTimer.unref();
  // Every 5 minutes: grants and windows that ended reopen their blocker, then new exceptions go out in one digest.
  const exceptions = (): void => {
    try { blockers.expireDue(); } catch (error) { logger.error(error); }
    try { alerts.run(); } catch (error) { logger.error(error); }
  };
  const alertTimer = setInterval(exceptions, 5 * 60_000); alertTimer.unref();
  // Grants and windows that ended while the server was down close at start, not 5 minutes later.
  try { blockers.expireDue(); } catch (error) { logger.error(error); }
  const handoffs = new HandoffService(db, org, messages);
  const permissions = new PermissionService(db, org, options.emit, options.remoteApproval ?? false);
  const runners = new RunnerService(db, org, options.emit);
  const sweep = setInterval(() => runners.sweep(), 30_000); sweep.unref();
  const statusCheck = options.statusCheck ? new StatusCheck(db, org, messages, options.statusCheck) : null;
  const statusTimer = statusCheck ? setInterval(() => statusCheck.run(), 5 * 60_000) : null; statusTimer?.unref();
  const whoami = (agentId: string, options: { afterCompaction?: boolean } = {}): WhoAmI => {
    const seat = org.seatForAgent(agentId);
    if (!seat) return { agentId, seat, department: null, channels: [], handoff: null, handoffBrief: null };
    const self = { kind: 'seat', seatId: seat.id } as const;
    return { agentId, seat, department: org.department(seat.departmentId), channels: messages.channelsForSeat(seat.id), handoff: handoffs.get(self, seat.id), handoffBrief: handoffs.brief(seat.id, options) };
  };
  /**
   * Working time of a seat = time its session is active. Every telemetry event adds the gap since the previous event of
   * the same session (at most WORK_GAP_MS, so an idle or crashed session does not count), unless the previous event ended
   * the turn or waits for a human (turn.stop, session.end, permission.request). Robust to turns that never send a stop.
   */
  const trackWork = (agentId: string, kind: string, ts: string): void => {
    const at = Date.parse(ts); const seat = org.seatForAgent(agentId);
    if (!Number.isFinite(at)) return;
    const mark = (db.raw.prepare('SELECT work_mark AS mark FROM agents WHERE id=?').get(agentId) as { mark: number | null } | undefined)?.mark ?? null;
    if (seat && mark !== null && at > mark) {
      const before = Math.floor(seat.workMs / 60_000);
      db.raw.prepare('UPDATE seats SET work_ms=work_ms+? WHERE id=?').run(Math.min(at - mark, WORK_GAP_MS), seat.id);
      if (Math.floor((seat.workMs + Math.min(at - mark, WORK_GAP_MS)) / 60_000) !== before) org.publish();
    }
    const pauses = kind === 'turn.stop' || kind === 'session.end' || kind === 'permission.request';
    db.raw.prepare('UPDATE agents SET work_mark=? WHERE id=?').run(pauses ? null : Math.max(mark ?? 0, at), agentId);
  };
  const onTurnStop = (agentId: string): void => {
    const seat = org.seatForAgent(agentId); const done = seat ? clearPending.get(seat.id) : undefined;
    if (!seat || !done) return;
    clearPending.delete(seat.id);
    if (db.raw.prepare("SELECT 1 FROM tasks WHERE assignee_seat_id=? AND status='doing'").get(seat.id)) return;
    const focus = `/compact Task ${done} is done. Keep: who you are (seat @${seat.id}), your open tasks and their state, decisions, file paths and commits the next task needs. Drop the finished task's step-by-step work, tool output and logs.`;
    const mode = afterTaskOf(seat); if (mode === 'off') return;
    try { runners.enqueue(seat.id, mode === 'clear' ? 'fresh' : 'prompt', mode === 'clear' ? null : focus, `auto: ${done} done`); } catch { /* not run by an online runner: keep the session */ }
  };
  const touchAgent = (agentId: string): void => { db.raw.prepare('UPDATE agents SET last_contact_at=? WHERE id=?').run(Date.now(), agentId); };
  return { org, messages, wake: wakeService, tasks, blockers, dispatch, alerts, serviceTokens, progress, approvals, handoffs, permissions, runners, whoami, touchAgent, trackWork, onTurnStop, afterTaskDefault, setAfterTaskDefault, close: () => { clearInterval(sweep); clearInterval(approvalTimer); clearInterval(alertTimer); if (statusTimer) clearInterval(statusTimer); wakeService.close(); permissions.close(); runners.close(); } };
};
