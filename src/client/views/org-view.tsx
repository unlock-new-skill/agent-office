import { useState, type FormEvent, type ReactNode } from 'react';
import { errorText, type Api } from '../api/http.js';
import { AGENT_DRAG_TYPE, sessionLabel } from '../components/seat-card.js';
import { DepartmentColumn } from '../components/department-column.js';
import { unassignedAgents, type OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState; api: Api; notify: (text: string) => void; onDismiss: (agentId: string) => Promise<void> };

export function OrgView({ state, api, notify, onDismiss }: Props): ReactNode {
  const unassigned = unassignedAgents(state);
  const [adding, setAdding] = useState(false); const [draft, setDraft] = useState({ name: '', color: '#64748b' });
  const addDepartment = (event: FormEvent): void => {
    event.preventDefault();
    api.send('POST', '/v1/departments', draft).then(() => { setAdding(false); setDraft({ name: '', color: '#64748b' }); }).catch(error => notify(errorText(error)));
  };

  return (
    <div className="org-view">
      <section className="tray" aria-label="Unassigned sessions">
        <h2>Unassigned sessions <span className="muted">— drag onto a seat, or use a seat's “Assign session…” menu; ✕ hides one until it starts again. Sessions quiet for 5 minutes drop off.</span></h2>
        {unassigned.length === 0
          ? <p className="muted">No unseated Claude Code sessions. Connect a machine with <strong>Connect machine</strong> (top bar), then start <code>claude</code> there and it appears here.</p>
          : <ul className="session-tray">
              {unassigned.map(agent => (
                <li key={agent.id} className="session-card" draggable onDragStart={event => { event.dataTransfer.setData(AGENT_DRAG_TYPE, agent.id); event.dataTransfer.effectAllowed = 'link'; }} title={agent.project}>
                  <strong>{sessionLabel(agent)}</strong><span className="muted">{agent.state}{agent.currentTool ? ` · ${agent.currentTool}` : ''}</span>
                  <button type="button" className="icon-btn" aria-label={`Dismiss ${sessionLabel(agent)} from the lobby`} title="Hide until this session starts again" onClick={() => { onDismiss(agent.id).catch(error => notify(errorText(error))); }}>✕</button>
                </li>
              ))}
            </ul>}
      </section>
      <div className="dept-grid">
        {(state.org?.departments ?? []).map(department => <DepartmentColumn key={department.id} department={department} state={state} api={api} notify={notify} />)}
        <section className="dept-column add-dept">
          {adding
            ? <form className="seat-form" onSubmit={addDepartment}>
                <label>Department name<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} maxLength={80} required autoFocus /></label>
                <label>Color<input type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label>
                <div className="row-actions"><button type="submit" className="btn btn-primary">Create</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
              </form>
            : <button type="button" className="btn btn-block btn-ghost" onClick={() => setAdding(true)}>+ Department</button>}
        </section>
      </div>
    </div>
  );
}
