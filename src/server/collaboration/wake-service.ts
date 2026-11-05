import type { Database } from '../db/database.js';
import type { ChatMessage } from '../../shared/contracts.js';
import type { MessageService } from './message-service.js';
import { OUTPUTS_CHANNEL_ID, type OrgService } from './org-service.js';

export type WakeState = 'timeout' | 'aborted' | 'paused' | 'unseated' | 'ended' | 'wake_limit' | 'busy' | 'shutdown';
export type WakeResult = { wake: true; reason: string; items: ChatMessage[] } | { wake: false; state: WakeState };
type Waiter = { seatId: string; finish: (result: WakeResult) => void; recheck: () => void };

const MAX_REASON = 4000; const MAX_ITEM = 400; const MAX_WAITERS = 64; const MAX_SCAN = 200;
/** A leader quiet this long, and not parked waiting for work, is treated as unavailable so the deputy stands in. */
const LEADER_IDLE_MS = 10 * 60_000;
/** A seat stopped by the auto-wake limit re-arms by itself after this long without an automatic wake. */
export const WAKE_COOLDOWN_MS = 15 * 60_000;
/** Tools that only talk or keep notes: a turn using nothing else is chatter and counts toward the auto-wake limit. */
const CHATTER_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
export const isWorkTool = (tool: string): boolean => !tool.startsWith('mcp__agent-office__') && !CHATTER_TOOLS.has(tool);

/**
 * Decides when a seated Claude session should be woken (Stop hook / wait_for_message) and hands it the unread items.
 * Only an @mention of S wakes seat S (including @all and the system lines for task changes, which mention whoever must
 * act): leaders coordinate who does what, so unmentioned traffic never pulls a second agent onto the same work. A seat
 * is never woken by its own messages, while its department is paused, or past the auto-wake limit.
 * A department's deputy is also woken by items addressed to its leader while that leader is unavailable.
 */
export class WakeService {
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly maxAutoWakes: number) {}

  /** Delivers pending wake items now, or reports why the seat cannot be woken. Never blocks. */
  check(seatId: string): WakeResult {
    const seat = this.org.seat(seatId);
    if (!seat.agentId) return { wake: false, state: 'unseated' };
    if (this.agentEnded(seat.agentId)) return { wake: false, state: 'ended' };
    if (this.org.department(seat.departmentId).paused) return { wake: false, state: 'paused' };
    if (seat.consecutiveWakes >= this.maxAutoWakes && !this.cooledDown(seatId)) return { wake: false, state: 'wake_limit' };
    const pending = this.pending(seatId);
    if (pending.items.length === 0) return { wake: false, state: 'timeout' };
    const standIn = this.standingInFor(seatId);
    const count = this.db.transaction(() => {
      for (const [channelId, lastSeq] of pending.channelHighWater) this.messages.markRead(seatId, channelId, lastSeq);
      for (const { channelId, threadSeq, seq } of pending.guestHighWater) this.messages.markThreadRead(seatId, channelId, threadSeq, seq);
      // After a cooldown release the count starts over, so a real loop is stopped again after another full budget.
      const before = seat.consecutiveWakes >= this.maxAutoWakes ? 0 : seat.consecutiveWakes;
      this.db.raw.prepare('UPDATE seats SET consecutive_wakes=?,last_wake_at=? WHERE id=?').run(before + 1, Date.now(), seatId);
      return before + 1;
    });
    if (count >= this.maxAutoWakes || seat.consecutiveWakes >= this.maxAutoWakes) this.org.publish();
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

  /** A turn that does real work (edits, shell, reads…) is progress, not ping-pong: it re-arms the auto-wake budget. */
  noteToolUse(agentId: string, tool: string): void { if (isWorkTool(tool)) this.resetGuardForAgent(agentId); }

  waiterCount(): number { return this.waiters.size; }
  close(): void { for (const waiter of [...this.waiters]) waiter.finish({ wake: false, state: 'shutdown' }); }

  private pending(seatId: string): { items: ChatMessage[]; channelHighWater: Map<string, number>; guestHighWater: Array<{ channelId: string; threadSeq: number; seq: number }>; otherUnread: number } {
    const standIn = this.standingInFor(seatId);
    const items: ChatMessage[] = []; const channelHighWater = new Map<string, number>(); let unreadInWokenChannels = 0;
    for (const channel of this.messages.channelsForSeat(seatId)) {
      // #outputs is a feed for the manager: nothing posted there wakes an agent.
      if (channel.unread === 0 || channel.id === OUTPUTS_CHANNEL_ID) continue;
      const unread = this.messages.list({ kind: 'seat', seatId }, channel.id, { after: channel.lastReadSeq, limit: MAX_SCAN });
      const waking = unread.filter(message => {
        if (message.deletedAt || (message.senderKind === 'seat' && message.senderId === seatId)) return false;
        return message.mentions.includes(seatId) || (standIn !== null && message.mentions.includes(standIn));
      });
      if (waking.length === 0) continue;
      items.push(...waking); channelHighWater.set(channel.id, channel.lastSeq); unreadInWokenChannels += channel.unread;
    }
    const channelItems = items.length;
    // Threads of other channels the seat was invited into by a mention: only mentions there wake it.
    const guestHighWater: Array<{ channelId: string; threadSeq: number; seq: number }> = [];
    for (const guest of this.messages.guestThreads(seatId)) {
      const unread = this.messages.threadAfter(guest.channelId, guest.threadSeq, guest.lastReadSeq, MAX_SCAN);
      const waking = unread.filter(message => !message.deletedAt && !(message.senderKind === 'seat' && message.senderId === seatId) && message.mentions.includes(seatId));
      if (waking.length === 0) continue;
      items.push(...waking); guestHighWater.push({ channelId: guest.channelId, threadSeq: guest.threadSeq, seq: unread.at(-1)!.seq });
    }
    return { items, channelHighWater, guestHighWater, otherUnread: Math.max(unreadInWokenChannels - channelItems, 0) };
  }

  private cooledDown(seatId: string): boolean {
    const row = this.db.raw.prepare('SELECT last_wake_at AS lastWakeAt FROM seats WHERE id=?').get(seatId) as { lastWakeAt: number | null } | undefined;
    return !row?.lastWakeAt || Date.now() - row.lastWakeAt >= WAKE_COOLDOWN_MS;
  }

  /** A session that ended (SessionEnd) must not consume mentions meant for whoever takes the seat next. */
  private agentEnded(agentId: string): boolean {
    const agent = this.db.raw.prepare('SELECT ended_at AS endedAt FROM agents WHERE id=?').get(agentId) as { endedAt: string | null } | undefined;
    return !agent || agent.endedAt !== null;
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
    const footer = `${otherUnread > 0 ? `(+${otherUnread} other unread message(s) in these channels)\n` : ''}Next: use agent_office_read_channel for context (for a thread item, agent_office_read_thread { channelId, seq: the thread number } — the only way into a thread of a channel you are not in), do the work, reply with agent_office_send_message (mention @seat-id; pass threadSeq to answer inside a thread — the [n] shown — so replies do not flood the channel), update tasks with agent_office_update_task, and keep your seat note current with agent_office_save_handoff.`;
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
