import { type Money, applyBps, clampNonNegative } from "./money.js";

/**
 * The customer wallet: prepaid balance they can top up and spend on future
 * orders.
 *
 * The regulatory shape of this matters more than the feature does.
 *
 * Holding customer funds that can be spent is, by default, issuing electronic
 * money — which in Germany needs a BaFin licence under the ZAG, and operating
 * without one is a criminal offence (§63 ZAG). What keeps this feature legal is
 * the LIMITED NETWORK EXCEPTION (§2 Abs. 1 Nr. 10 ZAG, PSD2 Art. 3(k)): a
 * balance spendable only on the issuer's own goods and services is not e-money.
 *
 * Three properties preserve that exemption, and each is enforced here:
 *
 *  1. Balance is spendable ONLY on our own orders. Never transferable to another
 *     user, never withdrawable as cash. Cash redeemability at par on demand is
 *     the defining characteristic of e-money.
 *  2. Purchased balance is tracked separately from granted balance. Money the
 *     customer paid is refundable to their original payment method — that is
 *     consumer protection, not cash redemption. Cashback and goodwill were never
 *     their money and are not refundable.
 *  3. Volume under the exception is monitored, because exceeding €1m in twelve
 *     months triggers a notification duty to BaFin (§2 Abs. 2 ZAG).
 */

/** Where a unit of balance came from. Drives refundability and spend order. */
export type BalanceBucket = "PURCHASED" | "GRANTED";

export interface WalletBalance {
  /** Money the customer paid us. Refundable to source. */
  purchased: Money;
  /** Cashback, goodwill, promotions. Never refundable for money. */
  granted: Money;
  total: Money;
}

export function walletBalance(purchased: Money, granted: Money): WalletBalance {
  return { purchased, granted, total: purchased + granted };
}

/**
 * How a spend is split across the two buckets.
 *
 * Granted balance is spent FIRST because it expires and purchased balance does
 * not. Spending the customer's own money first while their cashback quietly
 * expired would be indefensible.
 */
export interface SpendPlan {
  fromGranted: Money;
  fromPurchased: Money;
  total: Money;
  shortfall: Money;
}

export function planSpend(balance: WalletBalance, amount: Money): SpendPlan {
  const requested = clampNonNegative(amount);
  const fromGranted = Math.min(balance.granted, requested);
  const fromPurchased = Math.min(balance.purchased, requested - fromGranted);
  const total = fromGranted + fromPurchased;

  return { fromGranted, fromPurchased, total, shortfall: requested - total };
}

// ---------------------------------------------------------------------------
// Top-up
// ---------------------------------------------------------------------------

export const MIN_TOPUP: Money = 1000;
export const MAX_TOPUP: Money = 20_000;
/**
 * Ceiling on a stored balance. Partly product sense, partly risk: a large stored
 * balance makes the account a target and makes us look more like a bank.
 */
export const MAX_WALLET_BALANCE: Money = 50_000;

export interface TopUpTier {
  /** Minimum amount to qualify, gross cents. */
  threshold: Money;
  /** Bonus in basis points on the topped-up amount. */
  bonusBps: number;
}

/**
 * Deposit more, get a bonus. The bonus lands in the GRANTED bucket: it is not
 * the customer's money, so it must not be refundable as money.
 */
export const TOPUP_TIERS: TopUpTier[] = [
  { threshold: 2000, bonusBps: 300 },   // €20+ → 3%
  { threshold: 5000, bonusBps: 500 },   // €50+ → 5%
  { threshold: 10_000, bonusBps: 800 }, // €100+ → 8%
];

export interface TopUpQuote {
  /** What the customer is charged. */
  amount: Money;
  /** Bonus granted on top. */
  bonus: Money;
  bonusBps: number;
  /** What lands in the wallet in total. */
  credited: Money;
  /** Next tier, so the UI can nudge without lying about the current one. */
  nextTier: { threshold: Money; bonusBps: number; extraNeeded: Money } | null;
}

export function quoteTopUp(amount: Money, tiers: TopUpTier[] = TOPUP_TIERS): TopUpQuote {
  const qualifying = tiers
    .filter((t) => amount >= t.threshold)
    .sort((a, b) => b.bonusBps - a.bonusBps)[0];

  const bonusBps = qualifying?.bonusBps ?? 0;
  const bonus = applyBps(amount, bonusBps);

  const next = tiers
    .filter((t) => t.threshold > amount)
    .sort((a, b) => a.threshold - b.threshold)[0];

  return {
    amount,
    bonus,
    bonusBps,
    credited: amount + bonus,
    nextTier: next
      ? { threshold: next.threshold, bonusBps: next.bonusBps, extraNeeded: next.threshold - amount }
      : null,
  };
}

export type TopUpRejection =
  | "BELOW_MINIMUM"
  | "ABOVE_MAXIMUM"
  | "WOULD_EXCEED_WALLET_CAP";

export function validateTopUp(
  amount: Money,
  currentBalance: Money,
): { ok: true } | { ok: false; reason: TopUpRejection } {
  if (amount < MIN_TOPUP) return { ok: false, reason: "BELOW_MINIMUM" };
  if (amount > MAX_TOPUP) return { ok: false, reason: "ABOVE_MAXIMUM" };
  // Checked against the charged amount plus bonus, since both land in the wallet.
  if (currentBalance + quoteTopUp(amount).credited > MAX_WALLET_BALANCE) {
    return { ok: false, reason: "WOULD_EXCEED_WALLET_CAP" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Refunds of unused balance
// ---------------------------------------------------------------------------

export interface RefundabilityResult {
  refundable: Money;
  /** Granted balance that cannot be paid out, with the reason stated. */
  nonRefundable: Money;
  explanation: string;
}

/**
 * What we can pay back if a customer asks to close their wallet.
 *
 * Only purchased balance, and only what is unspent. Refunding granted balance as
 * money would convert a marketing accrual into cash redemption, which is exactly
 * the property that would make this e-money.
 */
export function refundableBalance(balance: WalletBalance): RefundabilityResult {
  return {
    refundable: balance.purchased,
    nonRefundable: balance.granted,
    explanation:
      balance.granted > 0
        ? "Aufgeladenes Guthaben zahlen wir auf dein Zahlungsmittel zurück. Cashback und Bonusguthaben sind vom Umtausch in Geld ausgeschlossen."
        : "Aufgeladenes Guthaben zahlen wir auf dein Zahlungsmittel zurück.",
  };
}

/**
 * Aggregate volume passing through the limited-network exception.
 *
 * Exceeding €1,000,000 over twelve months triggers a notification duty to BaFin
 * under §2 Abs. 2 ZAG. Discovering that after the fact is far worse than
 * tracking it, so the threshold is in code and surfaces a warning band early.
 */
export const ZAG_NOTIFICATION_THRESHOLD: Money = 100_000_000;

export interface ZagStatus {
  twelveMonthVolume: Money;
  notificationRequired: boolean;
  approachingThreshold: boolean;
  note: string;
}

export function assessZagThreshold(twelveMonthVolume: Money): ZagStatus {
  const notificationRequired = twelveMonthVolume >= ZAG_NOTIFICATION_THRESHOLD;
  // Warn at 80%, because a BaFin notification is not a same-week task.
  const approachingThreshold =
    !notificationRequired && twelveMonthVolume >= ZAG_NOTIFICATION_THRESHOLD * 0.8;

  return {
    twelveMonthVolume,
    notificationRequired,
    approachingThreshold,
    note: notificationRequired
      ? "Notification to BaFin required under §2 Abs. 2 ZAG: limited-network payment volume exceeded €1m over twelve months."
      : approachingThreshold
        ? "Approaching the €1m limited-network threshold (§2 Abs. 2 ZAG). Begin the BaFin notification now."
        : "Within the limited-network exception.",
  };
}

// ---------------------------------------------------------------------------
// Tipping after delivery
// ---------------------------------------------------------------------------

/**
 * Tips can be added after the fact, which is when people actually know whether
 * the delivery was good.
 *
 * The window is bounded so a charge cannot appear against a card days later, and
 * the tip is never funded from wallet balance: a tip paid out of cashback we
 * granted would mean paying the courier with our own marketing budget while the
 * customer takes the credit for it.
 */
export const TIP_WINDOW_HOURS = 48;
export const MAX_TIP: Money = 5000;

export type TipRejection = "WINDOW_CLOSED" | "ABOVE_MAXIMUM" | "NOT_DELIVERED" | "NO_COURIER";

export function validateLateTip(
  amount: Money,
  deliveredAt: Date | null,
  hasCourier: boolean,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: TipRejection } {
  if (!deliveredAt) return { ok: false, reason: "NOT_DELIVERED" };
  if (!hasCourier) return { ok: false, reason: "NO_COURIER" };
  if (amount > MAX_TIP) return { ok: false, reason: "ABOVE_MAXIMUM" };

  const hoursSince = (now.getTime() - deliveredAt.getTime()) / 3_600_000;
  if (hoursSince > TIP_WINDOW_HOURS) return { ok: false, reason: "WINDOW_CLOSED" };

  return { ok: true };
}
