import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** created: the process creation time as Windows reports it; with the pid it identifies one process instance. */
export type ProcessEntry = { pid: number; commandLine: string; created?: string };

/**
 * Older runners of this connector among the running processes: `node <script> runner` with nothing after it, so the
 * live-view windows (`runner watch <seat>`), the MCP server, hooks and `update` itself are never matched.
 */
export const olderRunners = (processes: ProcessEntry[], script: string, selfPid: number): number[] => {
  const file = path.basename(script).toLowerCase();
  return processes
    .filter(entry => entry.pid !== selfPid)
    .filter(entry => {
      const line = entry.commandLine.toLowerCase().trim();
      const at = line.lastIndexOf(file);
      return at >= 0 && /^"?\s+runner$/.test(line.slice(at + file.length));
    })
    .map(entry => entry.pid);
};

export const listNodeProcesses = (): ProcessEntry[] => {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine,@{n='Created';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map(item => item as { ProcessId?: unknown; CommandLine?: unknown; Created?: unknown })
    .filter(item => typeof item.ProcessId === 'number' && typeof item.CommandLine === 'string')
    .map(item => ({ pid: item.ProcessId as number, commandLine: item.CommandLine as string, ...(typeof item.Created === 'string' ? { created: item.Created } : {}) }));
};

/**
 * Windows only. The scheduled task starts the runner through wscript, which exits at once, so `schtasks /End` cannot
 * stop a running runner and `/Run` would start a second one next to it, both driving the same seats. A runner that
 * starts therefore ends any older runner of this connector, with its seats (`taskkill /T`), before taking them over;
 * the seats resume their own sessions under the new runner. If it cannot look or cannot end one, it refuses to start.
 * Elsewhere launchd/systemd already keep a single runner.
 */
export const endOlderRunners = (script: string, out: (line: string) => void, deps: { list?: () => ProcessEntry[]; kill?: (pid: number) => void; platform?: string } = {}): number[] => {
  if ((deps.platform ?? process.platform) !== 'win32') return [];
  let pids: number[];
  try {
    const all = (deps.list ?? listNodeProcesses)();
    // Only runners started before this one: two starting together must not end each other.
    const candidates = olderRunners(all, script, process.pid);
    // Order by creation time, ties (same millisecond) by pid, so of two runners exactly one ends the other. A runner
    // whose creation time is unknown cannot be ordered: refuse rather than risk ending a newer one or running beside it.
    const time = (entry: ProcessEntry | undefined): number => (entry?.created ? Date.parse(entry.created) : Number.NaN);
    const mine = time(all.find(entry => entry.pid === process.pid));
    const unknown = candidates.filter(pid => Number.isNaN(time(all.find(entry => entry.pid === pid))));
    if (candidates.length > 0 && (Number.isNaN(mine) || unknown.length > 0)) throw new Error(`no creation time for ${Number.isNaN(mine) ? 'this runner' : `runner ${unknown.join(',')}`}`);
    pids = candidates.filter(pid => { const theirs = time(all.find(entry => entry.pid === pid)); return theirs < mine || (theirs === mine && pid < process.pid); });
  }
  catch (error) { throw new Error(`could not look for an older runner (${error instanceof Error ? error.message.slice(0, 160) : String(error)}). Not starting, so two runners never drive the same seats.`); }
  const kill = deps.kill ?? ((pid: number) => { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 }); });
  for (const pid of pids) {
    try { kill(pid); out(`ended the older runner (pid ${pid}) and its seats; this runner takes them over`); }
    catch (error) { throw new Error(`could not end the older runner (pid ${pid}): ${error instanceof Error ? error.message.slice(0, 160) : String(error)}. Not starting a second runner next to it.`); }
  }
  return pids;
};
