/**
 * German is the default locale and English the fallback — not the other way
 * round. Turkish and Arabic are included because they are the largest non-German
 * language communities in Germany and this is a delivery app, not a luxury good.
 */
export type Locale = "de" | "en" | "tr" | "ar";

export const DEFAULT_LOCALE: Locale = "de";
export const RTL_LOCALES: Locale[] = ["ar"];

type Dict = Record<string, string>;

const de: Dict = {
  "order.status.AWAITING_MERCHANT": "Warten auf Bestätigung",
  "order.status.PREPARING": "Wird zubereitet",
  "order.status.AWAITING_COURIER": "Warten auf Kurier",
  "order.status.OUT_FOR_DELIVERY": "Unterwegs zu dir",
  "order.status.DELIVERED": "Geliefert",
  "order.status.CANCELLED": "Storniert",
  "cancellation.free": "Kostenlose Stornierung — der Laden hat die Bestellung noch nicht angenommen.",
  "cancellation.goodsOnly": "Die Ware wird berechnet, die Liefergebühr wird erstattet.",
  "cancellation.full": "Der Kurier ist bereits unterwegs — der volle Betrag wird berechnet.",
  "cancellation.notPossible": "Diese Bestellung kann nicht mehr storniert werden.",
  "checkout.deliveryFee": "Liefergebühr",
  "checkout.serviceFee": "Servicegebühr",
  "checkout.deposit": "Pfand",
  "checkout.discount": "Rabatt",
  "checkout.tip": "Trinkgeld",
  "checkout.total": "Gesamt",
  "checkout.vatIncluded": "inkl. MwSt.",
  "checkout.smallBasket": "Mindestbestellwert-Zuschlag",
  "age.required": "Altersnachweis erforderlich",
  "age.explain": "Der Kurier prüft bei der Übergabe deinen Ausweis.",
  "withdrawal.perishable":
    "Für verderbliche Waren und zubereitete Speisen besteht kein Widerrufsrecht (§312g Abs. 2 BGB).",
  "butler.title": "Butler",
  "butler.subtitle": "Wir holen dir alles, was aufs Rad passt.",
  "allergens.title": "Allergene",
};

const en: Dict = {
  "order.status.AWAITING_MERCHANT": "Waiting for confirmation",
  "order.status.PREPARING": "Being prepared",
  "order.status.AWAITING_COURIER": "Waiting for a courier",
  "order.status.OUT_FOR_DELIVERY": "On the way to you",
  "order.status.DELIVERED": "Delivered",
  "order.status.CANCELLED": "Cancelled",
  "cancellation.free": "Free cancellation — the store hasn't accepted yet.",
  "cancellation.goodsOnly": "You'll be charged for the goods; the delivery fee is refunded.",
  "cancellation.full": "The courier has already left — the full amount is charged.",
  "cancellation.notPossible": "This order can no longer be cancelled.",
  "checkout.deliveryFee": "Delivery fee",
  "checkout.serviceFee": "Service fee",
  "checkout.deposit": "Deposit",
  "checkout.discount": "Discount",
  "checkout.tip": "Tip",
  "checkout.total": "Total",
  "checkout.vatIncluded": "VAT included",
  "checkout.smallBasket": "Small basket surcharge",
  "age.required": "Proof of age required",
  "age.explain": "The courier will check your ID at handover.",
  "withdrawal.perishable":
    "There is no right of withdrawal for perishable goods and prepared food (§312g(2) BGB).",
  "butler.title": "Butler",
  "butler.subtitle": "We'll fetch anything that fits on a bike.",
  "allergens.title": "Allergens",
};

const DICTS: Record<Locale, Dict> = { de, en, tr: {}, ar: {} };

export function t(key: string, locale: Locale = DEFAULT_LOCALE): string {
  return DICTS[locale]?.[key] ?? DICTS[DEFAULT_LOCALE][key] ?? en[key] ?? key;
}

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

/** LMIV allergen labels — regulated wording, so it is a fixed table. */
export const ALLERGEN_LABELS: Record<string, { de: string; en: string }> = {
  GLUTEN: { de: "Glutenhaltiges Getreide", en: "Cereals containing gluten" },
  CRUSTACEANS: { de: "Krebstiere", en: "Crustaceans" },
  EGGS: { de: "Eier", en: "Eggs" },
  FISH: { de: "Fische", en: "Fish" },
  PEANUTS: { de: "Erdnüsse", en: "Peanuts" },
  SOYBEANS: { de: "Soja", en: "Soybeans" },
  MILK: { de: "Milch", en: "Milk" },
  NUTS: { de: "Schalenfrüchte", en: "Tree nuts" },
  CELERY: { de: "Sellerie", en: "Celery" },
  MUSTARD: { de: "Senf", en: "Mustard" },
  SESAME: { de: "Sesam", en: "Sesame" },
  SULPHITES: { de: "Schwefeldioxid und Sulphite", en: "Sulphur dioxide and sulphites" },
  LUPIN: { de: "Lupinen", en: "Lupin" },
  MOLLUSCS: { de: "Weichtiere", en: "Molluscs" },
};
