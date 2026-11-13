import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { ApprovalDelivery, ApprovalEvent, ApprovalRequest, ApprovalStatus, CollabEvent } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { conflict, forbidden, invalid, notFound } from './office-error.js';
import type { OrgService } from './org-service.js';
import type { TaskService } from './task-service.js';
import { logger } from '../logger.js';

export const APPROVAL_DEFAULT_MINUTES = 60;
const MIN_MINUTES = 5; const MAX_MINUTES = 7 * 24 * 60;
/** Bounded queue: a seat cannot flood the manager. */
export const MAX_PENDING_PER_SEAT = 10; export const MAX_PENDING_TOTAL = 100;
export const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_MS = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000];

/**
 * Text that looks like a credential is refused, so it never reaches Telegram, the UI or logs: key=value secrets,
 * bearer/API tokens, private keys, cookies, connection strings with a password and long opaque strings.
 */
const SECRET_PATTERNS = [
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session[_-]?id|authorization)["']?\s*[:=]\s*["']?\S{4,}/i,
  // Prose: "password is X", "password \"X\"", "mật khẩu: X".
  /(?:password|passwd|passphrase|mật khẩu)\s+(?:is\s+|=\s*|là\s+)?["']?[^\s"']{4,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\baos_[A-Za-z0-9_-]{10,}/,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  // Long opaque strings mixing upper, lower case and digits (keys, JWT parts); paths, slugs and commit hashes pass.
  /(?<![A-Za-z0-9+_])(?=[A-Za-z0-9+_]*\d)(?=[A-Za-z0-9+_]*[A-Z])(?=[A-Za-z0-9+_]*[a-z])[A-Za-z0-9+_]{32,}/,
];
export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some(pattern => pattern.test(text));

type Row = {
  id: string; requesterSeatId: string; taskId: string | null; channelId: string; threadSeq: number | null; action: string; scope: string; reason: string;
  consequences: string; target: string; dedupeKey: string; expiresAt: number; status: ApprovalStatus; revision: number; nonce: string;
  decidedBy: string | null; decidedVia: 'web' | 'telegram' | null; decidedAt: number | null; decisionNote: string;
  deliveryStatus: ApprovalDelivery; deliveryAttempts: number; deliveryError: string; nextAttemptAt: number; messageId: number | null; sentAt: number | null;
  staleMessageId: number | null; finalEdited: number; createdAt: number; updatedAt: number;
};
const COLUMNS = `id,requester_seat_id AS requesterSeatId,task_id AS taskId,channel_id AS channelId,thread_seq AS threadSeq,action,scope,reason,consequences,target,
  dedupe_key AS dedupeKey,expires_at AS expiresAt,status,revision,nonce,decided_by AS decidedBy,decided_via AS decidedVia,decided_at AS decidedAt,decision_note AS decisionNote,
  delivery_status AS deliveryStatus,delivery_attempts AS deliveryAttempts,delivery_error AS deliveryError,next_attempt_at AS nextAttemptAt,message_id AS messageId,
  sent_at AS sentAt,stale_message_id AS staleMessageId,final_edited AS finalEdited,created_at AS createdAt,updated_at AS updatedAt`;
/** Internal row for the Telegram delivery (carries the nonce and message ids, never returned by the API). */
export type ApprovalDeliveryRow = Row;

const toApproval = (row: Row): ApprovalRequest => ({
  id: row.id, requesterSeatId: row.requesterSeatId, taskId: row.taskId, channelId: row.channelId, threadSeq: row.threadSeq,
  action: row.action, scope: row.scope, reason: row.reason, consequences: row.consequences, target: row.target, expiresAt: row.expiresAt,
  status: row.status, revision: row.revision, decidedBy: row.decidedBy, decidedVia: row.decidedVia, decidedAt: row.decidedAt, decisionNote: row.decisionNote,
  delivery: { status: row.deliveryStatus, attempts: row.deliveryAttempts, error: row.deliveryError, sentAt: row.sentAt },
  createdAt: row.createdAt, updatedAt: row.updatedAt,
});

export type ApprovalInput = { taskId?: string | undefined; channelId?: string | undefined; threadSeq?: number | undefined; action: string; scope: string; reason: string; consequences?: string | undefined; target?: string | undefined; expiresInMinutes?: number | undefined };
export type ApprovalEdit = { action?: string | undefined; scope?: string | undefined; reason?: string | undefined; consequences?: string | undefined; target?: string | undefined; expiresInMinutes?: number | undefined };
export type TelegramDecision = { nonce: string; decision: 'approve' | 'reject'; messageId: number | null };
const clock = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * Manager approval requests. A seat asks for one specific decision tied to a task it can read or a thread it is in; the
 * manager approves or rejects it from the web or from the paired private Telegram chat. The request's status (the
 * decision, source of truth here and in `approval_events`) is kept apart from its Telegram delivery status. Every edit
 * of the scope is a new revision with a new nonce, so an older approval button no longer decides it. Approving records
 * the decision and tells the requester and its lead in the originating thread — it never runs anything, never changes a
 * task's status, result or dependencies and grants nothing beyond the stated scope until the expiry.
 */
export class ApprovalService {
  /** The Telegram delivery is told when something needs sending or editing. */
  onDeliveryNeeded: () => void = () => undefined;

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly tasks: TaskService, private readonly messages: MessageService, private readonly emit: (event: CollabEvent) => void, private readonly telegramEnabled: () => boolean = () => false) {}

  /** The manager sees every request; a seat sees its own and those on tasks it can read. */
  list(actor: Actor, status?: ApprovalStatus): ApprovalRequest[] {
    this.expireDue();
    const rows = (status
      ? this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE status=? ORDER BY created_at DESC`).all(status)
      : this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`).all()) as Row[];
    return rows.filter(row => this.canSee(actor, row)).slice(0, 200).map(toApproval);
  }

  pending(): ApprovalRequest[] { return (this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE status='pending' ORDER BY created_at`).all() as Row[]).map(toApproval); }

  get(actor: Actor, id: string): { approval: ApprovalRequest; events: ApprovalEvent[] } {
    this.expireDue();
    const row = this.row(id);
    if (!this.canSee(actor, row)) throw forbidden('forbidden_approval');
    const events = this.db.raw.prepare('SELECT kind,actor,via,revision,detail,created_at AS createdAt FROM approval_events WHERE approval_id=? ORDER BY id').all(id) as ApprovalEvent[];
    return { approval: toApproval(row), events };
  }

  /** A seat asks; the same pending request asked again (a retry) returns the existing one instead of a second request. */
  request(actor: Actor, input: ApprovalInput): { approval: ApprovalRequest; duplicate: boolean } {
    if (actor.kind !== 'seat') throw forbidden('approval_requested_by_seats');
    const fields = this.fields(input);
    const where = this.context(actor, input);
    const dedupeKey = createHash('sha256').update(JSON.stringify([where.taskId, where.channelId, where.threadSeq, fields.action, fields.scope, fields.target])).digest('hex');
    this.expireDue();
    const existing = this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE requester_seat_id=? AND dedupe_key=? AND status='pending'`).get(actor.seatId, dedupeKey) as Row | undefined;
    if (existing) return { approval: toApproval(existing), duplicate: true };
    const mine = (this.db.raw.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE requester_seat_id=? AND status='pending'").get(actor.seatId) as { n: number }).n;
    if (mine >= MAX_PENDING_PER_SEAT) throw conflict('too_many_pending_approvals', { limit: MAX_PENDING_PER_SEAT });
    const total = (this.db.raw.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE status='pending'").get() as { n: number }).n;
    if (total >= MAX_PENDING_TOTAL) throw conflict('approval_queue_full', { limit: MAX_PENDING_TOTAL });
    const id = `ap-${randomBytes(4).toString('hex')}`; const now = Date.now();
    this.db.transaction(() => {
      this.db.raw.prepare(`INSERT INTO approval_requests(id,requester_seat_id,task_id,channel_id,thread_seq,action,scope,reason,consequences,target,dedupe_key,expires_at,status,revision,nonce,delivery_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,?,?,?)`)
        .run(id, actor.seatId, where.taskId, where.channelId, where.threadSeq, fields.action, fields.scope, fields.reason, fields.consequences, fields.target, dedupeKey, now + fields.minutes * 60_000, this.nonce(), this.initialDelivery(), now, now);
      this.event(id, 'requested', actor.seatId, 'office', 1, fields.action);
    });
    this.changed(id);
    return { approval: toApproval(this.row(id)), duplicate: false };
  }

  /** The requester changes a pending request: a new revision with a new nonce, so any earlier approval button is void. */
  update(actor: Actor, id: string, input: ApprovalEdit): ApprovalRequest {
    const before = this.pendingRow(id);
    if (actor.kind !== 'seat' || actor.seatId !== before.requesterSeatId) throw forbidden('approval_changed_by_requester');
    const fields = this.fields({ action: input.action ?? before.action, scope: input.scope ?? before.scope, reason: input.reason ?? before.reason, consequences: input.consequences ?? before.consequences, target: input.target ?? before.target, expiresInMinutes: input.expiresInMinutes });
    const now = Date.now();
    const expiresAt = input.expiresInMinutes === undefined ? before.expiresAt : now + fields.minutes * 60_000;
    const dedupeKey = createHash('sha256').update(JSON.stringify([before.taskId, before.channelId, before.threadSeq, fields.action, fields.scope, fields.target])).digest('hex');
    const twin = this.db.raw.prepare("SELECT id FROM approval_requests WHERE requester_seat_id=? AND dedupe_key=? AND status='pending' AND id!=?").get(before.requesterSeatId, dedupeKey, id) as { id: string } | undefined;
    if (twin) throw conflict('approval_duplicate', { approvalId: twin.id });
    this.db.transaction(() => {
      this.db.raw.prepare(`UPDATE approval_requests SET action=?,scope=?,reason=?,consequences=?,target=?,dedupe_key=?,expires_at=?,revision=revision+1,nonce=?,
        delivery_status=?,delivery_attempts=0,delivery_error='',next_attempt_at=0,stale_message_id=COALESCE(message_id,stale_message_id),message_id=NULL,sent_at=NULL,updated_at=? WHERE id=?`)
        .run(fields.action, fields.scope, fields.reason, fields.consequences, fields.target, dedupeKey, expiresAt, this.nonce(), this.initialDelivery(), now, id);
      this.event(id, 'superseded', actor.seatId, 'office', before.revision + 1, `revision ${before.revision} replaced`);
    });
    this.changed(id);
    return toApproval(this.row(id));
  }

  /** The requester (or the manager) withdraws a pending request. */
  cancel(actor: Actor, id: string, note = ''): ApprovalRequest {
    const before = this.pendingRow(id);
    if (actor.kind === 'seat' && actor.seatId !== before.requesterSeatId) throw forbidden('approval_changed_by_requester');
    this.finish(before, 'cancelled', actor.kind === 'manager' ? 'manager' : actor.seatId, 'web', note.trim().slice(0, 500));
    return toApproval(this.row(id));
  }

  /** The manager decides from the web; `revision` must be the one the manager saw. */
  decide(actor: Actor, id: string, decision: 'approve' | 'reject', revision: number, note = ''): ApprovalRequest {
    if (actor.kind !== 'manager') throw forbidden('approval_decided_by_manager');
    this.expireDue();
    const row = this.row(id);
    if (row.status !== 'pending') {
      if (row.status === (decision === 'approve' ? 'approved' : 'rejected') && row.revision === revision) return toApproval(row);
      throw conflict(`approval_${row.status}`);
    }
    if (row.revision !== revision) throw conflict('approval_superseded', { revision: row.revision });
    this.finish(row, decision === 'approve' ? 'approved' : 'rejected', 'manager', 'web', note.trim().slice(0, 500));
    return toApproval(this.row(id));
  }

  /**
   * A button press from the paired private chat (the caller checked chat and sender). The nonce must be the current
   * revision's and the press must come from the message sent for it; pressing again answers with the outcome and
   * records nothing new.
   */
  decideFromTelegram(press: TelegramDecision): string {
    this.expireDue();
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE nonce=?`).get(press.nonce) as Row | undefined;
    if (!row) return 'Not current — this request was changed or does not exist.';
    if (press.messageId !== null && row.messageId !== null && press.messageId !== row.messageId) { this.event(row.id, 'callback_refused', 'telegram', 'telegram', row.revision, 'button from another message'); return 'Not allowed.'; }
    if (row.status !== 'pending') return `Already ${row.status}.`;
    this.finish(row, press.decision === 'approve' ? 'approved' : 'rejected', 'manager', 'telegram', '');
    return press.decision === 'approve' ? 'Approved' : 'Rejected';
  }

  /** Records a refused Telegram press (wrong chat or sender) on the request it named, if any. */
  refuseCallback(nonce: string, why: string): void {
    const row = this.db.raw.prepare('SELECT id,revision FROM approval_requests WHERE nonce=?').get(nonce) as { id: string; revision: number } | undefined;
    if (row) this.event(row.id, 'callback_refused', 'telegram', 'telegram', row.revision, why);
  }

  /** Pending requests past their expiry become expired (never approved by silence). */
  expireDue(now = Date.now()): void {
    const due = this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE status='pending' AND expires_at<=?`).all(now) as Row[];
    for (const row of due) { try { this.finish(row, 'expired', 'office', 'office', ''); } catch (error) { logger.error(error); } }
  }

  // ---- Telegram delivery bookkeeping (used by the notifier; delivery never changes the decision) ----

  /** Requests whose current revision should be sent now. */
  deliveryDue(now = Date.now(), limit = 10): Row[] {
    return this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE status='pending' AND expires_at>? AND (delivery_status IN ('queued','disabled','not_paired') OR (delivery_status='retry' AND next_attempt_at<=?)) ORDER BY created_at LIMIT ?`).all(now, now, limit) as Row[];
  }

  /** Telegram messages to edit: decided requests (outcome) and replaced revisions (superseded). */
  editsDue(limit = 10): Row[] {
    return this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE (status!='pending' AND message_id IS NOT NULL AND final_edited=0) OR stale_message_id IS NOT NULL ORDER BY updated_at LIMIT ?`).all(limit) as Row[];
  }

  markEdited(id: string, kind: 'final' | 'stale'): void {
    this.db.raw.prepare(kind === 'final' ? 'UPDATE approval_requests SET final_edited=1 WHERE id=?' : 'UPDATE approval_requests SET stale_message_id=NULL WHERE id=?').run(id);
  }

  /** Records a delivery outcome for one revision; a result for an older revision is ignored. */
  markDelivery(id: string, revision: number, outcome: { status: ApprovalDelivery; error?: string; messageId?: number; retryInMs?: number }): void {
    const row = this.row(id);
    if (row.revision !== revision) {
      // Sent while the request was being edited: remember that message so it is marked replaced, not left looking live.
      if (outcome.status === 'sent' && outcome.messageId !== undefined) this.db.raw.prepare('UPDATE approval_requests SET stale_message_id=COALESCE(stale_message_id,?) WHERE id=?').run(outcome.messageId, id);
      if (outcome.status === 'sent' && outcome.messageId !== undefined) this.onDeliveryNeeded();
      return;
    }
    const now = Date.now(); const attempted = outcome.status !== 'disabled' && outcome.status !== 'not_paired';
    const attempts = row.deliveryAttempts + (attempted ? 1 : 0);
    let status = outcome.status;
    if (status === 'retry' && attempts >= MAX_DELIVERY_ATTEMPTS) status = 'failed';
    const nextAt = status === 'retry' ? now + (outcome.retryInMs ?? RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)]!) : 0;
    const error = (outcome.error ?? '').slice(0, 300);
    if (row.deliveryStatus === status && row.deliveryError === error && !attempted) return;
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE approval_requests SET delivery_status=?,delivery_attempts=?,delivery_error=?,next_attempt_at=?,message_id=COALESCE(?,message_id),sent_at=CASE WHEN ?=\'sent\' THEN ? ELSE sent_at END WHERE id=?')
        .run(status, attempts, error, nextAt, outcome.messageId ?? null, status, now, id);
      this.event(id, `delivery_${status}`, 'telegram', 'telegram', revision, error);
    });
    this.changed(id, false);
  }

  /** The manager asks to send a request again after a failed or uncertain delivery. */
  resend(actor: Actor, id: string): ApprovalRequest {
    if (actor.kind !== 'manager') throw forbidden('approval_decided_by_manager');
    const row = this.pendingRow(id);
    if (!this.telegramEnabled()) throw conflict('telegram_disabled');
    if (!['failed', 'uncertain', 'disabled', 'not_paired'].includes(row.deliveryStatus)) throw conflict('approval_delivery_in_progress');
    this.db.transaction(() => {
      this.db.raw.prepare("UPDATE approval_requests SET delivery_status='queued',delivery_attempts=0,delivery_error='',next_attempt_at=0,stale_message_id=COALESCE(message_id,stale_message_id),message_id=NULL WHERE id=?").run(id);
      this.event(id, 'resend', 'manager', 'web', row.revision, `after ${row.deliveryStatus}`);
    });
    this.changed(id, false);
    return toApproval(this.row(id));
  }

  /** The decision line posted in the originating task/thread; the requester and its lead are mentioned (woken). */
  private relay(row: Row, status: ApprovalStatus, by: string, via: string, note: string): void {
    const seats = this.org.view().seats; const requester = seats.find(seat => seat.id === row.requesterSeatId);
    const lead = requester ? seats.find(seat => seat.departmentId === requester.departmentId && seat.role === 'leader') : undefined;
    // The seat that caused the line (a requester cancelling) is not woken by it.
    const mentions = [...(requester ? [requester.id] : []), ...(lead && lead.id !== row.requesterSeatId ? [lead.id] : [])].filter(id => id !== by);
    const head = status === 'approved' ? `✅ APPROVED by ${by} (${via})` : status === 'rejected' ? `❌ REJECTED by ${by} (${via})` : status === 'expired' ? '⌛ EXPIRED — not approved' : `CANCELLED by ${by}`;
    const lines = [`${[...new Set([row.requesterSeatId, ...mentions])].map(id => `@${id}`).join(' ')} Approval ${row.id} r${row.revision}: ${head} at ${clock(Date.now())}.`, `Action: ${row.action}`, `Scope: ${row.scope}`];
    if (row.target) lines.push(`Target: ${row.target}`);
    if (status === 'approved') lines.push(`Valid until ${clock(row.expiresAt)}, for exactly this scope. It runs nothing and changes no task status, result or dependency; execution still needs the usual role and checks.`);
    if (note) lines.push(`Note: ${note}`);
    const body = lines.join('\n');
    try {
      if (row.taskId) this.tasks.postLine(this.tasks.get(row.taskId), body, mentions);
      else this.messages.postSystem(row.channelId, body, mentions, row.threadSeq ?? undefined);
    } catch {
      try { this.messages.postSystem(row.channelId, body, mentions); } catch (error) { logger.error(error); }
    }
  }

  private finish(row: Row, status: ApprovalStatus, by: string, via: 'web' | 'telegram' | 'office', note: string): void {
    const now = Date.now();
    const done = this.db.transaction(() => {
      const changed = this.db.raw.prepare("UPDATE approval_requests SET status=?,decided_by=?,decided_via=?,decided_at=?,decision_note=?,updated_at=? WHERE id=? AND status='pending' AND revision=?")
        .run(status, by, via === 'office' ? null : via, now, note, now, row.id, row.revision).changes;
      if (changed === 1) this.event(row.id, status, by, via, row.revision, note);
      return changed === 1;
    });
    if (!done) throw conflict('approval_changed');
    // The decision is saved: telling the thread must never turn it into an error (a removed seat or channel).
    try { this.relay(row, status, by, via, note); } catch (error) { logger.error(error); }
    this.changed(row.id);
  }

  private fields(input: { action: string; scope: string; reason: string; consequences?: string | undefined; target?: string | undefined; expiresInMinutes?: number | undefined }): { action: string; scope: string; reason: string; consequences: string; target: string; minutes: number } {
    const action = input.action.trim(); const scope = input.scope.trim(); const reason = input.reason.trim(); const consequences = (input.consequences ?? '').trim(); const target = (input.target ?? '').trim();
    if (!action || action.length > 200 || !scope || scope.length > 500 || !reason || reason.length > 1000 || consequences.length > 500 || target.length > 200) throw invalid('invalid_approval');
    const minutes = input.expiresInMinutes ?? APPROVAL_DEFAULT_MINUTES;
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) throw invalid('invalid_approval_expiry');
    if ([action, scope, reason, consequences, target].some(looksSecret)) throw invalid('approval_contains_secret: describe the credential, never paste it');
    return { action, scope, reason, consequences, target, minutes };
  }

  /** A task the seat can read, or a thread of a channel it belongs to (or was invited into). */
  private context(actor: Actor & { kind: 'seat' }, input: ApprovalInput): { taskId: string | null; channelId: string; threadSeq: number | null } {
    if (input.taskId) {
      const task = this.tasks.get(input.taskId);
      if (!this.tasks.canRead(actor, task)) throw forbidden('forbidden_task_read');
      return { taskId: task.id, channelId: task.departmentId, threadSeq: task.threadSeq };
    }
    if (!input.channelId || input.threadSeq === undefined) throw invalid('approval_needs_task_or_thread');
    this.messages.thread(actor, input.channelId, input.threadSeq);
    return { taskId: null, channelId: input.channelId, threadSeq: input.threadSeq };
  }

  private canSee(actor: Actor, row: Row): boolean {
    if (actor.kind === 'manager' || actor.seatId === row.requesterSeatId) return true;
    if (!row.taskId) return false;
    try { return this.tasks.canRead(actor, this.tasks.get(row.taskId)); } catch { return false; }
  }

  private initialDelivery(): ApprovalDelivery { return this.telegramEnabled() ? 'queued' : 'disabled'; }
  private nonce(): string { return randomBytes(12).toString('hex'); }

  private row(id: string): Row {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE id=?`).get(id) as Row | undefined;
    if (!row) throw notFound('approval');
    return row;
  }

  private pendingRow(id: string): Row {
    this.expireDue();
    const row = this.row(id);
    if (row.status !== 'pending') throw conflict(`approval_${row.status}`);
    return row;
  }

  private event(id: string, kind: string, actor: string, via: string, revision: number, detail: string): void {
    this.db.raw.prepare('INSERT INTO approval_events(approval_id,kind,actor,via,revision,detail,created_at) VALUES (?,?,?,?,?,?,?)').run(id, kind, actor, via, revision, detail.slice(0, 1000), Date.now());
  }

  private changed(id: string, deliver = true): void {
    this.emit({ type: 'collab', kind: 'approvals', pending: this.pending(), changedId: id });
    if (deliver) this.onDeliveryNeeded();
  }
}
