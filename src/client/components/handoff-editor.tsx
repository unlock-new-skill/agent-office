import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { SeatHandoff } from '../../shared/contracts.js';

type Props = { seatTitle: string; load: () => Promise<SeatHandoff | null>; save: (body: string) => Promise<void>; onClose: () => void };

/** Manager view/edit of a seat's handoff note — the memory a new session on that seat starts from. */
export function HandoffEditor({ seatTitle, load, save, onClose }: Props): ReactNode {
  const [body, setBody] = useState<string | null>(null); const [meta, setMeta] = useState('');
  // Load once per open: parents pass fresh closures on every realtime re-render, which must not clobber the draft.
  const initial = useRef({ load, onClose });
  useEffect(() => {
    let alive = true; const { load, onClose } = initial.current;
    load().then(handoff => { if (!alive) return; setBody(handoff?.body ?? ''); setMeta(handoff ? `Updated ${new Date(handoff.updatedAt).toLocaleString()} by ${handoff.updatedBy}` : 'No note yet'); }).catch(() => alive && onClose());
    return () => { alive = false; };
  }, []);
  const submit = (event: FormEvent): void => { event.preventDefault(); if (body !== null) save(body).then(onClose).catch(() => undefined); };
  return (
    <form className="seat-form" onSubmit={submit}>
      <label>Handoff note — {seatTitle}<textarea rows={8} value={body ?? ''} disabled={body === null} onChange={event => setBody(event.target.value)} maxLength={8000} /></label>
      <small className="muted">{body === null ? 'Loading…' : meta}</small>
      <div className="row-actions"><button type="submit" className="btn btn-primary" disabled={body === null}>Save</button><button type="button" className="btn" onClick={onClose}>Close</button></div>
    </form>
  );
}
