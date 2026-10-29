import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Office } from '../collaboration/office.js';
import type { CollabEvent, PermissionRequest } from '../../shared/contracts.js';
import type { TelegramClient } from './telegram-client.js';

type Update = {
  update_id: number;
  message?: { chat: { id: number; title?: string; username?: string; first_name?: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
};
type Deps = { client: TelegramClient; db: Database; office: Office; publicOrigin: string | null; log: (message: string) => void; sleep?: (ms: number) => Promise<void> };

const CHAT_KEY = 'telegram.chat_id';
const PAIRING_MS = 10 * 60_000; const MAX_SENDS_PER_MINUTE = 20;
const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000];
const DECISION = /^p:(a|d):([0-9a-f-]{36})$/;
const RESET = /^w:([a-z0-9][a-z0-9-]{0,63})$/;
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

  constructor(private readonly deps: Deps) {}

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

  start(): void { if (this.running) return; this.running = true; void this.loop(); }
  stop(): void { this.running = false; }

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
    const now = Date.now();
    while (this.sends.length && now - this.sends[0]! > 60_000) this.sends.shift();
    if (this.sends.length >= MAX_SENDS_PER_MINUTE) { this.deps.log('telegram: rate limit reached, notification skipped'); return; }
    this.sends.push(now);
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
