import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Seat } from '../../shared/contracts.js';
import { mentionQueryAt } from '../state/mentions.js';

type Props = { channelLabel: string; seats: Seat[]; onSend: (body: string) => Promise<void> };

export function Composer({ channelLabel, seats, onSend }: Props): ReactNode {
  const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [active, setActive] = useState(0);
  const [query, setQuery] = useState<{ query: string; start: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null); const inputId = useId();
  // "@all" heads the list: it mentions every seat in the channel.
  const everyone = { id: 'all', title: 'Everyone in this channel' } as Seat;
  const suggestions = query ? [...('all'.startsWith(query.query) || 'everyone'.startsWith(query.query) ? [everyone] : []), ...seats.filter(seat => seat.id.startsWith(query.query) || seat.title.toLowerCase().includes(query.query))].slice(0, 6) : [];

  const update = (value: string, caret: number): void => { setText(value); setQuery(mentionQueryAt(value, caret)); setActive(0); };
  const choose = (seat: Seat): void => {
    if (!query) return;
    const caret = input.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, query.start)}@${seat.id} ${text.slice(caret)}`; const position = query.start + seat.id.length + 2;
    setText(next); setQuery(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position); });
  };
  const submit = async (): Promise<void> => {
    if (!text.trim() || sending) return;
    setSending(true);
    try { await onSend(text); setText(''); setQuery(null); } finally { setSending(false); input.current?.focus(); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((active + 1) % suggestions.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((active - 1 + suggestions.length) % suggestions.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(suggestions[active]!); return; }
      if (event.key === 'Escape') { setQuery(null); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };

  return (
    <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {suggestions.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Mention a seat">
          {suggestions.map((seat, index) => (
            <li key={seat.id} role="option" aria-selected={index === active}>
              <button type="button" className={index === active ? 'active' : ''} onMouseDown={event => { event.preventDefault(); choose(seat); }}><b>@{seat.id}</b><span>{seat.title}</span></button>
            </li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor={inputId}>Message {channelLabel}</label>
      <textarea id={inputId} ref={input} rows={2} value={text} placeholder={`Message ${channelLabel} — @ to mention a seat, Shift+Enter for newline`}
        onChange={event => update(event.target.value, event.target.selectionStart)} onKeyDown={onKeyDown} maxLength={16_384} />
      <button type="submit" className="btn btn-primary" disabled={sending || !text.trim()}>{sending ? 'Sending…' : 'Send'}</button>
    </form>
  );
}
