import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseClaudeLine, type ClaudeEvent, type PromptResponse } from '../../src/connector/runner/claude-process.js';
import { RunnerState, type SeatConfig } from '../../src/connector/runner/runner-config.js';
import { promptBinding, SeatWorker, type PromptRequest, type PromptVerdict, type WorkerDeps } from '../../src/connector/runner/seat-worker.js';
import { SessionStore } from '../../src/connector/session-store.js';
import type { RunnerSeat } from '../../src/shared/contracts.js';

const seat: SeatConfig = { seatId: 'dev-be', cwd: '/repo', permissionMode: 'bypassPermissions', autoStart: true, showWindow: false };
const QUESTION = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] };
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A scripted `claude -p` that records control responses, and an Agent Office stand-in the test answers by hand. */
const harness = (withAsk = true, outcome?: (id: string, ok: boolean) => void) => {
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'ao-prompt-')));
  const responses: Array<{ requestId: string; response: PromptResponse | { error: string } }> = []; const statuses: RunnerSeat[] = [];
  const asked: PromptRequest[] = []; const delivered: string[] = []; const cancelled: string[][] = [];
  let answer: ((verdict: PromptVerdict) => void) | null = null; let alive: (() => boolean) | null = null;
  let emit: (event: ClaudeEvent) => void = () => undefined;
  const deps: WorkerDeps = {
    state: new RunnerState(store), listen: async () => null,
    spawn: (_seat, _resume, onEvent) => { emit = onEvent; return { send: () => undefined, interrupt: () => undefined, close: () => onEvent({ kind: 'exit', code: 0, stderr: '' }), kill: () => onEvent({ kind: 'exit', code: null, stderr: '' }), respond: (requestId, response) => responses.push({ requestId, response }) }; },
    onStatus: status => statuses.push(status), onLog: () => undefined, setTimer: () => undefined, sleep: async () => {}, now: () => 1_000_000,
    ...(withAsk ? { ask: (request: PromptRequest, isAlive: () => boolean, onFiled: (id: string) => void) => { asked.push(request); alive = isAlive; onFiled('pr-1'); return new Promise<PromptVerdict>(resolve => { answer = resolve; }); } } : {}),
    delivered: id => delivered.push(id), cancelPrompts: ids => cancelled.push(ids), ...(outcome ? { outcome } : {}),
  };
  const worker = new SeatWorker(seat, deps); worker.start();
  emit({ kind: 'init', sessionId: 's-1' });
  return { responses, statuses, asked, delivered, cancelled, emit: (event: ClaudeEvent) => emit(event), answer: (verdict: PromptVerdict) => answer!(verdict), alive: () => alive!() };
};
const prompt = (input: Record<string, unknown> = QUESTION, tool = 'AskUserQuestion'): ClaudeEvent => ({ kind: 'prompt', requestId: 'req-1', toolUseId: 'toolu_1', tool, input });

test('can_use_tool control requests are parsed; other control requests are answered with an error', () => {
  const line = JSON.stringify({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: QUESTION, tool_use_id: 'toolu_1', requires_user_interaction: true } });
  assert.deepEqual(parseClaudeLine(line), [prompt()]);
  assert.deepEqual(parseClaudeLine('{"type":"control_request","request_id":"req-2","request":{"subtype":"elicitation"}}'), [{ kind: 'control', requestId: 'req-2', subtype: 'elicitation' }]);
  const h = harness();
  h.emit({ kind: 'control', requestId: 'req-2', subtype: 'elicitation' });
  assert.deepEqual(h.responses, [{ requestId: 'req-2', response: { error: 'the Agent Office runner does not support elicitation' } }]);
});

test('a question is filed with its binding, the seat shows it is waiting, and the answer goes back to the same request', async () => {
  const h = harness();
  h.emit(prompt()); await tick();
  assert.equal(h.asked.length, 1);
  assert.deepEqual({ ...h.asked[0]!, input: undefined }, { seatId: 'dev-be', sessionId: 's-1', requestId: 'req-1', toolUseId: 'toolu_1', tool: 'AskUserQuestion', input: undefined, binding: promptBinding('AskUserQuestion', QUESTION) });
  assert.match(h.statuses.at(-1)!.detail, /waiting for an answer to a question since 00:16 UTC/);
  h.answer({ id: 'pr-1', behavior: 'allow', answers: { 'Which color?': 'Blue' }, message: '', binding: promptBinding('AskUserQuestion', QUESTION) }); await tick();
  assert.deepEqual(h.responses, [{ requestId: 'req-1', response: { behavior: 'allow', updatedInput: { ...QUESTION, answers: { 'Which color?': 'Blue' } } } }]);
  assert.deepEqual(h.delivered, ['pr-1']); assert.equal(h.statuses.at(-1)!.detail, 'working');
});

test('a permission allow passes the original input unchanged; a decision for other input or a deny is a deny', async () => {
  const input = { command: 'ls src' };
  let h = harness(); h.emit(prompt(input, 'Bash')); await tick();
  h.answer({ id: 'pr-1', behavior: 'allow', answers: { injected: 'rm -rf /' }, message: '', binding: promptBinding('Bash', input) }); await tick();
  assert.deepEqual(h.responses[0]!.response, { behavior: 'allow', updatedInput: input });
  h = harness(); h.emit(prompt(input, 'Bash')); await tick();
  h.answer({ id: 'pr-1', behavior: 'allow', answers: null, message: '', binding: promptBinding('Bash', { command: 'ls /' }) }); await tick();
  assert.equal((h.responses[0]!.response as { behavior: string }).behavior, 'deny', 'an allow bound to other input is not applied');
  h = harness(); h.emit(prompt(input, 'Bash')); await tick();
  h.answer({ id: 'pr-1', behavior: 'deny', answers: null, message: 'Use the existing script.', binding: null }); await tick();
  assert.deepEqual(h.responses[0]!.response, { behavior: 'deny', message: 'Use the existing script.' });
});

test('without routing a prompt is denied at once; a session that ends while waiting gets nothing and its prompts are cancelled', async () => {
  const bare = harness(false); bare.emit(prompt()); await tick();
  assert.equal((bare.responses[0]!.response as { behavior: string }).behavior, 'deny');
  const h = harness(); h.emit(prompt()); await tick();
  assert.equal(h.alive(), true);
  h.emit({ kind: 'exit', code: 1, stderr: 'crash' });
  assert.equal(h.alive(), false); assert.deepEqual(h.cancelled, [['pr-1']], 'only this process\'s own prompts are cancelled');
  h.answer({ id: 'pr-1', behavior: 'allow', answers: { 'Which color?': 'Red' }, message: '', binding: promptBinding('AskUserQuestion', QUESTION) }); await tick();
  assert.deepEqual(h.responses, [], 'a late answer is never written to a new process'); assert.deepEqual(h.delivered, []);
});

test('a request Claude Code withdraws (control_cancel_request) is never answered and its prompt is cancelled', async () => {
  assert.deepEqual(parseClaudeLine('{"type":"control_cancel_request","request_id":"req-1"}'), [{ kind: 'prompt-cancel', requestId: 'req-1' }]);
  const h = harness(); h.emit(prompt()); await tick();
  h.emit({ kind: 'prompt-cancel', requestId: 'req-1' });
  assert.equal(h.alive(), false); assert.deepEqual(h.cancelled, [['pr-1']]);
  assert.equal(h.statuses.at(-1)!.detail, 'working');
  h.answer({ id: 'pr-1', behavior: 'allow', answers: { 'Which color?': 'Red' }, message: '', binding: promptBinding('AskUserQuestion', QUESTION) }); await tick();
  assert.deepEqual(h.responses, [], 'a withdrawn request gets no response'); assert.deepEqual(h.delivered, []);
});

test('an allowed permission that then runs is reported once with its outcome; questions and denials are not', async () => {
  const input = { command: 'ls src' }; const outcomes: Array<[string, boolean]> = [];
  const h = harness(true, (id, ok) => outcomes.push([id, ok]));
  h.emit({ kind: 'prompt', requestId: 'req-1', toolUseId: 'toolu_9', tool: 'Bash', input }); await tick();
  h.answer({ id: 'pr-1', behavior: 'allow', answers: null, message: '', binding: promptBinding('Bash', input) }); await tick();
  h.emit({ kind: 'tool-result', toolUseId: 'toolu_other', ok: true });
  h.emit({ kind: 'tool-result', toolUseId: 'toolu_9', ok: false });
  h.emit({ kind: 'tool-result', toolUseId: 'toolu_9', ok: true });
  assert.deepEqual(outcomes, [['pr-1', false]]);
  assert.deepEqual(parseClaudeLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","is_error":true}]}}'), [{ kind: 'tool-result', toolUseId: 'toolu_9', ok: false }]);
});
