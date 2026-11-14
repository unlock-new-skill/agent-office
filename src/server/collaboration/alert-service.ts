import type { Database } from '../db/database.js';
import type { Blocker, OfficeAlert, Task } from '../../shared/contracts.js';
import type { BlockerService } from './blocker-service.js';
import type { DispatchService } from './dispatch-service.js';
import { doingTime, type TaskService } from './task-service.js';
import type { MessageService } from './message-service.js';
import { LEADERS_CHANNEL_ID, type OrgService } from './org-service.js';

/** A blocker with no due date and no change for this long is reported as stale. */
export const STALE_BLOCKER_MS = 24 * 3_600_000;
/**
 * A task in progress is overdue once its time spent in doing — summed over every doing period from the status history,
 * not wall-clock since the first start — exceeds its estimate plus this margin. Time blocked, todo or done never counts.
 */
const OVERDUE_MARGIN = 1.25;
const MAX_LINES = 30;

/**
 * Exceptions for leads and the PM, without spam: missing owner, task over its estimate, a running task whose conditions
 * broke, blockers past their due date, stale or without a resolver. Each alert has a stable key; alert_state holds the
 * keys already reported and still live (a cleared alert is dropped, so it is new again if it returns). A digest in
 * #leaders lists up to MAX_LINES new alerts; the rest wait for the next run instead of being marked reported unseen.
 * Nothing is posted while nothing changed. Off when dispatch is off. Alerts never change tasks.
 */
export class AlertService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly blockers: BlockerService, private readonly dispatch: DispatchService, private readonly tasks: TaskService) {}

  /** Current alerts, optionally limited to departments. */
  current(now = Date.now(), departmentId: string | null = null): OfficeAlert[] {
    const alerts: OfficeAlert[] = []; const entries = this.dispatch.evaluations();
    const byId = new Map(entries.map(entry => [entry.task.id, entry.task]));
    // One org read per scan (view() is heavy), not one per alert.
    const leaders = new Map(this.org.view().seats.filter(seat => seat.role === 'leader').map(seat => [seat.departmentId, seat.id]));
    const leader = (department: string): string => { const id = leaders.get(department); return id ? `@${id}` : 'manager'; };
    const doing = doingTime(this.db, entries.filter(entry => entry.task.status === 'doing').map(entry => entry.task.id), now);
    for (const { task, evaluation } of entries) {
      if (task.status === 'done' || task.kind === 'tracking') continue;
      if (task.assigneeSeatId === null) alerts.push({ key: `owner:${task.id}`, kind: 'owner-missing', departmentId: task.departmentId, owner: leader(task.departmentId), taskIds: [task.id], text: `${task.id} "${task.title}" has no assignee`, next: 'set assigneeSeatId (or close it if it is no longer needed — with its output)' });
      const spent = doing.get(task.id);
      if (task.status === 'doing' && spent && task.estimateMinutes !== null && spent.activeMs > task.estimateMinutes * 60_000 * OVERDUE_MARGIN) {
        const minutes = (ms: number): number => Math.round(ms / 60_000);
        const runs = spent.runs > 1 ? ` over ${spent.runs} runs; this run ${minutes(now - spent.runStart)}m since ${new Date(spent.runStart).toISOString()}` : '';
        alerts.push({ key: `overdue:${task.id}:${spent.runStart}:${task.estimateMinutes}`, kind: 'overdue', departmentId: task.departmentId, owner: task.assigneeSeatId ? `@${task.assigneeSeatId}` : leader(task.departmentId), taskIds: [task.id], text: `${task.id} "${task.title}" has ${minutes(spent.activeMs)}m in doing${runs} (time blocked/todo/done not counted) on an estimate of ${task.estimateMinutes}m`, next: 'owner: post progress, re-estimate or split into steps; move it out of doing while it only waits' });
      }
      if (task.status === 'doing' && evaluation.gate.length > 0) alerts.push({ key: `gate:${task.id}:${evaluation.gate.map(reason => reason.group).sort().join(',')}`, kind: 'gate-broken', departmentId: task.departmentId, owner: task.assigneeSeatId ? `@${task.assigneeSeatId}` : leader(task.departmentId), taskIds: [task.id], text: `${task.id} "${task.title}" is in progress but ${evaluation.gate.map(reason => reason.text).join('; ')}`, next: `owner and ${leader(task.departmentId)} decide to continue or pause` });
    }
    for (const blocker of this.blockers.list({ status: 'open' })) {
      const open = blocker.taskIds.map(id => byId.get(id)).filter((task): task is Task => Boolean(task) && task!.status !== 'done');
      // A blocker shared by several departments is shown on each of their boards.
      for (const department of new Set(open.map(task => task.departmentId))) {
        const base = { departmentId: department, owner: this.resolverOf(blocker, department, leader), taskIds: open.filter(task => task.departmentId === department).map(task => task.id) };
        if (blocker.dueAt !== null && now > blocker.dueAt) alerts.push({ ...base, key: `due:${blocker.id}:${department}:${blocker.dueAt}`, kind: 'blocker-overdue', text: `${blocker.id} (${blocker.kind}) "${blocker.description}" was due ${new Date(blocker.dueAt).toISOString()}`, next: blocker.nextStep || 'set the next step and a new due date' });
        else if (blocker.dueAt === null && now - blocker.updatedAt > STALE_BLOCKER_MS) alerts.push({ ...base, key: `stale:${blocker.id}:${department}:${blocker.updatedAt}`, kind: 'blocker-stale', text: `${blocker.id} (${blocker.kind}) "${blocker.description}" has not moved for ${Math.round((now - blocker.updatedAt) / 3_600_000)}h`, next: blocker.nextStep || 'set the next step' });
        if (!blocker.resolverSeatId && !blocker.resolverRole) alerts.push({ ...base, key: `resolver:${blocker.id}:${department}`, kind: 'resolver-missing', owner: leader(department), text: `${blocker.id} "${blocker.description}" has no resolver`, next: 'name the seat or role that removes it' });
      }
    }
    return departmentId ? alerts.filter(alert => alert.departmentId === departmentId) : alerts;
  }

  /** Reports new alerts once in a digest in #leaders. Returns the alerts that were reported (at most MAX_LINES per run). */
  run(now = Date.now()): OfficeAlert[] {
    if (this.dispatch.mode() === 'off') return [];
    const alerts = this.current(now); const live = new Set(alerts.map(alert => alert.key));
    const known = new Set((this.db.raw.prepare('SELECT key FROM alert_state').all() as Array<{ key: string }>).map(row => row.key));
    const forget = this.db.raw.prepare('DELETE FROM alert_state WHERE key=?');
    this.db.transaction(() => { for (const key of known) if (!live.has(key)) forget.run(key); });
    const fresh = alerts.filter(alert => !known.has(alert.key));
    const shown = fresh.slice(0, MAX_LINES);
    if (shown.length === 0) return [];
    // Post first, then remember: a crash in between repeats a line at worst; it never loses one.
    // Work-in-progress alerts go to the owner in the task thread, not to the PM: an overdue task is the owner's call
    // (re-estimate, split, post progress), and a broken gate was already raised there by the dispatcher.
    for (const alert of shown.filter(candidate => candidate.kind === 'overdue')) {
      const owner = /^@([a-z0-9-]+)$/.exec(alert.owner)?.[1];
      this.tasks.postLine(this.tasks.get(alert.taskIds[0]!), `${owner ? `@${owner} ` : ''}${alert.text}. Next: ${alert.next}. Reported once.`, owner ? [owner] : []);
    }
    const digest = shown.filter(candidate => candidate.kind !== 'overdue' && candidate.kind !== 'gate-broken');
    if (digest.length > 0) this.digest(digest, fresh.length - shown.length);
    const remember = this.db.raw.prepare('INSERT OR REPLACE INTO alert_state(key,first_seen,notified_at,active) VALUES (?,?,?,1)');
    this.db.transaction(() => { for (const alert of shown) remember.run(alert.key, now, now); });
    return shown;
  }

  private digest(alerts: OfficeAlert[], waiting: number): void {
    const lines = alerts.map(alert => `- [${alert.kind}] ${alert.text} — owner ${alert.owner} — next: ${alert.next}`);
    const more = waiting > 0 ? `\n…${waiting} more come in the next digests (all of them are on Tasks → By blocker).` : '';
    const inLeaders = (id: string): boolean => this.org.isMember(LEADERS_CHANNEL_ID, id);
    // The PM is woken only when nobody else can act: a task without owner or a blocker without resolver.
    const needsCoordinator = alerts.some(alert => alert.kind === 'owner-missing' || alert.kind === 'resolver-missing');
    const coordinators = needsCoordinator ? this.org.view().seats.filter(seat => seat.coordinator).map(seat => seat.id).filter(inLeaders) : [];
    const owners = alerts.flatMap(alert => /^@([a-z0-9-]+)$/.exec(alert.owner)?.[1] ?? []).filter(inLeaders);
    const mentions = [...new Set([...coordinators, ...owners])];
    this.messages.postSystem(LEADERS_CHANNEL_ID, `${mentions.map(id => `@${id}`).join(' ')} Exceptions — ${alerts.length} new:\n${lines.join('\n')}${more}\nEach line names who acts; reply in the task threads. Reported once until it changes.`.slice(0, 16_000), mentions);
  }

  private resolverOf(blocker: Blocker, department: string, leader: (department: string) => string): string {
    if (blocker.resolverSeatId) return `@${blocker.resolverSeatId}`;
    return blocker.resolverRole ?? leader(department);
  }
}
