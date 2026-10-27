import { useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../api/http.js';
import { Composer } from '../components/composer.js';
import { MembersPanel } from '../components/members-panel.js';
import { MessageList } from '../components/message-list.js';
import { Sidebar } from '../components/sidebar.js';
import { TasksPanel } from '../components/tasks-panel.js';
import type { OfficeHandle } from '../state/use-office.js';

type Props = { office: OfficeHandle; channelId: string; onSelectChannel: (channelId: string) => void; notify: (text: string) => void };

export function ChatView({ office, channelId, onSelectChannel, notify }: Props): ReactNode {
  const { state, api, loadHistory, loadOlder, markRead } = office;
  const [panel, setPanel] = useState<'members' | 'tasks'>('members');
  const channel = state.org?.channels.find(candidate => candidate.id === channelId);
  const department = state.org?.departments.find(candidate => candidate.id === channel?.departmentId);
  const messages = state.messages[channelId];

  useEffect(() => { if (channel && !messages) void loadHistory(channelId).catch(error => notify(errorText(error))); }, [channel, channelId, messages, loadHistory, notify]);
  useEffect(() => { if (channel) markRead(channelId, channel.lastSeq); }, [channel, channelId, markRead]);

  if (!state.org) return <div className="loading">Loading office…</div>;
  if (!channel) return <div className="chat-layout"><Sidebar state={state} channelId={channelId} onSelect={onSelectChannel} /><main className="chat-main"><p className="empty">Channel not found.</p></main></div>;
  const label = `#${channel.id}`;
  const subtitle = channel.kind === 'leaders' ? 'All department leaders' : `${department?.name ?? ''} department${department?.paused ? ' · paused' : ''}`;

  return (
    <div className="chat-layout">
      <Sidebar state={state} channelId={channelId} onSelect={onSelectChannel} />
      <main className="chat-main" aria-label={label}>
        <header className="chat-head">
          <h2><span className="hash" style={department ? { color: department.color } : undefined}>#</span>{channel.id}</h2>
          <span className="muted">{subtitle} · {channel.memberSeatIds.length} seats</span>
        </header>
        <MessageList messages={messages ?? []} org={state.org} onLoadOlder={() => loadOlder(channelId)}
          onEdit={async (message, body) => { try { await api.send('PATCH', `/v1/channels/${encodeURIComponent(channelId)}/messages/${message.seq}`, { body }); } catch (error) { notify(errorText(error)); throw error; } }}
          onDelete={message => { if (window.confirm('Delete this message?')) api.send('DELETE', `/v1/channels/${encodeURIComponent(channelId)}/messages/${message.seq}`).catch(error => notify(errorText(error))); }} />
        <Composer channelLabel={label} seats={state.org.seats} onSend={async body => {
          try { await api.send('POST', `/v1/channels/${encodeURIComponent(channelId)}/messages`, { body }); } catch (error) { notify(errorText(error)); throw error; }
        }} />
      </main>
      <aside className="detail-panel" aria-label="Channel details">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={panel === 'members'} className={panel === 'members' ? 'active' : ''} onClick={() => setPanel('members')}>Members</button>
          <button type="button" role="tab" aria-selected={panel === 'tasks'} className={panel === 'tasks' ? 'active' : ''} onClick={() => setPanel('tasks')}>Tasks</button>
        </div>
        <div role="tabpanel">{panel === 'members' ? <MembersPanel state={state} channel={channel} /> : <TasksPanel state={state} channel={channel} api={api} notify={notify} />}</div>
      </aside>
    </div>
  );
}
