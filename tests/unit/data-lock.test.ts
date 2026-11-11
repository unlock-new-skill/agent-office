import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DataLock } from '../../src/server/data-lock.js';

test('a lock left with our own pid (container restart, PID 1 again) is taken over', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-lock-'));
  writeFileSync(path.join(dir, 'agent-office.lock'), JSON.stringify({ pid: process.pid, startedAt: '2026-11-11T00:00:00.000Z' }));
  const lock = new DataLock(dir);
  assert.doesNotThrow(() => lock.acquire());
  lock.release();
});

test('a lock held by another live process still refuses to start', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-lock-'));
  writeFileSync(path.join(dir, 'agent-office.lock'), JSON.stringify({ pid: process.ppid }));
  assert.throws(() => new DataLock(dir).acquire(), /daemon_already_running/);
});
