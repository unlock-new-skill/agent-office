import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { Department, SeatHandoff, SeatRole } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import { seatStatus, unassignedAgents, type OfficeState } from '../state/office-store.js';
import { SeatRunnerPanel } from './runner-controls.js';
import { SeatCard } from './seat-card.js';

type Props = { department: Department; state: OfficeState; api: Api; notify: (text: string) => void };

export function DepartmentColumn({ department, state, api, notify }: Props): ReactNode {
  const seats = (state.org?.seats ?? []).filter(seat => seat.departmentId === department.id);
  const unassigned = unassignedAgents(state);
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState({ name: department.name, color: department.color, deputySeatId: department.deputySeatId });
  const members = seats.filter(seat => seat.role === 'member');
  const [adding, setAdding] = useState(false); const [seatDraft, setSeatDraft] = useState({ title: '', description: '', role: 'member' as SeatRole });
  const run = (action: Promise<unknown>): void => { action.catch(error => notify(errorText(error))); };

  const saveDepartment = (event: FormEvent): void => { event.preventDefault(); run(api.send('PATCH', `/v1/departments/${department.id}`, draft).then(() => setEditing(false))); };
  const addSeat = (event: FormEvent): void => {
    event.preventDefault();
    run(api.send('POST', `/v1/departments/${department.id}/seats`, seatDraft).then(() => { setAdding(false); setSeatDraft({ title: '', description: '', role: 'member' }); }));
  };

  return (
    <section className="dept-column" style={{ '--dept': department.color } as CSSProperties} aria-label={department.name}>
      <header className="dept-head">
        {editing
          ? <form className="dept-form" onSubmit={saveDepartment}>
              <input aria-label="Department name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} maxLength={80} required />
              <input aria-label="Department color" type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} />
              <select aria-label="Deputy (stands in for the leader)" title="Deputy: joins #leaders and stands in for the leader when the leader is unavailable" value={draft.deputySeatId ?? ''} onChange={event => setDraft({ ...draft, deputySeatId: event.target.value || null })}>
                <option value="">No deputy</option>
                {members.map(seat => <option key={seat.id} value={seat.id}>Deputy: {seat.title}</option>)}
              </select>
              <button type="submit" className="btn btn-small btn-primary">Save</button><button type="button" className="btn btn-small" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          : <>
              <h2><span className="dept-dot" style={{ background: department.color }} />{department.name}</h2>
              <span className="spacer" />
              <button type="button" className={`btn btn-small ${department.paused ? 'btn-warn' : ''}`} aria-pressed={department.paused} onClick={() => run(api.send('PATCH', `/v1/departments/${department.id}`, { paused: !department.paused }))}>{department.paused ? 'Resume' : 'Pause'}</button>
              <button type="button" className="icon-btn" aria-label={`Edit ${department.name}`} onClick={() => { setDraft({ name: department.name, color: department.color, deputySeatId: department.deputySeatId }); setEditing(true); }}>✎</button>
              <button type="button" className="icon-btn" aria-label={`Delete ${department.name}`} onClick={() => { if (window.confirm(`Delete department ${department.name}, its seats, channel, messages and tasks?`)) run(api.send('DELETE', `/v1/departments/${department.id}`)); }}>🗑</button>
            </>}
      </header>
      {department.deputySeatId && !editing && <p className="dept-deputy muted">Deputy: @{department.deputySeatId} — stands in when the leader is unavailable</p>}
      {department.paused && <p className="dept-paused">Paused — seats in this department are not auto-woken.</p>}
      <div className="seat-stack">
        {seats.map(seat => (
          <SeatCard key={seat.id} seat={seat} status={seatStatus(seat, state.agents)} agent={state.agents.find(agent => agent.id === seat.agentId)} unassigned={unassigned}
            onAssign={agentId => run(api.send('PUT', `/v1/seats/${seat.id}/agent`, { agentId }))}
            onSave={patch => run(api.send('PATCH', `/v1/seats/${seat.id}`, patch))}
            loadHandoff={() => api.get<{ handoff: SeatHandoff | null }>(`/v1/seats/${seat.id}/handoff`).then(result => result.handoff).catch(error => { notify(errorText(error)); throw error; })}
            saveHandoff={body => api.send('PUT', `/v1/seats/${seat.id}/handoff`, { body }).then(() => notify(`Handoff note for @${seat.id} saved.`)).catch(error => { notify(errorText(error)); throw error; })}
            onDelete={() => { if (window.confirm(`Delete seat ${seat.title}? Its tasks become unassigned.`)) run(api.send('DELETE', `/v1/seats/${seat.id}`)); }}
            runner={<SeatRunnerPanel seatId={seat.id} title={seat.title} state={state} api={api} notify={notify} />} />
        ))}
      </div>
      {adding
        ? <form className="seat-form add" onSubmit={addSeat}>
            <label>Title<input value={seatDraft.title} onChange={event => setSeatDraft({ ...seatDraft, title: event.target.value })} maxLength={80} required autoFocus /></label>
            <label>Role<select value={seatDraft.role} onChange={event => setSeatDraft({ ...seatDraft, role: event.target.value as SeatRole })}><option value="member">member</option><option value="leader">leader</option></select></label>
            <label>Specialty<textarea rows={2} value={seatDraft.description} onChange={event => setSeatDraft({ ...seatDraft, description: event.target.value })} maxLength={2000} /></label>
            <div className="row-actions"><button type="submit" className="btn btn-primary">Add seat</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
          </form>
        : <button type="button" className="btn btn-block btn-ghost" onClick={() => setAdding(true)}>+ Seat</button>}
    </section>
  );
}
