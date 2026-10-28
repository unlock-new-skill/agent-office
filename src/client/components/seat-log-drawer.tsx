import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RunnerCommand, RunnerLogEntry } from '../../shared/contracts.js';
import type { Api } from '../api/http.js';

type Props = { seatId: string; title: string; api: Api; live: RunnerLogEntry[]; liveCommands: RunnerCommand[]; onClose: () => void };

const KIND_LABEL: Record<RunnerLogEntry['kind'], string> = { text: 'says', tool: 'tool', result: 'turn', error: 'error', state: 'runner', prompt: 'prompt' };
const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Live log of a runner seat (what the agent says and which tools it runs) plus the audit of manager commands. */
export function SeatLogDrawer({ seatId, title, api, live, liveCommands, onClose }: Props): ReactNode {
  const [history, setHistory] = useState<RunnerLogEntry[]>([]); const [commands, setCommands] = useState<RunnerCommand[]>([]);
  const bottom = useRef<HTMLLIElement>(null);

  useEffect(() => {
    void api.get<{ entries: RunnerLogEntry[] }>(`/v1/seats/${seatId}/runner-log`).then(result => setHistory(result.entries)).catch(() => undefined);
    void api.get<{ commands: RunnerCommand[] }>(`/v1/seats/${seatId}/runner-commands`).then(result => setCommands(result.commands)).catch(() => undefined);
  }, [api, seatId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = useMemo(() => {
    const last = history.at(-1)?.ts ?? 0;
    return [...history, ...live.filter(entry => entry.ts > last)].slice(-300);
  }, [history, live]);
  const audit = useMemo(() => {
    const byId = new Map(commands.map(command => [command.id, command]));
    for (const command of liveCommands) byId.set(command.id, command);
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  }, [commands, liveCommands]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [entries.length]);

  return (
    <aside className="log-drawer" role="dialog" aria-label={`Live log of ${title}`}>
      <header className="thread-head">
        <strong>{title}</strong><span className="muted">@{seatId} · live log</span><span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close log" onClick={onClose}>✕</button>
      </header>
      <ol className="log-entries">
        {entries.length === 0 && <li className="muted">Nothing yet — the log fills while the runner works.</li>}
        {entries.map((entry, index) => (
          <li key={`${entry.ts}-${index}`} className={`log-entry kind-${entry.kind}`}><time>{time(entry.ts)}</time><span className="log-kind">{KIND_LABEL[entry.kind]}</span><span className="log-text">{entry.summary}</span></li>
        ))}
        <li ref={bottom} aria-hidden="true" className="log-end" />
      </ol>
      <section className="log-audit">
        <h3>Commands</h3>
        {audit.length === 0 ? <p className="muted">No commands yet.</p> : (
          <ul>{audit.map(command => <li key={command.id}><time>{time(command.createdAt)}</time> <strong>{command.kind}</strong> by {command.requestedBy} — {command.status}{command.result ? `: ${command.result}` : ''}{command.text ? <span className="muted"> “{command.text.slice(0, 80)}”</span> : null}</li>)}</ul>
        )}
      </section>
    </aside>
  );
}
