import { useState } from "react";
import { api } from "../lib/api";

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Anmeldung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 20 }}>
      <form className="card" style={{ width: "100%", maxWidth: 380 }} onSubmit={submit}>
        <h1 style={{ marginTop: 0, fontSize: 24 }}>Liefero Partner</h1>
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          <input
            type="email"
            placeholder="E-Mail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
          <input
            type="password"
            placeholder="Passwort"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error ? <div style={{ color: "var(--danger)", fontSize: 14 }}>{error}</div> : null}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Anmelden…" : "Anmelden"}
          </button>
        </div>
      </form>
    </div>
  );
}
