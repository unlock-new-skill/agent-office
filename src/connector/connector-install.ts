import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type InstallStep = 'checkpoint' | 'backed-up' | 'installed' | 'hooks-synced' | 'restarting' | 'restarted' | 'taken-over'
  | 'installed-no-service' | 'rolled-back' | 'failed';
/** Running runners of this connector: pid → identity (pid + creation time; Windows reuses pids). */
export type RunnerSnapshot = Map<number, string>;

/** What install-self leaves on disk before and after each mutation, for a later check or rollback. */
export type InstallCheckpoint = {
  at: string; target: string; from: string | null; to: string; connectorBackup: string | null; settingsBackup: string | null;
  step: InstallStep; detail: string;
};

export type InstallDeps = {
  /** This file's bytes, read once: the same buffer is hashed and written, so nothing can swap them in between. */
  source: Uint8Array;
  home: string;
  pinned: string;
  now: () => Date;
  /** Runs `sync-hooks` with the installed file; returns the settings backup path it reported (null when none). */
  syncHooks: (target: string) => string | null;
  /** Restarts the runner service; false when no service is installed. */
  restart: (target: string) => boolean;
  /** Windows: the runners running now. The old ones must be gone and a new one running once the new runner has taken over. */
  runners?: () => RunnerSnapshot;
  /** Ends a runner with its process tree (a new runner that did not take over in time). */
  endRunner?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Puts the previous settings file back when the new runner never took over (rollback of the hook sync). */
  restoreSettings?: (backup: string) => void;
  takeoverWaitMs?: number;
  out?: (line: string) => void;
};

/**
 * Installs `source` as `<home>/bin/agent-office.mjs` only if it hashes to the pinned value, so the bytes that run
 * afterwards are exactly the ones that were checked (no second download). Order, each step recorded first in a
 * checkpoint file written before anything changes: keep the current connector under a new backup name (never
 * overwriting one), install, sync the Agent Office hooks, restart the runner. On Windows the older runner must then
 * disappear and a new one run (the new one ends the old with its seats, possibly including this process). If that has
 * not happened when the wait is over, any new runner is ended, the previous connector and settings are put back, and
 * if no runner is left the previous version is started once. Every failure stops at once; nothing is retried.
 */
export const installConnector = async (deps: InstallDeps): Promise<InstallCheckpoint> => {
  const out = deps.out ?? (() => undefined);
  const mine = sha256(deps.source);
  if (mine !== deps.pinned) throw new Error(`this file is ${mine}, not the pinned ${deps.pinned}; nothing was changed`);
  const target = path.join(deps.home, 'bin', 'agent-office.mjs');
  const stamp = deps.now().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const backup = `${target}.bak-${stamp}`;
  const file = path.join(deps.home, `rollout-${stamp}.json`);
  for (const taken of [backup, file]) if (existsSync(taken)) throw new Error(`${taken} already exists; nothing was changed`);
  // Taken before any change: if the runners cannot be listed, nothing is installed.
  const older = deps.runners?.() ?? new Map<number, string>();
  const current = existsSync(target) ? readFileSync(target) : null;
  const record: InstallCheckpoint = { at: deps.now().toISOString(), target, from: current ? sha256(current) : null, to: deps.pinned, connectorBackup: current ? backup : null, settingsBackup: null, step: 'checkpoint', detail: '' };
  const save = (step: InstallStep, detail = ''): void => {
    record.step = step; record.detail = detail;
    writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  };
  const fail = (detail: string): never => { save('failed', detail); throw new Error(`${detail} (checkpoint ${file})`); };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (current) {
      writeFileSync(backup, current, { flag: 'wx' });
      if (sha256(readFileSync(backup)) !== record.from) fail('the backup does not match the current connector; the connector was not changed');
      save('backed-up');
    }
    writeFileSync(`${target}.tmp`, deps.source); renameSync(`${target}.tmp`, target);
    const installed = sha256(readFileSync(target));
    if (installed !== deps.pinned) fail(`installed file is ${installed}, not ${deps.pinned}; restore ${backup}`);
    save('installed');
    record.settingsBackup = deps.syncHooks(target); save('hooks-synced');
    save('restarting', older.size > 0 ? `older runner pids ${[...older.keys()].join(',')}` : '');
    if (!deps.restart(target)) { save('installed-no-service', 'no runner service: start the runner yourself'); return record; }
    save('restarted');
    if (!deps.runners) return record;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const known = new Set(older.values());
    // A listing that fails while waiting or rolling back is noted, never a reason to leave the new connector half in place.
    const notes: string[] = [];
    const look = (): { oldAlive: boolean; fresh: number[] } | null => {
      try {
        const now = deps.runners!();
        return { oldAlive: [...now.values()].some(id => known.has(id)), fresh: [...now].filter(([, id]) => !known.has(id)).map(([pid]) => pid) };
      } catch (error) { notes.push(`could not list the runners (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`); return null; }
    };
    const tookOver = (seen: ReturnType<typeof look>): boolean => seen !== null && !seen.oldAlive && seen.fresh.length > 0;
    const deadline = deps.now().getTime() + (deps.takeoverWaitMs ?? 90_000);
    let seen = look();
    while (deps.now().getTime() < deadline) {
      if (tookOver(seen)) { save('taken-over', `new runner pid ${seen!.fresh.join(',')}`); return record; }
      await sleep(2000); seen = look();
    }
    if (tookOver(seen)) { save('taken-over', `new runner pid ${seen!.fresh.join(',')}`); return record; }
    // No clean takeover in time: end every new runner (listed right before it is ended, so a reused pid is not hit),
    // put the previous files back, then end any new runner that appeared meanwhile, so none can take over late.
    const ended: number[] = [];
    const endNewRunners = (): void => {
      let now: RunnerSnapshot;
      try { now = deps.runners!(); } catch (error) { notes.push(`could not list the runners to end new ones (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`); return; }
      for (const [pid, id] of now) {
        if (known.has(id) || ended.includes(pid)) continue;
        try { deps.endRunner?.(pid); ended.push(pid); }
        catch (error) { notes.push(`could not end new runner ${pid} (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`); }
      }
    };
    endNewRunners();
    if (current) { writeFileSync(`${target}.tmp`, current); renameSync(`${target}.tmp`, target); }
    if (record.settingsBackup && deps.restoreSettings) deps.restoreSettings(record.settingsBackup);
    endNewRunners();
    const left = look();
    const restarted = left !== null && !left.oldAlive && left.fresh.length === 0 && current !== null && deps.restart(target);
    const files = current ? `previous connector${record.settingsBackup ? ' and settings' : ''} restored` : `no previous connector to restore; the new one stays${record.settingsBackup ? ', previous settings restored' : ''}`;
    save('rolled-back', [`${seen === null ? 'the runners could not be listed' : seen.oldAlive ? 'the old runner was still running' : 'no runner had taken over'} after the wait`,
      `ended new runner ${ended.join(',') || 'none'}`, files, ...(restarted ? ['started the previous version once'] : []), ...notes].join('; '));
    out(current ? `the new runner did not take over; restored the previous connector (${record.from})` : 'the new runner did not take over; there was no previous connector to restore');
    return record;
  } catch (error) {
    if (record.step !== 'failed') { try { save('failed', error instanceof Error ? error.message.slice(0, 300) : String(error)); } catch { /* keep the original error */ } }
    throw error;
  }
};
