import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class DurableSpool {
  private readonly file: string;
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); this.file = path.join(directory, 'telemetry.ndjson'); if (!existsSync(this.file)) { closeSync(openSync(this.file, 'wx', 0o600)); } else chmodSync(this.file, 0o600); }
  append(value: unknown): void {
    const line = `${JSON.stringify(value)}\n`; const fd = openSync(this.file, 'a', 0o600); try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
  }
  size(): number { return statSync(this.file).size; }
  async drain(send: (value: unknown) => Promise<boolean>, maxBytes = 256 * 1024 * 1024): Promise<{ sent: number; remaining: number }> {
    if (this.size() > maxBytes) throw new Error('spool_overflow');
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean); let sent = 0;
    while (sent < lines.length) { if (!(await send(JSON.parse(lines[sent]!)))) break; sent += 1; }
    const remainder = lines.slice(sent); const temporary = `${this.file}.tmp-${process.pid}`; writeFileSync(temporary, remainder.length ? `${remainder.join('\n')}\n` : '', { mode: 0o600 }); renameSync(temporary, this.file); return { sent, remaining: remainder.length };
  }
}
