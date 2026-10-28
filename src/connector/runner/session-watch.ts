import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionStore } from '../session-store.js';
import { RunnerState } from './runner-config.js';

const AUTO = '[Agent Office]';
const color = { dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m', reset: '\x1b[0m' };
const paint = (tone: keyof typeof color, text: string): string => `${color[tone]}${text}${color.reset}`;
const BACKLOG = 40;

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };
type Entry = { type?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: string | Block[] } };

export const watchPidFile = (store: SessionStore, seatId: string): string => path.join(store.home, 'watch', `${seatId}.pid`);

/** Where Claude Code keeps the transcript of a session: <config>/projects/<encoded cwd>/<session>.jsonl. */
export const findTranscript = (sessionId: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')): string | null => {
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const folder of readdirSync(projects)) {
    const file = path.join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
};

const clock = (timestamp: string | undefined): string => paint('dim', timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : '--:--:--');
const toolDetail = (input: Record<string, unknown> | undefined): string => {
  const value = ['command', 'file_path', 'pattern', 'url', 'description', 'prompt'].map(key => input?.[key]).find(item => typeof item === 'string') as string | undefined;
  return value ? value.replace(/\s+/g, ' ').slice(0, 160) : '';
};
const resultText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as Block).text ?? '').join('\n') : '';

/** Renders one transcript line as zero or more readable lines; subagent (sidechain) chatter is left out. */
export const renderEntry = (raw: string): string[] => {
  let entry: Entry;
  try { entry = JSON.parse(raw) as Entry; } catch { return []; }
  if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'assistant')) return [];
  const at = clock(entry.timestamp); const content = entry.message?.content;
  if (typeof content === 'string') {
    if (entry.type !== 'user' || !content.trim()) return [];
    return content.startsWith(AUTO) ? [`${at} ${paint('magenta', `⚑ ${content.slice(0, 400)}`)}`] : [`${at} ${paint('cyan', `› ${content}`)}`];
  }
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text?.trim()) lines.push(entry.type === 'assistant' ? `${at} ${paint('bold', '●')} ${block.text.trim()}` : `${at} ${paint('cyan', `› ${block.text.trim()}`)}`);
    if (block.type === 'tool_use') lines.push(`${at} ${paint('yellow', `⏺ ${block.name ?? 'tool'}`)}${toolDetail(block.input) ? paint('yellow', `(${toolDetail(block.input)})`) : ''}`);
    if (block.type === 'tool_result') {
      const text = resultText(block.content).trim().split('\n');
      const shown = text.slice(0, 4).map(line => line.slice(0, 200)).join('\n           ');
      lines.push(`${' '.repeat(9)}${paint(block.is_error ? 'red' : 'dim', `⎿ ${shown || '(no output)'}${text.length > 4 ? ` … +${text.length - 4} lines` : ''}`)}`);
    }
  }
  return lines;
};

/**
 * Read-only live view of a runner seat's conversation for a desktop terminal window. Follows the seat's current session
 * (runner-state.json) and tails its transcript; never writes to the session, so it is safe while the runner works.
 */
export const runWatch = async (store: SessionStore, seatId: string, out: (text: string) => void = text => process.stdout.write(text)): Promise<void> => {
  const pidFile = watchPidFile(store, seatId);
  mkdirSync(path.dirname(pidFile), { recursive: true }); writeFileSync(pidFile, String(process.pid));
  const cleanup = (): void => { try { unlinkSync(pidFile); } catch { /* already gone */ } };
  process.on('exit', cleanup); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(0));
  out(`\x1b]0;Agent Office · @${seatId}\x07`);
  out(`${paint('bold', `Agent Office — @${seatId}`)} ${paint('dim', '(read-only view; control the seat from the web: Org → Log / Prompt / Stop)')}\n`);
  const state = new RunnerState(store);
  let sessionId: string | null = null; let file: string | null = null; let offset = 0; let partial = ''; let waitingShown = false;
  for (;;) {
    const current = state.sessionId(seatId);
    if (current !== sessionId) { sessionId = current; file = null; offset = 0; partial = ''; }
    if (sessionId && !file) {
      file = findTranscript(sessionId);
      if (file) {
        out(`\n${paint('green', `── session ${sessionId} ──`)}\n`);
        const lines = readFrom(file, 0).split('\n'); offset = statSync(file).size;
        partial = lines.pop() ?? '';
        for (const line of lines.flatMap(renderEntry).slice(-BACKLOG)) out(`${line}\n`);
        waitingShown = false;
      }
    }
    if (!file && !waitingShown) { out(paint('dim', 'Waiting for the seat to start a session…\n')); waitingShown = true; }
    if (file && existsSync(file) && statSync(file).size > offset) {
      const chunk = readFrom(file, offset); offset += Buffer.byteLength(chunk);
      const lines = (partial + chunk).split('\n'); partial = lines.pop() ?? '';
      for (const line of lines.flatMap(renderEntry)) out(`${line}\n`);
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
};

const readFrom = (file: string, start: number): string => {
  const size = statSync(file).size; if (size <= start) return '';
  const buffer = Buffer.alloc(size - start); const handle = openSync(file, 'r');
  try { readSync(handle, buffer, 0, buffer.length, start); } finally { closeSync(handle); }
  return buffer.toString('utf8');
};
