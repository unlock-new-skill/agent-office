import type { Department, Seat } from '../../shared/contracts.js';

/** Logical pixel units; the canvas scales them by an integer factor so the art stays crisp. */
export const TILE = 16;
export const CELL_W = 48;
export const CELL_H = 56;
const PAD = TILE;
const WALL = TILE * 2;
const GAP = TILE;
const LOBBY_SLOT_W = 40;

export type DeskSpot = { seatId: string; x: number; y: number; leader: boolean };
export type Room = { departmentId: string; name: string; color: string; paused: boolean; x: number; y: number; w: number; h: number; desks: DeskSpot[] };
export type LobbySpot = { agentId: string; x: number; y: number };
export type Lobby = { x: number; y: number; w: number; h: number; spots: LobbySpot[] };
export type MapLayout = { rooms: Room[]; lobby: Lobby | null; width: number; height: number };

const roomSize = (seats: number, perRow: number): { w: number; h: number } => {
  const rows = Math.max(1, Math.ceil(seats / perRow));
  return { w: PAD * 2 + Math.max(Math.min(perRow, seats), 2) * CELL_W, h: WALL + rows * CELL_H + PAD / 2 };
};

/**
 * Places one room per department (leader desk first) in rows that wrap at `maxWidth`, plus a lobby for sessions
 * without a seat. Pure so it can be unit-tested and recomputed only when the org or the viewport changes.
 */
/** `gap`: space between rooms in layout pixels (the 3D office spreads departments further apart than the 2D map). */
export const layoutOffice = (departments: Department[], seats: Seat[], unseatedAgentIds: string[], maxWidth: number, gap = GAP): MapLayout => {
  // Three desks per row, or two when even a three-desk room would not fit the viewport (phones).
  const perRow = maxWidth >= PAD * 2 + 3 * CELL_W + gap * 2 ? 3 : 2;
  const rooms: Room[] = []; let x = gap; let y = gap; let rowHeight = 0; let width = 0;
  const place = (w: number, h: number): { x: number; y: number } => {
    if (x > gap && x + w + gap > maxWidth) { x = gap; y += rowHeight + gap; rowHeight = 0; }
    const at = { x, y }; x += w + gap; rowHeight = Math.max(rowHeight, h); width = Math.max(width, x);
    return at;
  };
  for (const department of departments) {
    const members = seats.filter(seat => seat.departmentId === department.id).sort((a, b) => Number(b.role === 'leader') - Number(a.role === 'leader') || a.sort - b.sort);
    const size = roomSize(members.length, perRow);
    const at = place(size.w, size.h);
    rooms.push({
      departmentId: department.id, name: department.name, color: department.color, paused: department.paused, ...at, ...size,
      desks: members.map((seat, index) => ({ seatId: seat.id, leader: seat.role === 'leader', x: at.x + PAD + (index % perRow) * CELL_W, y: at.y + WALL + Math.floor(index / perRow) * CELL_H })),
    });
  }
  let lobby: Lobby | null = null;
  if (unseatedAgentIds.length > 0) {
    const perRow = Math.max(2, Math.floor((Math.min(maxWidth, 6 * LOBBY_SLOT_W + PAD * 2) - PAD * 2) / LOBBY_SLOT_W));
    const shown = unseatedAgentIds.slice(0, perRow * 2);
    const w = PAD * 2 + Math.min(shown.length, perRow) * LOBBY_SLOT_W; const h = WALL + Math.ceil(shown.length / perRow) * CELL_H;
    const at = place(Math.max(w, PAD * 2 + 2 * LOBBY_SLOT_W), h);
    lobby = { ...at, w: Math.max(w, PAD * 2 + 2 * LOBBY_SLOT_W), h, spots: shown.map((agentId, index) => ({ agentId, x: at.x + PAD + (index % perRow) * LOBBY_SLOT_W, y: at.y + WALL + Math.floor(index / perRow) * CELL_H })) };
  }
  return { rooms, lobby, width: Math.max(width, gap * 2), height: y + rowHeight + gap };
};

/** Seat or lobby agent under a logical point, for hover and click. */
export const hitTest = (layout: MapLayout, px: number, py: number): { seatId: string } | { agentId: string } | null => {
  for (const room of layout.rooms) for (const desk of room.desks) if (px >= desk.x && px < desk.x + CELL_W && py >= desk.y && py < desk.y + CELL_H) return { seatId: desk.seatId };
  for (const spot of layout.lobby?.spots ?? []) if (px >= spot.x && px < spot.x + LOBBY_SLOT_W && py >= spot.y && py < spot.y + CELL_H) return { agentId: spot.agentId };
  return null;
};

/** Stable small hash so each seat keeps the same look across reloads. */
export const seatHash = (id: string): number => { let hash = 2166136261; for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return hash >>> 0; };
