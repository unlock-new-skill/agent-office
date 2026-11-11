import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureClaudeSetup, mcpEntry } from '../../src/connector/claude-setup.js';

const node = '/usr/local/bin/node'; const connector = '/Volumes/new-drive/.agent-office/bin/agent-office.mjs';

const withConfigDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-claude-setup-'));
  const before = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = dir;
  try { run(dir); } finally { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; }
};

test('re-adds missing hooks and leaves a set-up machine alone', () => {
  withConfigDir(dir => {
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'agent-office': mcpEntry(node, connector) } }));
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    const first = ensureClaudeSetup(node, connector, 120);
    assert.equal(first.problem, null);
    assert.equal(first.fixed.length, 1);
    const settings = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { model: string; hooks: Record<string, unknown> };
    assert.equal(settings.model, 'opus');
    assert.ok(settings.hooks.Stop && settings.hooks.SessionStart);

    const second = ensureClaudeSetup(node, connector, 120);
    assert.deepEqual(second, { fixed: [], problem: null }, 'nothing to fix the second time');
    assert.equal(readdirSync(dir).filter(name => name.includes('.bak-agent-office-')).length, 1, 'no new backup when nothing changed');
  });
});

test('a broken settings.json is reported, not overwritten', () => {
  withConfigDir(dir => {
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'agent-office': mcpEntry(node, '/Volumes/old-drive/agent-office.mjs') } }));
    writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    assert.match(ensureClaudeSetup(node, connector, 120).problem ?? '', /not valid JSON/, 'broken settings are reported, not overwritten');
    assert.equal(readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ not json');
  });
});
