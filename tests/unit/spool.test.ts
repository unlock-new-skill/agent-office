import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableSpool } from '../../src/connector/spool.js';

test('DurableSpool retains failed delivery and drains idempotently', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-spool-')); const spool = new DurableSpool(dir);
  try {
    spool.append({ id: 'a' }); spool.append({ id: 'b' });
    let calls = 0; const first = await spool.drain(async () => { calls += 1; return calls === 1; });
    assert.deepEqual(first, { sent: 1, remaining: 1 });
    const second = await spool.drain(async value => (value as { id: string }).id === 'b');
    assert.deepEqual(second, { sent: 1, remaining: 0 }); assert.equal(spool.size(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
