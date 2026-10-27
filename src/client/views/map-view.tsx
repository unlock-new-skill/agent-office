import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { joinPrompt } from '../../shared/join.js';
import { sessionLabel } from '../components/seat-card.js';
import { StatusDot } from '../components/status-dot.js';
import { hitTest, layoutOffice } from '../map/office-map-layout.js';
import { paintOffice, type PaintInput, type SeatSprite } from '../map/office-map-painter.js';
import { SEAT_STATUS_LABEL, seatStatus, unassignedAgents, type OfficeState, type SeatStatus } from '../state/office-store.js';

type Props = { state: OfficeState; notify: (text: string) => void };
type Target = { seatId: string } | { agentId: string };
const LEGEND: SeatStatus[] = ['working', 'listening', 'blocked', 'idle', 'wake_limited', 'offline', 'vacant'];
const keyOf = (target: Target | null): string | null => target ? ('seatId' in target ? target.seatId : target.agentId) : null;

/** Pixel office: one room per department, a desk per seat, agents drawn with their live status. */
export function MapView({ state, notify }: Props): ReactNode {
  const host = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0); const [hover, setHover] = useState<{ target: Target; x: number; y: number } | null>(null); const [selected, setSelected] = useState<Target | null>(null);
  const scale = width >= 1200 ? 3 : 2;

  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const seats = useMemo(() => state.org?.seats ?? [], [state.org]);
  const lobbyAgents = useMemo(() => unassignedAgents(state), [state]);
  const layout = useMemo(() => layoutOffice(state.org?.departments ?? [], seats, lobbyAgents.map(agent => agent.id), Math.max(width / scale, 120)), [state.org, seats, lobbyAgents, width, scale]);
  const sprites = useMemo(() => new Map<string, SeatSprite>(seats.map(seat => [seat.id, { title: seat.title, status: seatStatus(seat, state.agents) }])), [seats, state.agents]);
  const lobbyLabels = useMemo(() => new Map(lobbyAgents.map(agent => [agent.id, sessionLabel(agent)])), [lobbyAgents]);

  // The animation loop reads the latest frame input from a ref so React renders never restart it.
  const frame = useRef<Omit<PaintInput, 'time'>>({ layout, seats: sprites, lobbyLabels, hovered: null, selected: null });
  frame.current = { layout, seats: sprites, lobbyLabels, hovered: keyOf(hover?.target ?? null), selected: keyOf(selected) };
  useEffect(() => {
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
  }, [scale]);

  const targetAt = (event: MouseEvent<HTMLCanvasElement>): Target | null => {
    const box = event.currentTarget.getBoundingClientRect();
    return hitTest(layout, (event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
  };
  const onMove = (event: MouseEvent<HTMLCanvasElement>): void => {
    const target = targetAt(event); const box = host.current?.getBoundingClientRect();
    setHover(target && box ? { target, x: event.clientX - box.left + host.current!.scrollLeft, y: event.clientY - box.top + host.current!.scrollTop } : null);
  };

  const describe = (target: Target): { title: string; lines: string[]; status: SeatStatus | null; seat: { id: string; title: string } | null } => {
    if ('agentId' in target) {
      const agent = state.agents.find(candidate => candidate.id === target.agentId);
      return { title: agent ? sessionLabel(agent) : target.agentId, status: null, seat: null, lines: [`Unseated session · ${agent?.state ?? 'unknown'}${agent?.currentTool ? ` · ${agent.currentTool}` : ''}`, 'Assign it in Org or paste a join link into it.'] };
    }
    const seat = seats.find(candidate => candidate.id === target.seatId);
    if (!seat) return { title: target.seatId, lines: [], status: null, seat: null };
    const agent = state.agents.find(candidate => candidate.id === seat.agentId); const status = seatStatus(seat, state.agents);
    const department = state.org?.departments.find(candidate => candidate.id === seat.departmentId);
    return {
      title: seat.title, status, seat,
      lines: [`@${seat.id} · ${seat.role} of ${department?.name ?? seat.departmentId}`, `Status: ${SEAT_STATUS_LABEL[status]}`, agent ? `Session: ${sessionLabel(agent)}${agent.currentTool ? ` · running ${agent.currentTool}` : ''}` : 'No session', ...(seat.description ? [seat.description] : [])],
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
      </div>
      <div className="map-stage" ref={host} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvas} className="map-canvas" role="img" aria-label={`Office map: ${counts.filter(([, count]) => count > 0).map(([status, count]) => `${count} ${SEAT_STATUS_LABEL[status]}`).join(', ')}`}
          onMouseMove={onMove} onClick={event => setSelected(targetAt(event))} style={{ cursor: hover ? 'pointer' : 'default' }} />
        {tip && hover && !selected && <div className="map-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}><strong>{tip.title}</strong>{tip.lines.slice(0, 3).map(line => <span key={line}>{line}</span>)}</div>}
      </div>
      {detail && (
        <aside className="map-detail" aria-label="Selected seat">
          <header>{detail.status && <StatusDot status={detail.status} />}<strong>{detail.title}</strong><span className="spacer" /><button type="button" className="icon-btn" aria-label="Close" onClick={() => setSelected(null)}>✕</button></header>
          {detail.lines.map(line => <p key={line}>{line}</p>)}
          {detail.seat && <div className="row-actions"><button type="button" className="btn btn-small" onClick={() => copyJoin(detail.seat!)}>Copy join</button></div>}
        </aside>
      )}
    </div>
  );
}
