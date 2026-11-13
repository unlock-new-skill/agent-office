import type { Database } from '../db/database.js';
import type { Blocker, OfficeAlert, Task } from '../../shared/contracts.js';
import type { BlockerService } from './blocker-service.js';
import type { DispatchService } from './dispatch-service.js';
import type { MessageService } from './message-service.js';
import { LEADERS_CHANNEL_ID, type OrgService } from './org-service.js';

/** A blocker with no due date and no change for this long is reported as stale. */
export const STALE_BLOCKER_MS = 24 * 3_600_000;
/** A task in progress is overdue once it ran its estimate plus this margin. */
const OVERDUE_MARGIN = 1.25;
const MAX_LINES = 30;

/**
 * Exceptions for leads and the PM, without spam: missing owner, task over its estimate, a running task whose conditions
 * broke, blockers past their due date, stale or without a resolver. Each alert has a stable key; alert_state remembers
 * which ones were reported, so a digest in #leaders lists only alerts that are new (or came back after clearing), and
 * nothing is posted while nothing changed. Off when dispatch is off. Alerts never change tasks.
 */
export class AlertService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly blockers: BlockerService, private readonly dispatch: DispatchService) {}

  /** Current alerts, optionally limited to departments. */
  current(now = Date.now(), departmentId: string | null = null): OfficeAlert[] {
    const alerts: OfficeAlert[] = []; const entries = this.dispatch.evaluations();
    const byId = new Map(entries.map(entry => [entry.task.id, entry.task]));
    const leader = (department: string): string => { const seat = this.org.view().seats.find(candidate => candidate.departmentId === department && candidate.role === 'leader'); return seat ? `@${seat.id}` : 'manager'; };
    for (const { task, evaluation } of entries) {
      if (task.status === 'done' || task.kind === 'tracking') continue;
      if (task.assigneeSeatId === null) alerts.push({ key: `owner:${task.id}`, kind: 'owner-missing', departmentId: task.departmentId, owner: leader(task.departmentId), taskIds: [task.id], text: `${task.id} "${task.title}" has no assignee`, next: 'set assigneeSeatId (or close it if it is no longer needed — with its output)' });
      if (task.status === 'doing' && task.actualStart !== null && task.estimateMinutes !== null && now > task.actualStart + task.estimateMinutes * 60_000 * OVERDUE_MARGIN) {
        alerts.push({ key: `overdue:${task.id}:${task.actualStart}`, kind: 'overdue', departmentId: task.departmentId, owner: task.assigneeSeatId ? `@${task.assigneeSeatId}` : leader(task.departmentId), taskIds: [task.id], text: `${task.id} "${task.title}" runs ${Math.round((now - task.actualStart) / 60_000)}m on an estimate of ${task.estimateMinutes}m`, next: 'post progress, re-estimate or split into steps; the lead decides' });
      }
      if (task.status === 'doing' && evaluation.gate.length > 0) alerts.push({ key: `gate:${task.id}:${evaluation.gate.map(reason => reason.group).sort().join(',')}`, kind: 'gate-broken', departmentId: task.departmentId, owner: task.assigneeSeatId ? `@${task.assigneeSeatId}` : leader(task.departmentId), taskIds: [task.id], text: `${task.id} "${task.title}" is in progress but ${evaluation.gate.map(reason => reason.text).join('; ')}`, next: `owner and ${leader(task.departmentId)} decide to continue or pause` });
    }
    for (const blocker of this.blockers.list({ status: 'open' })) {
      const tasks = blocker.taskIds.map(id => byId.get(id)).filter((task): task is Task => Boolean(task) && task!.status !== 'done');
      if (tasks.length === 0) continue;
      const department = tasks[0]!.departmentId; const resolver = this.resolverOf(blocker, department, leader);
      const base = { departmentId: department, owner: resolver, taskIds: tasks.map(task => task.id) };
      if (blocker.dueAt !== null && now > blocker.dueAt) alerts.push({ ...base, key: `due:${blocker.id}:${blocker.dueAt}`, kind: 'blocker-overdue', text: `${blocker.id} (${blocker.kind}) "${blocker.description}" was due ${new Date(blocker.dueAt).toISOString()}`, next: blocker.nextStep || 'set the next step and a new due date' });
      else if (blocker.dueAt === null && now - blocker.updatedAt > STALE_BLOCKER_MS) alerts.push({ ...base, key: `stale:${blocker.id}:${blocker.updatedAt}`, kind: 'blocker-stale', text: `${blocker.id} (${blocker.kind}) "${blocker.description}" has not moved for ${Math.round((now - blocker.updatedAt) / 3_600_000)}h`, next: blocker.nextStep || 'set the next step' });
      if (!blocker.resolverSeatId && !blocker.resolverRole) alerts.push({ ...base, key: `resolver:${blocker.id}`, kind: 'resolver-missing', owner: leader(department), text: `${blocker.id} "${blocker.description}" has no resolver`, next: 'name the seat or role that removes it' });
    }
    return departmentId ? alerts.filter(alert => alert.departmentId === departmentId) : alerts;
  }

  /** Reports new alerts once in a digest in #leaders. Returns the alerts that were reported. */
  run(now = Date.now()): OfficeAlert[] {
    if (this.dispatch.mode() === 'off') return [];
    const alerts = this.current(now);
    return this.db.transaction(() => {
      const known = new Map((this.db.raw.prepare('SELECT key,notified_at AS notifiedAt,active FROM alert_state').all() as Array<{ key: string; notifiedAt: number | null; active: number }>).map(row => [row.key, row]));
      const live = new Set(alerts.map(alert => alert.key));
      for (const key of known.keys()) if (!live.has(key)) this.db.raw.prepare('UPDATE alert_state SET active=0 WHERE key=?').run(key);
      // An alert that cleared and came back is new again; one still reported stays quiet.
      const fresh = alerts.filter(alert => { const row = known.get(alert.key); return !row || row.active === 0 || row.notifiedAt === null; });
      const upsert = this.db.raw.prepare('INSERT INTO alert_state(key,first_seen,notified_at,active) VALUES (?,?,?,1) ON CONFLICT(key) DO UPDATE SET notified_at=excluded.notified_at,active=1');
      for (const alert of fresh) upsert.run(alert.key, now, now);
      if (fresh.length > 0) this.digest(fresh);
      return fresh;
    });
  }

  private digest(alerts: OfficeAlert[]): void {
    const lines = alerts.slice(0, MAX_LINES).map(alert => `- [${alert.kind}] ${alert.text} — owner ${alert.owner} — next: ${alert.next}`);
    const more = alerts.length > MAX_LINES ? `\n…and ${alerts.length - MAX_LINES} more on Tasks → By blocker.` : '';
    const coordinators = this.org.view().seats.filter(seat => seat.coordinator).map(seat => seat.id);
    const owners = alerts.flatMap(alert => /^@([a-z0-9-]+)$/.exec(alert.owner)?.[1] ?? []).filter(id => this.org.isMember(LEADERS_CHANNEL_ID, id));
    const mentions = [...new Set([...coordinators, ...owners])];
    this.messages.postSystem(LEADERS_CHANNEL_ID, `${mentions.map(id => `@${id}`).join(' ')} Exceptions — ${alerts.length} new:\n${lines.join('\n')}${more}\nEach line names who acts; reply in the task threads. Reported once until it changes.`.slice(0, 16_000), mentions);
  }

  private resolverOf(blocker: Blocker, department: string, leader: (department: string) => string): string {
    if (blocker.resolverSeatId) return `@${blocker.resolverSeatId}`;
    return blocker.resolverRole ?? leader(department);
  }
}
