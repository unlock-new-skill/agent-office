import type { Database } from '../db/database.js';
import type { MessageService } from './message-service.js';
import { LEADERS_CHANNEL_ID, type OrgService } from './org-service.js';

export type StatusCheckOptions = { seatId: string; silentMs: number };
type OpenTask = { id: string; status: string };

const ACTIVE = "('doing','blocked')";
const MAX_LISTED = 5;

/**
 * Departments can go silent: their agents keep working (or are stuck) without reporting. When a department with work in
 * progress has had no channel message and no task change for `silentMs`, the coordinator seat (usually the PM) is
 * mentioned in #leaders and asked to request a report. Each department is flagged at most once per quiet window.
 */
export class StatusCheck {
  private readonly flagged = new Map<string, number>();

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly options: StatusCheckOptions) {}

  run(now = Date.now()): void {
    const coordinator = this.coordinator();
    if (!coordinator) return;
    const lines: string[] = [];
    for (const department of this.org.view().departments) {
      if (department.id === coordinator.departmentId || department.paused) continue;
      const open = this.db.raw.prepare(`SELECT id,status FROM tasks WHERE department_id=? AND status IN ${ACTIVE} ORDER BY updated_at`).all(department.id) as OpenTask[];
      if (open.length === 0) continue;
      const quietFor = now - this.lastActivity(department.id);
      const since = this.flagged.get(department.id) ?? 0;
      if (quietFor < this.options.silentMs || now - since < this.options.silentMs) continue;
      this.flagged.set(department.id, now);
      const lead = this.db.raw.prepare("SELECT id FROM seats WHERE department_id=? AND role='leader'").get(department.id) as { id: string } | undefined;
      const tasks = open.slice(0, MAX_LISTED).map(task => task.status === 'blocked' ? `${task.id} blocked` : task.id).join(', ') + (open.length > MAX_LISTED ? `, +${open.length - MAX_LISTED}` : '');
      lines.push(`- ${department.name}${lead ? ` (lead ${lead.id})` : ''}: quiet ${Math.round(quietFor / 60_000)} min, ${open.length} in progress (${tasks})`);
    }
    if (lines.length === 0) return;
    this.messages.postSystem(LEADERS_CHANNEL_ID, `@${coordinator.id} Status check — no report for a while:\n${lines.join('\n')}\nAsk these leads for a short report (done / doing / blocked, next step) and help unblock them.`, [coordinator.id]);
  }

  /** The seat to ping: it must exist, be occupied and sit in #leaders, otherwise the check stays quiet. */
  private coordinator(): { id: string; departmentId: string } | null {
    const seat = this.db.raw.prepare('SELECT id,department_id AS departmentId,agent_id AS agentId FROM seats WHERE id=?').get(this.options.seatId) as { id: string; departmentId: string; agentId: string | null } | undefined;
    if (!seat?.agentId || !this.org.isMember(LEADERS_CHANNEL_ID, seat.id)) return null;
    return seat;
  }

  /** Latest message in the department channel or task change in the department (0 when there is none). */
  private lastActivity(departmentId: string): number {
    const row = this.db.raw.prepare(`SELECT MAX(at) AS at FROM (
      SELECT MAX(created_at) AS at FROM messages WHERE channel_id=? AND deleted_at IS NULL
      UNION ALL SELECT MAX(updated_at) FROM tasks WHERE department_id=?)`).get(departmentId, departmentId) as { at: number | null };
    return row.at ?? 0;
  }
}
