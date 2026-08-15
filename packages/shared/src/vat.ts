import { type Money, apportion } from "./money.js";

/**
 * German VAT (Umsatzsteuer) for a delivery marketplace.
 *
 * The subtle rule: a delivery charge is a Nebenleistung (ancillary supply) to the
 * goods, so it follows the VAT rate of the MAIN supply rather than carrying a flat
 * 19%. For a mixed basket (7% groceries + 19% beer) the fee must be apportioned
 * pro rata across rate buckets. Same for the service fee.
 *
 * Prices in this system are GROSS, so VAT is extracted out of the gross amount:
 *   vat = gross - (gross / (1 + rate))
 */

export type VatCategory =
  | "FOOD_REDUCED"
  | "BEVERAGE_STANDARD"
  | "GOODS_STANDARD"
  | "SERVICE_STANDARD";

export type CountryCode = "DE" | "AT" | "NL";

/** Rates in basis points. */
export interface VatProfile {
  reduced: number;
  standard: number;
}

const PROFILES: Record<CountryCode, VatProfile> = {
  DE: { reduced: 700, standard: 1900 },
  AT: { reduced: 1000, standard: 2000 },
  NL: { reduced: 900, standard: 2100 },
};

export function vatProfile(country: CountryCode): VatProfile {
  return PROFILES[country];
}

export function rateFor(category: VatCategory, country: CountryCode = "DE"): number {
  const profile = vatProfile(country);
  return category === "FOOD_REDUCED" ? profile.reduced : profile.standard;
}

/** Extract the VAT contained in a gross amount. */
export function vatFromGross(gross: Money, rateBps: number): Money {
  return gross - Math.round((gross * 10_000) / (10_000 + rateBps));
}

export interface TaxableLine {
  gross: Money;
  category: VatCategory;
}

export interface VatInput {
  lines: TaxableLine[];
  deliveryFee: Money;
  serviceFee: Money;
  /** Pfand is taxed at the standard rate. */
  depositTotal: Money;
  /** Reduces the taxable base; apportioned like the fees. */
  discountTotal: Money;
  /** Tips are not consideration for a supply by us — excluded from the base. */
  tipAmount: Money;
  country?: CountryCode;
}

export interface VatResult {
  /** Gross total that VAT was computed on (tips excluded). */
  taxableGross: Money;
  /** rateBps -> VAT amount. §14 UStG requires rates shown separately. */
  breakdown: Record<string, Money>;
  totalVat: Money;
}

/**
 * Apportion fees and discounts across rate buckets by net line weight, then
 * extract VAT per bucket.
 */
export function calculateVat(input: VatInput): VatResult {
  const country = input.country ?? "DE";

  // Bucket the item lines by rate.
  const buckets = new Map<number, Money>();
  for (const line of input.lines) {
    const rate = rateFor(line.category, country);
    buckets.set(rate, (buckets.get(rate) ?? 0) + line.gross);
  }

  // A basket of nothing but fees still has to be taxed somewhere.
  if (buckets.size === 0) {
    buckets.set(vatProfile(country).standard, 0);
  }

  const rates = [...buckets.keys()].sort((a, b) => a - b);
  const weights = rates.map((r) => buckets.get(r) ?? 0);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // Ancillary supplies follow the main supply, so they ride the same weights.
  const apportionable = input.deliveryFee + input.serviceFee;
  const feeParts =
    weightSum > 0
      ? apportion(apportionable, weights)
      : rates.map((_, i) => (i === rates.length - 1 ? apportionable : 0));

  const discountParts =
    weightSum > 0 ? apportion(input.discountTotal, weights) : rates.map(() => 0);

  const standardRate = vatProfile(country).standard;
  const breakdown: Record<string, Money> = {};
  let totalVat = 0;
  let taxableGross = 0;

  rates.forEach((rate, i) => {
    let gross = (buckets.get(rate) ?? 0) + (feeParts[i] ?? 0) - (discountParts[i] ?? 0);
    // Pfand always sits at the standard rate, regardless of what it is attached to.
    if (rate === standardRate) gross += input.depositTotal;

    const vat = vatFromGross(gross, rate);
    breakdown[String(rate)] = (breakdown[String(rate)] ?? 0) + vat;
    totalVat += vat;
    taxableGross += gross;
  });

  // Guard: a standard-rate bucket must exist if there is any deposit to tax.
  if (input.depositTotal > 0 && !rates.includes(standardRate)) {
    const vat = vatFromGross(input.depositTotal, standardRate);
    breakdown[String(standardRate)] = (breakdown[String(standardRate)] ?? 0) + vat;
    totalVat += vat;
    taxableGross += input.depositTotal;
  }

  return { taxableGross, breakdown, totalVat };
}

/** Pfand amounts under VerpackG, in gross cents. */
export const DEPOSIT_AMOUNTS: Record<string, Money> = {
  NONE: 0,
  ONE_WAY_025: 25,
  REUSABLE_008: 8,
  REUSABLE_015: 15,
  CRATE_150: 150,
};

export function depositFor(scheme: string): Money {
  return DEPOSIT_AMOUNTS[scheme] ?? 0;
}
