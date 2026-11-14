import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type ProcessEntry = { pid: number; commandLine: string };

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

const listNodeProcesses = (): ProcessEntry[] => {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map(item => item as { ProcessId?: unknown; CommandLine?: unknown })
    .filter(item => typeof item.ProcessId === 'number' && typeof item.CommandLine === 'string')
    .map(item => ({ pid: item.ProcessId as number, commandLine: item.CommandLine as string }));
};

/**
 * Windows only. The scheduled task starts the runner through wscript, which exits at once, so `schtasks /End` cannot
 * stop a running runner and `/Run` would start a second one next to it, both driving the same seats. A runner that
 * starts therefore ends any older runner of this connector, with its seats (`taskkill /T`), before taking them over;
 * the seats resume their own sessions under the new runner. If one cannot be ended this runner refuses to start.
 * Elsewhere launchd/systemd already keep a single runner.
 */
export const endOlderRunners = (script: string, out: (line: string) => void, deps: { list?: () => ProcessEntry[]; kill?: (pid: number) => void; platform?: string } = {}): number[] => {
  if ((deps.platform ?? process.platform) !== 'win32') return [];
  let pids: number[];
  try { pids = olderRunners((deps.list ?? listNodeProcesses)(), script, process.pid); }
  catch (error) { out(`could not look for an older runner (${error instanceof Error ? error.message.slice(0, 160) : String(error)}); starting anyway`); return []; }
  const kill = deps.kill ?? ((pid: number) => { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 }); });
  for (const pid of pids) {
    try { kill(pid); out(`ended the older runner (pid ${pid}) and its seats; this runner takes them over`); }
    catch (error) { throw new Error(`could not end the older runner (pid ${pid}): ${error instanceof Error ? error.message.slice(0, 160) : String(error)}. Not starting a second runner next to it.`); }
  }
  return pids;
};
