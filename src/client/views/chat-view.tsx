import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/** Last open thread (`<channel>:<seq>`), per browser, reopened when coming back to that room. */
const THREAD_KEY = 'agent-office.last-thread';
type OpenThread = { channelId: string; seq: number };
const readThread = (channelId: string): OpenThread | null => {
  const fromUrl = Number(new URLSearchParams(location.search).get('thread'));
  if (Number.isInteger(fromUrl) && fromUrl > 0) return { channelId, seq: fromUrl };
  try {
    const [channel, seq] = (localStorage.getItem(THREAD_KEY) ?? '').split(':');
    return channel === channelId && Number.isInteger(Number(seq)) && Number(seq) > 0 ? { channelId, seq: Number(seq) } : null;
  } catch { return null; }
};

type Props = { office: OfficeHandle; channelId: string; onSelectChannel: (channelId: string) => void; notify: (text: string) => void };

export function ChatView({ office, channelId, onSelectChannel, notify }: Props): ReactNode {
  const { state, api, loadHistory, loadOlder, markRead, loadThread } = office;
  const [panel, setPanel] = useState<'members' | 'tasks' | null>(null);
  const [thread, setThread] = useState<OpenThread | null>(() => readThread(channelId));
  useEffect(() => { setThread(current => current?.channelId === channelId ? current : readThread(channelId)); }, [channelId]);
  const threadSeq = thread?.channelId === channelId ? thread.seq : null;
  const setThreadSeq = (seq: number | null): void => setThread(seq === null ? null : { channelId, seq });
  // The open thread lives in the URL (?thread=<seq>) and in storage, so reloads and links reopen it.
  useEffect(() => {
    const url = new URL(location.href);
    if (threadSeq !== null) url.searchParams.set('thread', String(threadSeq)); else url.searchParams.delete('thread');
    if (url.href !== location.href) history.replaceState(history.state, '', url);
    try {
      if (threadSeq !== null) localStorage.setItem(THREAD_KEY, `${channelId}:${threadSeq}`);
      else if (localStorage.getItem(THREAD_KEY)?.startsWith(`${channelId}:`)) localStorage.removeItem(THREAD_KEY);
    } catch { /* storage blocked: the URL still carries the thread */ }
  }, [channelId, threadSeq]);
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [panel]);
  const channel = state.org?.channels.find(candidate => candidate.id === channelId);
  const department = state.org?.departments.find(candidate => candidate.id === channel?.departmentId);
  const messages = state.messages[channelId];

  useEffect(() => { if (channel && !messages) void loadHistory(channelId).catch(error => notify(errorText(error))); }, [channel, channelId, messages, loadHistory, notify]);
  useEffect(() => { if (channel) markRead(channelId, channel.lastSeq); }, [channel, channelId, markRead]);
  const threadLoaded = threadSeq !== null && Boolean(state.threads[threadKey(channelId, threadSeq)]);
  const requestedThread = useRef<string | null>(null);
  useEffect(() => {
    if (!channel || threadSeq === null || threadLoaded || requestedThread.current === threadKey(channelId, threadSeq)) return;
    requestedThread.current = threadKey(channelId, threadSeq);
    // A thread that no longer exists (deleted, wrong link) just closes.
    loadThread(channelId, threadSeq).catch(() => setThread(null));
  }, [channel, channelId, threadSeq, threadLoaded, loadThread]);

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
  const openThread = (message: ChatMessage): void => setThreadSeq(message.seq);
  const subtitle = channel.kind === 'leaders' ? 'All department leaders' : `${department?.name ?? ''} department${department?.paused ? ' · paused' : ''}`;

  return (
    <div className={`chat-layout ${threadSeq !== null ? 'with-thread' : ''}`}>
      <Sidebar state={state} channelId={channelId} onSelect={onSelectChannel} />
      <main className="chat-main" aria-label={label}>
        <header className="chat-head">
          <h2><span className="hash" style={department ? { color: department.color } : undefined}>#</span>{channel.id}</h2>
          <span className="muted">{subtitle} · {channel.memberSeatIds.length} seats</span>
          <span className="chat-head-actions">
            <button type="button" className={`btn btn-small ${panel === 'members' ? 'active' : ''}`} aria-expanded={panel === 'members'} onClick={() => setPanel(panel === 'members' ? null : 'members')}>Members</button>
            <button type="button" className={`btn btn-small ${panel === 'tasks' ? 'active' : ''}`} aria-expanded={panel === 'tasks'} onClick={() => setPanel(panel === 'tasks' ? null : 'tasks')}>Tasks</button>
          </span>
        </header>
        <MessageList messages={messages ?? []} org={state.org} onLoadOlder={() => loadOlder(channelId)} onEdit={editMessage} onDelete={deleteMessage} onOpenThread={openThread} activeThreadSeq={threadSeq} />
        <Composer channelLabel={label} seats={members} onSend={body => send(body)} />
      </main>
      {threadSeq !== null && <ThreadPanel channelId={channelId} thread={state.threads[threadKey(channelId, threadSeq)]} org={state.org}
        seats={members} onSend={body => send(body, threadSeq)} onEdit={editMessage} onDelete={deleteMessage} onClose={() => setThreadSeq(null)} />}
      {panel && <aside className="detail-panel" aria-label="Channel details">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={panel === 'members'} className={panel === 'members' ? 'active' : ''} onClick={() => setPanel('members')}>Members</button>
          <button type="button" role="tab" aria-selected={panel === 'tasks'} className={panel === 'tasks' ? 'active' : ''} onClick={() => setPanel('tasks')}>Tasks</button>
          <button type="button" className="icon-btn detail-close" aria-label="Close panel" onClick={() => setPanel(null)}>✕</button>
        </div>
        <div role="tabpanel">{panel === 'members' ? <MembersPanel state={state} channel={channel} /> : <TasksPanel state={state} channel={channel} api={api} notify={notify} />}</div>
      </aside>}
    </div>
  );
}
