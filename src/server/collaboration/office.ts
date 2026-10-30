import type { Database } from '../db/database.js';
import type { CollabEvent, Department, Seat, SeatHandoff, Task } from '../../shared/contracts.js';
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
export type OfficeOptions = { maxAutoWakes: number; emit: (event: CollabEvent) => void; remoteApproval?: boolean; statusCheck?: StatusCheckOptions | null; coordinatorSeatId?: string | null; afterTask?: AfterTask };
/** What a member's runner seat does with its context once it finishes a task: compact it, start a new session, or nothing. */
export type AfterTask = 'compact' | 'clear' | 'off';
/** handoff = the seat's raw note; handoffBrief = note + open tasks + unread, ready to inject into a session's context. */
export type WhoAmI = { agentId: string; seat: Seat | null; department: Department | null; channels: ChannelSummary[]; handoff: SeatHandoff | null; handoffBrief: string | null };
export type Office = { org: OrgService; messages: MessageService; wake: WakeService; tasks: TaskService; handoffs: HandoffService; permissions: PermissionService; runners: RunnerService; whoami: (agentId: string, options?: { afterCompaction?: boolean }) => WhoAmI; touchAgent: (agentId: string) => void; trackWork: (agentId: string, kind: string, ts: string) => void; onTurnStop: (agentId: string) => void; close: () => void };

/** Wires the collaboration services around one database and one realtime emitter. */
export const createOffice = (db: Database, options: OfficeOptions): Office => {
  const org = new OrgService(db, options.emit, options.maxAutoWakes);
  let wake: WakeService | null = null;
  const messages = new MessageService(db, org, options.emit, message => wake?.onPosted(message), () => wake?.notify());
  wake = new WakeService(db, org, messages, options.maxAutoWakes);
  const wakeService = wake; org.onMutated = () => wakeService.notify();
  /**
   * Members (not leaders or deputies) start each task with a light context: when the assignee itself marks a task done,
   * its runner seat compacts (`/compact`, keeping a summary) or restarts in a new session (handoff note, tasks and unread
   * messages carry over) as soon as that turn ends. Seats run from a terminal, or with another task in progress, are left alone.
   */
  const afterTask = options.afterTask ?? 'off';
  const clearPending = new Map<string, string>();
  const markForClear = (task: Task): void => {
    if (afterTask === 'off' || !task.assigneeSeatId) return;
    const seat = org.seat(task.assigneeSeatId);
    if (seat.role === 'leader' || org.department(seat.departmentId).deputySeatId === seat.id) return;
    clearPending.set(seat.id, task.id);
  };
  const tasks = new TaskService(db, org, messages, options.emit, options.coordinatorSeatId ?? null, markForClear);
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
    try { runners.enqueue(seat.id, afterTask === 'clear' ? 'fresh' : 'prompt', afterTask === 'clear' ? null : focus, `auto: ${done} done`); } catch { /* not run by an online runner: keep the session */ }
  };
  const touchAgent = (agentId: string): void => { db.raw.prepare('UPDATE agents SET last_contact_at=? WHERE id=?').run(Date.now(), agentId); };
  return { org, messages, wake: wakeService, tasks, handoffs, permissions, runners, whoami, touchAgent, trackWork, onTurnStop, close: () => { clearInterval(sweep); if (statusTimer) clearInterval(statusTimer); wakeService.close(); permissions.close(); runners.close(); } };
};
