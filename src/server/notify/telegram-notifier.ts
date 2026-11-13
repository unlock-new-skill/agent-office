import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Office } from '../collaboration/office.js';
import type { CollabEvent, PermissionRequest } from '../../shared/contracts.js';
import type { ApprovalDeliveryRow } from '../collaboration/approval-service.js';
import { TelegramError, type TelegramClient } from './telegram-client.js';

type Update = {
  update_id: number;
  message?: { chat: { id: number; title?: string; username?: string; first_name?: string }; text?: string };
  callback_query?: { id: string; from?: { id: number }; data?: string; message?: { chat: { id: number; type?: string }; message_id: number } };
};
type Deps = { client: TelegramClient; db: Database; office: Office; publicOrigin: string | null; log: (message: string) => void; sleep?: (ms: number) => Promise<void> };

const CHAT_KEY = 'telegram.chat_id';
const PAIRING_MS = 10 * 60_000; const MAX_SENDS_PER_MINUTE = 20;
const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000];
const DECISION = /^p:(a|d):([0-9a-f-]{36})$/;
const RESET = /^w:([a-z0-9][a-z0-9-]{0,63})$/;
const APPROVAL = /^ap:(a|r):([0-9a-f]{24})$/;
const APPROVAL_TICK_MS = 5000;
const clock = (at: number): string => new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const OUTCOME_LINE: Record<string, string> = { approved: '✅ APPROVED', rejected: '❌ REJECTED', expired: '⌛ EXPIRED — not approved', cancelled: '🚫 CANCELLED by the requester' };
const OUTCOME: Record<string, string> = { allowed: '✅ Allowed', denied: '❌ Denied', expired: '⌛ Expired — denied' };

/**
 * Telegram notifications for the manager: permission prompts arrive with Allow/Deny buttons that decide them, and runner
 * seats that fail are reported. The bot serves exactly one chat, paired with a short-lived code from the web UI, and
 * long-polls getUpdates (outbound through the proxy) instead of exposing a webhook.
 */
export class TelegramNotifier {
  private offset = 0; private running = false; private botUsername: string | null = null;
  private pairing: { code: string; expiresAt: number } | null = null;
  private readonly pending = new Set<string>();
  private readonly messages = new Map<string, { messageId: number; text: string }>();
  private readonly seatStates = new Map<string, string>();
  private readonly wakeLimited = new Set<string>();
  private orgSeen = false;
  private readonly sends: number[] = [];
  private pumping = false; private pumpAgain = false; private approvalTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: Deps) { deps.office.approvals.onDeliveryNeeded = () => { void this.pumpApprovals(); }; }

  status(): { enabled: true; paired: boolean; botUsername: string | null } { return { enabled: true, paired: this.chatId() !== null, botUsername: this.botUsername }; }

  /** One-time code the manager sends to the bot as `/start <code>`; the deep link opens the bot with it prefilled. */
  startPairing(): { code: string; expiresAt: number; link: string | null } {
    const code = randomBytes(4).toString('hex'); const expiresAt = Date.now() + PAIRING_MS;
    this.pairing = { code, expiresAt };
    return { code, expiresAt, link: this.botUsername ? `https://t.me/${this.botUsername}?start=${code}` : null };
  }

  unpair(): void { this.deps.db.raw.prepare('DELETE FROM app_settings WHERE key=?').run(CHAT_KEY); }

  async sendTest(): Promise<void> {
    const chat = this.chatId(); if (!chat) throw new Error('not_paired');
    await this.deps.client.call('sendMessage', { chat_id: chat, text: '🔔 Agent Office: test notification — this chat will receive permission prompts and runner alerts.' });
  }

  start(): void {
    if (this.running) return; this.running = true; void this.loop();
    this.approvalTimer = setInterval(() => { void this.pumpApprovals(); }, APPROVAL_TICK_MS); this.approvalTimer.unref();
    void this.pumpApprovals();
  }
  stop(): void { this.running = false; if (this.approvalTimer) clearInterval(this.approvalTimer); }

  /**
   * Sends manager approval requests that are due and edits messages of decided or replaced ones. Only the paired chat,
   * and only if it is a private chat, receives them. Delivery outcomes are recorded apart from the decision; a timeout
   * is "uncertain" and is not resent by itself (no duplicate message), a 429 waits for Telegram's retry_after.
   */
  async pumpApprovals(): Promise<void> {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const approvals = this.deps.office.approvals;
        approvals.expireDue();
        const chat = this.chatId();
        for (const row of approvals.deliveryDue()) {
          if (!chat) { approvals.markDelivery(row.id, row.revision, { status: 'not_paired', error: 'Telegram is not paired: Setup → Telegram → pair from a private chat with the bot' }); continue; }
          if (!/^[1-9]\d*$/.test(chat)) { approvals.markDelivery(row.id, row.revision, { status: 'failed', error: 'the paired chat is not a private chat: pair again from a private chat with the bot' }); continue; }
          if (!this.allowSend()) { this.pumpAgain = false; break; }
          try {
            const message = await this.deps.client.call<{ message_id: number }>('sendMessage', { chat_id: chat, text: this.approvalText(row), reply_markup: this.approvalButtons(row) });
            approvals.markDelivery(row.id, row.revision, { status: 'sent', messageId: message.message_id });
          } catch (error) {
            approvals.markDelivery(row.id, row.revision, this.deliveryFailure(error));
            this.deps.log(`telegram approval ${row.id} delivery failed: ${(error as Error).message}`);
          }
        }
        if (chat) for (const row of approvals.editsDue()) {
          if (row.staleMessageId !== null) {
            if (!this.allowSend()) break;
            if (await this.edit(chat, row.staleMessageId, `${this.approvalText({ ...row, revision: row.revision - 1 })}\n\n→ Replaced by a newer revision: these buttons no longer decide it.`)) approvals.markEdited(row.id, 'stale');
          }
          if (row.status !== 'pending' && row.messageId !== null && !row.finalEdited) {
            if (!this.allowSend()) break;
            if (await this.edit(chat, row.messageId, `${this.approvalText(row)}\n\n→ ${OUTCOME_LINE[row.status] ?? row.status}${row.decidedVia ? ` (${row.decidedVia})` : ''} ${row.decidedAt ? clock(row.decidedAt) : ''}`)) approvals.markEdited(row.id, 'final');
          }
        }
      } while (this.pumpAgain);
    } catch (error) { this.deps.log(`telegram approvals failed: ${(error as Error).message}`); }
    finally { this.pumping = false; }
  }

  private deliveryFailure(error: unknown): { status: 'retry' | 'uncertain' | 'failed'; error: string; retryInMs?: number } {
    const message = error instanceof Error ? error.message : 'request failed';
    if (!(error instanceof TelegramError)) return { status: 'uncertain', error: message };
    if (error.kind === 'network') return { status: 'retry', error: message };
    if (error.kind === 'uncertain') return { status: 'uncertain', error: `${message} — may have been delivered; resend from Agent Office if it did not arrive` };
    if (error.code === 429) return { status: 'retry', error: message, retryInMs: Math.max(1, error.retryAfter ?? 30) * 1000 };
    if (error.code !== null && error.code >= 500) return { status: 'uncertain', error: `${message} — may have been delivered; resend from Agent Office if it did not arrive` };
    return { status: 'failed', error: message };
  }

  /** The review summary: who asks, for what, why, the cost, the target and the expiry — nothing else from the office. */
  private approvalText(row: ApprovalDeliveryRow): string {
    const where = row.taskId ? `task ${row.taskId} (#${row.channelId}${row.threadSeq ? ` thread ${row.threadSeq}` : ''})` : `#${row.channelId} thread ${row.threadSeq}`;
    const lines = [`🟡 Approval ${row.id} r${row.revision} — @${row.requesterSeatId} asks for your decision`, `Where: ${where}`, `Action: ${row.action}`, `Scope: ${row.scope}`, `Reason: ${row.reason.length > 300 ? `${row.reason.slice(0, 300)}…` : row.reason}`];
    if (row.consequences) lines.push(`Consequences/cost: ${row.consequences}`);
    if (row.target) lines.push(`Target: ${row.target}`);
    lines.push(`Expires: ${clock(row.expiresAt)} (not approved if unanswered)`, 'Approving only records your decision for this exact scope; it runs nothing.');
    return lines.join('\n');
  }

  private approvalButtons(row: ApprovalDeliveryRow): Record<string, unknown> {
    const buttons: Array<Array<Record<string, string>>> = [[{ text: '✅ Approve', callback_data: `ap:a:${row.nonce}` }, { text: '❌ Reject', callback_data: `ap:r:${row.nonce}` }]];
    if (this.deps.publicOrigin?.startsWith('https://')) buttons.push([{ text: 'Open Agent Office', url: `${this.deps.publicOrigin}/requests` }]);
    return { inline_keyboard: buttons };
  }

  /** True when the edit is done or can never succeed (message gone, unchanged); false means try again on a later tick. */
  private async edit(chat: string, messageId: number, text: string): Promise<boolean> {
    try { await this.deps.client.call('editMessageText', { chat_id: chat, message_id: messageId, text }); return true; }
    catch (error) {
      this.deps.log(`telegram edit failed: ${(error as Error).message}`);
      return error instanceof TelegramError && error.kind === 'api' && error.code !== 429 && (error.code ?? 0) < 500;
    }
  }

  /** Shared send budget (MAX_SENDS_PER_MINUTE) for alerts and approvals. */
  private allowSend(): boolean {
    const now = Date.now();
    while (this.sends.length && now - this.sends[0]! > 60_000) this.sends.shift();
    if (this.sends.length >= MAX_SENDS_PER_MINUTE) return false;
    this.sends.push(now); return true;
  }

  /** Collaboration events from the office; sends are async and never block the emitter. */
  onEvent(event: CollabEvent): void {
    if (event.kind === 'permission') this.onPermissions(event.pending);
    if (event.kind === 'org') {
      // Alert when a seat newly hits the auto-wake limit (usually two agents looping); the first view only seeds state.
      for (const seat of event.org.seats) {
        const limited = seat.wakeState === 'wake_limited';
        if (limited && !this.wakeLimited.has(seat.id) && this.orgSeen) this.send(`⛔ @${seat.id} (${seat.title}) hit the auto-wake limit — chat-only turns in a row, agents may be looping. Mentions wait; it resumes by itself after 15 min quiet, or reset now.`, { inline_keyboard: [[{ text: '🔄 Reset', callback_data: `w:${seat.id}` }]] });
        if (limited) this.wakeLimited.add(seat.id); else this.wakeLimited.delete(seat.id);
      }
      this.orgSeen = true;
    }
    if (event.kind === 'runners') {
      for (const runner of event.runners) for (const seat of runner.seats) {
        const key = `${runner.id}:${seat.seatId}`; const before = this.seatStates.get(key); this.seatStates.set(key, seat.state);
        if (seat.state === 'failed' && before !== undefined && before !== 'failed') this.send(`⚠️ Runner seat @${seat.seatId} on ${runner.machine} failed: ${seat.detail}\nStart it again from Org.`);
      }
    }
  }

  private onPermissions(pending: PermissionRequest[]): void {
    const ids = new Set(pending.map(request => request.id));
    for (const request of pending) if (!this.pending.has(request.id)) { this.pending.add(request.id); this.notifyPermission(request); }
    for (const id of [...this.pending]) {
      if (ids.has(id)) continue;
      this.pending.delete(id);
      const sent = this.messages.get(id); this.messages.delete(id);
      const chat = this.chatId();
      if (!sent || !chat) continue;
      let outcome = '';
      try { const request = this.deps.office.permissions.get(id); outcome = `${OUTCOME[request.status] ?? request.status}${request.decidedBy ? ` (${request.decidedBy === 'telegram' ? 'Telegram' : 'web'})` : ''}`; } catch { outcome = 'resolved'; }
      void this.deps.client.call('editMessageText', { chat_id: chat, message_id: sent.messageId, text: `${sent.text}\n\n→ ${outcome}` }).catch(error => this.deps.log(`telegram edit failed: ${(error as Error).message}`));
    }
  }

  private notifyPermission(request: PermissionRequest): void {
    const who = request.seatId ? `@${request.seatId}` : request.agentId;
    const text = `🔐 ${who} needs permission\n\n${request.summary.slice(0, 1500)}\n\nAnswer soon — unanswered prompts are denied.`;
    const buttons: Array<Array<Record<string, string>>> = [[{ text: '✅ Allow', callback_data: `p:a:${request.id}` }, { text: '❌ Deny', callback_data: `p:d:${request.id}` }]];
    if (this.deps.publicOrigin?.startsWith('https://')) buttons.push([{ text: 'Open Agent Office', url: this.deps.publicOrigin }]);
    this.send(text, { inline_keyboard: buttons }, messageId => this.messages.set(request.id, { messageId, text }));
  }

  private send(text: string, markup?: Record<string, unknown>, onSent?: (messageId: number) => void): void {
    const chat = this.chatId(); if (!chat) return;
    if (!this.allowSend()) { this.deps.log('telegram: rate limit reached, notification skipped'); return; }
    void this.deps.client.call<{ message_id: number }>('sendMessage', { chat_id: chat, text, ...(markup ? { reply_markup: markup } : {}) })
      .then(message => onSent?.(message.message_id))
      .catch(error => this.deps.log(`telegram send failed: ${(error as Error).message}`));
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        if (!this.botUsername) this.botUsername = (await this.deps.client.call<{ username: string }>('getMe')).username;
        const updates = await this.deps.client.call<Update[]>('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
        failures = 0;
        for (const update of updates) { this.offset = update.update_id + 1; await this.handle(update).catch(error => this.deps.log(`telegram update failed: ${(error as Error).message}`)); }
      } catch (error) {
        const delay = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
        this.deps.log(`telegram polling failed (${(error as Error).message}); retrying in ${delay / 1000} s`);
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      }
    }
  }

  private async handle(update: Update): Promise<void> {
    const paired = this.chatId();
    if (update.message?.text) {
      const chat = String(update.message.chat.id); const code = /^(?:\/start\s+)?([0-9a-f]{8})$/.exec(update.message.text.trim())?.[1];
      if (code && this.pairing && code === this.pairing.code && Date.now() < this.pairing.expiresAt) {
        this.pairing = null;
        this.deps.db.raw.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CHAT_KEY, chat);
        await this.deps.client.call('sendMessage', { chat_id: chat, text: '✅ Paired with Agent Office. Permission prompts and runner alerts will arrive here.' });
      }
      // Anyone else, or anything else, gets no answer: the bot does not reveal what it is to strangers.
      return;
    }
    const query = update.callback_query;
    if (!query) return;
    const approval = APPROVAL.exec(query.data ?? '');
    if (approval) {
      // Only the manager's paired private chat decides: the press must come from that chat, from that user (in a
      // private chat the user id is the chat id). Anything else is refused and recorded on the request.
      const chat = String(query.message?.chat.id ?? ''); const from = String(query.from?.id ?? '');
      const why = !paired ? 'telegram not paired' : chat !== paired ? 'wrong chat' : from !== paired ? 'wrong sender' : query.message?.chat.type !== undefined && query.message.chat.type !== 'private' ? 'not a private chat' : null;
      let answer: string;
      if (why) { this.deps.office.approvals.refuseCallback(approval[2]!, why); answer = 'Not allowed.'; }
      else {
        try { answer = this.deps.office.approvals.decideFromTelegram({ nonce: approval[2]!, decision: approval[1] === 'a' ? 'approve' : 'reject', messageId: query.message?.message_id ?? null }); }
        catch (error) { answer = (error as { status?: number }).status === 409 ? 'Already decided.' : 'Failed — decide in Agent Office.'; this.deps.log(`telegram approval press failed: ${(error as Error).message}`); }
      }
      await this.deps.client.call('answerCallbackQuery', { callback_query_id: query.id, text: answer });
      return;
    }
    const reset = RESET.exec(query.data ?? '');
    if (reset && paired && String(query.message?.chat.id) === paired) {
      let answer = 'Reset — the seat reacts to mentions again';
      try { this.deps.office.org.resetWakeLimit(reset[1]!); } catch { answer = 'Seat not found'; }
      await this.deps.client.call('answerCallbackQuery', { callback_query_id: query.id, text: answer });
      return;
    }
    const match = DECISION.exec(query.data ?? '');
    if (!paired || String(query.message?.chat.id) !== paired || !match) { await this.deps.client.call('answerCallbackQuery', { callback_query_id: query.id, text: 'Not allowed.' }); return; }
    let answer: string;
    try {
      this.deps.office.permissions.decide(match[2]!, match[1] === 'a' ? 'allow' : 'deny', match[1] === 'a' ? '' : 'Denied by the manager from Telegram.', 'telegram');
      answer = match[1] === 'a' ? 'Allowed' : 'Denied';
    } catch { answer = 'Already resolved'; }
    await this.deps.client.call('answerCallbackQuery', { callback_query_id: query.id, text: answer });
  }

  private chatId(): string | null {
    return (this.deps.db.raw.prepare('SELECT value FROM app_settings WHERE key=?').get(CHAT_KEY) as { value: string } | undefined)?.value ?? null;
  }
}
