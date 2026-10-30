import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeArgs, claudeEnv, parseClaudeLine, type ClaudeEvent } from '../../src/connector/runner/claude-process.js';
import { RunnerState, type SeatConfig } from '../../src/connector/runner/runner-config.js';
import { SeatWorker, type WorkerDeps } from '../../src/connector/runner/seat-worker.js';
import { SessionStore } from '../../src/connector/session-store.js';
import type { RunnerLogEntry, RunnerSeat } from '../../src/shared/contracts.js';

const seat: SeatConfig = { seatId: 'dev-be', cwd: '/repo', permissionMode: 'acceptEdits', autoStart: true, showWindow: false };

/** A scripted stand-in for `claude -p`: records what the worker writes and lets the test emit stream-json events. */
const harness = (listen: WorkerDeps['listen'] = async () => null, savedSession: string | null = null) => {
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-runner-')));
  if (savedSession) new RunnerState(store).setSessionId('dev-be', savedSession);
  const spawns: Array<{ resume: string | null; sent: string[]; interrupts: number; closed: boolean; emit: (event: ClaudeEvent) => void }> = [];
  const timers: Array<() => void> = []; const statuses: RunnerSeat[] = []; const logs: RunnerLogEntry[] = [];
  const deps: WorkerDeps = {
    state: new RunnerState(store), listen,
    spawn: (_seat, resume, onEvent) => {
      const record = { resume, sent: [] as string[], interrupts: 0, closed: false, emit: onEvent };
      spawns.push(record);
      return { send: text => record.sent.push(text), interrupt: () => { record.interrupts++; }, close: () => { record.closed = true; onEvent({ kind: 'exit', code: 0, stderr: '' }); }, kill: () => onEvent({ kind: 'exit', code: null, stderr: '' }) };
    },
    onStatus: status => statuses.push(status), onLog: entry => logs.push(entry),
    setTimer: run => { timers.push(run); }, sleep: async () => {}, now: () => 1_000_000,
  };
  return { store, deps, spawns, timers, statuses, logs, worker: new SeatWorker(seat, deps) };
};

test('stream-json lines map to init, text, tool and result events', () => {
  assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s-1"}'), [{ kind: 'init', sessionId: 's-1' }]);
  assert.deepEqual(parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi\\nthere"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}'), [{ kind: 'text', text: 'hi there' }, { kind: 'tool', name: 'Bash', summary: 'ls -la' }]);
  assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"success","result":"done"}'), [{ kind: 'result', ok: true, detail: 'done' }]);
  assert.deepEqual(parseClaudeLine('not json'), []);
  assert.deepEqual(claudeArgs(seat, 's-1'), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--resume', 's-1', '--allowedTools', 'mcp__agent-office']);
  const env = claudeEnv('dev-be', { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' });
  assert.equal(env.CLAUDECODE, undefined); assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.AGENT_OFFICE_SEAT, 'dev-be'); assert.equal(env.AGENT_OFFICE_RUNNER, '1'); assert.equal(env.PATH, '/bin');
});

test('a new seat starts a session, remembers its id, and resumes it after a restart', async () => {
  const { worker, spawns, store } = harness();
  assert.equal(worker.start().ok, true);
  assert.equal(spawns[0]!.resume, null); assert.match(spawns[0]!.sent[0]!, /^\[Agent Office\] You are running unattended as seat @dev-be/);
  spawns[0]!.emit({ kind: 'init', sessionId: 'sess-a' });
  assert.equal(new RunnerState(store).sessionId('dev-be'), 'sess-a');
  assert.equal(worker.start().ok, false, 'already running');
  await worker.restart();
  assert.equal(spawns[0]!.closed, true);
  assert.equal(spawns[1]!.resume, 'sess-a'); assert.match(spawns[1]!.sent[0]!, /restarted this session/);
});

test('forgetting the session makes the next start a new session', async () => {
  const { worker, spawns, store } = harness();
  worker.start(); spawns[0]!.emit({ kind: 'init', sessionId: 'sess-a' });
  await worker.stop(); worker.forgetSession();
  assert.equal(new RunnerState(store).sessionId('dev-be'), null);
  worker.start();
  assert.equal(spawns[1]!.resume, null);
});

test('a finished turn listens for a wake and hands the reason to Claude as the next turn', async () => {
  let calls = 0;
  const { worker, spawns, statuses } = harness(async () => (++calls === 1 ? '[Agent Office] 1 new item(s) for @dev-be' : null));
  worker.start(); spawns[0]!.emit({ kind: 'init', sessionId: 'sess-a' });
  spawns[0]!.emit({ kind: 'result', ok: true, detail: 'done' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns[0]!.sent[1], '[Agent Office] 1 new item(s) for @dev-be');
  assert.ok(statuses.some(status => status.state === 'idle'));
  assert.equal(worker.snapshot().state, 'running');
});

test('crashes restart with --resume after a backoff and stop for good after five in ten minutes', () => {
  const { worker, spawns, timers } = harness();
  worker.start(); spawns[0]!.emit({ kind: 'init', sessionId: 'sess-a' });
  for (let crash = 0; crash < 4; crash++) {
    spawns.at(-1)!.emit({ kind: 'exit', code: 1, stderr: 'boom' });
    assert.equal(worker.snapshot().state, 'starting');
    timers.shift()!();
    assert.equal(spawns.at(-1)!.resume, 'sess-a');
    spawns.at(-1)!.emit({ kind: 'init', sessionId: 'sess-a' });
  }
  spawns.at(-1)!.emit({ kind: 'exit', code: 1, stderr: 'boom' });
  assert.equal(worker.snapshot().state, 'failed');
  assert.equal(worker.snapshot().restarts, 4);
  assert.equal(worker.start().ok, true, 'the manager can start a failed seat again');
});

test('a session that cannot be resumed is dropped so the next start is fresh', () => {
  const { worker, spawns, timers, store } = harness(undefined, 'gone');
  worker.start();
  assert.equal(spawns[0]!.resume, 'gone');
  spawns[0]!.emit({ kind: 'exit', code: 1, stderr: 'No conversation found' });
  assert.equal(new RunnerState(store).sessionId('dev-be'), null);
  timers.shift()!();
  assert.equal(spawns[1]!.resume, null); assert.match(spawns[1]!.sent[0]!, /You are running unattended/);
});

test('interrupt, prompt and stop commands', async () => {
  const { worker, spawns, logs } = harness();
  assert.equal(worker.prompt('hi').ok, false, 'stopped seats cannot be prompted');
  worker.start(); spawns[0]!.emit({ kind: 'init', sessionId: 'sess-a' });
  assert.equal(worker.interrupt().ok, true); assert.equal(spawns[0]!.interrupts, 1);
  spawns[0]!.emit({ kind: 'result', ok: false, detail: 'interrupted' });
  assert.equal(worker.interrupt().ok, false, 'nothing to interrupt while idle');
  assert.deepEqual(worker.prompt('please run the tests'), { ok: true, message: 'sent' });
  assert.equal(spawns[0]!.sent.at(-1), 'please run the tests');
  assert.ok(logs.some(entry => entry.kind === 'prompt' && entry.summary === 'please run the tests'));
  assert.deepEqual(await worker.stop(), { ok: true, message: 'stopped' });
  assert.equal(worker.snapshot().state, 'stopped');
});

test('bypassPermissions seats run with --dangerously-skip-permissions', () => {
  assert.deepEqual(claudeArgs({ ...seat, permissionMode: 'bypassPermissions' }, null), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--allowedTools', 'mcp__agent-office']);
});

test('the desktop live view renders prompts, wakes, replies, tools and results, and hides subagent chatter', async () => {
  const { renderEntry } = await import('../../src/connector/runner/session-watch.js');
  const plain = (lines: string[]): string => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const at = '2026-10-28T10:00:00.000Z';
  assert.match(plain(renderEntry(JSON.stringify({ type: 'user', timestamp: at, message: { content: 'run the tests' } }))), /› run the tests/);
  assert.match(plain(renderEntry(JSON.stringify({ type: 'user', timestamp: at, message: { content: '[Agent Office] 1 new item(s) for @dev-be' } }))), /⚑ \[Agent Office\] 1 new item/);
  assert.match(plain(renderEntry(JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }))), /● On it\.\n.*⏺ Bash\(npm test\)/);
  assert.match(plain(renderEntry(JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', content: 'a\nb\nc\nd\ne\nf' }] } }))), /⎿ a\n\s+b\n\s+c\n\s+d … \+2 lines/);
  assert.deepEqual(renderEntry(JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } })), []);
  assert.deepEqual(renderEntry(JSON.stringify({ type: 'attachment' })), []);
  assert.deepEqual(renderEntry('not json'), []);
});

test('a seat model is passed to claude --model', () => {
  assert.ok(claudeArgs({ ...seat, model: 'gpt-6-astra' }, null).join(' ').includes('--model gpt-6-astra'));
});
