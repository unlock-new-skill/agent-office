import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusCheck } from '../../src/server/collaboration/status-check.js';
import { createSeededOffice, insertAgent } from '../helpers/office-fixture.js';

const HOUR = 3_600_000;
const manager = { kind: 'manager' as const };

test('status check pings the coordinator about departments quiet with work in progress, once per quiet window', () => {
  const fixture = createSeededOffice(); const { org, messages, tasks } = fixture.office;
  const check = new StatusCheck(fixture.db, org, messages, { seatId: 'ops-lead', silentMs: HOUR });
  const leadersLast = (): string => messages.list(manager, 'leaders').at(-1)?.body ?? '';
  const task = tasks.create(manager, { title: 'Login API', body: '', assigneeSeatId: 'dev-be' });
  tasks.create(manager, { title: 'Docs', body: '', assigneeSeatId: 'ba-docs' });
  check.run(Date.now() + 2 * HOUR);
  assert.equal(leadersLast(), '', 'an unseated coordinator is never pinged');

  org.assignAgent('ops-lead', insertAgent(fixture.db, 'agent-ops'));
  check.run(Date.now() + 2 * HOUR);
  assert.equal(leadersLast(), '', 'todo work alone is not in progress');

  tasks.update(manager, task.id, { status: 'doing' });
  check.run(Date.now() + 10 * 60_000);
  assert.equal(leadersLast(), '', 'recent activity is not silence');
  check.run(Date.now() + 2 * HOUR);
  const ping = messages.list(manager, 'leaders').at(-1)!;
  assert.deepEqual(ping.mentions, ['ops-lead']);
  assert.match(ping.body, /Dev \(lead dev-lead\): quiet \d+ min, 1 in progress \(t-dev-1\)/);
  assert.doesNotMatch(ping.body, /BA/);

  const count = messages.list(manager, 'leaders').length;
  check.run(Date.now() + 2.5 * HOUR);
  assert.equal(messages.list(manager, 'leaders').length, count, 'the same department is not flagged again within the window');
  fixture.close();
});
