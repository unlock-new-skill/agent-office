import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { ChannelKind, ChatMessage, CollabEvent, SenderKind } from '../../shared/contracts.js';
import { conflict, forbidden, invalid, notFound } from './office-error.js';
import type { OrgService } from './org-service.js';

export type Actor = { kind: 'manager' } | { kind: 'seat'; seatId: string };
export type ChannelSummary = { id: string; name: string; kind: ChannelKind; departmentId: string | null; lastSeq: number; lastReadSeq: number; unread: number };
type MessageRow = { id: string; channelId: string; seq: number; senderKind: SenderKind; senderId: string; body: string; mentionsJson: string; createdAt: number; editedAt: number | null; deletedAt: number | null; threadSeq: number | null; replyCount: number; lastReplyAt: number | null };
const MESSAGE_COLUMNS = `id,channel_id AS channelId,seq,sender_kind AS senderKind,sender_id AS senderId,body,mentions_json AS mentionsJson,created_at AS createdAt,edited_at AS editedAt,deleted_at AS deletedAt,thread_seq AS threadSeq,
  (SELECT COUNT(*) FROM messages r WHERE r.channel_id=messages.channel_id AND r.thread_seq=messages.seq AND r.deleted_at IS NULL) AS replyCount,
  (SELECT MAX(r.created_at) FROM messages r WHERE r.channel_id=messages.channel_id AND r.thread_seq=messages.seq AND r.deleted_at IS NULL) AS lastReplyAt`;
const MAX_THREAD = 500;
const MAX_BODY = 16_384;
const toMessage = ({ mentionsJson, ...row }: MessageRow): ChatMessage => ({ ...row, mentions: JSON.parse(mentionsJson) as string[] });

/** Channel messages with server-enforced routing: a seat may only read/post in channels it is a member of; the manager may use any channel. */
export class MessageService {
  constructor(
    private readonly db: Database, private readonly org: OrgService, private readonly emit: (event: CollabEvent) => void,
    private readonly onPosted: (message: ChatMessage) => void = () => undefined,
    private readonly onChanged: () => void = () => undefined,
  ) {}

  /** Posts to the channel, or into the thread of root message `threadSeq` (threads are one level deep). */
  post(actor: Actor, channelId: string, body: string, threadSeq?: number): ChatMessage {
    this.assertAccess(actor, channelId);
    if (threadSeq !== undefined) this.threadRoot(channelId, threadSeq);
    return this.insert(channelId, actor.kind === 'manager' ? 'manager' : 'seat', actor.kind === 'manager' ? 'manager' : actor.seatId, body, undefined, threadSeq);
  }

  /** Root message plus its replies, oldest first. */
  thread(actor: Actor, channelId: string, seq: number): { root: ChatMessage; replies: ChatMessage[] } {
    this.assertAccess(actor, channelId);
    const root = this.threadRoot(channelId, seq);
    const replies = (this.db.raw.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id=? AND thread_seq=? ORDER BY seq LIMIT ?`).all(channelId, seq, MAX_THREAD) as MessageRow[]).map(toMessage);
    return { root, replies };
  }

  /** Author of a thread's root, used to wake them on replies (null for system/manager roots or unknown seqs). */
  threadRootSeat(channelId: string, seq: number): string | null {
    const row = this.db.raw.prepare("SELECT sender_id AS senderId FROM messages WHERE channel_id=? AND seq=? AND sender_kind='seat'").get(channelId, seq) as { senderId: string } | undefined;
    return row?.senderId ?? null;
  }

  /** System lines (task lifecycle). Mentions are explicit so they never wake the actor that caused them. */
  postSystem(channelId: string, body: string, mentions: string[]): ChatMessage { return this.insert(channelId, 'system', 'system', body, mentions); }

  /** Authors edit their own messages; mentions are re-parsed (seats that already received it are not woken again). */
  edit(actor: Actor, channelId: string, seq: number, body: string): ChatMessage {
    const message = this.find(actor, channelId, seq);
    if (!this.isAuthor(actor, message)) throw forbidden('not_message_author');
    if (body.trim().length === 0 || body.length > MAX_BODY) throw invalid('invalid_message_body');
    const mentions = this.parseMentions(body); const editedAt = Date.now();
    this.db.raw.prepare('UPDATE messages SET body=?,mentions_json=?,edited_at=? WHERE id=?').run(body, JSON.stringify(mentions), editedAt, message.id);
    return this.publishChange({ ...message, body, mentions, editedAt });
  }

  /** Soft delete by the author or the manager: keeps seq (read cursors stay valid), clears body and mentions. */
  remove(actor: Actor, channelId: string, seq: number): ChatMessage {
    const message = this.find(actor, channelId, seq);
    if (actor.kind !== 'manager' && !this.isAuthor(actor, message)) throw forbidden('not_message_author');
    const deletedAt = Date.now();
    this.db.raw.prepare("UPDATE messages SET body='',mentions_json='[]',deleted_at=? WHERE id=?").run(deletedAt, message.id);
    return this.publishChange({ ...message, body: '', mentions: [], deletedAt });
  }

  /** Channel history by seq. `topLevel` hides thread replies (the UI timeline); agents reading unread get everything. */
  list(actor: Actor, channelId: string, page: { after?: number | undefined; before?: number | undefined; limit?: number | undefined; topLevel?: boolean | undefined } = {}): ChatMessage[] {
    this.assertAccess(actor, channelId);
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 200); const top = page.topLevel ? ' AND thread_seq IS NULL' : '';
    if (page.after !== undefined) return (this.db.raw.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id=? AND seq>?${top} ORDER BY seq LIMIT ?`).all(channelId, page.after, limit) as MessageRow[]).map(toMessage);
    const rows = this.db.raw.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id=? AND seq<?${top} ORDER BY seq DESC LIMIT ?`).all(channelId, page.before ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  markRead(seatId: string, channelId: string, seq: number): void {
    if (!this.org.isMember(channelId, seatId)) throw forbidden('forbidden_channel');
    this.db.raw.prepare('INSERT INTO seat_reads(seat_id,channel_id,last_read_seq) VALUES (?,?,?) ON CONFLICT(seat_id,channel_id) DO UPDATE SET last_read_seq=MAX(last_read_seq,excluded.last_read_seq)').run(seatId, channelId, seq);
  }

  channelsForSeat(seatId: string): ChannelSummary[] {
    return (this.db.raw.prepare(`SELECT c.id,c.name,c.kind,c.department_id AS departmentId,COALESCE((SELECT MAX(seq) FROM messages m WHERE m.channel_id=c.id),0) AS lastSeq,COALESCE(r.last_read_seq,0) AS lastReadSeq
      FROM channel_members cm JOIN channels c ON c.id=cm.channel_id LEFT JOIN seat_reads r ON r.seat_id=cm.seat_id AND r.channel_id=c.id WHERE cm.seat_id=? ORDER BY c.kind='department',c.id`).all(seatId) as Array<Omit<ChannelSummary, 'unread'>>)
      .map(channel => ({ ...channel, unread: Math.max(channel.lastSeq - channel.lastReadSeq, 0) }));
  }

  private find(actor: Actor, channelId: string, seq: number): ChatMessage {
    this.assertAccess(actor, channelId);
    const row = this.db.raw.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id=? AND seq=?`).get(channelId, seq) as MessageRow | undefined;
    if (!row) throw notFound('message');
    const message = toMessage(row);
    if (message.deletedAt) throw conflict('message_deleted');
    return message;
  }

  private threadRoot(channelId: string, seq: number): ChatMessage {
    const row = this.db.raw.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id=? AND seq=?`).get(channelId, seq) as MessageRow | undefined;
    if (!row) throw notFound('message');
    if (row.threadSeq !== null) throw invalid('reply_to_thread_root');
    return toMessage(row);
  }

  /** Re-reads a message so live clients get fresh thread stats (e.g. a root's reply count after a new reply). */
  private fresh(channelId: string, seq: number): ChatMessage | null {
    const row = this.db.raw.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id=? AND seq=?`).get(channelId, seq) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  private isAuthor(actor: Actor, message: ChatMessage): boolean {
    return actor.kind === 'manager' ? message.senderKind === 'manager' : message.senderKind === 'seat' && message.senderId === actor.seatId;
  }

  private publishChange(message: ChatMessage): ChatMessage {
    this.emit({ type: 'collab', kind: 'message', message });
    const root = message.threadSeq ? this.fresh(message.channelId, message.threadSeq) : null;
    if (root) this.emit({ type: 'collab', kind: 'message', message: root });
    this.onChanged();
    return message;
  }

  private assertAccess(actor: Actor, channelId: string): void {
    this.org.channel(channelId);
    if (actor.kind === 'seat' && !this.org.isMember(channelId, actor.seatId)) throw forbidden('forbidden_channel');
  }

  private insert(channelId: string, senderKind: SenderKind, senderId: string, body: string, explicitMentions?: string[], threadSeq?: number): ChatMessage {
    if (body.trim().length === 0 || body.length > MAX_BODY) throw invalid('invalid_message_body');
    const mentions = explicitMentions ?? this.parseMentions(body);
    const message = this.db.transaction(() => {
      const seq = (this.db.raw.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM messages WHERE channel_id=?').get(channelId) as { next: number }).next;
      const created: ChatMessage = { id: randomUUID(), channelId, seq, senderKind, senderId, body, mentions, createdAt: Date.now(), threadSeq: threadSeq ?? null, replyCount: 0, lastReplyAt: null };
      this.db.raw.prepare('INSERT INTO messages(id,channel_id,seq,sender_kind,sender_id,body,mentions_json,created_at,thread_seq) VALUES (?,?,?,?,?,?,?,?,?)').run(created.id, channelId, seq, senderKind, senderId, body, JSON.stringify(mentions), created.createdAt, threadSeq ?? null);
      if (senderKind === 'seat') this.db.raw.prepare('INSERT INTO seat_reads(seat_id,channel_id,last_read_seq) VALUES (?,?,?) ON CONFLICT(seat_id,channel_id) DO UPDATE SET last_read_seq=excluded.last_read_seq').run(senderId, channelId, seq);
      return created;
    });
    this.emit({ type: 'collab', kind: 'message', message });
    const root = threadSeq ? this.fresh(channelId, threadSeq) : null;
    if (root) this.emit({ type: 'collab', kind: 'message', message: root });
    this.onPosted(message);
    return message;
  }

  private parseMentions(body: string): string[] {
    const candidates = [...new Set([...body.matchAll(/(?<![\w@])@([a-z0-9][a-z0-9-]{0,63})/g)].map(match => match[1]!))];
    return candidates.filter(id => this.db.raw.prepare('SELECT 1 FROM seats WHERE id=?').get(id));
  }
}
