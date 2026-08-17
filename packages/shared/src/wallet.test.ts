import { test } from "node:test";
import assert from "node:assert/strict";
import {
  walletBalance, planSpend, quoteTopUp, validateTopUp, refundableBalance,
  assessZagThreshold, validateLateTip,
  MIN_TOPUP, MAX_TOPUP, MAX_WALLET_BALANCE, ZAG_NOTIFICATION_THRESHOLD,
  TIP_WINDOW_HOURS, MAX_TIP,
} from "./wallet.js";

test("granted balance is spent before purchased, because it expires", () => {
  const balance = walletBalance(5000, 300);
  const plan = planSpend(balance, 1000);

  // Spending the customer's own money while their cashback quietly expired
  // would be indefensible.
  assert.equal(plan.fromGranted, 300);
  assert.equal(plan.fromPurchased, 700);
  assert.equal(plan.total, 1000);
  assert.equal(plan.shortfall, 0);
});

test("a spend larger than the wallet reports a shortfall rather than overdrawing", () => {
  const plan = planSpend(walletBalance(500, 200), 2000);
  assert.equal(plan.total, 700);
  assert.equal(plan.shortfall, 1300);
});

test("spending against an empty wallet is a no-op, not a negative balance", () => {
  const plan = planSpend(walletBalance(0, 0), 1000);
  assert.equal(plan.fromGranted, 0);
  assert.equal(plan.fromPurchased, 0);
  assert.equal(plan.shortfall, 1000);
});

test("top-up bonus applies the best qualifying tier, not the sum of tiers", () => {
  const small = quoteTopUp(1500);
  assert.equal(small.bonusBps, 0);
  assert.equal(small.credited, 1500);

  const twenty = quoteTopUp(2000);
  assert.equal(twenty.bonusBps, 300);
  assert.equal(twenty.bonus, 60);
  assert.equal(twenty.credited, 2060);

  // €100 qualifies for all three tiers; it gets the best one, not 3+5+8.
  const hundred = quoteTopUp(10_000);
  assert.equal(hundred.bonusBps, 800);
  assert.equal(hundred.bonus, 800);
  assert.equal(hundred.credited, 10_800);
});

test("the next tier is reported so the nudge is truthful", () => {
  const quote = quoteTopUp(3000);
  assert.equal(quote.bonusBps, 300);
  assert.equal(quote.nextTier?.threshold, 5000);
  assert.equal(quote.nextTier?.extraNeeded, 2000);

  // At the top tier there is nothing left to promise.
  assert.equal(quoteTopUp(15_000).nextTier, null);
});

test("top-ups are bounded at both ends and by the wallet cap", () => {
  assert.deepEqual(validateTopUp(MIN_TOPUP, 0), { ok: true });
  assert.deepEqual(validateTopUp(MIN_TOPUP - 1, 0), { ok: false, reason: "BELOW_MINIMUM" });
  assert.deepEqual(validateTopUp(MAX_TOPUP + 1, 0), { ok: false, reason: "ABOVE_MAXIMUM" });

  // The cap is checked against the credited total, bonus included — otherwise
  // the bonus could push a wallet past its own ceiling.
  const nearCap = MAX_WALLET_BALANCE - 1000;
  assert.deepEqual(validateTopUp(10_000, nearCap), {
    ok: false,
    reason: "WOULD_EXCEED_WALLET_CAP",
  });
});

test("only purchased balance is refundable as money", () => {
  const result = refundableBalance(walletBalance(3000, 750));

  // Paying out granted balance would turn a marketing accrual into cash
  // redemption, which is the property that makes a balance e-money.
  assert.equal(result.refundable, 3000);
  assert.equal(result.nonRefundable, 750);
  assert.match(result.explanation, /Cashback/);
});

test("a wallet with no granted balance gets the simpler explanation", () => {
  const result = refundableBalance(walletBalance(3000, 0));
  assert.equal(result.refundable, 3000);
  assert.equal(result.nonRefundable, 0);
  assert.doesNotMatch(result.explanation, /Cashback/);
});

test("the ZAG notification threshold warns before it is crossed", () => {
  const fine = assessZagThreshold(10_000_000);
  assert.equal(fine.notificationRequired, false);
  assert.equal(fine.approachingThreshold, false);

  // 80% — a BaFin notification is not a same-week task.
  const approaching = assessZagThreshold(ZAG_NOTIFICATION_THRESHOLD * 0.85);
  assert.equal(approaching.notificationRequired, false);
  assert.equal(approaching.approachingThreshold, true);
  assert.match(approaching.note, /§2 Abs. 2 ZAG/);

  const over = assessZagThreshold(ZAG_NOTIFICATION_THRESHOLD);
  assert.equal(over.notificationRequired, true);
  assert.match(over.note, /required/);
});

test("late tips are allowed inside the window and refused outside it", () => {
  const deliveredAt = new Date("2026-08-17T12:00:00Z");
  const soon = new Date("2026-08-17T14:00:00Z");
  const late = new Date(deliveredAt.getTime() + (TIP_WINDOW_HOURS + 1) * 3_600_000);

  assert.deepEqual(validateLateTip(300, deliveredAt, true, soon), { ok: true });
  assert.deepEqual(validateLateTip(300, deliveredAt, true, late), {
    ok: false,
    reason: "WINDOW_CLOSED",
  });
});

test("a tip needs a delivered order and a courier to pay", () => {
  const now = new Date("2026-08-17T14:00:00Z");
  const deliveredAt = new Date("2026-08-17T12:00:00Z");

  assert.deepEqual(validateLateTip(300, null, true, now), { ok: false, reason: "NOT_DELIVERED" });
  assert.deepEqual(validateLateTip(300, deliveredAt, false, now), { ok: false, reason: "NO_COURIER" });
  assert.deepEqual(validateLateTip(MAX_TIP + 1, deliveredAt, true, now), {
    ok: false,
    reason: "ABOVE_MAXIMUM",
  });
});
