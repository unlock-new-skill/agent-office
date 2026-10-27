import type { Database } from '../db/database.js';
import type { ChatMessage } from '../../shared/contracts.js';
import type { MessageService } from './message-service.js';
import type { OrgService } from './org-service.js';

export type WakeState = 'timeout' | 'aborted' | 'paused' | 'unseated' | 'wake_limit' | 'busy' | 'shutdown';
export type WakeResult = { wake: true; reason: string; items: ChatMessage[] } | { wake: false; state: WakeState };
type Waiter = { seatId: string; finish: (result: WakeResult) => void; recheck: () => void };

const MAX_REASON = 4000; const MAX_ITEM = 400; const MAX_WAITERS = 64; const MAX_SCAN = 200;
/** A leader quiet this long, and not parked waiting for work, is treated as unavailable so the deputy stands in. */
const LEADER_IDLE_MS = 10 * 60_000;

/**
 * Decides when a seated Claude session should be woken (Stop hook / wait_for_message) and hands it the unread items.
 * Wake triggers for seat S: @mention of S, any manager message, or (members only) a leader message in S's department
 * channel. A seat is never woken by its own messages, while its department is paused, or past the auto-wake limit.
 * A department's deputy is also woken by items addressed to its leader while that leader is unavailable.
 */
export class WakeService {
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly maxAutoWakes: number) {}

  /** Delivers pending wake items now, or reports why the seat cannot be woken. Never blocks. */
  check(seatId: string): WakeResult {
    const seat = this.org.seat(seatId);
    if (!seat.agentId) return { wake: false, state: 'unseated' };
    if (this.org.department(seat.departmentId).paused) return { wake: false, state: 'paused' };
    if (seat.consecutiveWakes >= this.maxAutoWakes) return { wake: false, state: 'wake_limit' };
    const pending = this.pending(seatId);
    if (pending.items.length === 0) return { wake: false, state: 'timeout' };
    const standIn = this.standingInFor(seatId);
    const count = this.db.transaction(() => {
      for (const [channelId, lastSeq] of pending.channelHighWater) this.messages.markRead(seatId, channelId, lastSeq);
      this.db.raw.prepare('UPDATE seats SET consecutive_wakes=consecutive_wakes+1 WHERE id=?').run(seatId);
      return seat.consecutiveWakes + 1;
    });
    if (count >= this.maxAutoWakes) this.org.publish();
    return { wake: true, reason: this.formatReason(seatId, pending.items, pending.otherUnread, standIn), items: pending.items };
  }

  /** Long-poll: resolves as soon as a wake item exists, or with timeout/abort. */
  wait(seatId: string, timeoutMs: number, signal?: AbortSignal): Promise<WakeResult> {
    const immediate = this.check(seatId);
    if (immediate.wake || immediate.state !== 'timeout' || timeoutMs <= 0) return Promise.resolve(immediate);
    if (this.waiters.size >= MAX_WAITERS) return Promise.resolve({ wake: false, state: 'busy' });
    if (signal?.aborted) return Promise.resolve({ wake: false, state: 'aborted' });
    return new Promise(resolve => {
      const onAbort = (): void => waiter.finish({ wake: false, state: 'aborted' });
      const timer = setTimeout(() => waiter.finish({ wake: false, state: 'timeout' }), timeoutMs);
      const waiter: Waiter = {
        seatId,
        finish: result => {
          if (!this.waiters.delete(waiter)) return;
          clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
          if (![...this.waiters].some(other => other.seatId === seatId)) { this.org.listening.delete(seatId); this.org.publish(); }
          resolve(result);
        },
        recheck: () => { const result = this.check(seatId); if (result.wake || result.state !== 'timeout') waiter.finish(result); },
      };
      this.waiters.add(waiter); signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.org.listening.has(seatId)) { this.org.listening.add(seatId); this.org.publish(); }
    });
  }

  /** Called after every post and org change: re-evaluates parked waiters. */
  notify(): void { for (const waiter of [...this.waiters]) waiter.recheck(); }

  /** A manager message to a channel re-arms the auto-wake budget of everyone in it. */
  onPosted(message: ChatMessage): void {
    if (message.senderKind === 'manager') this.db.raw.prepare('UPDATE seats SET consecutive_wakes=0 WHERE id IN (SELECT seat_id FROM channel_members WHERE channel_id=?)').run(message.channelId);
    this.notify();
  }

  /** A human prompt (UserPromptSubmit → turn.start) re-arms the seat's auto-wake budget. */
  resetGuardForAgent(agentId: string): void {
    const seat = this.org.seatForAgent(agentId);
    if (!seat || seat.consecutiveWakes === 0) return;
    this.db.raw.prepare('UPDATE seats SET consecutive_wakes=0 WHERE id=?').run(seat.id);
    this.org.publish();
  }

  waiterCount(): number { return this.waiters.size; }
  close(): void { for (const waiter of [...this.waiters]) waiter.finish({ wake: false, state: 'shutdown' }); }

  private pending(seatId: string): { items: ChatMessage[]; channelHighWater: Map<string, number>; otherUnread: number } {
    const seat = this.org.seat(seatId);
    const leader = this.db.raw.prepare("SELECT id FROM seats WHERE department_id=? AND role='leader'").get(seat.departmentId) as { id: string } | undefined;
    const standIn = this.standingInFor(seatId);
    const items: ChatMessage[] = []; const channelHighWater = new Map<string, number>(); let unreadInWokenChannels = 0;
    for (const channel of this.messages.channelsForSeat(seatId)) {
      if (channel.unread === 0) continue;
      const unread = this.messages.list({ kind: 'seat', seatId }, channel.id, { after: channel.lastReadSeq, limit: MAX_SCAN });
      const waking = unread.filter(message => {
        if (message.deletedAt || (message.senderKind === 'seat' && message.senderId === seatId)) return false;
        if (message.mentions.includes(seatId) || message.senderKind === 'manager') return true;
        if (standIn && message.mentions.includes(standIn)) return true;
        // A reply in a thread you started is addressed to you, like a mention.
        if (message.threadSeq && message.senderKind !== 'system' && this.messages.threadRootSeat(channel.id, message.threadSeq) === seatId) return true;
        return seat.role === 'member' && channel.kind === 'department' && channel.departmentId === seat.departmentId && message.senderKind === 'seat' && message.senderId === leader?.id;
      });
      if (waking.length === 0) continue;
      items.push(...waking); channelHighWater.set(channel.id, channel.lastSeq); unreadInWokenChannels += channel.unread;
    }
    return { items, channelHighWater, otherUnread: Math.max(unreadInWokenChannels - items.length, 0) };
  }

  /** Leader id when `seatId` is its department's deputy and the leader has no live, responsive session; else null. */
  standingInFor(seatId: string): string | null {
    const seat = this.org.seat(seatId); const department = this.org.department(seat.departmentId);
    if (department.deputySeatId !== seatId) return null;
    const leader = this.db.raw.prepare("SELECT id,agent_id AS agentId,consecutive_wakes AS wakes FROM seats WHERE department_id=? AND role='leader'").get(seat.departmentId) as { id: string; agentId: string | null; wakes: number } | undefined;
    if (!leader) return null;
    if (!leader.agentId || leader.wakes >= this.maxAutoWakes) return leader.id;
    if (this.org.listening.has(leader.id)) return null;
    const agent = this.db.raw.prepare('SELECT ended_at AS endedAt,last_event_at AS lastEventAt FROM agents WHERE id=?').get(leader.agentId) as { endedAt: string | null; lastEventAt: string | null } | undefined;
    if (!agent || agent.endedAt) return leader.id;
    return agent.lastEventAt && Date.now() - Date.parse(agent.lastEventAt) > LEADER_IDLE_MS ? leader.id : null;
  }

  private formatReason(seatId: string, items: ChatMessage[], otherUnread: number, standIn: string | null = null): string {
    const seat = this.org.seat(seatId); const department = this.org.department(seat.departmentId);
    const header = `[Agent Office] ${items.length} new item(s) for @${seat.id} (${seat.title}, ${seat.role} of ${department.name}):`
      + (standIn ? `\nYou are the deputy and @${standIn} (your leader) is unavailable: handle items addressed to @${standIn} as acting leader (reply in #leaders, create tasks with requestedBy for cross-department requests).` : '');
    const footer = `${otherUnread > 0 ? `(+${otherUnread} other unread message(s) in these channels)\n` : ''}Next: use agent_office_read_channel for context, do the work, reply with agent_office_send_message (mention @seat-id; pass threadSeq to answer inside a thread — the [n] shown — so replies do not flood the channel), update tasks with agent_office_update_task, and keep your seat note current with agent_office_save_handoff.`;
    const lines: string[] = []; let budget = MAX_REASON - header.length - footer.length - 64;
    for (const item of items) {
      const sender = item.senderKind === 'seat' ? `@${item.senderId}` : item.senderKind;
      const body = item.body.replace(/\s+/g, ' ').trim(); const where = item.threadSeq ? `#${item.channelId} thread [${item.threadSeq}]` : `#${item.channelId} [${item.seq}]`;
      const line = `- ${where} ${sender}: ${body.length > MAX_ITEM ? `${body.slice(0, MAX_ITEM)}…` : body}`;
      if (line.length > budget) { lines.push(`- …and ${items.length - lines.length} more`); break; }
      lines.push(line); budget -= line.length + 1;
    }
    return `${header}\n${lines.join('\n')}\n${footer}`;
  }
}
