import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentOfficeHooks } from '../src/connector/installer.js';

// Prints (never writes) the Claude Code settings needed for Agent Office: telemetry/registration hooks, the Stop wake hook and the MCP server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = path.join(root, 'dist', 'scripts', 'claude-hook.js'); const mcp = path.join(root, 'dist', 'src', 'server', 'mcp-stdio.js');
const command = `${process.execPath} ${hook}`;
// PermissionRequest may wait for the manager's Allow/Deny (AGENT_OFFICE_PERMISSION_WAIT_SECONDS, default 120 s).
const permissionWait = Math.min(Math.max(Number(process.env.AGENT_OFFICE_PERMISSION_WAIT_SECONDS ?? 120) || 0, 0), 580);
const settings = { hooks: agentOfficeHooks(command, permissionWait) };
const mcpServers = { 'agent-office': { command: process.execPath, args: [mcp] } };
process.stdout.write(JSON.stringify({ settings, mcpServers, instructions: [
  'Run npm run build first so the dist/ paths exist.',
  'Merge "settings.hooks" into ~/.claude/settings.json (review before merging).',
  'Add "mcpServers" via: claude mcp add-json --scope user agent-office \'' + JSON.stringify(mcpServers['agent-office']) + '\'',
  'Run npm run connect once (daemon running) so sessions can self-register.',
  'Stop hook long-polls up to AGENT_OFFICE_WAKE_WAIT_SECONDS (default 290s) for messages addressed to the seat.',
  'PermissionRequest waits up to AGENT_OFFICE_PERMISSION_WAIT_SECONDS (default 120s) for Allow/Deny in the web UI when the daemon runs with AGENT_OFFICE_REMOTE_APPROVAL=true; the terminal prompt appears only after that. Set it to 0 on machines where someone sits at the terminal.',
] }, null, 2) + '\n');
