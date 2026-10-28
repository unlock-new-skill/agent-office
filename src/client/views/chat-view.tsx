import { useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../api/http.js';
import { Composer } from '../components/composer.js';
import { MembersPanel } from '../components/members-panel.js';
import { MessageList } from '../components/message-list.js';
import { Sidebar } from '../components/sidebar.js';
import { TasksPanel } from '../components/tasks-panel.js';
import { ThreadPanel } from '../components/thread-panel.js';
import type { ChatMessage } from '../../shared/contracts.js';
import { threadKey } from '../state/office-store.js';
import type { OfficeHandle } from '../state/use-office.js';

type Props = { office: OfficeHandle; channelId: string; onSelectChannel: (channelId: string) => void; notify: (text: string) => void };

export function ChatView({ office, channelId, onSelectChannel, notify }: Props): ReactNode {
  const { state, api, loadHistory, loadOlder, markRead, loadThread } = office;
  const [panel, setPanel] = useState<'members' | 'tasks'>('members');
  const [threadSeq, setThreadSeq] = useState<number | null>(null);
  useEffect(() => setThreadSeq(null), [channelId]);
  const channel = state.org?.channels.find(candidate => candidate.id === channelId);
  const department = state.org?.departments.find(candidate => candidate.id === channel?.departmentId);
  const messages = state.messages[channelId];

  useEffect(() => { if (channel && !messages) void loadHistory(channelId).catch(error => notify(errorText(error))); }, [channel, channelId, messages, loadHistory, notify]);
  useEffect(() => { if (channel) markRead(channelId, channel.lastSeq); }, [channel, channelId, markRead]);

  if (!state.org) return <div className="loading">Loading office…</div>;
  if (!channel) return <div className="chat-layout"><Sidebar state={state} channelId={channelId} onSelect={onSelectChannel} /><main className="chat-main"><p className="empty">Channel not found.</p></main></div>;
  const label = `#${channel.id}`;
  // Mentions only reach channel members, so suggestions are limited to them.
  const members = state.org.seats.filter(seat => channel.memberSeatIds.includes(seat.id));
  const path = `/v1/channels/${encodeURIComponent(channelId)}`;
  const editMessage = async (message: ChatMessage, body: string): Promise<void> => { try { await api.send('PATCH', `${path}/messages/${message.seq}`, { body }); } catch (error) { notify(errorText(error)); throw error; } };
  const deleteMessage = (message: ChatMessage): void => { if (window.confirm('Delete this message?')) api.send('DELETE', `${path}/messages/${message.seq}`).catch(error => notify(errorText(error))); };
  const send = async (body: string, inThread?: number): Promise<void> => {
    try { await api.send('POST', `${path}/messages`, inThread ? { body, threadSeq: inThread } : { body }); } catch (error) { notify(errorText(error)); throw error; }
  };
  const openThread = (message: ChatMessage): void => { setThreadSeq(message.seq); loadThread(channelId, message.seq).catch(error => notify(errorText(error))); };
  const subtitle = channel.kind === 'leaders' ? 'All department leaders' : `${department?.name ?? ''} department${department?.paused ? ' · paused' : ''}`;

  return (
    <div className={`chat-layout ${threadSeq !== null ? 'with-thread' : ''}`}>
      <Sidebar state={state} channelId={channelId} onSelect={onSelectChannel} />
      <main className="chat-main" aria-label={label}>
        <header className="chat-head">
          <h2><span className="hash" style={department ? { color: department.color } : undefined}>#</span>{channel.id}</h2>
          <span className="muted">{subtitle} · {channel.memberSeatIds.length} seats</span>
        </header>
        <MessageList messages={messages ?? []} org={state.org} onLoadOlder={() => loadOlder(channelId)} onEdit={editMessage} onDelete={deleteMessage} onOpenThread={openThread} activeThreadSeq={threadSeq} />
        <Composer channelLabel={label} seats={members} onSend={body => send(body)} />
      </main>
      {threadSeq !== null && <ThreadPanel channelId={channelId} thread={state.threads[threadKey(channelId, threadSeq)]} org={state.org}
        seats={members} onSend={body => send(body, threadSeq)} onEdit={editMessage} onDelete={deleteMessage} onClose={() => setThreadSeq(null)} />}
      <aside className={`detail-panel ${threadSeq !== null ? 'behind-thread' : ''}`} aria-label="Channel details">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={panel === 'members'} className={panel === 'members' ? 'active' : ''} onClick={() => setPanel('members')}>Members</button>
          <button type="button" role="tab" aria-selected={panel === 'tasks'} className={panel === 'tasks' ? 'active' : ''} onClick={() => setPanel('tasks')}>Tasks</button>
        </div>
        <div role="tabpanel">{panel === 'members' ? <MembersPanel state={state} channel={channel} /> : <TasksPanel state={state} channel={channel} api={api} notify={notify} />}</div>
      </aside>
    </div>
  );
}
