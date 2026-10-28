import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage, OrgView } from '../../shared/contracts.js';
import { splitMentions } from '../state/mentions.js';

/** onOpenThread: shows the reply action and reply counts (omitted inside a thread, where replies cannot nest). */
type Props = { messages: ChatMessage[]; org: OrgView; onLoadOlder?: () => Promise<boolean>; onEdit: (message: ChatMessage, body: string) => Promise<void>; onDelete: (message: ChatMessage) => void; onOpenThread?: (message: ChatMessage) => void; activeThreadSeq?: number | null; emptyText?: string };
const time = (timestamp: number): string => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (timestamp: number): string => new Date(timestamp).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export function MessageList({ messages, org, onLoadOlder, onEdit, onDelete, onOpenThread, activeThreadSeq = null, emptyText = 'No messages yet. Say hi — mention a seat with @ to wake it.' }: Props): ReactNode {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const stick = useRef(true); const [hasOlder, setHasOlder] = useState(true);
  const lastId = messages.at(-1)?.id;

  useLayoutEffect(() => { const node = scroller.current; if (node && stick.current) node.scrollTop = node.scrollHeight; }, [lastId]);
  useEffect(() => { setHasOlder((messages[0]?.seq ?? 1) > 1); }, [messages]);

  const sender = (message: ChatMessage): { name: string; color: string; initial: string } => {
    if (message.senderKind === 'manager') return { name: 'Manager', color: '#a78bfa', initial: 'M' };
    if (message.senderKind === 'system') return { name: 'Office', color: '#64748b', initial: '•' };
    const seat = org.seats.find(candidate => candidate.id === message.senderId);
    const department = org.departments.find(candidate => candidate.id === seat?.departmentId);
    return { name: seat?.title ?? `@${message.senderId}`, color: department?.color ?? '#64748b', initial: (seat?.title ?? message.senderId).slice(0, 1).toUpperCase() };
  };

  return (
    <div className="message-scroller" ref={scroller} onScroll={event => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} role="log" aria-live="polite" aria-label="Messages">
      {onLoadOlder && hasOlder && messages.length > 0 && <button type="button" className="load-older" onClick={() => void onLoadOlder().then(setHasOlder)}>Load older messages</button>}
      {messages.length === 0 && <p className="empty">{emptyText}</p>}
      {messages.map((message, index) => {
        const previous = messages[index - 1]; const who = sender(message);
        const newDay = !previous || day(previous.createdAt) !== day(message.createdAt);
        const grouped = !newDay && previous && previous.senderKind === message.senderKind && previous.senderId === message.senderId && message.createdAt - previous.createdAt < 5 * 60_000 && message.senderKind !== 'system';
        // Highlight exactly what the server counted as mentions (channel members only).
        const body = splitMentions(message.body, message.mentions).map((segment, key) => segment.mention ? <span key={key} className="mention">{segment.text}</span> : <span key={key}>{segment.text}</span>);
        const replies = onOpenThread && (message.replyCount ?? 0) > 0
          ? <button type="button" className={`thread-link ${activeThreadSeq === message.seq ? 'active' : ''}`} onClick={() => onOpenThread(message)}>
              {message.replyCount} repl{message.replyCount === 1 ? 'y' : 'ies'}{message.lastReplyAt ? <span className="muted"> · last {time(message.lastReplyAt)}</span> : null}
            </button>
          : null;
        const replyAction = onOpenThread ? <button type="button" className="icon-btn" aria-label="Reply in thread" title="Reply in thread" onClick={() => onOpenThread(message)}>💬</button> : null;
        return (
          <div key={message.id}>
            {newDay && <div className="day-divider"><span>{day(message.createdAt)}</span></div>}
            {message.senderKind === 'system'
              ? <div className={`message system ${activeThreadSeq === message.seq ? 'in-thread' : ''}`}>
                  <span className="system-text">{body}{replies && <> {replies}</>}</span><time>{time(message.createdAt)}</time>
                  {replyAction && <div className="message-actions">{replyAction}</div>}
                </div>
              : <article className={`message ${grouped ? 'grouped' : ''} ${activeThreadSeq === message.seq ? 'in-thread' : ''}`}>
                  {grouped ? <time className="gutter-time">{time(message.createdAt)}</time> : <span className="avatar" style={{ background: who.color }} aria-hidden>{who.initial}</span>}
                  <div className="message-main">
                    {!grouped && <header><strong>{who.name}</strong>{message.senderKind === 'seat' && <span className="handle">@{message.senderId}</span>}<time>{time(message.createdAt)}</time></header>}
                    {message.deletedAt
                      ? <p className="message-body deleted">message deleted</p>
                      : editing?.id === message.id
                        ? <form className="message-edit" onSubmit={event => { event.preventDefault(); void onEdit(message, editing.draft).then(() => setEditing(null)); }}>
                            <label className="sr-only" htmlFor={`edit-${message.id}`}>Edit message</label>
                            <textarea id={`edit-${message.id}`} value={editing.draft} onChange={event => setEditing({ id: message.id, draft: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }} rows={2} autoFocus maxLength={16_384} />
                            <div className="row-actions"><button type="submit" className="btn btn-small btn-primary">Save</button><button type="button" className="btn btn-small" onClick={() => setEditing(null)}>Cancel</button></div>
                          </form>
                        : <p className="message-body">{body}{message.editedAt && <span className="edited"> (edited)</span>}</p>}
                    {replies}
                  </div>
                  {!message.deletedAt && editing?.id !== message.id && (
                    <div className="message-actions">
                      {replyAction}
                      {message.senderKind === 'manager' && <button type="button" className="icon-btn" aria-label="Edit message" onClick={() => setEditing({ id: message.id, draft: message.body })}>✎</button>}
                      <button type="button" className="icon-btn" aria-label="Delete message" onClick={() => onDelete(message)}>🗑</button>
                    </div>
                  )}
                </article>}
          </div>
        );
      })}
    </div>
  );
}
