import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook } from './hook-runner.js';
import { agentOfficeHooks, hookCommand, LISTEN_SECONDS, mergeAgentOfficeHooks, removeAgentOfficeHooks, type ClaudeSettings } from './installer.js';
import { startMcpServer } from './mcp-server.js';
import { loadRunnerConfig, runnerConfigFile, SAMPLE_CONFIG } from './runner/runner-config.js';
import { installService, restartServiceIfInstalled, uninstallService } from './runner/runner-service-install.js';
import { Runner } from './runner/runner.js';
import { SessionStore } from './session-store.js';

/**
 * Single-file connector installed on agent machines (bundled to agent-office.mjs, served by the daemon):
 *   hook       Claude Code hook entry: JSON on stdin → decision on stdout (exit 0), or a wake on stderr (exit 2)
 *   mcp        agent_office_* MCP tools over stdio
 *   install    --url <daemon> --code <install code>: store a connector credential, merge hooks, register MCP
 *   update     replace this file with the daemon's current connector, then re-sync the hook list in settings
 *   sync-hooks merge the current hook list into ~/.claude/settings.json (run by update with the new file)
 *   uninstall  remove our hooks, the MCP registration and the stored connector
 *   runner     run the seats in ~/.agent-office/runner.json headless and take commands from the web
 *              (`runner init` writes a sample; `runner install-service` / `uninstall-service` start it at login)
 */
const [mode, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] : undefined; };
const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'settings.json');
const self = fileURLToPath(import.meta.url);
const numberEnv = (name: string, fallback: number): number => { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) && value >= 0 ? value : fallback; };

/** Watches the process that started this hook (Claude Code): once it exits we are re-parented or it no longer exists. */
const parentAlive = (): (() => boolean) => {
  const parent = process.ppid;
  return () => {
    if (process.ppid !== parent) return false;
    try { process.kill(parent, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
};

const readStdin = async (): Promise<string> => { let text = ''; for await (const chunk of process.stdin) text += String(chunk); return text; };

const readSettings = (): ClaudeSettings => {
  if (!existsSync(settingsFile)) return {};
  try { return JSON.parse(readFileSync(settingsFile, 'utf8')) as ClaudeSettings; }
  catch { throw new Error(`${settingsFile} is not valid JSON; fix it and run the installer again.`); }
};
const writeSettings = (settings: ClaudeSettings): string => {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  const backup = `${settingsFile}.bak-agent-office-${Date.now()}`;
  if (existsSync(settingsFile)) copyFileSync(settingsFile, backup);
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return backup;
};

/** Runs the `claude` CLI; on Windows it is a .cmd shim that needs a shell. Returns false when it is missing or fails. */
const claude = (args: string[]): boolean => {
  try { execFileSync('claude', args, { stdio: 'ignore', shell: process.platform === 'win32' }); return true; } catch { return false; }
};

const install = async (): Promise<void> => {
  const url = option('url')?.replace(/\/+$/, ''); const code = option('code');
  if (!url || !code) throw new Error('usage: agent-office.mjs install --url <https://office.example.com> --code <install code>');
  const response = await fetch(`${url}/v1/install/redeem`, { method: 'POST', headers: { authorization: `Bearer ${code}`, 'content-type': 'application/json' }, body: JSON.stringify({ machine: process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'unknown' }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({})) as { daemonUrl?: string; token?: string; machineId?: string | null; error?: string };
  if (!response.ok || !body.token) throw new Error(`install code rejected (${body.error ?? response.status}). Ask the manager for a new one (Org → Add machine).`);
  const store = new SessionStore(); store.saveConnector({ daemonUrl: body.daemonUrl ?? url, token: body.token });
  const command = hookCommand(process.execPath, self);
  const backup = writeSettings(mergeAgentOfficeHooks(readSettings(), agentOfficeHooks(command, numberEnv('AGENT_OFFICE_PERMISSION_WAIT_SECONDS', 120))));
  const mcp = { command: process.execPath.replaceAll('\\', '/'), args: [self.replaceAll('\\', '/'), 'mcp'] };
  claude(['mcp', 'remove', 'agent-office', '-s', 'user']);
  const mcpOk = claude(['mcp', 'add-json', '--scope', 'user', 'agent-office', JSON.stringify(mcp)]);
  process.stdout.write([
    `Connected to ${body.daemonUrl ?? url}. Credential: ${store.home}/connector.json`,
    `Hooks merged into ${settingsFile}${existsSync(backup) ? ` (previous version: ${backup})` : ''}.`,
    mcpOk ? 'MCP server "agent-office" registered for your user.' : `Could not run "claude mcp". Register the MCP server yourself:\n  claude mcp add-json --scope user agent-office '${JSON.stringify(mcp)}'`,
    'Start a seated session, e.g.:  AGENT_OFFICE_SEAT=design-atom claude   (PowerShell: $env:AGENT_OFFICE_SEAT="design-atom"; claude)',
    'Already-running Claude sessions must be restarted to pick up the hooks.',
  ].join('\n') + '\n');
  // A machine created on the web: start its runner now and at every login; its seats come from the web.
  if (body.machineId) {
    try { process.stdout.write(`${installService(self, store.home)}\nThis machine's seats are managed on the web (Machines); changes apply within seconds.\n`); }
    catch (error) { process.stdout.write(`Could not install the runner service (${error instanceof Error ? error.message : String(error)}). Run it by hand: node "${self}" runner install-service\n`); }
  }
};

const update = async (): Promise<void> => {
  const connector = new SessionStore().connector();
  if (!connector) throw new Error('not installed: run the install command from the web UI (Connect machine) first.');
  const response = await fetch(`${connector.daemonUrl}/connector/agent-office.mjs`, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok || !text.includes('agent-office.mjs')) throw new Error(`download failed (${response.status})`);
  writeFileSync(`${self}.tmp`, text); renameSync(`${self}.tmp`, self);
  // The new file may hook more events than this (old) process knows about, so let it merge its own hook list.
  execFileSync(process.execPath, [self, 'sync-hooks'], { stdio: 'inherit' });
  const restarted = restartServiceIfInstalled(self, new SessionStore().home);
  process.stdout.write(`Connector updated from ${connector.daemonUrl}. ${restarted ? 'Runner service restarted. ' : ''}Restart running Claude sessions to use it.\n`);
};

const syncHooks = (): void => {
  const backup = writeSettings(mergeAgentOfficeHooks(readSettings(), agentOfficeHooks(hookCommand(process.execPath, self), numberEnv('AGENT_OFFICE_PERMISSION_WAIT_SECONDS', 120))));
  process.stdout.write(`Hooks synced in ${settingsFile}${existsSync(backup) ? ` (previous version: ${backup})` : ''}.\n`);
};

const uninstall = (): void => {
  writeSettings(removeAgentOfficeHooks(readSettings()));
  claude(['mcp', 'remove', 'agent-office', '-s', 'user']);
  rmSync(path.join(new SessionStore().home, 'connector.json'), { force: true });
  process.stdout.write('Agent Office hooks, MCP registration and connector credential removed.\n');
};

/** Foreground runner; `runner init` writes a sample config to edit first. */
const runner = async (): Promise<void> => {
  const store = new SessionStore();
  if (rest[0] === 'init') {
    const file = runnerConfigFile(store);
    if (existsSync(file)) { process.stdout.write(`${file} already exists; edit it, then run: agent-office.mjs runner\n`); return; }
    store.saveJson('runner.json', SAMPLE_CONFIG);
    process.stdout.write(`Wrote ${file}. List the seats this machine runs (seatId, absolute cwd of the repo), then run: agent-office.mjs runner\n`);
    return;
  }
  if (rest[0] === 'uninstall-service') { process.stdout.write(`${uninstallService(self, store.home)}\n`); return; }
  if (!store.connector()) throw new Error('not installed: run the install command from the web UI (Connect machine) first.');
  if (rest[0] === 'install-service') {
    loadRunnerConfig(store);
    process.stdout.write(`${installService(self, store.home)}\n`); return;
  }
  const active = new Runner({ store, fetch, config: loadRunnerConfig(store), out: line => process.stdout.write(`${new Date().toISOString()} ${line}\n`) });
  const shutdown = (): void => { void active.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  await active.run();
};

if (mode === 'hook') {
  let raw: unknown = null;
  try { raw = JSON.parse(await readStdin()) as unknown; } catch { /* malformed input degrades to {} */ }
  const output = await runHook(raw, {
    store: new SessionStore(), fetch, wakeWaitSeconds: Math.min(numberEnv('AGENT_OFFICE_WAKE_WAIT_SECONDS', LISTEN_SECONDS) || LISTEN_SECONDS, LISTEN_SECONDS),
    requestedSeat: process.env.AGENT_OFFICE_SEAT || undefined, permissionWaitSeconds: Math.min(numberEnv('AGENT_OFFICE_PERMISSION_WAIT_SECONDS', 120), 580),
    alive: parentAlive(), runnerManaged: process.env.AGENT_OFFICE_RUNNER === '1',
  });
  // A background Stop hook (asyncRewake) wakes Claude only through exit code 2, with the reason on stderr.
  if (output.decision === 'block' && typeof output.reason === 'string') { process.stderr.write(`${output.reason}\n`); process.exitCode = 2; }
  else process.stdout.write(`${JSON.stringify(output)}\n`);
} else if (mode === 'mcp') startMcpServer();
else if (mode === 'install') await install().catch(error => { process.stderr.write(`agent-office install failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
else if (mode === 'update') await update().catch(error => { process.stderr.write(`agent-office update failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
else if (mode === 'sync-hooks') syncHooks();
else if (mode === 'uninstall') uninstall();
else if (mode === 'runner') await runner().catch(error => { process.stderr.write(`agent-office runner: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
else { process.stderr.write('usage: agent-office.mjs hook | mcp | install --url <url> --code <code> | update | sync-hooks | uninstall | runner [init | install-service | uninstall-service]\n'); process.exitCode = 2; }
