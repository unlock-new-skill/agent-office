import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { RunnerCommand, RunnerCommandKind, RunnerSeat, RunnerView } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';
import { runnerSeatFor, type OfficeState } from '../state/office-store.js';
import { SeatLogDrawer } from './seat-log-drawer.js';

type Props = {
  runner: RunnerView; seat: RunnerSeat; lastCommand: RunnerCommand | undefined;
  onCommand: (kind: RunnerCommandKind, text?: string) => Promise<void>; onOpenLog: () => void;
};

const STATE_LABEL: Record<RunnerSeat['state'], string> = { starting: 'starting', running: 'working', idle: 'listening', stopped: 'stopped', failed: 'failed' };

/** Remote control for a seat run headless by a machine's runner. Stop and Restart need a second click to confirm. */
export function RunnerControls({ runner, seat, lastCommand, onCommand, onOpenLog }: Props): ReactNode {
  const [confirming, setConfirming] = useState<'stop' | 'restart' | null>(null);
  const [prompting, setPrompting] = useState(false); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const send = (kind: RunnerCommandKind, prompt?: string): void => {
    setBusy(true);
    void onCommand(kind, prompt).then(() => { if (kind === 'prompt') { setText(''); setPrompting(false); } }).finally(() => setBusy(false));
  };
  const guarded = (kind: 'stop' | 'restart'): void => {
    if (confirming === kind) { setConfirming(null); send(kind); return; }
    setConfirming(kind); if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirming(null), 4000);
  };
  const submit = (event: FormEvent): void => { event.preventDefault(); if (text.trim()) send('prompt', text.trim()); };
  const stopped = seat.state === 'stopped' || seat.state === 'failed';
  const disabled = busy || !runner.online;

  return (
    <div className="runner-box">
      <div className="runner-line">
        <span className={`runner-state state-${seat.state}`}>⚙ {STATE_LABEL[seat.state]}</span>
        <span className="muted runner-machine" title={`Runner on ${runner.machine} · permission mode ${seat.permissionMode}`}>{runner.machine}{runner.online ? '' : ' · offline'}</span>
        {seat.restarts > 0 && <span className="muted">· {seat.restarts} restart{seat.restarts === 1 ? '' : 's'}</span>}
      </div>
      {seat.detail && (seat.state === 'starting' || seat.state === 'failed') && <div className="runner-detail muted">{seat.detail}</div>}
      <div className="runner-actions">
        {stopped
          ? <button type="button" className="btn btn-small btn-primary" disabled={disabled} onClick={() => send('start')}>Start</button>
          : <>
              <button type="button" className={`btn btn-small ${confirming === 'stop' ? 'btn-warn' : ''}`} disabled={disabled} onClick={() => guarded('stop')}>{confirming === 'stop' ? 'Confirm stop' : 'Stop'}</button>
              <button type="button" className={`btn btn-small ${confirming === 'restart' ? 'btn-warn' : ''}`} disabled={disabled} onClick={() => guarded('restart')}>{confirming === 'restart' ? 'Confirm restart' : 'Restart'}</button>
              <button type="button" className="btn btn-small" disabled={disabled || seat.state !== 'running'} onClick={() => send('interrupt')} title="Stop the current turn; the session stays">Interrupt</button>
            </>}
        <button type="button" className="btn btn-small" disabled={disabled || stopped} aria-expanded={prompting} onClick={() => setPrompting(!prompting)}>Prompt</button>
        <button type="button" className="btn btn-small" onClick={onOpenLog}>Log</button>
      </div>
      {prompting && (
        <form className="runner-prompt" onSubmit={submit}>
          <label className="sr-only" htmlFor={`prompt-${seat.seatId}`}>Prompt for @{seat.seatId}</label>
          <textarea id={`prompt-${seat.seatId}`} rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder={`Message @${seat.seatId} directly (queued if it is busy)`} autoFocus
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event); }} />
          <div className="row-actions"><button type="submit" className="btn btn-small btn-primary" disabled={busy || !text.trim()}>Send</button><button type="button" className="btn btn-small" onClick={() => setPrompting(false)}>Cancel</button></div>
        </form>
      )}
      {lastCommand && <div className={`runner-last muted status-${lastCommand.status}`}>{lastCommand.kind}: {lastCommand.status}{lastCommand.result ? ` — ${lastCommand.result}` : ''}</div>}
    </div>
  );
}

/** Runner controls and live-log drawer for one seat; renders nothing when no runner offers the seat. */
export function SeatRunnerPanel({ seatId, title, state, api, notify }: { seatId: string; title: string; state: OfficeState; api: Api; notify: (text: string) => void }): ReactNode {
  const [logOpen, setLogOpen] = useState(false); const close = useCallback(() => setLogOpen(false), []);
  const found = runnerSeatFor(state, seatId);
  if (!found) return null;
  const commands = state.runnerCommands[seatId] ?? [];
  const onCommand = (kind: RunnerCommandKind, text?: string): Promise<void> => api.send<RunnerCommand>('POST', `/v1/seats/${seatId}/runner-commands`, text ? { kind, text } : { kind })
    .then(() => notify(`${kind} sent to @${seatId}.`)).catch(error => { notify(errorText(error)); throw error; });
  return (
    <>
      <RunnerControls runner={found.runner} seat={found.seat} lastCommand={commands[0]} onCommand={onCommand} onOpenLog={() => setLogOpen(true)} />
      {logOpen && <SeatLogDrawer seatId={seatId} title={title} api={api} live={state.runnerLogs[seatId] ?? []} liveCommands={commands} onClose={close} />}
    </>
  );
}
