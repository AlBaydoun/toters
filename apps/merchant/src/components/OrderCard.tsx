import { useState } from "react";
import { formatEur } from "@liefero/shared";
import { api, type QueueOrder } from "../lib/api";

const REJECT_REASONS = [
  { key: "OUT_OF_STOCK", label: "Zutaten aus" },
  { key: "TOO_BUSY", label: "Zu viel los" },
  { key: "CLOSING", label: "Wir schließen" },
  { key: "CANNOT_FULFIL", label: "Nicht machbar" },
];

const PREP_OPTIONS = [10, 15, 20, 30, 45];

/**
 * One order in the queue.
 *
 * Accepting asks for a prep estimate rather than assuming one. The estimate
 * drives when a courier is dispatched, so a wrong default means either a courier
 * idling at the counter or food going cold waiting for one.
 */
export function OrderCard({ order, onChange }: { order: QueueOrder; onChange: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const waiting = order.minutesWaiting ?? 0;
  // A new order waiting more than five minutes is a problem the merchant needs
  // to see before the customer does.
  const urgent = order.status === "AWAITING_MERCHANT" && waiting >= 5;

  return (
    <div className="card" style={{ borderColor: urgent ? "var(--danger)" : undefined }}>
      <div className="row">
        <strong className="grow" style={{ fontSize: 18 }}>{order.reference}</strong>
        <span className="muted">{formatEur(order.itemsSubtotal)}</span>
      </div>

      <div className="row" style={{ marginTop: 4, fontSize: 14 }}>
        <span className={urgent ? "" : "muted"} style={{ color: urgent ? "var(--danger)" : undefined }}>
          {waiting} Min wartend
        </span>
        <span className="muted">· {order.destination}</span>
        {order.fulfilmentMode === "SCHEDULED" && order.scheduledFor ? (
          <span style={{ color: "var(--warn)" }}>
            · geplant {new Date(order.scheduledFor).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : null}
      </div>

      {order.requiredAge ? (
        <div style={{ marginTop: 8, color: "var(--warn)", fontSize: 14 }}>
          Altersbeschränkt (ab {order.requiredAge}) — der Kurier prüft den Ausweis.
        </div>
      ) : null}

      <ul style={{ margin: "12px 0", paddingLeft: 18, lineHeight: 1.6 }}>
        {order.items.map((item) => (
          <li key={item.id}>
            <strong>{item.quantity}×</strong> {item.name}
            {item.options.length > 0 ? (
              <span className="muted"> ({item.options.join(", ")})</span>
            ) : null}
            {item.note ? (
              <div style={{ color: "var(--warn)", fontSize: 14 }}>Notiz: {item.note}</div>
            ) : null}
          </li>
        ))}
      </ul>

      {order.courier ? (
        <div className="muted" style={{ fontSize: 14, marginBottom: 8 }}>
          Kurier: {order.courier.firstName} ({order.courier.vehicle})
        </div>
      ) : null}

      {rejecting ? (
        <div>
          <div className="muted" style={{ marginBottom: 8, fontSize: 14 }}>Grund wählen:</div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {REJECT_REASONS.map((r) => (
              <button
                key={r.key}
                className="btn-danger"
                disabled={busy}
                onClick={() => run(() => api.reject(order.id, r.key))}
              >
                {r.label}
              </button>
            ))}
            <button className="btn-secondary" onClick={() => setRejecting(false)}>Zurück</button>
          </div>
        </div>
      ) : order.status === "AWAITING_MERCHANT" ? (
        <div>
          <div className="muted" style={{ marginBottom: 8, fontSize: 14 }}>
            Annehmen — wie lange braucht ihr?
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {PREP_OPTIONS.map((minutes) => (
              <button
                key={minutes}
                className="btn-primary"
                disabled={busy}
                onClick={() => run(() => api.accept(order.id, minutes))}
              >
                {minutes} Min
              </button>
            ))}
            <button className="btn-secondary" disabled={busy} onClick={() => setRejecting(true)}>
              Ablehnen
            </button>
          </div>
        </div>
      ) : order.status === "PREPARING" ? (
        <button className="btn-primary" disabled={busy} onClick={() => run(() => api.ready(order.id))}>
          Fertig — bereit zur Abholung
        </button>
      ) : (
        <div className="muted">{statusLabel(order.status)}</div>
      )}
    </div>
  );
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    AWAITING_COURIER: "Wartet auf Kurier",
    OUT_FOR_DELIVERY: "Unterwegs zum Kunden",
    DELIVERED: "Geliefert",
  };
  return labels[status] ?? status;
}
