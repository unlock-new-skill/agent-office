import type { ReactNode } from 'react';
import type { Channel } from '../../shared/contracts.js';
import { SEAT_STATUS_LABEL, seatStatus, type OfficeState } from '../state/office-store.js';
import { StatusDot } from './status-dot.js';

export function MembersPanel({ state, channel }: { state: OfficeState; channel: Channel }): ReactNode {
  const seats = (state.org?.seats ?? []).filter(seat => channel.memberSeatIds.includes(seat.id));
  return (
    <ul className="member-list">
      {seats.map(seat => {
        const status = seatStatus(seat, state.agents); const agent = state.agents.find(candidate => candidate.id === seat.agentId);
        const department = state.org?.departments.find(candidate => candidate.id === seat.departmentId);
        return (
          <li key={seat.id} className="member">
            <div className="member-head"><StatusDot status={status} /><strong>{seat.title}</strong>{seat.role === 'leader' && <span className="pill pill-leader">lead</span>}</div>
            <div className="member-meta">@{seat.id}{channel.kind === 'leaders' && department ? ` · ${department.name}` : ''}</div>
            <div className="member-status">{SEAT_STATUS_LABEL[status]}{agent?.currentTool ? ` · ${agent.currentTool}` : ''}{seat.consecutiveWakes > 0 ? ` · ${seat.consecutiveWakes} auto-wakes` : ''}</div>
            {seat.description && <p className="member-desc">{seat.description}</p>}
          </li>
        );
      })}
    </ul>
  );
}
