import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { parseOfficeConfig } from '../../src/server/collaboration/seed.js';
import { exampleOfficeYaml } from '../helpers/office-fixture.js';

test('example office yaml parses into 4 departments and 14 seats', () => {
  const config = parseOfficeConfig(exampleOfficeYaml());
  assert.equal(config.departments.length, 4);
  assert.equal(config.departments.flatMap(department => department.seats).length, 14);
});

test('invalid office yaml is rejected', () => {
  assert.throws(() => parseOfficeConfig('departments:\n  - id: a\n    name: A\n    seats:\n      - { id: x, title: X, role: leader }\n      - { id: y, title: Y, role: leader }\n'), /more than one leader/);
  assert.throws(() => parseOfficeConfig('departments:\n  - id: a\n    name: A\n    seats:\n      - { id: x, title: X, role: boss }\n'));
  assert.throws(() => parseOfficeConfig('departments:\n  - id: leaders\n    name: L\n'), /reserved/);
  assert.throws(() => parseOfficeConfig('departments: !!js/function "function () {}"'));
});

test('opening a schema v1 database requires a reset', () => {
  const db = new Database({ filename: ':memory:' });
  db.raw.exec('PRAGMA user_version=1');
  assert.throws(() => (db as unknown as { migrate: () => void }).migrate(), /schema_reset_required/);
  db.close();
});
