import type { CollabEvent, Delta, Snapshot } from '../../shared/contracts.js';

export type StreamMessage = ({ type: 'snapshot' } & Snapshot) | { type: 'reset'; snapshot: Snapshot } | Delta | CollabEvent;
export type StreamHandlers = { onMessage: (message: StreamMessage) => void; onStatus: (connected: boolean) => void };

/** Authenticated WebSocket with exponential reconnect; each (re)connect starts with a fresh snapshot. Returns a disposer. */
export const connectStream = (handlers: StreamHandlers): (() => void) => {
  let socket: WebSocket | null = null; let attempt = 0; let timer: ReturnType<typeof setTimeout> | null = null; let closed = false;
  const open = (): void => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/stream`);
    socket.onopen = () => { attempt = 0; handlers.onStatus(true); };
    socket.onmessage = event => { try { handlers.onMessage(JSON.parse(String(event.data)) as StreamMessage); } catch { /* ignore malformed frame */ } };
    socket.onclose = () => {
      handlers.onStatus(false);
      if (closed) return;
      timer = setTimeout(open, Math.min(1000 * 2 ** attempt, 15_000)); attempt += 1;
    };
  };
  open();
  return () => { closed = true; if (timer) clearTimeout(timer); socket?.close(); };
};
