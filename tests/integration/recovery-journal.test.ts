import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recoverRestore, writeRestoreJournal } from '../../src/server/restore-recovery.js';

for (let completedMoves = 0; completedMoves <= 4; completedMoves++) {
  test(`restore recovery isolates old sidecars after ${completedMoves} completed renames`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-office-journal-'));
    try {
      const target = path.join(root, 'agent-office.sqlite');
      const temporary = `${target}.restore-123`;
      const previous = `${target}.before-restore-123`;
      const oldFiles = [target, `${target}-wal`, `${target}-shm`];
      const oldNames = [previous, `${previous}-wal`, `${previous}-shm`];
      const oldContents = ['previous database', 'previous WAL', 'previous SHM'];
      oldFiles.forEach((file, index) => writeFileSync(file, oldContents[index]!, { mode: 0o600 }));
      writeFileSync(temporary, 'validated replacement', { mode: 0o600 });
      writeRestoreJournal(root, { target, temporary, previous, oldFiles, oldNames });

      const moves = [...oldFiles.map((from, index) => ({ from, to: oldNames[index]! })), { from: temporary, to: target }];
      for (const move of moves.slice(0, completedMoves)) renameSync(move.from, move.to);

      recoverRestore(root);
      assert.equal(readFileSync(target, 'utf8'), 'validated replacement');
      assert.equal(existsSync(`${target}-wal`), false, 'old WAL must never attach to replacement');
      assert.equal(existsSync(`${target}-shm`), false, 'old SHM must never attach to replacement');
      oldNames.forEach((file, index) => assert.equal(readFileSync(file, 'utf8'), oldContents[index]));
      assert.equal(existsSync(temporary), false);
      assert.equal(existsSync(path.join(root, 'restore-journal.json')), false);
      recoverRestore(root);
      assert.equal(readFileSync(target, 'utf8'), 'validated replacement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
