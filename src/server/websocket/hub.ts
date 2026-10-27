import type { WebSocket } from 'ws';
import type { CollabEvent, Delta, Snapshot } from '../../shared/contracts.js';

type ReplayPage = { deltas: Delta[]; nextAfter: number | null; highWater: number };
type Subscriber = { socket: WebSocket; sessionId: string; generation: string; watermark: number; buffering: boolean; buffer: Delta[]; bufferedBytes: number };
const MAX_SUBSCRIBERS = 8; const MAX_BUFFERED_DELTAS = 20_000; const MAX_BUFFER_BYTES = 2 * 1024 * 1024; const MAX_GLOBAL_BUFFER_BYTES = 16 * 1024 * 1024;

export class WebSocketHub {
  private readonly subscribers = new Map<WebSocket, Subscriber>(); private bufferedDeltas = 0; private bufferedBytes = 0;
  subscribe(socket: WebSocket, sessionId: string, snapshot: Snapshot): boolean {
    const snapshotPayload = JSON.stringify({ type: 'snapshot', ...snapshot });
    if (this.subscribers.size >= MAX_SUBSCRIBERS || Buffer.byteLength(snapshotPayload) > MAX_BUFFER_BYTES) { socket.close(1013, 'subscriber_limit'); return false; }
    const subscriber: Subscriber = { socket, sessionId, generation: snapshot.generation, watermark: snapshot.seq, buffering: true, buffer: [], bufferedBytes: 0 };
    this.subscribers.set(socket, subscriber); socket.once('close', () => this.remove(socket)); this.send(socket, snapshotPayload); return true;
  }
  activate(socket: WebSocket, replay: Delta[]): void {
    const subscriber = this.subscribers.get(socket); if (!subscriber) return;
    const buffered = subscriber.buffer.splice(0); const bufferedBytes = subscriber.bufferedBytes; this.bufferedDeltas -= buffered.length; this.bufferedBytes -= bufferedBytes; subscriber.bufferedBytes = 0;
    for (const delta of replay) { if (!this.subscribers.has(socket)) return; this.sendDelta(subscriber, delta); }
    for (const delta of buffered) { if (!this.subscribers.has(socket)) return; if (delta.seq > subscriber.watermark) this.sendDelta(subscriber, delta); }
    if (this.subscribers.has(socket)) subscriber.buffering = false;
  }
  publish(delta: Delta): void {
    const bytes = Buffer.byteLength(JSON.stringify(delta));
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.generation !== delta.generation || delta.seq <= subscriber.watermark) continue;
      if (subscriber.buffering) {
        if (subscriber.buffer.length >= 5000 || subscriber.bufferedBytes + bytes > MAX_BUFFER_BYTES || this.bufferedDeltas >= MAX_BUFFERED_DELTAS || this.bufferedBytes + bytes > MAX_GLOBAL_BUFFER_BYTES) { subscriber.socket.close(1013, 'stream_backpressure'); this.remove(subscriber.socket); continue; }
        subscriber.buffer.push(delta); subscriber.bufferedBytes += bytes; this.bufferedDeltas += 1; this.bufferedBytes += bytes;
      } else if (delta.seq === subscriber.watermark + 1) this.sendDelta(subscriber, delta);
    }
  }
  repair(replay: (generation: string, afterSeq: number) => ReplayPage, snapshot: () => Snapshot): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.buffering) continue;
      try {
        const page = replay(subscriber.generation, subscriber.watermark);
        for (const delta of page.deltas) this.sendDelta(subscriber, delta);
        if (page.deltas.length === 0 && page.nextAfter !== null && page.nextAfter > subscriber.watermark) subscriber.watermark = page.nextAfter;
      } catch {
        try { if (subscriber.socket.readyState === 1) subscriber.socket.send(JSON.stringify({ type: 'reset', reason: 'stream_repair_failed', snapshot: snapshot() })); } catch { /* socket already closed */ }
        subscriber.socket.close(1011, 'stream_repair_failed'); this.remove(subscriber.socket);
      }
    }
  }
  /** Collaboration notifications are not seq-ordered; clients refetch REST state after reconnect, so best-effort fan-out is enough. */
  broadcast(event: CollabEvent): void { const payload = JSON.stringify(event); for (const subscriber of this.subscribers.values()) this.send(subscriber.socket, payload); }
  revokeSession(sessionId: string): void { for (const subscriber of this.subscribers.values()) if (subscriber.sessionId === sessionId) { subscriber.socket.close(1008, 'session_revoked'); this.remove(subscriber.socket); } }
  sweep(isActive: (sessionId: string) => boolean): void { for (const subscriber of this.subscribers.values()) if (!isActive(subscriber.sessionId)) { subscriber.socket.close(1008, 'session_expired'); this.remove(subscriber.socket); } }
  close(): void { for (const subscriber of this.subscribers.values()) subscriber.socket.close(1001, 'server_shutdown'); this.subscribers.clear(); this.bufferedDeltas = 0; this.bufferedBytes = 0; }
  private sendDelta(subscriber: Subscriber, delta: Delta): void { if (delta.seq <= subscriber.watermark) return; subscriber.watermark = delta.seq; if (subscriber.socket.readyState === 1 && subscriber.socket.bufferedAmount < MAX_BUFFER_BYTES) this.send(subscriber.socket, JSON.stringify(delta)); else if (subscriber.socket.readyState === 1) { subscriber.socket.close(1013, 'client_backpressure'); this.remove(subscriber.socket); } }
  private send(socket: WebSocket, payload: string): void { try { if (socket.readyState === 1) socket.send(payload); } catch { socket.close(1011, 'stream_write_failed'); this.remove(socket); } }
  private remove(socket: WebSocket): void { const subscriber = this.subscribers.get(socket); if (!subscriber) return; this.bufferedDeltas -= subscriber.buffer.length; this.bufferedBytes -= subscriber.bufferedBytes; this.subscribers.delete(socket); }
}
