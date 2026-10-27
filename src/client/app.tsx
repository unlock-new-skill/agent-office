import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApi, currentSession } from './api/http.js';
import { AddMachinePanel } from './components/add-machine-panel.js';
import { ApprovalsBar } from './components/approvals-bar.js';
import { Toast } from './components/toast.js';
import { useOffice } from './state/use-office.js';
import { ChatView } from './views/chat-view.js';
import { LoginView } from './views/login-view.js';
import { OrgView } from './views/org-view.js';
import { RequestsView } from './views/requests-view.js';

export function App(): ReactNode {
  const [csrfToken, setCsrfToken] = useState<string | null | undefined>(undefined);
  useEffect(() => { currentSession().then(setCsrfToken).catch(() => setCsrfToken(null)); }, []);
  if (csrfToken === undefined) return <div className="loading">Loading…</div>;
  if (csrfToken === null) return <LoginView onLogin={setCsrfToken} />;
  return <Workspace csrfToken={csrfToken} onSignedOut={() => setCsrfToken(null)} />;
}

function Workspace({ csrfToken, onSignedOut }: { csrfToken: string; onSignedOut: () => void }): ReactNode {
  const api = useMemo(() => createApi(csrfToken, onSignedOut), [csrfToken, onSignedOut]);
  const office = useOffice(api);
  const [view, setView] = useState<'chat' | 'org' | 'requests'>('chat');
  const openRequests = Object.values(office.state.tasks).filter(task => task.requesterSeatId && task.status !== 'done').length;
  const [channelId, setChannelId] = useState('leaders');
  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((text: string) => setToast(text), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  const seated = office.state.org?.seats.filter(seat => seat.agentId).length ?? 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>◆</span>Agent Office</div>
        <nav className="view-tabs" aria-label="Views">
          <button type="button" className={view === 'chat' ? 'active' : ''} aria-current={view === 'chat' ? 'page' : undefined} onClick={() => setView('chat')}>Chat</button>
          <button type="button" className={view === 'org' ? 'active' : ''} aria-current={view === 'org' ? 'page' : undefined} onClick={() => setView('org')}>Org</button>
          <button type="button" className={view === 'requests' ? 'active' : ''} aria-current={view === 'requests' ? 'page' : undefined} onClick={() => setView('requests')}>Requests{openRequests > 0 ? ` (${openRequests})` : ''}</button>
        </nav>
        <span className="spacer" />
        <AddMachinePanel api={api} notify={notify} />
        <span className="muted">{seated}/{office.state.org?.seats.length ?? 0} seats filled</span>
        <span className={`conn ${office.state.connected ? 'on' : 'off'}`}>{office.state.connected ? 'live' : 'reconnecting…'}</span>
        <button type="button" className="btn btn-small" onClick={() => void api.send('POST', '/v1/auth/logout').finally(onSignedOut)}>Sign out</button>
      </header>
      <ApprovalsBar pending={office.state.permissions} api={api} notify={notify} />
      {view === 'chat' && <ChatView office={office} channelId={channelId} onSelectChannel={setChannelId} notify={notify} />}
      {view === 'org' && <OrgView state={office.state} api={api} notify={notify} />}
      {view === 'requests' && <RequestsView state={office.state} />}
      <Toast text={toast} onClose={() => setToast(null)} />
    </div>
  );
}
