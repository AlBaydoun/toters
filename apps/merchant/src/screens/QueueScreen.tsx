import { useCallback, useEffect, useState } from "react";
import { api, type QueueOrder, type StoreInfo } from "../lib/api";
import { OrderCard } from "../components/OrderCard";

const POLL_MS = 8_000;

/**
 * The queue is the console. Everything else is a settings page a merchant opens
 * once a month.
 *
 * New orders are split out from in-progress ones because they are the only thing
 * with a clock running against them — mixing them into one list is how orders
 * get missed on a busy service.
 */
export function QueueScreen({ store, onStoreChange }: { store: StoreInfo | null; onStoreChange: () => void }) {
  const [orders, setOrders] = useState<QueueOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrders(await api.orders("live"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verbindung verloren");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const incoming = orders.filter((o) => o.status === "AWAITING_MERCHANT");
  const inProgress = orders.filter((o) => o.status !== "AWAITING_MERCHANT");
  const paused = store?.status === "PAUSED";

  async function togglePause() {
    setPausing(true);
    try {
      await api.pause(!paused);
      onStoreChange();
    } finally {
      setPausing(false);
    }
  }

  return (
    <div style={{ padding: 20, display: "grid", gap: 20 }}>
      {paused ? (
        <div className="card" style={{ borderColor: "var(--warn)", background: "#2A2415" }}>
          <strong style={{ color: "var(--warn)" }}>Laden pausiert</strong>
          <div className="muted" style={{ marginTop: 4 }}>
            Kunden können gerade nicht bei euch bestellen.
          </div>
        </div>
      ) : null}

      {/* Compliance problems cost orders silently, so they surface on the screen
          the merchant actually looks at. */}
      {store && store.compliance.productsBlockedByMissingAllergens > 0 ? (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong style={{ color: "var(--danger)" }}>
            {store.compliance.productsBlockedByMissingAllergens} Produkte nicht verkaufbar
          </strong>
          <div className="muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
            Ohne vollständige Allergenangaben dürfen diese Artikel nicht verkauft werden (LMIV).
            Sie erscheinen nicht in der App. Unter „Speisekarte" ergänzen.
          </div>
        </div>
      ) : null}

      {error ? <div className="card" style={{ borderColor: "var(--danger)" }}>{error}</div> : null}

      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Neue Bestellungen {incoming.length > 0 ? `(${incoming.length})` : ""}
        </h2>
        <button className={paused ? "btn-primary" : "btn-secondary"} disabled={pausing} onClick={togglePause}>
          {paused ? "Laden öffnen" : "Laden pausieren"}
        </button>
      </div>

      {incoming.length === 0 ? (
        <div className="muted">Keine neuen Bestellungen.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {incoming.map((o) => <OrderCard key={o.id} order={o} onChange={load} />)}
        </div>
      )}

      <h2 style={{ margin: "8px 0 0" }}>In Arbeit ({inProgress.length})</h2>
      {inProgress.length === 0 ? (
        <div className="muted">Nichts in Arbeit.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {inProgress.map((o) => <OrderCard key={o.id} order={o} onChange={load} />)}
        </div>
      )}
    </div>
  );
}
