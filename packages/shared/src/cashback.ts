import { type Money, applyBps, clampNonNegative } from "./money.js";

/**
 * Cashback: a percentage of what the customer actually spent, returned as
 * spendable credit when the order is delivered.
 *
 * Distinct from loyalty points, which need a redemption threshold before they
 * are worth anything. Cashback is money, immediately, which is why it converts
 * better and why the rules around it have to be tighter.
 *
 * Four rules do the real work here, and each exists because of a specific way
 * this goes wrong:
 *
 *  1. Earned on money PAID, not on basket value. If credit-funded spend earned
 *     cashback, a customer could recycle the same balance and mint credit out of
 *     nothing. At 5% it converges rather than exploding, but it is still free
 *     money for no revenue, and it is trivially farmable.
 *  2. Pfand is excluded. It is a statutory pass-through; paying cashback on it
 *     means paying people to collect deposits.
 *  3. Tips are excluded. That money belongs to the courier and was never ours.
 *  4. Capped per order, so one large catering order cannot cost more in cashback
 *     than the order earned in contribution.
 */

export type LoyaltyTier = "BRONZE" | "SILVER" | "GOLD";

/** Base earn rate in basis points. 200 bps = 2%. */
export const TIER_CASHBACK_BPS: Record<LoyaltyTier, number> = {
  BRONZE: 200,
  SILVER: 300,
  GOLD: 500,
};

/**
 * Ceiling per order, gross cents. Without it, a €300 office catering order at
 * 5% hands back €15, which is more than the order contributes.
 */
export const CASHBACK_CAP_PER_ORDER: Money = 500;

/** Campaign boosts stack on the tier rate but the total is capped here. */
export const MAX_TOTAL_CASHBACK_BPS = 1500;

export interface CashbackCampaign {
  id: string;
  /** Additional basis points on top of the tier rate. */
  bonusBps: number;
  /** Null = platform-wide. */
  merchantId?: string | null;
  /** Who absorbs the cost. Merchant-funded boosts are the sustainable kind. */
  fundedBy: "PLATFORM" | "MERCHANT";
  label: string;
}

export interface CashbackInput {
  /** Gross value of the goods, before discounts. */
  itemsSubtotal: Money;
  /** Promotional discount already applied to the order. */
  discountTotal: Money;
  /** Existing credit spent on this order. Excluded from the earn base. */
  creditApplied: Money;
  /** Pfand. Never earns. */
  depositTotal: Money;
  /** Courier tip. Never earns. */
  tipAmount: Money;
  tier: LoyaltyTier;
  campaigns?: CashbackCampaign[];
  merchantId?: string | null;
}

export interface CashbackResult {
  /** What the customer will receive, gross cents. */
  amount: Money;
  /** The spend the rate was applied to, after every exclusion. */
  eligibleBase: Money;
  /** Combined rate actually used, after stacking and the ceiling. */
  effectiveBps: number;
  tierBps: number;
  campaignBps: number;
  /** True when the cap bit — surfaced so the UI can say so honestly. */
  capped: boolean;
  appliedCampaigns: { id: string; label: string; bonusBps: number }[];
}

export function calculateCashback(input: CashbackInput): CashbackResult {
  const tierBps = TIER_CASHBACK_BPS[input.tier];

  const applicable = (input.campaigns ?? []).filter(
    (c) => c.merchantId == null || c.merchantId === input.merchantId,
  );
  const campaignBps = applicable.reduce((sum, c) => sum + c.bonusBps, 0);

  const effectiveBps = Math.min(MAX_TOTAL_CASHBACK_BPS, tierBps + campaignBps);

  // The earn base is what the customer actually paid us for goods: basket, less
  // discounts, less any credit they spent, less the pass-through items.
  const eligibleBase = clampNonNegative(
    input.itemsSubtotal - input.discountTotal - input.creditApplied,
  );

  const raw = applyBps(eligibleBase, effectiveBps);
  const amount = Math.min(raw, CASHBACK_CAP_PER_ORDER);

  return {
    amount,
    eligibleBase,
    effectiveBps,
    tierBps,
    campaignBps: effectiveBps - tierBps,
    capped: raw > CASHBACK_CAP_PER_ORDER,
    appliedCampaigns: applicable.map((c) => ({ id: c.id, label: c.label, bonusBps: c.bonusBps })),
  };
}

/**
 * How much cashback to reverse when an order is refunded.
 *
 * Without this, order-and-refund is a way to farm credit. Proportional to the
 * refund so a partial refund reverses a partial award, and never more than was
 * granted.
 */
export function clawbackAmount(
  awarded: Money,
  refundedGoods: Money,
  originalEligibleBase: Money,
): Money {
  if (awarded <= 0 || originalEligibleBase <= 0) return 0;
  const proportion = Math.min(1, refundedGoods / originalEligibleBase);
  return Math.min(awarded, Math.round(awarded * proportion));
}

/**
 * Expiry for issued cashback credit.
 *
 * German law is the constraint here, not product preference. The general
 * limitation period is three years (§195 BGB), and a materially shorter expiry
 * buried in T&Cs is a candidate for being void as an unreasonable
 * disadvantage under §307 BGB. A short punitive window is therefore not just
 * hostile, it is probably unenforceable — so we do not use one.
 */
export const CASHBACK_EXPIRY_DAYS = 3 * 365;

export function cashbackExpiryFrom(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + CASHBACK_EXPIRY_DAYS * 86_400_000);
}

/**
 * The headline rate to advertise on a store card.
 *
 * Advertising a rate the customer will not actually receive is misleading under
 * the UWG, so this returns the rate that a customer at THIS tier would earn,
 * never the best rate available to anyone.
 */
export function displayRateBps(
  tier: LoyaltyTier,
  campaigns: CashbackCampaign[],
  merchantId: string | null,
): number {
  const applicable = campaigns.filter((c) => c.merchantId == null || c.merchantId === merchantId);
  return Math.min(
    MAX_TOTAL_CASHBACK_BPS,
    TIER_CASHBACK_BPS[tier] + applicable.reduce((s, c) => s + c.bonusBps, 0),
  );
}

export function formatRate(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}
