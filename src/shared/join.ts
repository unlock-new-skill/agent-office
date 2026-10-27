/** Seat join links: `<daemon>/join/<seat-id>`. Shared by the UI (copy button), the join page and the MCP join tool. */
export const joinUrl = (origin: string, seatId: string): string => `${origin.replace(/\/+$/, '')}/join/${encodeURIComponent(seatId)}`;

export const joinPrompt = (origin: string, seat: { id: string; title: string }): string =>
  `Join Agent Office as ${seat.title}: call the agent_office_join tool with seat "${joinUrl(origin, seat.id)}", then work in that role.`;

/** Seat id of the first join link in free text that points at this daemon (other hosts are ignored). */
export const joinLinkSeat = (text: string, daemonUrl: string): string | null => {
  let host: string; try { host = new URL(daemonUrl).host; } catch { return null; }
  for (const match of text.matchAll(/https?:\/\/([^/\s]+)\/join\/([A-Za-z0-9_-]{1,64})/g)) if (match[1] === host) return match[2] ?? null;
  return null;
};

/** Accepts a join URL, "@seat-id" or a bare seat id. */
export const seatIdFromJoin = (value: string): string => {
  const trimmed = value.trim();
  const fromUrl = /\/join\/([^/?#\s]+)/.exec(trimmed)?.[1];
  return decodeURIComponent(fromUrl ?? trimmed).replace(/^@/, '');
};
