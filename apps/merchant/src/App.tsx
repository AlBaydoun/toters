import { useCallback, useEffect, useState } from "react";
import { api, isSignedIn, signOut, type StoreInfo } from "./lib/api";
import { LoginScreen } from "./screens/LoginScreen";
import { QueueScreen } from "./screens/QueueScreen";
import { MenuScreen } from "./screens/MenuScreen";
import { StatementScreen } from "./screens/StatementScreen";

type Tab = "queue" | "menu" | "statement";

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [tab, setTab] = useState<Tab>("queue");
  const [store, setStore] = useState<StoreInfo | null>(null);

  const loadStore = useCallback(async () => {
    if (!signedIn) return;
    try {
      setStore(await api.store());
    } catch {
      // A 401 has already cleared the token; drop back to the login screen.
      setSignedIn(isSignedIn());
    }
  }, [signedIn]);

  useEffect(() => { void loadStore(); }, [loadStore]);

  if (!signedIn) {
    return <LoginScreen onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <header
        style={{
          display: "flex", gap: 12, alignItems: "center", padding: "12px 20px",
          borderBottom: "1px solid var(--border)", position: "sticky", top: 0,
          background: "var(--bg)", zIndex: 10,
        }}
      >
        <strong style={{ flex: 1 }}>{store?.name ?? "Liefero Partner"}</strong>
        {(["queue", "menu", "statement"] as Tab[]).map((t) => (
          <button
            key={t}
            className={tab === t ? "btn-primary" : "btn-secondary"}
            onClick={() => setTab(t)}
          >
            {t === "queue" ? "Bestellungen" : t === "menu" ? "Speisekarte" : "Abrechnung"}
          </button>
        ))}
        <button
          className="btn-secondary"
          onClick={() => { signOut(); setSignedIn(false); }}
        >
          Abmelden
        </button>
      </header>

      {tab === "queue" ? <QueueScreen store={store} onStoreChange={loadStore} /> : null}
      {tab === "menu" ? <MenuScreen /> : null}
      {tab === "statement" ? <StatementScreen /> : null}
    </div>
  );
}
