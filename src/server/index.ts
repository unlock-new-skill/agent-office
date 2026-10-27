import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { createOffice } from './collaboration/office.js';
import { readOfficeConfig } from './collaboration/seed.js';
import { AuthService } from './auth/auth-service.js';
import { loadConfig } from './config.js';
import { Database } from './db/database.js';
import { EventStore } from './events/event-store.js';
import { DataLock } from './data-lock.js';
import { logger } from './logger.js';
import { readClientAsset } from './static-client.js';
import { recoverRestore } from './restore-recovery.js';
import { assertSupportedRuntime } from './runtime.js';
import { WebSocketHub } from './websocket/hub.js';
import { allowedHostsAndOrigins, clientPeer, securityHeaders } from './http-policy.js';

assertSupportedRuntime();

const MAX_BODY_BYTES = 256 * 1024;
const config = loadConfig();
if (!config.containerMode && !['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('local_only_host_required');
const dataLock = new DataLock(config.dataDir);
dataLock.acquire();
recoverRestore(config.dataDir);
const db = new Database({ filename: path.join(config.dataDir, 'agent-office.sqlite') });
const hub = new WebSocketHub();
const auth = new AuthService(db, config.sessionTtlSeconds, config.minPasswordLength);
if (!auth.isSetupComplete()) { logger.error('manager setup required; run npm run setup before starting daemon'); db.close(); dataLock.release(); process.exit(1); }
const events = new EventStore(db, delta => hub.publish(delta));
const office = createOffice(db, { maxAutoWakes: config.maxAutoWakes, emit: event => hub.broadcast(event), remoteApproval: config.remoteApproval });
const officeConfig = readOfficeConfig([path.join(process.cwd(), 'office.yaml'), path.join(process.cwd(), 'office.example.yaml')]);
if (officeConfig && office.org.seedIfEmpty(officeConfig)) logger.info('seeded organization from office.yaml');
const snapshot = (): ReturnType<typeof events.snapshot> => ({ ...events.snapshot(), org: office.org.view() });
const app = createApp({ config, db, auth, events, office, revokeSession: id => hub.revokeSession(id) });

const allowedHost = `${config.host}:${config.port}`; const { hosts: allowedHosts, origins: allowedOrigins } = allowedHostsAndOrigins(config); const staticHeaders = securityHeaders(config);

const requestHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  headers.set('x-agent-office-peer', clientPeer(request.headers['x-forwarded-for'], request.socket.remoteAddress, config.trustProxy));
  return headers;
};

const readBody = (request: IncomingMessage, maxBytes: number): Promise<Buffer> => new Promise((resolve, reject) => {
  let settled = false; const finish = (error?: Error, value?: Buffer): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value ?? Buffer.alloc(0)); };
  const timer = setTimeout(() => { request.resume(); finish(new Error('request_timeout')); }, 10_000); timer.unref();
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > maxBytes) { request.resume(); request.once('end', () => finish(new Error('payload_too_large'))); return; }
  const chunks: Buffer[] = []; let size = 0; let tooLarge = false;
  request.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); else tooLarge = true; });
  request.on('end', () => finish(tooLarge ? new Error('payload_too_large') : undefined, Buffer.concat(chunks)));
  request.on('aborted', () => finish(new Error('request_aborted')));
  request.on('error', error => finish(error));
});

const serveRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  try {
    if (!allowedHosts.has(request.headers.host ?? '')) { response.writeHead(403); response.end(); return; }
    const method = request.method ?? 'GET'; const requestPath = (request.url ?? '/').split('?')[0] ?? '/';
    if ((method === 'GET' || method === 'HEAD') && !requestPath.startsWith('/v1') && !requestPath.startsWith('/join/') && requestPath !== '/agent-guide' && requestPath !== '/healthz') {
      const asset = await readClientAsset(requestPath); if (asset) { response.writeHead(200, { ...staticHeaders, 'content-type': asset.contentType }); response.end(asset.body); return; }
    }
    const maxBody = requestPath === '/v1/agents/events' ? 64 * 1024 : requestPath.endsWith('/messages') ? 16 * 1024 : MAX_BODY_BYTES;
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request, maxBody);
    const url = `http://${request.headers.host ?? allowedHost}${request.url ?? '/'}`;
    const aborter = new AbortController(); response.once('close', () => { if (!response.writableFinished) aborter.abort(); });
    const requestInit: RequestInit = { method, headers: requestHeaders(request), signal: aborter.signal }; if (body !== undefined) requestInit.body = body as unknown as BodyInit;
    const result = await app.fetch(new Request(url, requestInit)); const responseHeaders: Record<string, string> = {};
    result.headers.forEach((value, key) => { responseHeaders[key] = value; });
    response.writeHead(result.status, responseHeaders); response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    if (error instanceof Error && error.message === 'payload_too_large') { response.writeHead(413, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'payload_too_large' })); return; }
    if (error instanceof Error && error.message === 'request_timeout') { response.writeHead(408, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'request_timeout' })); return; }
    if (error instanceof Error && error.message === 'request_aborted') { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'request_aborted' })); return; }
    logger.error(error); response.writeHead(500); response.end();
  }
};

const httpServer = createServer((request, response) => { void serveRequest(request, response); });
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

httpServer.on('upgrade', (request, socket, head) => {
  if (!allowedHosts.has(request.headers.host ?? '') || !allowedOrigins.has(request.headers.origin ?? '') || request.url?.split('?')[0] !== '/v1/stream') { socket.destroy(); return; }
  const sessionRequest = new Request(`http://${allowedHost}/v1/me`, { headers: requestHeaders(request) }); const session = auth.authenticateRequest(sessionRequest);
  if (!session) { socket.destroy(); return; }
  websocketServer.handleUpgrade(request, socket, head, client => {
    const current = snapshot();
    if (!hub.subscribe(client, session.id, current)) return;
    const params = new URL(request.url ?? '/v1/stream', `http://${allowedHost}`).searchParams;
    const generation = params.get('generation'); const since = params.get('since');
    const hasCursor = generation !== null || since !== null;
    const cursor = since === null ? null : Number(since);
    try {
      let replay;
      if (!hasCursor) replay = events.replay(current.generation, current.seq);
      else {
        if (generation === null || cursor === null || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor_invalid');
        replay = events.replay(generation, cursor);
      }
      hub.activate(client, replay);
    } catch (error) { const reason = error instanceof Error ? error.message : 'cursor_invalid'; try { if (client.readyState === 1) client.send(JSON.stringify({ type: 'reset', reason, snapshot: current })); } catch { /* socket closed during reset */ } hub.activate(client, []); }
  });
});

const sweep = setInterval(() => hub.sweep(sessionId => auth.isSessionActive(sessionId)), 1000); sweep.unref();
const repair = setInterval(() => hub.repair((generation, afterSeq) => events.replayPage(generation, afterSeq), snapshot), 1000); repair.unref();
httpServer.listen(config.port, config.host, () => logger.info(`agent-office listening on http://${config.host}:${config.port}`));
const shutdown = (): void => { office.close(); clearInterval(sweep); clearInterval(repair); hub.close(); httpServer.close(); db.close(); dataLock.release(); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
