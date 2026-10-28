import { useState, type FormEvent, type ReactNode } from 'react';
import { errorText, type Api } from '../api/http.js';

type Created = { code: string; expiresAt: number; uses: number; commands: { unix: string; windows: string } };
type Props = { api: Api; notify: (text: string) => void };
/** Commands for machines that already have the connector; they need no install code. */
const MAINTENANCE = [
  { action: 'Update connector', unix: 'node ~/.agent-office/bin/agent-office.mjs update', windows: 'node "$env:USERPROFILE\\.agent-office\\bin\\agent-office.mjs" update' },
  { action: 'Sync hooks (once after updating a connector installed before Oct 28)', unix: 'node ~/.agent-office/bin/agent-office.mjs sync-hooks', windows: 'node "$env:USERPROFILE\\.agent-office\\bin\\agent-office.mjs" sync-hooks' },
  { action: 'Uninstall', unix: 'node ~/.agent-office/bin/agent-office.mjs uninstall', windows: 'node "$env:USERPROFILE\\.agent-office\\bin\\agent-office.mjs" uninstall' },
];

/**
 * Top-bar "Connect machine": mints an install code and shows the one-line commands that connect a new machine
 * (no repo checkout needed). Opens as a dialog so it is reachable from every view right after sign-in.
 */
export function AddMachinePanel({ api, notify }: Props): ReactNode {
  const [open, setOpen] = useState(false); const [uses, setUses] = useState(1); const [created, setCreated] = useState<Created | null>(null);
  const create = (event: FormEvent): void => {
    event.preventDefault();
    api.send<Created>('POST', '/v1/install-codes', { uses, hours: 24 }).then(setCreated).catch(error => notify(errorText(error)));
  };
  const copy = (text: string): void => { navigator.clipboard.writeText(text).then(() => notify('Copied.')).catch(() => window.prompt('Copy this command:', text)); };
  const close = (): void => { setOpen(false); setCreated(null); setUses(1); };

  if (!open) return <button type="button" className="btn btn-small btn-primary" onClick={() => setOpen(true)}>Connect machine</button>;
  return (
    <div className="modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <section className="add-machine" role="dialog" aria-modal="true" aria-label="Connect machine">
      <h2>Connect a machine</h2>
      <p className="add-machine-section">New machine</p>
      {created
        ? <>
            <p className="muted">Run on the new machine (Node.js 20+ required). Valid for {created.uses} machine{created.uses > 1 ? 's' : ''} until {new Date(created.expiresAt).toLocaleString()}.</p>
            <label>macOS / Linux<span className="command-row"><code>{created.commands.unix}</code><button type="button" className="btn btn-small" onClick={() => copy(created.commands.unix)}>Copy</button></span></label>
            <label>Windows (PowerShell)<span className="command-row"><code>{created.commands.windows}</code><button type="button" className="btn btn-small" onClick={() => copy(created.commands.windows)}>Copy</button></span></label>
            <p className="muted">Then start a seated session, e.g. <code>AGENT_OFFICE_SEAT=design-atom claude</code>. Treat the code like a password.</p>
            <div className="row-actions"><button type="button" className="btn" onClick={close}>Done</button></div>
          </>
        : <form className="row-actions" onSubmit={create}>
            <p className="muted">Creates a one-line installer for Mac/Linux and Windows. Each run connects one machine (hooks + MCP); the code expires in 24 h.</p>
            <label className="inline-label">Machines<input autoFocus type="number" min={1} max={50} value={uses} onChange={event => setUses(Math.min(50, Math.max(1, Number(event.target.value) || 1)))} /></label>
            <button type="submit" className="btn btn-primary btn-small">Create install command</button>
            <button type="button" className="btn btn-small" onClick={close}>Cancel</button>
          </form>}
      <p className="add-machine-section">Machine already connected</p>
      {MAINTENANCE.map(item => (
        <div key={item.action} className="maintenance">
          <span className="muted">{item.action}</span>
          <label>macOS / Linux<span className="command-row"><code>{item.unix}</code><button type="button" className="btn btn-small" onClick={() => copy(item.unix)}>Copy</button></span></label>
          <label>Windows (PowerShell)<span className="command-row"><code>{item.windows}</code><button type="button" className="btn btn-small" onClick={() => copy(item.windows)}>Copy</button></span></label>
        </div>
      ))}
      <p className="muted">After updating, restart running Claude sessions so they load the new hooks and tools.</p>
    </section>
    </div>
  );
}
