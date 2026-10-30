import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { joinPrompt } from '../../shared/join.js';
import { errorText } from '../api/http.js';
import { sessionLabel } from '../components/seat-card.js';
import { StatusDot } from '../components/status-dot.js';
import { hitTest, layoutOffice } from '../map/office-map-layout.js';
import { paintOffice, type PaintInput, type SeatSprite } from '../map/office-map-painter.js';
import { SEAT_STATUS_LABEL, seatStatus, unassignedAgents, workLabel, type OfficeState, type SeatStatus } from '../state/office-store.js';
import type { TimeOfDay } from '../map3d/day-night.js';
import type { Task } from '../../shared/contracts.js';
import { Map3DStage } from './map-3d-stage.js';

/** publicView: the anonymous /map (no session names, no actions). onDismiss hides a lobby session. */
type Props = { state: OfficeState; notify: (text: string) => void; publicView?: boolean; onDismiss?: (agentId: string) => Promise<void>; onResetWakes?: (seatId: string) => Promise<void> };
type Target = { seatId: string } | { agentId: string };
const LEGEND: SeatStatus[] = ['working', 'listening', 'blocked', 'idle', 'wake_limited', 'offline', 'vacant'];
const STATUS_ORDER: Record<Task['status'], number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
const taskLine = (task: Task): string => `${task.id} ${task.title}`;
/** Open tasks of a seat, in progress first; the current one is the latest doing (or blocked) task. */
const seatTasks = (tasks: Record<string, Task>, seatId: string): Task[] => Object.values(tasks)
  .filter(task => task.assigneeSeatId === seatId && task.status !== 'done')
  .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt);
const queueLabel = (open: Task[], current: Task | undefined): string | undefined => {
  const rest = open.filter(task => task !== current);
  if (rest.length === 0) return undefined;
  const count = (status: Task['status']): number => rest.filter(task => task.status === status).length;
  const minutes = open.reduce((total, task) => total + (task.estimateMinutes ?? 0), 0);
  return [count('todo') && `${count('todo')} todo`, count('blocked') && `${count('blocked')} blocked`, count('doing') && `${count('doing')} more doing`, minutes > 0 && `⏱ ${workLabel(minutes * 60_000)} left`].filter(Boolean).join(' · ');
};
const keyOf = (target: Target | null): string | null => target ? ('seatId' in target ? target.seatId : target.agentId) : null;
/** 3D rooms are laid out on a fixed-width grid (about three rooms per row, three tiles apart); the camera does the fitting. */
const LAYOUT_WIDTH_3D = 760; const ROOM_GAP_3D = 48;
type Mode = '3d' | '2d';
const MODE_KEY = 'agent-office.map-mode';
const savedMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === '2d' ? '2d' : '3d'; } catch { return '3d'; } };
const TIME_KEY = 'agent-office.time-of-day';
const TIMES: Array<{ value: TimeOfDay; label: string; title: string }> = [
  { value: 'auto', label: 'Auto', title: 'Follow your local time' }, { value: 'day', label: '☀ Day', title: 'Always daytime' }, { value: 'night', label: '☾ Night', title: 'Always night' },
];
const savedTime = (): TimeOfDay => { try { const value = localStorage.getItem(TIME_KEY); return value === 'day' || value === 'night' ? value : 'auto'; } catch { return 'auto'; } };

/** Office map, 3D (Three.js, default) or 2D pixel canvas: one room per department, a desk per seat, agents with live status. */
export function MapView({ state, notify, publicView = false, onDismiss, onResetWakes }: Props): ReactNode {
  const host = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0); const [hover, setHover] = useState<{ target: Target; x: number; y: number } | null>(null); const [selected, setSelected] = useState<Target | null>(null);
  const scale = width >= 1200 ? 3 : 2;
  const [mode, setModeState] = useState<Mode>(savedMode);
  const [timeOfDay, setTimeState] = useState<TimeOfDay>(savedTime);
  const [resetView, setResetView] = useState(0);
  const setTimeOfDay = (next: TimeOfDay): void => { setTimeState(next); try { localStorage.setItem(TIME_KEY, next); } catch { /* preference is optional */ } };
  const setMode = (next: Mode): void => { setModeState(next); setHover(null); try { localStorage.setItem(MODE_KEY, next); } catch { /* preference is optional */ } };

  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const seats = useMemo(() => state.org?.seats ?? [], [state.org]);
  const lobbyAgents = useMemo(() => unassignedAgents(state), [state]);
  const layout = useMemo(() => layoutOffice(state.org?.departments ?? [], seats, lobbyAgents.map(agent => agent.id), mode === '3d' ? LAYOUT_WIDTH_3D : Math.max(width / scale, 120), mode === '3d' ? ROOM_GAP_3D : undefined), [state.org, seats, lobbyAgents, width, scale, mode]);
  const leaders = useMemo(() => new Set(seats.filter(seat => seat.role === 'leader').map(seat => seat.id)), [seats]);
  const sprites = useMemo(() => new Map<string, SeatSprite>(seats.map(seat => {
    const model = state.agents.find(agent => agent.id === seat.agentId)?.model;
    const detail = [model, seat.workMs > 0 ? workLabel(seat.workMs) : null].filter(Boolean).join(' · ');
    // Task titles stay off the public map.
    const open = publicView ? [] : seatTasks(state.tasks, seat.id); const current = open.find(task => task.status === 'doing' || task.status === 'blocked');
    const queue = queueLabel(open, current);
    return [seat.id, { title: seat.title, status: seatStatus(seat, state.agents), ...(detail ? { detail } : {}),
      ...(current ? { task: { text: `${current.status === 'blocked' ? '⏸' : '▶'} ${taskLine(current)}`, blocked: current.status === 'blocked' } } : {}), ...(queue ? { queue } : {}) }];
  })), [seats, state.agents, state.tasks, publicView]);
  const lobbyLabels = useMemo(() => new Map(lobbyAgents.map(agent => [agent.id, publicView ? 'Claude session' : sessionLabel(agent)])), [lobbyAgents, publicView]);

  // The animation loop reads the latest frame input from a ref so React renders never restart it.
  const frame = useRef<Omit<PaintInput, 'time'>>({ layout, seats: sprites, lobbyLabels, hovered: null, selected: null });
  frame.current = { layout, seats: sprites, lobbyLabels, hovered: keyOf(hover?.target ?? null), selected: keyOf(selected) };
  useEffect(() => {
    if (mode !== '2d') return;
    const element = canvas.current; const context = element?.getContext('2d'); if (!element || !context) return;
    let handle = 0;
    const draw = (time: number): void => {
      const { layout: current } = frame.current; const ratio = window.devicePixelRatio || 1;
      const cssWidth = current.width * scale; const cssHeight = current.height * scale;
      if (element.width !== Math.round(cssWidth * ratio) || element.height !== Math.round(cssHeight * ratio)) {
        element.width = Math.round(cssWidth * ratio); element.height = Math.round(cssHeight * ratio);
        element.style.width = `${cssWidth}px`; element.style.height = `${cssHeight}px`;
      }
      context.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
      handle = requestAnimationFrame(draw);
      paintOffice(context, { ...frame.current, time });
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [scale, mode]);

  const targetAt = (event: MouseEvent<HTMLCanvasElement>): Target | null => {
    const box = event.currentTarget.getBoundingClientRect();
    return hitTest(layout, (event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
  };
  const onMove = (event: MouseEvent<HTMLCanvasElement>): void => {
    const target = targetAt(event); const box = host.current?.getBoundingClientRect();
    setHover(target && box ? { target, x: event.clientX - box.left + host.current!.scrollLeft, y: event.clientY - box.top + host.current!.scrollTop } : null);
  };

  const describe = (target: Target): { title: string; lines: string[]; status: SeatStatus | null; seat: { id: string; title: string } | null; tasks?: Task[] } => {
    if ('agentId' in target) {
      const agent = state.agents.find(candidate => candidate.id === target.agentId);
      if (publicView) return { title: 'Claude session', status: null, seat: null, lines: [`Waiting for a seat · ${agent?.state ?? 'unknown'}`] };
      return { title: agent ? sessionLabel(agent) : target.agentId, status: null, seat: null, lines: [`Unseated session · ${agent?.state ?? 'unknown'}${agent?.currentTool ? ` · ${agent.currentTool}` : ''}`, 'Assign it in Org or paste a join link into it.'] };
    }
    const seat = seats.find(candidate => candidate.id === target.seatId);
    if (!seat) return { title: target.seatId, lines: [], status: null, seat: null };
    const agent = state.agents.find(candidate => candidate.id === seat.agentId); const status = seatStatus(seat, state.agents);
    const department = state.org?.departments.find(candidate => candidate.id === seat.departmentId);
    const open = publicView ? [] : seatTasks(state.tasks, seat.id); const current = open.find(task => task.status === 'doing' || task.status === 'blocked');
    return {
      title: seat.title, status, seat, tasks: open,
      lines: [`@${seat.id} · ${seat.role} of ${department?.name ?? seat.departmentId}`, `Status: ${SEAT_STATUS_LABEL[status]}`, ...(current ? [`${current.status === 'blocked' ? 'Blocked on' : 'Working on'}: ${taskLine(current)}`] : []), ...(agent?.model ? [`Model: ${agent.model}`] : []), `Worked: ${seat.workMs > 0 ? workLabel(seat.workMs) : '—'}`, agent ? (publicView ? `Agent active${agent.currentTool ? ` · running ${agent.currentTool}` : ''}` : `Session: ${sessionLabel(agent)}${agent.currentTool ? ` · running ${agent.currentTool}` : ''}`) : 'No session', ...(seat.description ? [seat.description] : [])],
    };
  };
  const detail = selected ? describe(selected) : null; const tip = hover ? describe(hover.target) : null;
  const counts = LEGEND.map(status => [status, seats.filter(seat => seatStatus(seat, state.agents) === status).length] as const);
  const copyJoin = (seat: { id: string; title: string }): void => {
    const prompt = joinPrompt(location.origin, seat);
    navigator.clipboard.writeText(prompt).then(() => notify('Join prompt copied.')).catch(() => window.prompt('Copy this join prompt:', prompt));
  };

  return (
    <div className="map-view">
      <div className="map-legend" aria-label="Status legend">
        {counts.map(([status, count]) => <span key={status} className="map-legend-item"><StatusDot status={status} />{SEAT_STATUS_LABEL[status]} <strong>{count}</strong></span>)}
        <span className="spacer" />
        <span className="map-mode" role="group" aria-label="Map style">
          <button type="button" className={mode === '3d' ? 'active' : ''} aria-pressed={mode === '3d'} onClick={() => setMode('3d')}>3D</button>
          <button type="button" className={mode === '2d' ? 'active' : ''} aria-pressed={mode === '2d'} onClick={() => setMode('2d')}>2D</button>
        </span>
        {mode === '3d' && <span className="map-mode" role="group" aria-label="Time of day">
          {TIMES.map(time => <button key={time.value} type="button" title={time.title} className={timeOfDay === time.value ? 'active' : ''} aria-pressed={timeOfDay === time.value} onClick={() => setTimeOfDay(time.value)}>{time.label}</button>)}
        </span>}
        {mode === '3d' && <button type="button" className="btn btn-small" title="Back to the whole office" onClick={() => setResetView(count => count + 1)}>⟲ Reset view</button>}
        {mode === '3d' && <span className="muted map-hint">double-click: center there · drag: rotate · wheel: zoom · right-drag / arrows: pan</span>}
      </div>
      <div className={`map-stage ${mode === '3d' ? 'is-3d' : ''}`} ref={host} onMouseLeave={() => setHover(null)}>
        {mode === '3d'
          ? <Map3DStage layout={layout} seats={sprites} leaders={leaders} lobbyLabels={lobbyLabels} hovered={keyOf(hover?.target ?? null)} selected={keyOf(selected)} timeOfDay={timeOfDay} resetView={resetView}
              onHover={(target, x, y) => setHover(target ? { target, x, y } : null)} onSelect={setSelected} onUnavailable={() => { setMode('2d'); notify('3D is not available in this browser; showing the 2D map.'); }} />
          : <canvas ref={canvas} className="map-canvas" role="img" aria-label={`Office map: ${counts.filter(([, count]) => count > 0).map(([status, count]) => `${count} ${SEAT_STATUS_LABEL[status]}`).join(', ')}`}
          onMouseMove={onMove} onClick={event => setSelected(targetAt(event))} style={{ cursor: hover ? 'pointer' : 'default' }} />}
        {tip && hover && !selected && <div className="map-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}><strong>{tip.title}</strong>{tip.lines.slice(0, 3).map(line => <span key={line}>{line}</span>)}</div>}
      </div>
      {detail && (
        <aside className="map-detail" aria-label="Selected seat">
          <header>{detail.status && <StatusDot status={detail.status} />}<strong>{detail.title}</strong><span className="spacer" /><button type="button" className="icon-btn" aria-label="Close" onClick={() => setSelected(null)}>✕</button></header>
          {detail.lines.map(line => <p key={line}>{line}</p>)}
          {detail.tasks && detail.tasks.length > 0 && <section className="map-tasks" aria-label="Open tasks">
            <h3>Tasks <span className="muted">{detail.tasks.length} open</span></h3>
            <ul>{detail.tasks.map(task => (
              <li key={task.id} className={`map-task status-${task.status}`}>
                <span className="map-task-head"><span className="map-task-status">{task.status}</span><code>{task.id}</code>{task.estimateMinutes !== null ? <span className="muted">⏱ {workLabel(task.estimateMinutes * 60_000)}</span> : <span className="task-no-estimate">no estimate</span>}</span>
                <span className="map-task-title">{task.title}</span>
                {task.dependsOn.length > 0 && <span className="muted">after {task.dependsOn.join(', ')}</span>}
              </li>))}
            </ul>
          </section>}
          {detail.seat && !publicView && <div className="row-actions">
            <button type="button" className="btn btn-small" onClick={() => copyJoin(detail.seat!)}>Copy join</button>
            {detail.status === 'wake_limited' && onResetWakes && <button type="button" className="btn btn-small btn-warn" onClick={() => { const seatId = detail.seat!.id; onResetWakes(seatId).then(() => notify(`@${seatId} can be woken again.`)).catch(error => notify(errorText(error))); }}>Reset wake limit</button>}
          </div>}
          {selected && 'agentId' in selected && !publicView && onDismiss && <div className="row-actions"><button type="button" className="btn btn-small" title="Hide from the lobby until this session starts again" onClick={() => { const agentId = selected.agentId; onDismiss(agentId).then(() => setSelected(null)).catch(error => notify(errorText(error))); }}>Dismiss</button></div>}
        </aside>
      )}
    </div>
  );
}
