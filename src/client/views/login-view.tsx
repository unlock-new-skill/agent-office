import { useState, type FormEvent, type ReactNode } from 'react';
import { errorText, login } from '../api/http.js';

export function LoginView({ onLogin }: { onLogin: (csrfToken: string) => void }): ReactNode {
  const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin(await login(password)); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  return (
    <main className="login-shell">
      <form onSubmit={event => void submit(event)} className="login-card">
        <p className="eyebrow">Local · Agent Office</p>
        <h1>Your AI company</h1>
        <p className="muted">Departments, leaders and Claude Code sessions working together.</p>
        <label htmlFor="password">Manager password</label>
        <input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoFocus autoComplete="current-password" required />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Enter office'}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
