import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentSnapshot, OrgView } from '../../shared/contracts.js';
import { publicMap } from '../api/http.js';
import { initialOfficeState, type OfficeState } from '../state/office-store.js';
import { MapView } from './map-view.js';

const REFRESH_MS = 10_000;

/** The office map for anyone without signing in: read-only, refreshed every few seconds, no session details. */
export function PublicMapView({ onSignIn }: { onSignIn: () => void }): ReactNode {
  const [data, setData] = useState<{ org: OrgView; agents: AgentSnapshot[] } | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const load = (): void => { publicMap().then(next => { if (active) { setData(next); setFailed(false); } }).catch(() => { if (active) setFailed(true); }); };
    load(); const timer = setInterval(load, REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const state = useMemo<OfficeState>(() => ({ ...initialOfficeState, org: data?.org ?? null, agents: data?.agents ?? [], connected: true }), [data]);

  return (
    <div className="app-shell public-map">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>◆</span>Agent Office</div>
        <span className="muted public-badge">Office map · live</span>
        <span className="spacer" />
        {failed && <span className="muted">Reconnecting…</span>}
        <button type="button" className="btn btn-small" onClick={onSignIn}>Sign in</button>
      </header>
      {data ? <MapView state={state} notify={() => undefined} publicView /> : <div className="loading">Loading map…</div>}
    </div>
  );
}
