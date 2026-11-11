import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentOfficeHooks, hookCommand, mergeAgentOfficeHooks, type ClaudeSettings } from './installer.js';

/**
 * The Claude Code user config the connector depends on: our hooks in settings.json and the `agent-office` MCP server
 * registered at user scope. Both point at the connector file by absolute path, so moving it (a new drive, a new
 * profile) or a fresh Claude Code install leaves sessions without the agent_office_* tools until they are re-added.
 */
const configDir = (): string => process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
export const settingsFile = (): string => path.join(configDir(), 'settings.json');
/** Claude Code keeps user-scope MCP servers in .claude.json: inside CLAUDE_CONFIG_DIR when set, else in the home folder. */
const userConfigFile = (): string => process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homedir(), '.claude.json');
const MCP_NAME = 'agent-office';

const slashes = (value: string): string => value.replaceAll('\\', '/');
export const mcpEntry = (nodePath: string, connectorPath: string): { command: string; args: string[] } => ({ command: slashes(nodePath), args: [slashes(connectorPath), 'mcp'] });

export const readSettings = (): ClaudeSettings => {
  const file = settingsFile();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) as ClaudeSettings; }
  catch { throw new Error(`${file} is not valid JSON; fix it and run the installer again.`); }
};

/** Writes settings.json after copying the previous version aside; returns the backup path. */
export const writeSettings = (settings: ClaudeSettings): string => {
  const file = settingsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.bak-agent-office-${Date.now()}`;
  if (existsSync(file)) copyFileSync(file, backup);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return backup;
};

/** Runs the `claude` CLI; on Windows it is a .cmd shim that needs a shell. Returns false when it is missing or fails. */
export const claude = (args: string[]): boolean => {
  const windows = process.platform === 'win32';
  // cmd.exe would split the JSON argument of add-json on its quotes.
  const quoted = windows ? args.map(arg => /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg) : args;
  try { execFileSync('claude', quoted, { stdio: 'ignore', shell: windows, windowsHide: true }); return true; } catch { return false; }
};

/** (Re)registers the MCP server at user scope for this connector file. */
export const registerMcp = (nodePath: string, connectorPath: string): boolean => {
  claude(['mcp', 'remove', MCP_NAME, '-s', 'user']);
  return claude(['mcp', 'add-json', '--scope', 'user', MCP_NAME, JSON.stringify(mcpEntry(nodePath, connectorPath))]);
};

const mcpRegistered = (nodePath: string, connectorPath: string): boolean => {
  try {
    const config = JSON.parse(readFileSync(userConfigFile(), 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: unknown }> };
    const entry = config.mcpServers?.[MCP_NAME];
    const want = mcpEntry(nodePath, connectorPath);
    return entry?.command === want.command && JSON.stringify(entry.args) === JSON.stringify(want.args);
  } catch { return false; }
};

const hooksInstalled = (settings: ClaudeSettings, ours: ClaudeSettings['hooks'] & object): boolean =>
  Object.entries(ours).every(([event, entries]) => entries.every(want => (settings.hooks?.[event] ?? []).some(entry =>
    entry.hooks.some(hook => want.hooks.some(mine => mine.command === hook.command && mine.timeout === hook.timeout && mine.asyncRewake === hook.asyncRewake)))));

/**
 * Makes sure Claude sessions started on this machine get the Agent Office tools and hooks for this connector file,
 * re-adding whatever is missing or points elsewhere. Returns what was fixed, and a problem when it could not be.
 */
export const ensureClaudeSetup = (nodePath: string, connectorPath: string, permissionWaitSeconds: number): { fixed: string[]; problem: string | null } => {
  const fixed: string[] = [];
  const ours = agentOfficeHooks(hookCommand(nodePath, connectorPath), permissionWaitSeconds);
  try {
    const settings = readSettings();
    if (!hooksInstalled(settings, ours)) { writeSettings(mergeAgentOfficeHooks(settings, ours)); fixed.push(`hooks re-added to ${settingsFile()}`); }
  } catch (error) { return { fixed, problem: error instanceof Error ? error.message : String(error) }; }
  if (mcpRegistered(nodePath, connectorPath)) return { fixed, problem: null };
  if (!registerMcp(nodePath, connectorPath)) return { fixed, problem: `could not register the "${MCP_NAME}" MCP server: is the claude CLI installed and on PATH?` };
  fixed.push(`MCP server "${MCP_NAME}" registered for this user`);
  return { fixed, problem: null };
};
