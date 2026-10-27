import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { CollabEvent, PermissionBehavior, PermissionRequest, PermissionStatus } from '../../shared/contracts.js';
import { conflict, forbidden, notFound } from './office-error.js';
import type { OrgService } from './org-service.js';

const MAX_SUMMARY = 2000; const MAX_WAITERS = 64; const MAX_PENDING_PER_AGENT = 8; const STALE_PENDING_MS = 10 * 60_000;
const COLUMNS = 'id,agent_id AS agentId,seat_id AS seatId,tool,summary,status,message,created_at AS createdAt,decided_at AS decidedAt,decided_by AS decidedBy';

/** One readable line per tool so the manager sees what will run, not a JSON dump. */
export const summarizeToolInput = (tool: string, input: unknown): string => {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const pick = (key: string): string | null => typeof fields[key] === 'string' ? fields[key] as string : null;
  const text = pick('command') ?? (pick('file_path') ? `${pick('file_path')}${pick('old_string') !== null ? ' (edit)' : ''}` : null) ?? pick('url') ?? pick('pattern') ?? JSON.stringify(input ?? {});
  const described = pick('description') ? `${text}\n— ${pick('description')}` : text;
  return `${tool}: ${described}`.slice(0, MAX_SUMMARY);
};

/**
 * Permission prompts answered from the manager UI. The agent's PermissionRequest hook files a request and long-polls
 * its decision; if nobody decides before the hook's wait ends, the request expires and Claude Code falls back to
 * its own terminal prompt. Parallel subagents of one session may each have a prompt pending.
 */
export class PermissionService {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly emit: (event: CollabEvent) => void, readonly enabled: boolean) {}

  create(agentId: string, tool: string, input: unknown): PermissionRequest {
    if (!this.enabled) throw forbidden('remote_approval_disabled');
    const request: PermissionRequest = { id: randomUUID(), agentId, seatId: this.org.seatForAgent(agentId)?.id ?? null, tool: tool.slice(0, 128), summary: summarizeToolInput(tool, input), status: 'pending', message: '', createdAt: Date.now(), decidedAt: null, decidedBy: null };
    this.db.transaction(() => {
      const { count } = this.db.raw.prepare("SELECT COUNT(*) AS count FROM permission_requests WHERE agent_id=? AND status='pending'").get(agentId) as { count: number };
      if (count >= MAX_PENDING_PER_AGENT) throw conflict('too_many_pending_permissions');
      this.db.raw.prepare('INSERT INTO permission_requests(id,agent_id,seat_id,tool,summary,status,created_at) VALUES (?,?,?,?,?,?,?)').run(request.id, agentId, request.seatId, request.tool, request.summary, 'pending', request.createdAt);
    });
    this.publish();
    return request;
  }

  get(id: string): PermissionRequest {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM permission_requests WHERE id=?`).get(id) as PermissionRequest | undefined;
    if (!row) throw notFound('permission');
    return row;
  }

  pending(): PermissionRequest[] {
    // A hook that died between polls never sends its final poll; nothing waits longer than the hook's own cap.
    this.db.raw.prepare("UPDATE permission_requests SET status='expired',decided_at=? WHERE status='pending' AND created_at<?").run(Date.now(), Date.now() - STALE_PENDING_MS);
    return this.db.raw.prepare(`SELECT ${COLUMNS} FROM permission_requests WHERE status='pending' ORDER BY created_at`).all() as PermissionRequest[];
  }

  decide(id: string, behavior: PermissionBehavior, message: string): PermissionRequest {
    const status: PermissionStatus = behavior === 'allow' ? 'allowed' : 'denied';
    const changed = this.db.raw.prepare("UPDATE permission_requests SET status=?,message=?,decided_at=?,decided_by='manager' WHERE id=? AND status='pending'").run(status, message, Date.now(), id);
    if (changed.changes === 0) { this.get(id); throw conflict('permission_already_resolved'); }
    this.wakeWaiters(id); this.publish();
    return this.get(id);
  }

  /**
   * Long-poll for the agent that filed the request. On the agent's final poll a still-pending request expires (the
   * terminal prompt takes over); intermediate polls (final=false) leave it pending for the next one.
   */
  async wait(id: string, agentId: string, timeoutMs: number, signal?: AbortSignal, final = true): Promise<PermissionRequest> {
    const request = this.get(id);
    if (request.agentId !== agentId) throw forbidden('forbidden_permission');
    if (request.status === 'pending' && timeoutMs > 0 && !signal?.aborted && this.waiterCount() < MAX_WAITERS) {
      await new Promise<void>(resolve => {
        const listeners = this.waiters.get(id) ?? new Set<() => void>(); this.waiters.set(id, listeners);
        const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); listeners.delete(done); if (listeners.size === 0) this.waiters.delete(id); resolve(); };
        const timer = setTimeout(done, timeoutMs);
        listeners.add(done); signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (!final) return this.get(id);
    const changed = this.db.raw.prepare("UPDATE permission_requests SET status='expired',decided_at=? WHERE id=? AND status='pending'").run(Date.now(), id);
    if (changed.changes > 0) this.publish();
    return this.get(id);
  }

  /** The session ended or a human took over the terminal: nothing can still be waiting on its prompts. */
  settleForAgent(agentId: string): void {
    if (this.expireForAgent(agentId) > 0) this.publish();
  }

  waiterCount(): number { let count = 0; for (const listeners of this.waiters.values()) count += listeners.size; return count; }
  close(): void { for (const id of [...this.waiters.keys()]) this.wakeWaiters(id); }

  private expireForAgent(agentId: string): number {
    const pending = this.db.raw.prepare("SELECT id FROM permission_requests WHERE agent_id=? AND status='pending'").all(agentId) as Array<{ id: string }>;
    if (pending.length === 0) return 0;
    this.db.raw.prepare("UPDATE permission_requests SET status='expired',decided_at=? WHERE agent_id=? AND status='pending'").run(Date.now(), agentId);
    for (const { id } of pending) this.wakeWaiters(id);
    return pending.length;
  }

  private wakeWaiters(id: string): void { for (const done of [...this.waiters.get(id) ?? []]) done(); }
  private publish(): void { this.emit({ type: 'collab', kind: 'permission', pending: this.pending() }); }
}
