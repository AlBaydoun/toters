import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCashback, clawbackAmount, displayRateBps, formatRate,
  cashbackExpiryFrom, TIER_CASHBACK_BPS, CASHBACK_CAP_PER_ORDER,
  MAX_TOTAL_CASHBACK_BPS, type CashbackCampaign,
} from "./cashback.js";

const base = {
  itemsSubtotal: 2000,
  discountTotal: 0,
  creditApplied: 0,
  depositTotal: 0,
  tipAmount: 0,
  tier: "BRONZE" as const,
};

test("cashback is a straight percentage of goods spend", () => {
  const result = calculateCashback(base);
  assert.equal(result.effectiveBps, TIER_CASHBACK_BPS.BRONZE);
  assert.equal(result.eligibleBase, 2000);
  assert.equal(result.amount, 40); // 2% of €20
});

test("higher tiers earn more on the same basket", () => {
  const bronze = calculateCashback({ ...base, tier: "BRONZE" }).amount;
  const silver = calculateCashback({ ...base, tier: "SILVER" }).amount;
  const gold = calculateCashback({ ...base, tier: "GOLD" }).amount;
  assert.ok(bronze < silver && silver < gold);
  assert.equal(gold, 100); // 5% of €20
});

test("credit-funded spend earns nothing — no minting credit from credit", () => {
  // The whole basket paid with existing balance.
  const fullyCredit = calculateCashback({ ...base, creditApplied: 2000 });
  assert.equal(fullyCredit.eligibleBase, 0);
  assert.equal(fullyCredit.amount, 0);

  // Half paid with credit earns on the half actually paid.
  const half = calculateCashback({ ...base, creditApplied: 1000 });
  assert.equal(half.eligibleBase, 1000);
  assert.equal(half.amount, 20);
});

test("Pfand and tips never earn cashback", () => {
  const withPassThroughs = calculateCashback({
    ...base,
    depositTotal: 150,
    tipAmount: 300,
  });
  // Neither reaches the earn base.
  assert.equal(withPassThroughs.eligibleBase, 2000);
  assert.equal(withPassThroughs.amount, 40);
});

test("discounts reduce the earn base — you earn on what you paid", () => {
  const result = calculateCashback({ ...base, discountTotal: 500 });
  assert.equal(result.eligibleBase, 1500);
  assert.equal(result.amount, 30);
});

test("a discount larger than the basket cannot produce negative cashback", () => {
  const result = calculateCashback({ ...base, discountTotal: 99_999 });
  assert.equal(result.eligibleBase, 0);
  assert.equal(result.amount, 0);
});

test("campaign boosts stack on the tier rate", () => {
  const campaign: CashbackCampaign = {
    id: "c1", bonusBps: 500, merchantId: null, fundedBy: "PLATFORM", label: "Launch week",
  };
  const result = calculateCashback({ ...base, campaigns: [campaign] });
  assert.equal(result.effectiveBps, TIER_CASHBACK_BPS.BRONZE + 500);
  assert.equal(result.campaignBps, 500);
  assert.equal(result.appliedCampaigns[0]?.id, "c1");
});

test("a merchant-scoped campaign does not apply to other merchants", () => {
  const campaign: CashbackCampaign = {
    id: "c1", bonusBps: 800, merchantId: "merchant_a", fundedBy: "MERCHANT", label: "Store deal",
  };

  const matching = calculateCashback({ ...base, campaigns: [campaign], merchantId: "merchant_a" });
  assert.equal(matching.campaignBps, 800);

  const other = calculateCashback({ ...base, campaigns: [campaign], merchantId: "merchant_b" });
  assert.equal(other.campaignBps, 0);
  assert.equal(other.appliedCampaigns.length, 0);
});

test("stacked campaigns cannot exceed the ceiling", () => {
  const campaigns: CashbackCampaign[] = [
    { id: "a", bonusBps: 1000, merchantId: null, fundedBy: "PLATFORM", label: "A" },
    { id: "b", bonusBps: 1000, merchantId: null, fundedBy: "MERCHANT", label: "B" },
  ];
  const result = calculateCashback({ ...base, campaigns });
  assert.equal(result.effectiveBps, MAX_TOTAL_CASHBACK_BPS);
});

test("a large order is capped, and the cap is reported", () => {
  // €300 catering at 5% would be €15, more than the order contributes.
  const result = calculateCashback({ ...base, itemsSubtotal: 30_000, tier: "GOLD" });
  assert.equal(result.amount, CASHBACK_CAP_PER_ORDER);
  assert.equal(result.capped, true);

  const small = calculateCashback(base);
  assert.equal(small.capped, false);
});

test("refunds claw back cashback proportionally, never more than granted", () => {
  const awarded = 100;
  const eligibleBase = 2000;

  assert.equal(clawbackAmount(awarded, 2000, eligibleBase), 100); // full refund
  assert.equal(clawbackAmount(awarded, 1000, eligibleBase), 50);  // half refund
  assert.equal(clawbackAmount(awarded, 0, eligibleBase), 0);

  // A refund exceeding the base must not reverse more than was ever awarded.
  assert.equal(clawbackAmount(awarded, 99_999, eligibleBase), 100);
  assert.equal(clawbackAmount(0, 2000, eligibleBase), 0);
});

test("the advertised rate is the one this customer actually gets", () => {
  const campaigns: CashbackCampaign[] = [
    { id: "a", bonusBps: 300, merchantId: "merchant_a", fundedBy: "MERCHANT", label: "A" },
  ];
  // Advertising someone else's better rate would be misleading under the UWG.
  assert.equal(displayRateBps("BRONZE", campaigns, "merchant_a"), 500);
  assert.equal(displayRateBps("BRONZE", campaigns, "merchant_b"), 200);
  assert.equal(displayRateBps("GOLD", campaigns, "merchant_a"), 800);
});

test("rates format without trailing noise", () => {
  assert.equal(formatRate(200), "2%");
  assert.equal(formatRate(250), "2.5%");
  assert.equal(formatRate(500), "5%");
});

test("cashback credit is valid for three years, matching §195 BGB", () => {
  const issued = new Date("2026-01-01T00:00:00Z");
  const expiry = cashbackExpiryFrom(issued);
  const years = (expiry.getTime() - issued.getTime()) / (365 * 86_400_000);
  // A materially shorter window risks being void under §307 BGB.
  assert.ok(years >= 2.9 && years <= 3.1, `expected ~3 years, got ${years}`);
});
