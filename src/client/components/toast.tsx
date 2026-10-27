import type { ReactNode } from 'react';

export function Toast({ text, onClose }: { text: string | null; onClose: () => void }): ReactNode {
  if (!text) return null;
  return <div className="toast" role="alert"><span>{text}</span><button type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>×</button></div>;
}
