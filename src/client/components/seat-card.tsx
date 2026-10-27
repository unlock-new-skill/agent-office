import { useCallback, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import type { AgentSnapshot, Seat, SeatHandoff, SeatRole } from '../../shared/contracts.js';
import { HandoffEditor } from './handoff-editor.js';
import { joinPrompt } from '../../shared/join.js';
import { SEAT_STATUS_LABEL, type SeatStatus } from '../state/office-store.js';
import { StatusDot } from './status-dot.js';

export const AGENT_DRAG_TYPE = 'application/x-agent-office-agent';
type Props = {
  seat: Seat; status: SeatStatus; agent: AgentSnapshot | undefined; unassigned: AgentSnapshot[];
  onAssign: (agentId: string | null) => void; onSave: (patch: { title: string; description: string; role: SeatRole }) => void; onDelete: () => void;
  loadHandoff: () => Promise<SeatHandoff | null>; saveHandoff: (body: string) => Promise<void>;
};
export const sessionLabel = (agent: AgentSnapshot): string => `${agent.project.split('/').filter(Boolean).at(-1) ?? agent.project} · ${agent.sessionId.slice(0, 8)}`;

export function SeatCard({ seat, status, agent, unassigned, onAssign, onSave, onDelete, loadHandoff, saveHandoff }: Props): ReactNode {
  const [editing, setEditing] = useState(false); const [handoffOpen, setHandoffOpen] = useState(false);
  const closeHandoff = useCallback(() => setHandoffOpen(false), []); const [over, setOver] = useState(false); const [copied, setCopied] = useState(false);
  const copyJoin = (): void => {
    const prompt = joinPrompt(location.origin, seat);
    navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => window.prompt('Copy this join prompt into a Claude Code session:', prompt));
  };
  const [draft, setDraft] = useState({ title: seat.title, description: seat.description, role: seat.role });
  const onDrop = (event: DragEvent): void => { event.preventDefault(); setOver(false); const agentId = event.dataTransfer.getData(AGENT_DRAG_TYPE); if (agentId) onAssign(agentId); };
  const save = (event: FormEvent): void => { event.preventDefault(); onSave(draft); setEditing(false); };

  return (
    <article className={`seat-card ${seat.role} ${over ? 'drop-over' : ''} ${seat.agentId ? 'filled' : 'vacant'}`}
      onDragOver={event => { if (event.dataTransfer.types.includes(AGENT_DRAG_TYPE)) { event.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      {handoffOpen
        ? <HandoffEditor seatTitle={seat.title} load={loadHandoff} save={saveHandoff} onClose={closeHandoff} />
        : editing
        ? <form className="seat-form" onSubmit={save}>
            <label>Title<input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} maxLength={80} required /></label>
            <label>Role<select value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as SeatRole })}><option value="member">member</option><option value="leader">leader</option></select></label>
            <label>Specialty<textarea rows={3} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} maxLength={2000} /></label>
            <div className="row-actions"><button type="submit" className="btn btn-primary">Save</button><button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button></div>
          </form>
        : <>
            <header className="seat-card-head">
              <span className="seat-title"><StatusDot status={status} /><strong>{seat.title}</strong>{seat.role === 'leader' && <span className="pill pill-leader">lead</span>}</span>
              <span className="seat-actions">
              <button type="button" className="btn btn-small" onClick={copyJoin} title={`Copies a prompt that makes a Claude Code session join @${seat.id}. Or start one with AGENT_OFFICE_SEAT=${seat.id} claude`}>{copied ? 'Copied' : 'Copy join'}</button>
              <button type="button" className="btn btn-small" onClick={() => setHandoffOpen(true)} title="Handoff note a new session on this seat starts from">Note</button>
              <button type="button" className="icon-btn" aria-label={`Edit ${seat.title}`} onClick={() => { setDraft({ title: seat.title, description: seat.description, role: seat.role }); setEditing(true); }}>✎</button>
              <button type="button" className="icon-btn" aria-label={`Delete ${seat.title}`} onClick={onDelete}>🗑</button>
              </span>
            </header>
            <div className="seat-handle">@{seat.id} · {SEAT_STATUS_LABEL[status]}</div>
            {seat.description && <p className="seat-desc">{seat.description}</p>}
            {seat.agentId
              ? <div className="seat-session"><span className="session-chip">{agent ? sessionLabel(agent) : seat.agentId}</span><button type="button" className="btn btn-small" onClick={() => onAssign(null)}>Unassign</button></div>
              : <label className="seat-assign"><span className="sr-only">Assign session to {seat.title}</span>
                  <select value="" onChange={event => event.target.value && onAssign(event.target.value)} disabled={unassigned.length === 0}>
                    <option value="">{unassigned.length ? 'Assign session… (or drop here)' : 'Drop a session here'}</option>
                    {unassigned.map(candidate => <option key={candidate.id} value={candidate.id}>{sessionLabel(candidate)}</option>)}
                  </select></label>}
          </>}
    </article>
  );
}
