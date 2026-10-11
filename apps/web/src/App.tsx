import { useEffect, useState } from 'react';
import { devToken, setDevToken } from './api';
import { IncidentPage } from './pages/Incident';
import { IncidentsPage } from './pages/Incidents';

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function TokenBar() {
  const [token, setToken] = useState(devToken() ?? '');
  const [open, setOpen] = useState(false);
  return (
    <div className="token">
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {devToken() ? 'Local dev token set' : 'Local dev token'}
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setDevToken(token.trim() || null);
            window.location.reload();
          }}
        >
          <input
            aria-label="Local dev token"
            placeholder="npm run -s dev:token -- --role viewer"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit">Use</button>
        </form>
      )}
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  const match = route.match(/^#\/incidents\/([A-Za-z0-9_]+)$/);
  return (
    <div className="shell">
      <header className="top">
        <a href="#/" className="brand">
          DataTrust
        </a>
        <span className="muted">incidents (read only)</span>
        <TokenBar />
      </header>
      <main>{match?.[1] ? <IncidentPage id={match[1]} /> : <IncidentsPage />}</main>
    </div>
  );
}
