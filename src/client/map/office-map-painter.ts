import type { SeatStatus } from '../state/office-store.js';
import { CELL_H, CELL_W, TILE, seatHash, type DeskSpot, type Lobby, type MapLayout, type Room } from './office-map-layout.js';

export type SeatSprite = { title: string; status: SeatStatus };
export type PaintInput = { layout: MapLayout; seats: Map<string, SeatSprite>; lobbyLabels: Map<string, string>; hovered: string | null; selected: string | null; time: number };

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const HAIR = ['#2b1d14', '#5a3825', '#a0522d', '#d8b04c', '#1f2937', '#7c2d12'];
const SHIRT = ['#3b82f6', '#ef4444', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1'];
const SCREEN: Record<SeatStatus, string> = { working: '#60a5fa', listening: '#22c55e', blocked: '#f59e0b', wake_limited: '#f87171', idle: '#334155', offline: '#0b0f14', vacant: '#0b0f14' };
const FONT = '6px ui-monospace, Menlo, monospace';

const rect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
const fit = (ctx: CanvasRenderingContext2D, text: string, width: number): string => {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text; while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
};
const shade = (hex: string, amount: number): string => {
  const value = Number.parseInt(hex.slice(1), 16); const channel = (shift: number): number => Math.max(0, Math.min(255, ((value >> shift) & 255) + amount));
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
};

const paintRoomShell = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, title: string, subtitle: string): void => {
  for (let ty = y + TILE * 2; ty < y + h; ty += TILE / 2) for (let tx = x; tx < x + w; tx += TILE / 2) rect(ctx, tx, ty, TILE / 2, TILE / 2, ((tx - x + ty - y) / (TILE / 2)) % 2 === 0 ? '#2a2e35' : '#262a30');
  rect(ctx, x, y, w, TILE * 2, shade(color, -90));
  rect(ctx, x, y + TILE * 2 - 3, w, 3, shade(color, -120));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.font = `bold ${FONT}`; const label = fit(ctx, title, w - 60);
  rect(ctx, x + 6, y + 6, ctx.measureText(label).width + 8, 11, color);
  ctx.fillStyle = '#0b0f14'; ctx.textBaseline = 'top'; ctx.fillText(label, x + 10, y + 8);
  ctx.font = FONT; ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'right'; ctx.fillText(subtitle, x + w - 6, y + 9); ctx.textAlign = 'left';
};

const paintPerson = (ctx: CanvasRenderingContext2D, cx: number, cy: number, id: string, options: { typing: boolean; leader: boolean; time: number }): void => {
  const hash = seatHash(id); const skin = SKIN[hash % SKIN.length]!; const hair = HAIR[(hash >>> 3) % HAIR.length]!; const shirt = SHIRT[(hash >>> 6) % SHIRT.length]!;
  const bob = options.typing ? 0 : Math.round(Math.sin(options.time / 600 + hash) * 0.6);
  rect(ctx, cx - 6, cy + 6 + bob, 12, 9, shirt); // body
  rect(ctx, cx - 6, cy + 13 + bob, 12, 2, shade(shirt, -50));
  const arm = options.typing ? Math.round(Math.sin(options.time / 90 + hash) * 1.5) : 0;
  rect(ctx, cx - 8, cy + 7 + bob + arm, 2, 6, shirt); rect(ctx, cx + 6, cy + 7 + bob - arm, 2, 6, shirt);
  rect(ctx, cx - 5, cy - 3 + bob, 10, 9, skin); // head
  rect(ctx, cx - 5, cy - 4 + bob, 10, 4, hair); rect(ctx, cx - 6, cy - 3 + bob, 2, 5, hair); rect(ctx, cx + 4, cy - 3 + bob, 2, 5, hair);
  if (options.leader) { rect(ctx, cx - 4, cy - 8 + bob, 8, 3, '#facc15'); rect(ctx, cx - 4, cy - 10 + bob, 2, 2, '#facc15'); rect(ctx, cx - 1, cy - 11 + bob, 2, 3, '#facc15'); rect(ctx, cx + 2, cy - 10 + bob, 2, 2, '#facc15'); }
};

const paintBubble = (ctx: CanvasRenderingContext2D, x: number, y: number, status: SeatStatus, time: number): void => {
  const blink = Math.floor(time / 450) % 2 === 0;
  if (status === 'blocked') {
    if (!blink) return;
    rect(ctx, x, y, 11, 11, '#f59e0b'); rect(ctx, x + 4, y + 2, 3, 5, '#1f1300'); rect(ctx, x + 4, y + 8, 3, 2, '#1f1300');
  } else if (status === 'wake_limited') {
    rect(ctx, x, y, 11, 11, '#f87171');
    for (let i = 0; i < 5; i++) { rect(ctx, x + 3 + i, y + 3 + i, 1, 1, '#2a0a0a'); rect(ctx, x + 7 - i, y + 3 + i, 1, 1, '#2a0a0a'); }
  } else if (status === 'idle') {
    const rise = (time / 60) % 10;
    ctx.font = `bold ${FONT}`; ctx.fillStyle = `rgba(203,213,225,${1 - rise / 10})`; ctx.fillText('z', x + 2, y + 6 - rise); ctx.fillText('Z', x + 6, y + 2 - rise / 2);
  } else if (status === 'listening') {
    rect(ctx, x, y + 2, 12, 8, '#e2e8f0'); rect(ctx, x + 2, y + 10, 2, 2, '#e2e8f0');
    for (let i = 0; i < 3; i++) rect(ctx, x + 2 + i * 3, y + 5, 2, 2, Math.floor(time / 300) % 3 === i ? '#16a34a' : '#64748b');
  }
};

const paintDesk = (ctx: CanvasRenderingContext2D, desk: DeskSpot, sprite: SeatSprite | undefined, input: PaintInput): void => {
  const { x, y } = desk; const status = sprite?.status ?? 'vacant'; const time = input.time;
  if (desk.leader) { rect(ctx, x + 3, y + 4, CELL_W - 6, CELL_H - 14, '#7c2d12'); rect(ctx, x + 5, y + 6, CELL_W - 10, CELL_H - 18, '#9a3412'); }
  if (input.selected === desk.seatId || input.hovered === desk.seatId) { ctx.strokeStyle = input.selected === desk.seatId ? '#a5b4fc' : '#64748b'; ctx.lineWidth = 1; ctx.strokeRect(x + 1.5, y + 1.5, CELL_W - 3, CELL_H - 3); }
  // monitor + desk
  rect(ctx, x + 15, y + 6, 18, 13, '#111827'); rect(ctx, x + 22, y + 19, 4, 3, '#111827');
  const flicker = status === 'working' && Math.floor(time / 120) % 3 === 0;
  rect(ctx, x + 17, y + 8, 14, 9, flicker ? '#93c5fd' : SCREEN[status]);
  if (status === 'working') for (let line = 0; line < 3; line++) rect(ctx, x + 18, y + 9 + line * 3, 3 + ((seatHash(desk.seatId) + line + Math.floor(time / 200)) % 9), 1, '#dbeafe');
  rect(ctx, x + 6, y + 21, 36, 6, '#a16207'); rect(ctx, x + 6, y + 27, 36, 2, '#713f12'); rect(ctx, x + 8, y + 29, 2, 4, '#713f12'); rect(ctx, x + 38, y + 29, 2, 4, '#713f12');
  rect(ctx, x + 18, y + 22, 12, 3, '#d4d4d8'); // keyboard
  // chair, then the person seated on it (back to the viewer, facing the monitor)
  rect(ctx, x + 16, y + 36, 16, 8, '#374151'); rect(ctx, x + 17, y + 44, 2, 2, '#1f2937'); rect(ctx, x + 29, y + 44, 2, 2, '#1f2937');
  if (status !== 'vacant') {
    ctx.globalAlpha = status === 'offline' ? 0.3 : 1;
    paintPerson(ctx, x + 24, y + 30, desk.seatId, { typing: status === 'working', leader: desk.leader, time });
    ctx.globalAlpha = 1;
    paintBubble(ctx, x + 34, y + 1, status, time);
  }
  ctx.font = FONT; ctx.fillStyle = status === 'vacant' || status === 'offline' ? '#64748b' : '#e2e8f0'; ctx.textAlign = 'center';
  ctx.fillText(fit(ctx, sprite?.title ?? desk.seatId, CELL_W - 2), x + CELL_W / 2, y + CELL_H - 8); ctx.textAlign = 'left';
};

const paintLobby = (ctx: CanvasRenderingContext2D, lobby: Lobby, input: PaintInput): void => {
  paintRoomShell(ctx, lobby.x, lobby.y, lobby.w, lobby.h, '#64748b', 'Lobby', `${input.lobbyLabels.size} unseated`);
  for (const spot of lobby.spots) {
    if (input.hovered === spot.agentId || input.selected === spot.agentId) { ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.strokeRect(spot.x + 1.5, spot.y + 1.5, 37, CELL_H - 3); }
    const wander = Math.round(Math.sin(input.time / 900 + seatHash(spot.agentId)) * 3);
    paintPerson(ctx, spot.x + 20 + wander, spot.y + 22, spot.agentId, { typing: false, leader: false, time: input.time });
    ctx.font = FONT; ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.fillText(fit(ctx, input.lobbyLabels.get(spot.agentId) ?? spot.agentId, 38), spot.x + 20, spot.y + CELL_H - 8); ctx.textAlign = 'left';
  }
};

const paintRoom = (ctx: CanvasRenderingContext2D, room: Room, input: PaintInput): void => {
  const online = room.desks.filter(desk => { const status = input.seats.get(desk.seatId)?.status; return status && status !== 'vacant' && status !== 'offline'; }).length;
  paintRoomShell(ctx, room.x, room.y, room.w, room.h, room.color, room.name, `${online}/${room.desks.length} on`);
  for (const desk of room.desks) paintDesk(ctx, desk, input.seats.get(desk.seatId), input);
  if (room.paused) {
    rect(ctx, room.x + 2, room.y + TILE * 2, room.w - 4, room.h - TILE * 2 - 2, 'rgba(2,6,23,0.6)');
    ctx.font = `bold ${FONT}`; ctx.fillStyle = '#f59e0b'; ctx.textAlign = 'center'; ctx.fillText('PAUSED', room.x + room.w / 2, room.y + TILE * 2 + 6); ctx.textAlign = 'left';
  }
};

/** Draws one frame in logical units (the caller sets an integer scale on the context). */
export const paintOffice = (ctx: CanvasRenderingContext2D, input: PaintInput): void => {
  ctx.imageSmoothingEnabled = false; ctx.textBaseline = 'top';
  rect(ctx, 0, 0, input.layout.width, input.layout.height, '#15171b');
  for (const room of input.layout.rooms) paintRoom(ctx, room, input);
  if (input.layout.lobby) paintLobby(ctx, input.layout.lobby, input);
};
