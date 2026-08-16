import { useCallback, useEffect, useState } from "react";
import { formatEur, ALLERGEN_LABELS } from "@liefero/shared";
import { api, type MerchantProduct } from "../lib/api";

const ALLERGENS = Object.keys(ALLERGEN_LABELS);

const ADDITIVES = [
  { key: "MIT_FARBSTOFF", label: "mit Farbstoff" },
  { key: "MIT_KONSERVIERUNGSSTOFF", label: "mit Konservierungsstoff" },
  { key: "MIT_ANTIOXIDATIONSMITTEL", label: "mit Antioxidationsmittel" },
  { key: "MIT_GESCHMACKSVERSTAERKER", label: "mit Geschmacksverstärker" },
  { key: "GESCHWEFELT", label: "geschwefelt" },
  { key: "GESCHWAERZT", label: "geschwärzt" },
  { key: "GEWACHST", label: "gewachst" },
  { key: "MIT_PHOSPHAT", label: "mit Phosphat" },
  { key: "MIT_SUESSUNGSMITTEL", label: "mit Süßungsmittel" },
  { key: "KOFFEINHALTIG", label: "koffeinhaltig" },
  { key: "CHININHALTIG", label: "chininhaltig" },
];

export function MenuScreen() {
  const [products, setProducts] = useState<MerchantProduct[]>([]);
  const [editing, setEditing] = useState<MerchantProduct | null>(null);

  const load = useCallback(async () => setProducts(await api.products()), []);
  useEffect(() => { void load(); }, [load]);

  const blocked = products.filter((p) => p.blockedReason === "MISSING_ALLERGEN_DATA");

  return (
    <div style={{ padding: 20, display: "grid", gap: 16 }}>
      <h2 style={{ margin: 0 }}>Speisekarte</h2>

      {blocked.length > 0 ? (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong style={{ color: "var(--danger)" }}>
            {blocked.length} Artikel brauchen Allergenangaben
          </strong>
          <div className="muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
            Die EU-Lebensmittelinformationsverordnung verlangt, dass Allergene vor Vertragsschluss
            bekannt sind. Ohne Angabe blockieren wir den Verkauf — das schützt euch vor Bußgeldern.
          </div>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        {products.map((product) => (
          <div key={product.id} className="card">
            <div className="row">
              <div className="grow">
                <strong>{product.name}</strong>
                <div className="muted" style={{ fontSize: 14 }}>
                  {formatEur(product.price)}
                  {product.category ? ` · ${product.category.name}` : ""}
                  {product.minimumAge ? ` · ab ${product.minimumAge}` : ""}
                </div>
                {product.blockedReason === "MISSING_ALLERGEN_DATA" ? (
                  <div style={{ color: "var(--danger)", fontSize: 14, marginTop: 4 }}>
                    Nicht verkaufbar — Allergenangaben fehlen
                  </div>
                ) : null}
              </div>

              <button
                className={product.isAvailable ? "btn-secondary" : "btn-primary"}
                onClick={async () => {
                  await api.setAvailability(product.id, !product.isAvailable);
                  await load();
                }}
              >
                {product.isAvailable ? "Ausverkauft" : "Wieder da"}
              </button>

              <button className="btn-secondary" onClick={() => setEditing(product)}>
                Allergene
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing ? (
        <FoodInfoEditor
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      ) : null}
    </div>
  );
}

/**
 * The LMIV declaration editor.
 *
 * The confirmation checkbox is separate from the allergen list on purpose:
 * "contains none of the 14" is a valid and common declaration, so completeness
 * cannot be inferred from a non-empty list. Making the merchant assert it also
 * puts the legal statement where it belongs — with them.
 */
function FoodInfoEditor({
  product,
  onClose,
  onSaved,
}: {
  product: MerchantProduct;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allergens, setAllergens] = useState<string[]>(product.allergens);
  const [additives, setAdditives] = useState<string[]>(product.additives);
  const [confirmed, setConfirmed] = useState(product.allergenDataComplete);
  const [saving, setSaving] = useState(false);

  function toggle(list: string[], set: (v: string[]) => void, key: string) {
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div className="card" style={{ maxWidth: 640, width: "100%", maxHeight: "90vh", overflow: "auto" }}>
        <h3 style={{ marginTop: 0 }}>{product.name}</h3>
        <p className="muted" style={{ lineHeight: 1.5 }}>
          Welche der 14 kennzeichnungspflichtigen Allergene sind enthalten?
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ALLERGENS.map((key) => (
            <button
              key={key}
              className={allergens.includes(key) ? "btn-primary" : "btn-secondary"}
              onClick={() => toggle(allergens, setAllergens, key)}
            >
              {ALLERGEN_LABELS[key]?.de ?? key}
            </button>
          ))}
        </div>

        <p className="muted" style={{ marginTop: 20, lineHeight: 1.5 }}>
          Zusatzstoffe (LMIDV):
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ADDITIVES.map((a) => (
            <button
              key={a.key}
              className={additives.includes(a.key) ? "btn-primary" : "btn-secondary"}
              onClick={() => toggle(additives, setAdditives, a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        <label
          className="row"
          style={{ marginTop: 20, gap: 12, cursor: "pointer", alignItems: "flex-start" }}
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            style={{ width: 24, height: 24, minHeight: 24, marginTop: 2 }}
          />
          <span style={{ lineHeight: 1.5 }}>
            Ich bestätige, dass diese Angaben vollständig und korrekt sind.
            {allergens.length === 0 ? (
              <strong> Dieses Produkt enthält keines der 14 Allergene.</strong>
            ) : null}
          </span>
        </label>

        <div className="row" style={{ marginTop: 20 }}>
          <button
            className="btn-primary grow"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await api.saveFoodInfo(product.id, { allergens, additives, confirmed });
                onSaved();
              } finally {
                setSaving(false);
              }
            }}
          >
            Speichern
          </button>
          <button className="btn-secondary" onClick={onClose}>Abbrechen</button>
        </div>
      </div>
    </div>
  );
}
