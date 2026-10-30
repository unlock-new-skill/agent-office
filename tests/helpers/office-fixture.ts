import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService } from '../../src/server/auth/auth-service.js';
import { createApp } from '../../src/server/app.js';
import { createOffice, type AfterTask, type Office } from '../../src/server/collaboration/office.js';
import { parseOfficeConfig } from '../../src/server/collaboration/seed.js';
import { loadConfig } from '../../src/server/config.js';
import { Database } from '../../src/server/db/database.js';
import { EventStore } from '../../src/server/events/event-store.js';
import type { CollabEvent } from '../../src/shared/contracts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const exampleOfficeYaml = (): string => readFileSync(path.join(root, 'office.example.yaml'), 'utf8');
export const PASSWORD = 'correct horse battery staple';
export const HOST = '127.0.0.1:8080';
export const ORIGIN = `http://${HOST}`;

export type Fixture = { db: Database; office: Office; emitted: CollabEvent[]; close: () => void };

/** In-memory office seeded from office.example.yaml. */
export const createSeededOffice = (options: { maxAutoWakes?: number; remoteApproval?: boolean; coordinatorSeatId?: string; afterTask?: AfterTask } = {}): Fixture => {
  const db = new Database({ filename: ':memory:' }); const emitted: CollabEvent[] = [];
  const office = createOffice(db, { maxAutoWakes: options.maxAutoWakes ?? 15, emit: event => emitted.push(event), remoteApproval: options.remoteApproval ?? false, coordinatorSeatId: options.coordinatorSeatId ?? null, afterTask: options.afterTask ?? 'off' });
  office.org.seed(parseOfficeConfig(exampleOfficeYaml()));
  return { db, office, emitted, close: () => { office.close(); db.close(); } };
};

/** Inserts an agents row the way session registration does, returning its id. */
export const insertAgent = (db: Database, agentId: string, sessionId = `session-${agentId}`): string => {
  db.raw.prepare("INSERT INTO agents(id,source,project,session_id,incarnation,last_contact_at,activity) VALUES (?,'claude','probe',?,?,?,'online')").run(agentId, sessionId, sessionId, Date.now());
  return agentId;
};

export type AppFixture = Fixture & {
  auth: AuthService; app: ReturnType<typeof createApp>;
  manager: (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;
  agent: (token: string, path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;
  seatToken: (seatId: string) => string;
};

/** Full HTTP app with a logged-in manager and helpers to seat bearer-authenticated agents. */
export const createAppFixture = (options: { maxAutoWakes?: number; remoteApproval?: boolean } = {}): AppFixture => {
  const fixture = createSeededOffice(options);
  const auth = new AuthService(fixture.db, 3600); auth.setupPassword(PASSWORD); const login = auth.login(PASSWORD);
  const config = { ...loadConfig({ AGENT_OFFICE_HOST: '127.0.0.1', AGENT_OFFICE_PORT: '8080' }), dataDir: '/tmp' };
  const app = createApp({ config, db: fixture.db, auth, events: new EventStore(fixture.db, () => undefined), office: fixture.office });
  const send = (headers: Record<string, string>, target: string, init: { method?: string; body?: unknown } = {}): Promise<Response> => Promise.resolve(app.request(`http://${HOST}${target}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { host: HOST, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }));
  return {
    ...fixture, auth, app,
    manager: (target, init) => send({ origin: ORIGIN, cookie: `agent_office_session=${login.token}`, 'x-csrf-token': login.csrfToken }, target, init),
    agent: (token, target, init) => send({ authorization: `Bearer ${token}` }, target, init),
    seatToken: seatId => {
      const registered = auth.registerSession({ sessionId: `session-${seatId}`, project: 'probe' });
      fixture.office.org.assignAgent(seatId, registered.agentId);
      return registered.token;
    },
  };
};
