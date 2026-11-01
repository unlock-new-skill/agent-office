import type { ReactNode } from 'react';
import { seatStatus, unreadFor, type OfficeState } from '../state/office-store.js';
import { StatusDot } from './status-dot.js';

type Props = { state: OfficeState; channelId: string; onSelect: (channelId: string) => void };

export function Sidebar({ state, channelId, onSelect }: Props): ReactNode {
  const org = state.org; if (!org) return <nav className="sidebar" aria-label="Channels" />;
  const leaders = org.channels.find(channel => channel.kind === 'leaders');
  const outputs = org.channels.find(channel => channel.kind === 'outputs');
  const channelButton = (id: string, label: string, color?: string): ReactNode => {
    const unread = channelId === id ? 0 : unreadFor(state, id);
    return (
      <button type="button" className={`channel-row ${channelId === id ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={() => onSelect(id)} aria-current={channelId === id ? 'page' : undefined}>
        <span className="hash" style={color ? { color } : undefined}>#</span><span className="channel-name">{label}</span>
        {unread > 0 && <span className="badge" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
    );
  };
  return (
    <nav className="sidebar" aria-label="Channels">
      {(leaders || outputs) && <section className="sidebar-group"><h2 className="sidebar-heading">Leadership</h2>{leaders && channelButton(leaders.id, 'leaders')}{outputs && channelButton(outputs.id, 'outputs')}</section>}
      {org.departments.map(department => {
        const seats = org.seats.filter(seat => seat.departmentId === department.id);
        return (
          <section key={department.id} className="sidebar-group">
            <h2 className="sidebar-heading"><span className="dept-dot" style={{ background: department.color }} />{department.name}{department.paused && <span className="pill pill-muted">paused</span>}</h2>
            {channelButton(department.id, department.id, department.color)}
            <ul className="seat-list">
              {seats.map(seat => (
                <li key={seat.id} className="seat-row" title={seat.description || seat.title}>
                  <StatusDot status={seatStatus(seat, state.agents)} />
                  <span className="seat-row-title">{seat.title}</span>
                  {seat.role === 'leader' && <span className="pill pill-leader">lead</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
