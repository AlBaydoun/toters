import { useEffect, useState } from "react";
import { formatEur } from "@liefero/shared";
import { api, type Statement } from "../lib/api";

function monthRange(offset = 0) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Commission appears as its own line rather than being netted off silently.
 * The P2B Regulation requires the terms to be transparent, and a merchant who
 * cannot see the deduction will assume the worst about it.
 */
export function StatementScreen() {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const { from, to } = monthRange(offset);
    void api.statement(from, to).then(setStatement).catch(() => setStatement(null));
  }, [offset]);

  return (
    <div style={{ padding: 20, display: "grid", gap: 16 }}>
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Abrechnung</h2>
        <button className="btn-secondary" onClick={() => setOffset((o) => o - 1)}>Vorheriger Monat</button>
        {offset < 0 ? (
          <button className="btn-secondary" onClick={() => setOffset((o) => o + 1)}>Nächster</button>
        ) : null}
      </div>

      {!statement ? (
        <div className="muted">Keine Daten für diesen Zeitraum.</div>
      ) : (
        <>
          <div className="card" style={{ display: "grid", gap: 8 }}>
            <Line label={`Warenwert (${statement.orderCount} Bestellungen)`} value={statement.goodsTotal} />
            {statement.depositTotal > 0 ? (
              <Line label="Pfand (durchlaufend)" value={statement.depositTotal} />
            ) : null}
            <Line
              label={`Provision (${(statement.commissionBps / 100).toFixed(1)} %)`}
              value={-statement.commission}
              negative
            />
            <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
            <div className="row">
              <strong className="grow">Auszahlung</strong>
              <strong style={{ fontSize: 20 }}>{formatEur(statement.payout)}</strong>
            </div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 4 }}>
              Auf Pfand wird keine Provision berechnet — es ist ein gesetzlich durchlaufender Posten.
            </div>
          </div>

          <div className="card">
            <strong>Einzelne Bestellungen</strong>
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                    <th style={{ padding: "6px 8px" }}>Referenz</th>
                    <th style={{ padding: "6px 8px" }}>Datum</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Waren</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Provision</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.orders.map((o) => (
                    <tr key={o.reference} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 8px" }}>{o.reference}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {o.deliveredAt ? new Date(o.deliveredAt).toLocaleDateString("de-DE") : "—"}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>{formatEur(o.goods)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--muted)" }}>
                        −{formatEur(o.commission)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Line({ label, value, negative }: { label: string; value: number; negative?: boolean }) {
  return (
    <div className="row">
      <span className="grow muted">{label}</span>
      <span style={{ color: negative ? "var(--muted)" : undefined }}>{formatEur(value)}</span>
    </div>
  );
}
