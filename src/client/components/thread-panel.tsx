import type { ReactNode } from 'react';
import type { ChatMessage, OrgView, Seat } from '../../shared/contracts.js';
import { Composer } from './composer.js';
import { MessageList } from './message-list.js';

type Props = {
  channelId: string; thread: { root: ChatMessage; replies: ChatMessage[] } | undefined; org: OrgView; memberIds: string[];
  onSend: (body: string) => Promise<void>; onEdit: (message: ChatMessage, body: string) => Promise<void>; onDelete: (message: ChatMessage) => void; onClose: () => void;
};

/**
 * Side panel for one thread: the root message, its replies and a composer that posts into the thread. Any seat of the
 * office can be mentioned here: a seat outside the channel is invited into this thread only.
 */
export function ThreadPanel({ channelId, thread, org, memberIds, onSend, onEdit, onDelete, onClose }: Props): ReactNode {
  const members = new Set(memberIds);
  const seats = [...org.seats.filter(seat => members.has(seat.id)), ...org.seats.filter(seat => !members.has(seat.id))];
  const guests = thread ? [...new Set([thread.root, ...thread.replies].flatMap(message => message.mentions).filter(id => !members.has(id) && org.seats.some(seat => seat.id === id)))] : [];
  const hint = (seat: Seat): string | null => members.has(seat.id) ? null : `${seat.departmentId} · joins this thread`;
  return (
    <aside className="thread-panel" aria-label="Thread">
      <header className="thread-head">
        <strong>Thread</strong><span className="muted">#{channelId}{thread ? ` · ${thread.replies.length} repl${thread.replies.length === 1 ? 'y' : 'ies'}` : ''}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close thread" onClick={onClose}>✕</button>
      </header>
      {guests.length > 0 && <p className="thread-guests muted">Also in this thread: {guests.map(id => `@${id}`).join(', ')}</p>}
      {thread
        ? <>
            <MessageList messages={[thread.root, ...thread.replies]} org={org} onEdit={onEdit} onDelete={onDelete} emptyText="No replies yet." />
            <Composer channelLabel={`thread in #${channelId}`} seats={seats} onSend={onSend} hint={hint} />
          </>
        : <p className="loading">Loading thread…</p>}
    </aside>
  );
}
