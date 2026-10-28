import type { ReactNode } from 'react';

/** A shell command with a Copy button (falls back to a prompt dialog where the clipboard API is unavailable). */
export function CommandRow({ text, notify }: { text: string; notify: (text: string) => void }): ReactNode {
  const copy = (): void => { navigator.clipboard.writeText(text).then(() => notify('Copied.')).catch(() => window.prompt('Copy this command:', text)); };
  return <span className="command-row"><code>{text}</code><button type="button" className="btn btn-small" onClick={copy}>Copy</button></span>;
}
