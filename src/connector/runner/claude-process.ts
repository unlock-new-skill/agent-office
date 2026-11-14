import { spawn, type ChildProcess } from 'node:child_process';

/**
 * On Windows the seat runs as cmd.exe → claude (shell: true), so killing the child only ends cmd.exe: claude and anything
 * it started keep the pipes open, 'close' never fires and a stop waits forever. taskkill /T ends the whole tree.
 */
export const killTree = (child: Pick<ChildProcess, 'pid' | 'kill'>, windows = process.platform === 'win32'): void => {
  if (windows && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill();
};
import type { SeatConfig } from './runner-config.js';

/** What the runner needs from Claude Code's stream-json output; everything else is ignored. */
export type ClaudeEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'result'; ok: boolean; detail: string }
  | { kind: 'exit'; code: number | null; stderr: string };

export type ClaudeProcessLike = { send: (text: string) => void; interrupt: () => void; close: () => void; kill: () => void };
export type SpawnClaude = (seat: SeatConfig, resume: string | null, onEvent: (event: ClaudeEvent) => void) => ClaudeProcessLike;

/** Allows every tool of the `agent-office` MCP server. */
const AGENT_OFFICE_TOOLS = 'mcp__agent-office';

/** Variables Claude Code sets for its own child processes; a runner started from a Claude session must not pass them on. */
const NESTED_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID'];

export const claudeArgs = (seat: SeatConfig, resume: string | null): string[] => [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ...(seat.permissionMode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : ['--permission-mode', seat.permissionMode]),
  ...(resume ? ['--resume', resume] : []),
  ...(seat.model ? ['--model', seat.model] : []),
  // The seat's own Agent Office tools never need a prompt: nobody is there to answer one.
  '--allowedTools', AGENT_OFFICE_TOOLS, ...(seat.allowedTools ?? []),
];

export const claudeEnv = (seatId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env = { ...base };
  for (const key of NESTED_SESSION_VARS) delete env[key];
  return { ...env, AGENT_OFFICE_SEAT: seatId, AGENT_OFFICE_RUNNER: '1' };
};

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max);

/** Maps one stream-json line to the events the runner cares about. */
export const parseClaudeLine = (line: string): ClaudeEvent[] => {
  let message: Record<string, unknown>;
  try { message = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
  if (message.type === 'system' && message.subtype === 'init' && typeof message.session_id === 'string') return [{ kind: 'init', sessionId: message.session_id }];
  if (message.type === 'result') return [{ kind: 'result', ok: message.subtype === 'success' && message.is_error !== true, detail: oneLine(typeof message.result === 'string' ? message.result : String(message.subtype ?? ''), 300) }];
  if (message.type !== 'assistant') return [];
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const events: ClaudeEvent[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) events.push({ kind: 'text', text: oneLine(block.text, 500) });
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
      const detail = ['command', 'file_path', 'pattern', 'url', 'description'].map(key => input[key]).find(value => typeof value === 'string') as string | undefined;
      events.push({ kind: 'tool', name: block.name, summary: oneLine(detail ?? '', 200) });
    }
  }
  return events;
};

/** Windows starts `claude` (a .cmd shim) through cmd.exe: quote every argument; config values were checked shell-safe. */
const quoteForCmd = (value: string): string => /[\s()]/.test(value) ? `"${value}"` : value;

/** Starts `claude -p` with stream-json in/out in the seat's working directory. */
export const spawnClaude: SpawnClaude = (seat, resume, onEvent) => {
  const windows = process.platform === 'win32';
  const args = claudeArgs(seat, resume);
  const child: ChildProcess = spawn('claude', windows ? args.map(quoteForCmd) : args, { cwd: seat.cwd, env: claudeEnv(seat.seatId), stdio: ['pipe', 'pipe', 'pipe'], shell: windows, windowsHide: true });
  let buffer = ''; let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk; let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) for (const event of parseClaudeLine(line)) onEvent(event);
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  child.on('error', error => { stderr += error.message; });
  child.on('close', code => onEvent({ kind: 'exit', code, stderr: oneLine(stderr, 500) }));
  const write = (value: unknown): void => { if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(value)}\n`); };
  return {
    send: text => write({ type: 'user', message: { role: 'user', content: text } }),
    interrupt: () => write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } }),
    close: () => { child.stdin?.end(); },
    kill: () => { killTree(child, windows); },
  };
};
