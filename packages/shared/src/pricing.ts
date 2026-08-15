import { type Money, applyBps, apportion, clampNonNegative } from "./money.js";
import { calculateVat, depositFor, type CountryCode, type VatCategory } from "./vat.js";

/**
 * The delivery fee is evaluated on every store card in a list view, so it must be
 * a cheap pure function with no I/O.
 *
 *   fee = base(zone)
 *       + distanceComponent(km, tapered)
 *       × demandMultiplier(capped)
 *       + smallBasketSurcharge
 *       − subscriptionWaiver
 */

export interface DeliveryFeeInput {
  baseFee: Money;
  distanceKm: number;
  /** Ratio of open orders to available couriers. 1.0 = balanced. */
  demandRatio: number;
  subtotal: Money;
  minimumBasket: Money;
  freeDeliveryAbove?: Money | null;
  hasSubscription?: boolean;
}

export interface DeliveryFeeResult {
  fee: Money;
  smallBasketSurcharge: Money;
  demandMultiplierBps: number;
  waived: boolean;
}

/** Per-km rate above the first free kilometre, gross cents. */
const PER_KM = 45;
/** Distance beyond which the per-km rate halves, so long trips stay sellable. */
const TAPER_KM = 4;
/**
 * Surge is capped at 1.5×. Uncapped or undisclosed surge runs straight into
 * German unfair-competition law (UWG) — the fee must be visible before commitment.
 */
const MAX_DEMAND_BPS = 15_000;

export function calculateDeliveryFee(input: DeliveryFeeInput): DeliveryFeeResult {
  const free =
    input.hasSubscription === true ||
    (input.freeDeliveryAbove != null && input.subtotal >= input.freeDeliveryAbove);

  // Distance: first km included, then tapered so a 9km trip isn't 9× a 1km trip.
  const billableKm = Math.max(0, input.distanceKm - 1);
  const nearKm = Math.min(billableKm, TAPER_KM);
  const farKm = Math.max(0, billableKm - TAPER_KM);
  const distanceComponent = Math.round(nearKm * PER_KM + farKm * PER_KM * 0.5);

  const demandMultiplierBps = Math.min(
    MAX_DEMAND_BPS,
    Math.max(10_000, Math.round(input.demandRatio * 10_000)),
  );

  const beforeSurge = input.baseFee + distanceComponent;
  const fee = free ? 0 : applyBps(beforeSurge, demandMultiplierBps);

  // Small-basket surcharge tops the basket up to the minimum rather than
  // blocking the order outright — better conversion, same economics.
  const smallBasketSurcharge =
    input.subtotal > 0 && input.subtotal < input.minimumBasket
      ? input.minimumBasket - input.subtotal
      : 0;

  return { fee, smallBasketSurcharge, demandMultiplierBps, waived: free };
}

/** Service fee: percentage of basket, floored and capped. */
const SERVICE_FEE_BPS = 800;
const SERVICE_FEE_MIN: Money = 49;
const SERVICE_FEE_MAX: Money = 249;

export function calculateServiceFee(subtotal: Money): Money {
  const raw = applyBps(subtotal, SERVICE_FEE_BPS);
  return Math.min(SERVICE_FEE_MAX, Math.max(SERVICE_FEE_MIN, raw));
}

export interface QuoteLine {
  productId: string;
  name: string;
  unitPrice: Money;
  quantity: number;
  vatCategory: VatCategory;
  depositScheme?: string;
  optionsDelta?: Money;
  minimumAge?: number | null;
}

export interface PromotionInput {
  type: "PERCENTAGE_OFF" | "FIXED_OFF" | "FREE_DELIVERY";
  value: number;
  maxDiscount?: Money | null;
  minimumBasket?: Money;
}

export interface QuoteInput {
  lines: QuoteLine[];
  delivery: DeliveryFeeInput;
  promotion?: PromotionInput | null;
  creditAvailable?: Money;
  tipAmount?: Money;
  country?: CountryCode;
}

export interface Quote {
  itemsSubtotal: Money;
  depositTotal: Money;
  deliveryFee: Money;
  serviceFee: Money;
  smallBasketSurcharge: Money;
  discountTotal: Money;
  creditApplied: Money;
  tipAmount: Money;
  grandTotal: Money;
  vatBreakdown: Record<string, Money>;
  totalVat: Money;
  requiredAge: number | null;
}

/**
 * The single source of truth for what an order costs. The API recomputes this
 * server-side at checkout — a client-supplied total is never trusted.
 */
export function buildQuote(input: QuoteInput): Quote {
  const country = input.country ?? "DE";

  let itemsSubtotal = 0;
  let depositTotal = 0;
  let requiredAge: number | null = null;
  const taxableLines: { gross: Money; category: VatCategory }[] = [];

  for (const line of input.lines) {
    const unit = line.unitPrice + (line.optionsDelta ?? 0);
    const gross = unit * line.quantity;
    itemsSubtotal += gross;
    taxableLines.push({ gross, category: line.vatCategory });

    if (line.depositScheme) {
      depositTotal += depositFor(line.depositScheme) * line.quantity;
    }
    if (line.minimumAge != null) {
      requiredAge = Math.max(requiredAge ?? 0, line.minimumAge);
    }
  }

  const deliveryInput = { ...input.delivery, subtotal: itemsSubtotal };
  const deliveryResult = calculateDeliveryFee(deliveryInput);
  const serviceFee = calculateServiceFee(itemsSubtotal);

  // --- Promotions. The discount base EXCLUDES deposits: Pfand is a statutory
  // --- pass-through and is never discountable.
  let discountTotal = 0;
  let deliveryFee = deliveryResult.fee;
  const promo = input.promotion;
  if (promo && itemsSubtotal >= (promo.minimumBasket ?? 0)) {
    if (promo.type === "PERCENTAGE_OFF") {
      const raw = applyBps(itemsSubtotal, promo.value);
      discountTotal = promo.maxDiscount != null ? Math.min(raw, promo.maxDiscount) : raw;
    } else if (promo.type === "FIXED_OFF") {
      discountTotal = Math.min(promo.value, itemsSubtotal);
    } else {
      deliveryFee = 0;
    }
  }

  const tipAmount = input.tipAmount ?? 0;

  const beforeCredit = clampNonNegative(
    itemsSubtotal +
      depositTotal +
      deliveryFee +
      serviceFee +
      deliveryResult.smallBasketSurcharge -
      discountTotal,
  );

  const creditApplied = Math.min(input.creditAvailable ?? 0, beforeCredit);
  const grandTotal = beforeCredit - creditApplied + tipAmount;

  const vat = calculateVat({
    lines: taxableLines,
    deliveryFee: deliveryFee + deliveryResult.smallBasketSurcharge,
    serviceFee,
    depositTotal,
    discountTotal,
    tipAmount,
    country,
  });

  return {
    itemsSubtotal,
    depositTotal,
    deliveryFee,
    serviceFee,
    smallBasketSurcharge: deliveryResult.smallBasketSurcharge,
    discountTotal,
    creditApplied,
    tipAmount,
    grandTotal,
    vatBreakdown: vat.breakdown,
    totalVat: vat.totalVat,
    requiredAge,
  };
}
