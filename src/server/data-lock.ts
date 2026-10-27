import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const activePid = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export class DataLock {
  private fd: number | null = null;
  private readonly file: string;
  constructor(private readonly dataDir: string) { this.file = path.join(dataDir, 'agent-office.lock'); }

  acquire(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      try {
        const record = JSON.parse(readFileSync(this.file, 'utf8')) as { pid?: number };
        if (record.pid && activePid(record.pid)) throw new Error('daemon_already_running');
      } catch (error) {
        if (error instanceof Error && error.message === 'daemon_already_running') throw error;
        throw new Error('daemon_lock_unreadable');
      }
      unlinkSync(this.file);
    }
    this.fd = openSync(this.file, 'wx', 0o600);
    writeFileSync(this.fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  }

  release(): void {
    if (this.fd === null) return;
    closeSync(this.fd); this.fd = null;
    try { unlinkSync(this.file); } catch { /* already removed */ }
  }
}

export const assertDaemonStopped = (dataDir: string): void => {
  const lock = new DataLock(dataDir);
  try { lock.acquire(); } finally { lock.release(); }
};
