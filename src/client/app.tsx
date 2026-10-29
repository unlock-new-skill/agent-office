import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApi, currentSession } from './api/http.js';
import { ApprovalsBar } from './components/approvals-bar.js';
import { Toast } from './components/toast.js';
import { routePath, useRoute, type View } from './router.js';
import { useOffice } from './state/use-office.js';
import { LoginView } from './views/login-view.js';

// Each route is its own chunk, fetched the first time it is opened.
const ChatView = lazy(() => import('./views/chat-view.js').then(module => ({ default: module.ChatView })));
const MapView = lazy(() => import('./views/map-view.js').then(module => ({ default: module.MapView })));
const OrgView = lazy(() => import('./views/org-view.js').then(module => ({ default: module.OrgView })));
const MachinesView = lazy(() => import('./views/machines-view.js').then(module => ({ default: module.MachinesView })));
const RequestsView = lazy(() => import('./views/requests-view.js').then(module => ({ default: module.RequestsView })));
const LandingView = lazy(() => import('./views/landing-view.js').then(module => ({ default: module.LandingView })));
const PublicMapView = lazy(() => import('./views/public-map-view.js').then(module => ({ default: module.PublicMapView })));
const SetupView = lazy(() => import('./views/setup-view.js').then(module => ({ default: module.SetupView })));
const TABS: Array<{ view: View; label: string }> = [{ view: 'chat', label: 'Chat' }, { view: 'map', label: 'Map' }, { view: 'org', label: 'Org' }, { view: 'machines', label: 'Machines' }, { view: 'requests', label: 'Requests' }];
const DEFAULT_CHANNEL = 'leaders';
/** Last opened chat room, per browser, so /chat and the Chat tab return to it. */
const LAST_CHANNEL_KEY = 'agent-office.last-channel';
const readLastChannel = (): string | null => { try { return localStorage.getItem(LAST_CHANNEL_KEY); } catch { return null; } };

export function App(): ReactNode {
  const [csrfToken, setCsrfToken] = useState<string | null | undefined>(undefined); const [signingIn, setSigningIn] = useState(false);
  useEffect(() => { currentSession().then(setCsrfToken).catch(() => setCsrfToken(null)); }, []);
  if (csrfToken === undefined) return <div className="loading">Loading…</div>;
  // /about is the public introduction; it is also what a visitor who is not signed in sees at /.
  const showLanding = !signingIn && (location.pathname === '/about' || (csrfToken === null && location.pathname === '/'));
  if (showLanding) return <Suspense fallback={<div className="loading">Loading…</div>}><LandingView signedIn={csrfToken !== null} onSignIn={() => setSigningIn(true)} /></Suspense>;
  // /map is public: visitors who are not signed in see the read-only office map.
  if (csrfToken === null && location.pathname.startsWith('/map') && !signingIn) return <Suspense fallback={<div className="loading">Loading…</div>}><PublicMapView onSignIn={() => setSigningIn(true)} /></Suspense>;
  if (csrfToken === null) return <LoginView onLogin={setCsrfToken} />;
  return <Workspace csrfToken={csrfToken} onSignedOut={() => setCsrfToken(null)} />;
}

function Workspace({ csrfToken, onSignedOut }: { csrfToken: string; onSignedOut: () => void }): ReactNode {
  const api = useMemo(() => createApi(csrfToken, onSignedOut), [csrfToken, onSignedOut]);
  const office = useOffice(api);
  const { route, navigate, link } = useRoute();
  // Normalise "/" and unknown paths to their canonical URL without adding a history entry.
  useEffect(() => { if (location.pathname !== routePath(route)) navigate(route, { replace: true }); }, [route, navigate]);
  const [lastChannel, setLastChannel] = useState(readLastChannel);
  useEffect(() => {
    if (route.view !== 'chat' || !route.channelId) return;
    setLastChannel(route.channelId);
    try { localStorage.setItem(LAST_CHANNEL_KEY, route.channelId); } catch { /* storage blocked: only this visit remembers */ }
  }, [route]);
  const channels = office.state.org?.channels;
  const rememberedChannel = lastChannel && (!channels || channels.some(channel => channel.id === lastChannel)) ? lastChannel : DEFAULT_CHANNEL;
  const channelId = route.channelId ?? rememberedChannel;
  // "/chat" opens the remembered room and shows it in the URL.
  useEffect(() => { if (route.view === 'chat' && !route.channelId && channels) navigate({ view: 'chat', channelId: rememberedChannel }, { replace: true }); }, [route, channels, rememberedChannel, navigate]);
  const openRequests = Object.values(office.state.tasks).filter(task => task.requesterSeatId && task.status !== 'done').length;
  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((text: string) => setToast(text), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  const seated = office.state.org?.seats.filter(seat => seat.agentId).length ?? 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>◆</span>Agent Office</div>
        <nav className="view-tabs" aria-label="Views">
          {TABS.map(tab => (
            <a key={tab.view} {...link(tab.view === 'chat' ? { view: 'chat', channelId: route.view === 'chat' ? route.channelId : rememberedChannel } : { view: tab.view, channelId: null })}
              className={route.view === tab.view ? 'active' : ''} aria-current={route.view === tab.view ? 'page' : undefined}>
              {tab.label}{tab.view === 'requests' && openRequests > 0 ? ` (${openRequests})` : ''}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <a {...link({ view: 'setup', channelId: null })} className={`btn btn-small btn-primary connect-link ${route.view === 'setup' ? 'active' : ''}`} aria-current={route.view === 'setup' ? 'page' : undefined}>Connect machine</a>
        <span className="muted">{seated}/{office.state.org?.seats.length ?? 0} seats filled</span>
        <span className={`conn ${office.state.connected ? 'on' : 'off'}`}>{office.state.connected ? 'live' : 'reconnecting…'}</span>
        <button type="button" className="btn btn-small" onClick={() => void api.send('POST', '/v1/auth/logout').finally(onSignedOut)}>Sign out</button>
      </header>
      <ApprovalsBar pending={office.state.permissions} api={api} notify={notify} />
      <Suspense fallback={<div className="loading">Loading…</div>}>
        {route.view === 'chat' && <ChatView office={office} channelId={channelId} onSelectChannel={id => navigate({ view: 'chat', channelId: id })} notify={notify} />}
        {route.view === 'map' && <MapView state={office.state} notify={notify} onDismiss={office.dismissAgent} onResetWakes={seatId => api.send('POST', `/v1/seats/${seatId}/reset-wakes`).then(() => undefined)} />}
        {route.view === 'org' && <OrgView state={office.state} api={api} notify={notify} onDismiss={office.dismissAgent} />}
        {route.view === 'machines' && <MachinesView state={office.state} api={api} notify={notify} />}
        {route.view === 'requests' && <RequestsView state={office.state} />}
        {route.view === 'setup' && <SetupView state={office.state} api={api} notify={notify} />}
      </Suspense>
      <Toast text={toast} onClose={() => setToast(null)} />
    </div>
  );
}
