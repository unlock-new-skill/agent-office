import type { ReactNode } from 'react';
import type { ChatMessage, OrgView } from '../../shared/contracts.js';
import { Composer } from './composer.js';
import { MessageList } from './message-list.js';

type Props = {
  channelId: string; thread: { root: ChatMessage; replies: ChatMessage[] } | undefined; org: OrgView;
  onSend: (body: string) => Promise<void>; onEdit: (message: ChatMessage, body: string) => Promise<void>; onDelete: (message: ChatMessage) => void; onClose: () => void;
};

/** Side panel for one thread: the root message, its replies and a composer that posts into the thread. */
export function ThreadPanel({ channelId, thread, org, onSend, onEdit, onDelete, onClose }: Props): ReactNode {
  return (
    <aside className="thread-panel" aria-label="Thread">
      <header className="thread-head">
        <strong>Thread</strong><span className="muted">#{channelId}{thread ? ` · ${thread.replies.length} repl${thread.replies.length === 1 ? 'y' : 'ies'}` : ''}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close thread" onClick={onClose}>✕</button>
      </header>
      {thread
        ? <>
            <MessageList messages={[thread.root, ...thread.replies]} org={org} onEdit={onEdit} onDelete={onDelete} emptyText="No replies yet." />
            <Composer channelLabel={`thread in #${channelId}`} seats={org.seats} onSend={onSend} />
          </>
        : <p className="loading">Loading thread…</p>}
    </aside>
  );
}
