import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateTranscriptPath } from '../../src/adapters/transcripts/path-validator.js';

test('transcript validator accepts only private files under trusted roots', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-office-transcript-')); const file = path.join(root, 'session.jsonl'); writeFileSync(file, '{}', { mode: 0o600 });
  try { assert.equal(validateTranscriptPath(file, [root]), realpathSync(file)); chmodSync(file, 0o644); assert.throws(() => validateTranscriptPath(file, [root]), /unsafe_transcript_file/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
