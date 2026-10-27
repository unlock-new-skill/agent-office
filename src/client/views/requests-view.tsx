import type { ReactNode } from 'react';
import type { Task } from '../../shared/contracts.js';
import type { OfficeState } from '../state/office-store.js';

type Props = { state: OfficeState };
/** Open requests older than this are flagged: a leader in the chain is probably stuck. */
const STALE_MS = 2 * 3_600_000;

const age = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
};

/** Cross-department board: tasks one department is doing for another department's leader, oldest open first. */
export function RequestsView({ state }: Props): ReactNode {
  const departmentName = (id: string | undefined): string => state.org?.departments.find(department => department.id === id)?.name ?? id ?? '—';
  const seatDepartment = (seatId: string | null): string | undefined => state.org?.seats.find(seat => seat.id === seatId)?.departmentId;
  const requests = Object.values(state.tasks).filter((task): task is Task & { requesterSeatId: string } => Boolean(task.requesterSeatId));
  const open = requests.filter(task => task.status !== 'done').sort((a, b) => a.createdAt - b.createdAt);
  const done = requests.filter(task => task.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  const now = Date.now();
  const rows = (tasks: Task[]): ReactNode => tasks.map(task => (
    <tr key={task.id} className={task.status !== 'done' && now - task.createdAt > STALE_MS ? 'stale' : ''}>
      <td><code>{task.id}</code></td>
      <td>{task.title}</td>
      <td>{departmentName(seatDepartment(task.requesterSeatId))} <span className="muted">@{task.requesterSeatId}</span></td>
      <td>{departmentName(task.departmentId)}</td>
      <td className="hide-narrow">{task.assigneeSeatId ? `@${task.assigneeSeatId}` : '—'}</td>
      <td><span className={`status-pill ${task.status}`}>{task.status}</span></td>
      <td>{age((task.status === 'done' ? task.updatedAt : now) - task.createdAt)}</td>
    </tr>
  ));
  const table = (tasks: Task[]): ReactNode => (
    <table className="requests-table">
      <thead><tr><th>Task</th><th>Request</th><th>From</th><th>To</th><th className="hide-narrow">Assignee</th><th>Status</th><th>Age</th></tr></thead>
      <tbody>{rows(tasks)}</tbody>
    </table>
  );

  return (
    <div className="requests-view">
      <section className="tray" aria-label="Open cross-department requests">
        <h2>Open requests <span className="muted">— tasks created with requestedBy; the asking leader is told automatically on blocked/done. Open longer than 2h is highlighted.</span></h2>
        {open.length ? table(open) : <p className="muted">No open cross-department requests.</p>}
      </section>
      {done.length > 0 && <section className="tray" aria-label="Recently completed requests"><h2>Recently done</h2>{table(done)}</section>}
    </div>
  );
}
