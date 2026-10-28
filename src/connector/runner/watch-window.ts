import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionStore } from '../session-store.js';
import { watchPidFile } from './session-watch.js';

const LINUX_TERMINALS: Array<[string, string[]]> = [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['xterm', ['-e']]];

const pidAlive = (file: string): number | null => {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null; }
};

const has = (command: string): boolean => { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } };

/**
 * Opens a desktop terminal window running `runner watch <seat>` (read-only live view of the seat's session), unless one
 * is already open. macOS: a .command file opened in Terminal; Windows: a new console via `start`; Linux: the first
 * available terminal emulator when a display is present. Returns why nothing was opened, or null on success.
 */
export const openWatchWindow = (store: SessionStore, seatId: string, script: string, node = process.execPath): string | null => {
  if (pidAlive(watchPidFile(store, seatId))) return 'already open';
  const args = [script, 'runner', 'watch', seatId];
  if (process.platform === 'darwin') {
    const dir = path.join(store.home, 'watch'); mkdirSync(dir, { recursive: true });
    const launcher = path.join(dir, `${seatId}.command`);
    writeFileSync(launcher, `#!/bin/sh\nexec "${node}" "${script}" runner watch ${seatId}\n`); chmodSync(launcher, 0o700);
    spawn('open', ['-a', 'Terminal', launcher], { detached: true, stdio: 'ignore' }).unref();
    return null;
  }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', `Agent Office @${seatId}`, node, ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return null;
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'no desktop session';
  const terminal = LINUX_TERMINALS.find(([command]) => has(command));
  if (!terminal) return 'no terminal emulator found';
  spawn(terminal[0], [...terminal[1], node, ...args], { detached: true, stdio: 'ignore' }).unref();
  return null;
};

/** Closes the seat's watch window process, if one is open (its window then shows the process ended). */
export const closeWatchWindow = (store: SessionStore, seatId: string): void => {
  const pid = pidAlive(watchPidFile(store, seatId));
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
};
