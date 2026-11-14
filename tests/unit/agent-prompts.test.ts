import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingOf, PromptService } from '../../src/server/collaboration/prompt-service.js';
import type { AgentPromptStatus } from '../../src/shared/contracts.js';
import { createSeededOffice } from '../helpers/office-fixture.js';

const manager = { kind: 'manager' } as const;
const seat = (seatId: string) => ({ kind: 'seat', seatId }) as const;
const OTHER = 'b'.repeat(64);
const question = (text = 'Which color?') => ({ questions: [{ question: text, header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] });

/** Seeded office (coordinator ops-lead) whose runner-1 runs every seat, and a prompt service on a clock the test moves. */
const setup = () => {
  const fixture = createSeededOffice({ coordinatorSeatId: 'ops-lead' });
  const idle = (seatId: string) => ({ seatId, state: 'idle' as const, sessionId: null, restarts: 0, permissionMode: 'bypassPermissions', detail: '' });
  fixture.office.runners.register('runner-1', 'win', ['dev-be', 'dev-fe', 'dev-lead', 'ops-lead'].map(idle));
  fixture.office.runners.register('runner-2', 'mac', [idle('ba-docs')]);
  // Prompts bind to the task the seat has in progress.
  const working = (seatId: string): string => {
    const task = fixture.office.tasks.create(manager, { title: `Work of ${seatId}`, body: 'Goal, inputs, expected output and acceptance criteria.', assigneeSeatId: seatId, estimateMinutes: 30 });
    fixture.office.tasks.update(manager, task.id, { status: 'doing' });
    return task.id;
  };
  const tasks = Object.fromEntries(['dev-be', 'dev-fe', 'dev-lead', 'ops-lead'].map(seatId => [seatId, working(seatId)]));
  let now = 1_000_000;
  const prompts = new PromptService(fixture.db, fixture.office.org, fixture.office.messages, fixture.office.runners, () => undefined, () => now);
  const file = (seatId: string, requestId: string, tool = 'AskUserQuestion', input: Record<string, unknown> = question(), runner = 'runner-1') =>
    prompts.create(runner, { seatId, sessionId: `s-${seatId}`, requestId, toolUseId: 'toolu_1', tool, input, binding: bindingOf(tool, input) });
  const lastLine = () => fixture.db.raw.prepare('SELECT body,mentions_json AS mentions,thread_seq AS threadSeq FROM messages ORDER BY rowid DESC LIMIT 1').get() as { body: string; mentions: string; threadSeq: number | null };
  return { fixture, prompts, file, tasks, lastLine, advance: (ms: number) => { now += ms; } };
};

test('a member\'s question is bound to its task: its technical lead and the PM may answer, woken in the task thread, once', async () => {
  const { fixture, prompts, file, tasks, lastLine } = setup();
  const prompt = file('dev-be', 'req-1');
  assert.equal(prompt.kind, 'question'); assert.equal(prompt.taskId, tasks['dev-be']!); assert.equal(prompt.managerOnly, false);
  assert.deepEqual(prompt.resolvers, [{ seatId: 'dev-lead', role: 'technical' }, { seatId: 'ops-lead', role: 'business' }]);
  assert.equal(prompt.state, 'waiting for an answer');
  const notice = lastLine();
  assert.match(notice.body, new RegExp(`\\[prompt ${prompt.id}\\] @dev-be is waiting on a question \\(task ${tasks['dev-be']!}\\)\\. technical: @dev-lead; business/priority: @ops-lead`));
  assert.deepEqual(JSON.parse(notice.mentions), ['dev-lead', 'ops-lead']); assert.ok(notice.threadSeq, 'posted in the task thread');
  assert.doesNotMatch(notice.body, /Which color\?|Color|Red|Blue/, 'the notice carries the id, kind and task: nothing the agent wrote');
  assert.equal(file('dev-be', 'req-1').id, prompt.id, 'the same request filed again is the same prompt');

  const waiting = prompts.wait('runner-1', prompt.id, 5000);
  const answered = prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Blue' } });
  assert.equal(answered.status, 'answered'); assert.equal(answered.decidedBy, 'seat:dev-lead');
  assert.deepEqual(await waiting, { id: prompt.id, status: 'answered', behavior: 'allow', answers: { 'Which color?': 'Blue' }, message: '', binding: prompt.binding });
  assert.throws(() => prompts.answer(manager, prompt.id, { binding: prompt.binding, behavior: 'deny' }), /prompt_already_resolved/, 'the first answer wins, even over the manager');
  assert.match(prompts.get(prompt.id).state, /answered by @dev-lead, not yet delivered/);
  assert.equal(prompts.delivered('runner-1', prompt.id).status, 'delivered');
  assert.match(prompts.get(prompt.id).state, /answer delivered to the session/);
  assert.equal(prompts.delivered('runner-1', prompt.id).status, 'delivered', 'delivered is recorded once');
  assert.equal((await prompts.wait('runner-1', prompt.id, 0)).status, 'delivered', 'a replayed poll cannot be applied again');
  fixture.close();
});

test('only the listed resolvers or the manager answer: never the asker, another member or another runner', () => {
  const { fixture, prompts, file } = setup();
  const prompt = file('dev-be', 'req-1');
  assert.throws(() => prompts.answer(seat('dev-be'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } }), /cannot_answer_own_prompt/);
  assert.throws(() => prompts.answer(seat('dev-fe'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } }), /not_prompt_resolver/);
  assert.throws(() => prompts.read(seat('dev-fe'), prompt.id), /forbidden_prompt/);
  assert.equal(prompts.list(seat('dev-fe')).length, 0); assert.equal(prompts.list(seat('dev-lead')).length, 1);
  assert.throws(() => file('dev-be', 'req-x', 'AskUserQuestion', question(), 'runner-2'), /seat/, 'a runner files prompts only for its own seats');
  return assert.rejects(prompts.wait('runner-2', prompt.id, 0), /forbidden_prompt/).then(() => fixture.close());
});

test('a leader is answered by the PM and its parent task\'s lead, never by itself; no task or nobody else leaves it to the manager', () => {
  const { fixture, prompts, file, tasks } = setup();
  const lead = file('dev-lead', 'req-1');
  assert.deepEqual(lead.resolvers, [{ seatId: 'ops-lead', role: 'business' }]);
  const parent = fixture.office.tasks.create(manager, { title: 'Parent', body: 'Goal, inputs, expected output and acceptance criteria.', assigneeSeatId: 'ba-lead', estimateMinutes: 30 });
  fixture.db.raw.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(parent.id, tasks['dev-lead']!);
  assert.deepEqual(file('dev-lead', 'req-1b').resolvers, [{ seatId: 'ba-lead', role: 'technical' }, { seatId: 'ops-lead', role: 'business' }]);
  fixture.db.raw.prepare('UPDATE tasks SET assignee_seat_id=? WHERE id=?').run('ba-docs', parent.id);
  assert.deepEqual(file('dev-lead', 'req-1c').resolvers, [{ seatId: 'ops-lead', role: 'business' }], 'an ordinary member named on the parent task is no resolver');
  fixture.db.raw.prepare("UPDATE departments SET deputy_seat_id='ba-docs' WHERE id='ba'").run();
  assert.deepEqual(file('dev-lead', 'req-1d').resolvers, [{ seatId: 'ba-docs', role: 'technical' }, { seatId: 'ops-lead', role: 'business' }], 'the deputy of the parent task\'s department leads it');
  prompts.cancel('runner-1', { ids: [file('dev-lead', 'req-1d').id] }, 'the session stopped or restarted');
  fixture.db.raw.prepare("UPDATE departments SET deputy_seat_id=NULL WHERE id='ba'").run();
  fixture.db.raw.prepare('UPDATE tasks SET assignee_seat_id=? WHERE id=?').run('design-lead', parent.id);
  assert.deepEqual(file('dev-lead', 'req-1e').resolvers, [{ seatId: 'ops-lead', role: 'business' }], 'a leader of another department named on the parent task is no resolver');
  const coordinator = file('ops-lead', 'req-2');
  assert.equal(coordinator.managerOnly, true); assert.match(coordinator.managerReason, /no resolver other than @ops-lead/, 'a PM request is not routed back to itself');
  fixture.db.raw.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(tasks['dev-fe']!);
  const idle = file('dev-fe', 'req-2b');
  assert.equal(idle.managerOnly, true); assert.match(idle.managerReason, /no task in progress/); assert.equal(idle.taskId, null);
  assert.equal(prompts.list(seat('dev-lead')).some(item => item.id === idle.id), false, 'the leader cannot answer outside an assigned scope');
  assert.throws(() => prompts.answer(seat('dev-lead'), coordinator.id, { binding: coordinator.binding, behavior: 'deny' }), /prompt_manager_only/);
  const blocked = file('dev-be', 'req-2c');
  assert.equal(blocked.managerOnly, true); assert.match(blocked.managerReason, /every resolver is itself waiting/, 'resolvers blocked on their own prompts are not counted on');
  prompts.cancel('runner-1', { seatId: 'dev-lead' }, 'the session stopped or restarted'); prompts.cancel('runner-1', { seatId: 'ops-lead' }, 'the session stopped or restarted'); prompts.cancel('runner-1', { ids: [blocked.id] }, 'the session stopped or restarted');
  const secret = file('dev-be', 'req-3', 'AskUserQuestion', question('Paste the API key for the store?'));
  assert.equal(secret.managerOnly, true); assert.match(secret.managerReason, /sensitive/);
  assert.throws(() => prompts.answer(seat('dev-lead'), secret.id, { binding: secret.binding, behavior: 'allow', answers: { 'Paste the API key for the store?': 'x' } }), /prompt_manager_only/);
  const push = file('dev-be', 'req-4', 'Bash', { command: 'git push origin main' });
  assert.equal(push.kind, 'permission'); assert.equal(push.managerOnly, true);
  const hidden = file('dev-be', 'req-4b', 'Bash', { command: `echo ${'x'.repeat(2100)}; git status` });
  assert.equal(hidden.managerOnly, true); assert.match(hidden.managerReason, /too long to show/, 'what a delegate approves must be shown in full');
  const tail = file('dev-be', 'req-4c', 'Write', { file_path: 'notes.txt', content: `${'x'.repeat(3000)} api_key=1234` });
  assert.match(tail.managerReason, /sensitive/, 'the whole input is scanned, not just the visible part');
  prompts.cancel('runner-1', { ids: [push.id, hidden.id, tail.id, secret.id] }, 'the session stopped or restarted');
  const ls = file('dev-be', 'req-5', 'Bash', { command: 'ls src' });
  assert.equal(ls.managerOnly, false);
  assert.throws(() => prompts.answer(seat('dev-lead'), ls.id, { binding: ls.binding, behavior: 'allow', answers: { x: 'y' } }), /answers_only_for_questions/);
  assert.equal(prompts.answer(manager, ls.id, { binding: ls.binding, behavior: 'allow' }).status, 'answered', 'the manager can answer any prompt');
  fixture.close();
});

test('a decision is bound to the exact prompt: wrong binding, missing or unknown answers are refused', () => {
  const { fixture, prompts, file } = setup();
  const prompt = file('dev-be', 'req-1');
  assert.throws(() => prompts.answer(seat('dev-lead'), prompt.id, { binding: OTHER, behavior: 'allow', answers: { 'Which color?': 'Red' } }), /prompt_binding_mismatch/);
  assert.throws(() => prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: {} }), /answer_missing/);
  assert.throws(() => prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red', 'Drop table?': 'yes' } }), /answer_unknown_question/);
  const own = prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Teal\n, please' } });
  assert.deepEqual(own.answers, { 'Which color?': 'Teal , please' }, 'own words are allowed, control characters flattened');
  assert.throws(() => file('dev-be', 'req-2', 'AskUserQuestion', { questions: 'not a list' }), /invalid_questions/);
  fixture.close();
});

test('expiry, cancel and a full queue never allow: the runner sees expired/cancelled and later answers are refused', async () => {
  const { fixture, prompts, file, advance } = setup();
  const prompt = file('dev-be', 'req-1');
  advance(20 * 60_000 + 1);
  assert.equal((await prompts.wait('runner-1', prompt.id, 0)).status, 'expired');
  assert.equal(prompts.get(prompt.id).state, 'expired without an answer: denied, not run');
  assert.throws(() => prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } }), /prompt_expired/);
  const next = file('dev-be', 'req-2');
  const waiting = prompts.wait('runner-1', next.id, 5000);
  assert.equal(prompts.cancel('runner-1', { seatId: 'dev-be' }, 'the session stopped or restarted'), 1);
  assert.equal((await waiting).status, 'cancelled');
  assert.equal(prompts.get(next.id).state, 'cancelled (the session stopped or restarted): not run');
  assert.throws(() => prompts.answer(manager, next.id, { binding: next.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } }), /prompt_already_resolved/);
  for (const id of ['a', 'b', 'c', 'd']) file('dev-fe', `q-${id}`);
  assert.throws(() => file('dev-fe', 'q-e'), /too_many_pending_prompts/);
  fixture.close();
});

test('two resolvers answering at the same time: exactly one decision is recorded', () => {
  const { fixture, prompts, file, tasks } = setup();
  fixture.office.org.updateDepartment('dev', { deputySeatId: 'dev-fe' });
  fixture.db.raw.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(tasks['dev-fe']!);
  const prompt = file('dev-be', 'req-1');
  assert.deepEqual(prompt.resolverSeatIds, ['dev-lead', 'dev-fe', 'ops-lead']);
  const outcomes: Array<AgentPromptStatus | 'refused'> = [];
  for (const [who, behavior] of [['dev-lead', 'allow'], ['dev-fe', 'deny']] as const) {
    try { outcomes.push(prompts.answer(seat(who), prompt.id, { binding: prompt.binding, behavior, answers: { 'Which color?': 'Red' } }).status); } catch { outcomes.push('refused'); }
  }
  assert.deepEqual(outcomes, ['answered', 'refused']);
  assert.equal(prompts.get(prompt.id).decidedBy, 'seat:dev-lead');
  fixture.close();
});

test('allowed and delivered is not "ran": the runner reports the tool outcome once, only for allowed permissions', () => {
  const { fixture, prompts, file } = setup();
  const ls = file('dev-be', 'req-1', 'Bash', { command: 'ls src' });
  assert.equal(prompts.outcome('runner-1', ls.id, true).outcome, null, 'nothing to record before an answer');
  prompts.answer(seat('dev-lead'), ls.id, { binding: ls.binding, behavior: 'allow' }); prompts.delivered('runner-1', ls.id);
  assert.equal(prompts.get(ls.id).state, 'allowed by @dev-lead: delivered, not reported as run yet');
  assert.equal(prompts.outcome('runner-1', ls.id, false).outcome, 'failed');
  assert.equal(prompts.outcome('runner-1', ls.id, true).outcome, 'failed', 'recorded once');
  assert.equal(prompts.get(ls.id).state, 'allowed by @dev-lead: delivered, ran with an error');
  const no = file('dev-be', 'req-2', 'Bash', { command: 'ls /' });
  prompts.answer(manager, no.id, { binding: no.binding, behavior: 'deny', message: 'no' }); prompts.delivered('runner-1', no.id);
  assert.equal(prompts.outcome('runner-1', no.id, true).outcome, null, 'a denial never becomes "ran"');
  assert.equal(prompts.get(no.id).state, 'denied by the manager: denial delivered, not run');
  assert.throws(() => prompts.outcome('runner-2', ls.id, true), /forbidden_prompt/);
  fixture.close();
});

test('a tool permission is a technical decision: the PM coordinator cannot answer it; no technical lead leaves it to the manager', () => {
  const { fixture, prompts, file } = setup();
  const ls = file('dev-be', 'req-1', 'Bash', { command: 'ls src' });
  assert.deepEqual(ls.resolvers, [{ seatId: 'dev-lead', role: 'technical' }]);
  assert.throws(() => prompts.answer(seat('ops-lead'), ls.id, { binding: ls.binding, behavior: 'allow' }), /not_prompt_resolver/);
  const lead = file('dev-lead', 'req-2', 'Bash', { command: 'ls src' });
  assert.equal(lead.managerOnly, true); assert.match(lead.managerReason, /no technical lead other than @dev-lead/);
  fixture.close();
});

test('the scope is checked again when answering: a finished task or an ambiguous one cannot be answered by a delegate', () => {
  const { fixture, prompts, file, tasks } = setup();
  const prompt = file('dev-be', 'req-1');
  fixture.db.raw.prepare("UPDATE tasks SET status='done' WHERE id=?").run(tasks['dev-be']!);
  assert.throws(() => prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } }), /prompt_scope_changed/);
  assert.equal(prompts.answer(manager, prompt.id, { binding: prompt.binding, behavior: 'deny' }).status, 'denied', 'the manager still can');
  const extra = fixture.office.tasks.create(manager, { title: 'Second', body: 'Goal, inputs, expected output and acceptance criteria.', assigneeSeatId: 'dev-fe', estimateMinutes: 30, kind: 'tracking' });
  fixture.db.raw.prepare("UPDATE tasks SET status='doing',kind='tracking' WHERE id IN (?,?)").run(extra.id, tasks['dev-fe']!);
  const ambiguous = file('dev-fe', 'req-2');
  assert.equal(ambiguous.managerOnly, true); assert.match(ambiguous.managerReason, /several tasks in progress/);
  fixture.close();
});

test('a decision the session can no longer receive is cancelled with its reason; a tool result before the delivery notice is kept', () => {
  const { fixture, prompts, file } = setup();
  const prompt = file('dev-be', 'req-1');
  prompts.answer(seat('dev-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } });
  assert.equal(prompts.cancel('runner-1', { ids: [prompt.id] }, 'the session withdrew the request'), 1);
  assert.equal(prompts.get(prompt.id).state, 'cancelled (the session withdrew the request), after an answer by @dev-lead that was never delivered: not run');
  assert.equal(prompts.delivered('runner-1', prompt.id).status, 'cancelled', 'a late delivery notice does not revive it');
  const ls = file('dev-be', 'req-2', 'Bash', { command: 'ls src' });
  prompts.answer(seat('dev-lead'), ls.id, { binding: ls.binding, behavior: 'allow' });
  assert.equal(prompts.outcome('runner-1', ls.id, true).state, 'allowed by @dev-lead: delivered, ran', 'the result can arrive before the delivery notice');
  assert.equal(prompts.delivered('runner-1', ls.id).outcome, 'succeeded');
  fixture.close();
});

test('prompts of a runner that went offline are cancelled by the sweep; online runners keep theirs', () => {
  const { fixture, prompts, file } = setup();
  const mine = file('dev-be', 'req-1'); const other = file('ba-docs', 'req-2', 'AskUserQuestion', question(), 'runner-2');
  assert.equal(prompts.cancelOffline(id => id === 'runner-1'), 1);
  assert.equal(prompts.get(other.id).state, 'cancelled (the runner went offline): not run');
  assert.equal(prompts.get(mine.id).status, 'pending');
  const decided = file('ba-docs', 'req-3', 'AskUserQuestion', question('Which size?'), 'runner-2');
  prompts.answer(manager, decided.id, { binding: decided.binding, behavior: 'deny' });
  prompts.cancelOffline(() => false);
  assert.equal(prompts.get(decided.id).status, 'denied', 'a sweep does not relabel a decision that may have reached the session');
  fixture.close();
});

test('a resolver who lost the scope can no longer read or list the prompt; the asker and the manager still can', () => {
  const { fixture, prompts, file, tasks } = setup();
  const prompt = file('dev-be', 'req-1');
  assert.equal(prompts.read(seat('dev-lead'), prompt.id).id, prompt.id); assert.equal(prompts.list(seat('dev-lead')).length, 1);
  // The lead stops being a leader: reading goes with the role, not with the resolver list stored at filing time.
  fixture.db.raw.prepare("UPDATE seats SET role='member' WHERE id='dev-lead'").run();
  assert.throws(() => prompts.read(seat('dev-lead'), prompt.id), /forbidden_prompt/);
  assert.equal(prompts.list(seat('dev-lead')).length, 0);
  assert.equal(prompts.read(seat('ops-lead'), prompt.id).id, prompt.id, 'the PM is still in scope');
  // The task ends: no delegate reads it any more, even a decided one.
  assert.equal(prompts.answer(seat('ops-lead'), prompt.id, { binding: prompt.binding, behavior: 'allow', answers: { 'Which color?': 'Red' } }).status, 'answered');
  fixture.db.raw.prepare("UPDATE tasks SET status='done' WHERE id=?").run(tasks['dev-be']!);
  assert.throws(() => prompts.read(seat('ops-lead'), prompt.id), /forbidden_prompt/);
  assert.equal(prompts.list(seat('ops-lead')).length, 0);
  assert.equal(prompts.read(seat('dev-be'), prompt.id).id, prompt.id, 'the asker reads its own prompt');
  assert.equal(prompts.read(manager, prompt.id).id, prompt.id); assert.equal(prompts.list(manager).length, 1);
  fixture.close();
});

test('the notice of a prompt kept for the manager carries no header, question or matched word (synthetic strings)', () => {
  const { fixture, prompts, file, lastLine } = setup();
  const input = { questions: [{ question: 'Use the synthetic-secret-value-42 for the store?', header: 'token zz-header-9', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };
  const prompt = file('dev-be', 'req-1', 'AskUserQuestion', input);
  assert.equal(prompt.managerOnly, true);
  const notice = lastLine();
  assert.match(notice.body, new RegExp(`\\[prompt ${prompt.id}\\] @dev-be is waiting on a question .*Only the manager can answer \\(the reason is in the prompt\\)`));
  assert.doesNotMatch(notice.body, /zz-header-9|token|synthetic-secret|store|Yes|sensitive/);
  assert.deepEqual(JSON.parse(notice.mentions), [], 'nobody but the manager is woken');
  const permission = file('dev-be', 'req-2', 'Bash', { command: 'cat zz-path-7/notes.txt' });
  assert.doesNotMatch(lastLine().body, /zz-path-7|Bash|cat/, 'tool name and input stay out of the channel');
  assert.match(lastLine().body, new RegExp(`\\[prompt ${permission.id}\\] @dev-be is waiting on a tool permission`));
  // Who can see the prompt itself: the manager and the asker, not the lead (manager-only), not the channel.
  assert.throws(() => prompts.read(seat('dev-lead'), prompt.id), /forbidden_prompt/);
  assert.equal(prompts.list(seat('dev-lead')).some(item => item.id === prompt.id), false);
  fixture.close();
});
