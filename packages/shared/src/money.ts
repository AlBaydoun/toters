/**
 * Money is always an integer number of cents, EUR, and GROSS (VAT-inclusive).
 *
 * PAngV requires gross prices in consumer-facing surfaces, so we store gross and
 * derive net out of it. No floats: every rounding decision is explicit.
 */
export type Money = number;

export const ZERO: Money = 0;

export function add(...amounts: Money[]): Money {
  return amounts.reduce((a, b) => a + b, 0);
}

export function subtract(a: Money, b: Money): Money {
  return a - b;
}

export function multiply(amount: Money, quantity: number): Money {
  return Math.round(amount * quantity);
}

/** Basis points, so 2000 bps = 20%. Avoids percentage floats entirely. */
export function applyBps(amount: Money, bps: number): Money {
  return Math.round((amount * bps) / 10_000);
}

/** Never let a computed charge go negative. */
export function clampNonNegative(amount: Money): Money {
  return Math.max(0, amount);
}

/**
 * Distribute `total` across `weights` so the parts sum EXACTLY to the total.
 * Largest-remainder method: without it, apportioned VAT lines fail to reconcile
 * against the invoice total by a cent or two, which finance will (rightly) reject.
 */
export function apportion(total: Money, weights: number[]): Money[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    // Degenerate case: put everything on the first bucket rather than losing it.
    return weights.map((_, i) => (i === 0 ? total : 0));
  }

  const exact = weights.map((w) => (total * w) / weightSum);
  const floored = exact.map(Math.floor);
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);

  const result = [...floored];
  for (let i = 0; remainder > 0 && i < order.length; i++, remainder--) {
    result[order[i]!.index]! += 1;
  }
  return result;
}

/** German formatting: "12,34 €". */
export function formatEur(amount: Money, locale = "de-DE"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(amount / 100);
}

/**
 * PAngV Grundpreis — the per-kg / per-litre price that must appear next to the
 * selling price for goods sold by weight or volume.
 */
export function formatUnitPrice(
  price: Money,
  contentAmount: number,
  contentUnit: string,
  locale = "de-DE",
): string | null {
  if (!contentAmount || contentAmount <= 0) return null;

  // Normalise to the reference quantity the regulation expects: 1 kg or 1 l.
  let referencePrice: number;
  let referenceUnit: string;
  switch (contentUnit) {
    case "g":
      referencePrice = (price / contentAmount) * 1000;
      referenceUnit = "kg";
      break;
    case "ml":
      referencePrice = (price / contentAmount) * 1000;
      referenceUnit = "l";
      break;
    case "kg":
    case "l":
      referencePrice = price / contentAmount;
      referenceUnit = contentUnit;
      break;
    default:
      return null; // Piece goods carry no Grundpreis obligation.
  }

  const formatted = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
  }).format(referencePrice / 100);
  return `${formatted} / ${referenceUnit}`;
}
