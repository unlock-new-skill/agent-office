import { SessionStore } from '../src/connector/session-store.js';
import { loadConfig } from '../src/server/config.js';
import { readPassword } from './password-prompt.js';

// One-time setup: logs in as manager against the running daemon and stores a connector credential for the Claude hooks.
const config = loadConfig(); const daemonUrl = process.env.AGENT_OFFICE_DAEMON_URL ?? `http://${config.host}:${config.port}`;
const headers = { host: new URL(daemonUrl).host, origin: daemonUrl, 'content-type': 'application/json' };
const login = await fetch(`${daemonUrl}/v1/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password: await readPassword('Manager password: ') }) });
if (!login.ok) throw new Error(`login_failed_${login.status}; is the daemon running (npm run dev)?`);
const { csrfToken } = await login.json() as { csrfToken: string }; const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const created = await fetch(`${daemonUrl}/v1/connectors`, { method: 'POST', headers: { ...headers, cookie, 'x-csrf-token': csrfToken }, body: '{}' });
if (!created.ok) throw new Error(`connector_create_failed_${created.status}`);
const { token } = await created.json() as { token: string };
const store = new SessionStore(); store.saveConnector({ daemonUrl, token });
process.stdout.write(`Connector saved to ${store.home}/connector.json. New Claude Code sessions will self-register.\nNext: npm run install-hooks and merge the printed settings into ~/.claude/settings.json.\n`);
