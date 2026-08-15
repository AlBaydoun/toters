import { test } from "node:test";
import assert from "node:assert/strict";
import { apportion, applyBps, formatUnitPrice } from "./money.js";
import { calculateVat, vatFromGross, depositFor } from "./vat.js";
import { buildQuote, calculateDeliveryFee, calculateServiceFee } from "./pricing.js";
import { assertTransition, canTransition, cancellationPolicyFor, IllegalTransitionError } from "./order-state.js";
import { enforceWageFloor, minimumWageAt, validateShift } from "./wage.js";
import { scoreCouriers, customerEtaMinutes, haversineKm } from "./dispatch.js";
import { isOldEnough, requiredAgeForBasket } from "./age.js";

test("apportion sums exactly to the total", () => {
  assert.equal(apportion(100, [1, 1, 1]).reduce((a, b) => a + b, 0), 100);
  assert.equal(apportion(1000, [3, 7]).reduce((a, b) => a + b, 0), 1000);
  assert.deepEqual(apportion(1000, [3, 7]), [300, 700]);
  // Degenerate: zero weights must not lose money.
  assert.equal(apportion(349, [0, 0]).reduce((a, b) => a + b, 0), 349);
});

test("VAT is extracted out of gross, not added to net", () => {
  // 10.70 gross at 7% contains 0.70 VAT.
  assert.equal(vatFromGross(1070, 700), 70);
  // 11.90 gross at 19% contains 1.90 VAT.
  assert.equal(vatFromGross(1190, 1900), 190);
});

test("delivery fee is apportioned across rate buckets, not flat 19%", () => {
  const result = calculateVat({
    lines: [
      { gross: 1000, category: "FOOD_REDUCED" },      // 7%
      { gross: 1000, category: "BEVERAGE_STANDARD" }, // 19%
    ],
    deliveryFee: 400,
    serviceFee: 200,
    depositTotal: 0,
    discountTotal: 0,
    tipAmount: 0,
  });

  // Equal item weights, so the 600 of fees splits 300/300.
  assert.equal(result.breakdown["700"], vatFromGross(1300, 700));
  assert.equal(result.breakdown["1900"], vatFromGross(1300, 1900));
  assert.equal(result.taxableGross, 2600);
});

test("tips are excluded from the taxable base", () => {
  const withTip = buildQuote({
    lines: [{ productId: "p1", name: "Pizza", unitPrice: 1200, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 2, demandRatio: 1, subtotal: 0, minimumBasket: 1000 },
    tipAmount: 200,
  });
  const withoutTip = buildQuote({
    lines: [{ productId: "p1", name: "Pizza", unitPrice: 1200, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 2, demandRatio: 1, subtotal: 0, minimumBasket: 1000 },
  });
  assert.equal(withTip.totalVat, withoutTip.totalVat);
  assert.equal(withTip.grandTotal - withoutTip.grandTotal, 200);
});

test("Pfand is taxed at the standard rate and is not discountable", () => {
  const quote = buildQuote({
    lines: [
      { productId: "b1", name: "Cola", unitPrice: 189, quantity: 6, vatCategory: "BEVERAGE_STANDARD", depositScheme: "ONE_WAY_025" },
    ],
    delivery: { baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 0, minimumBasket: 1000 },
    promotion: { type: "PERCENTAGE_OFF", value: 5000 },
  });
  assert.equal(quote.depositTotal, 150);            // 6 × €0.25
  assert.equal(quote.discountTotal, 189 * 6 * 0.5); // discount ignores the deposit
  assert.equal(depositFor("REUSABLE_008"), 8);
});

test("delivery fee tapers with distance and caps surge at 1.5x", () => {
  const near = calculateDeliveryFee({ baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 2000, minimumBasket: 1000 });
  const far = calculateDeliveryFee({ baseFee: 349, distanceKm: 9, demandRatio: 1, subtotal: 2000, minimumBasket: 1000 });
  assert.equal(near.fee, 349);
  // 8 billable km: 4 at full rate, 4 at half.
  assert.equal(far.fee, 349 + Math.round(4 * 45 + 4 * 45 * 0.5));

  const surging = calculateDeliveryFee({ baseFee: 349, distanceKm: 1, demandRatio: 5, subtotal: 2000, minimumBasket: 1000 });
  assert.equal(surging.demandMultiplierBps, 15_000);
  assert.equal(surging.fee, applyBps(349, 15_000));
});

test("small basket produces a surcharge rather than blocking the order", () => {
  const quote = buildQuote({
    lines: [{ productId: "p", name: "Coffee", unitPrice: 350, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 0, minimumBasket: 1000 },
  });
  assert.equal(quote.smallBasketSurcharge, 650);
});

test("service fee is floored and capped", () => {
  assert.equal(calculateServiceFee(100), 49);      // floor
  assert.equal(calculateServiceFee(1000), 80);     // 8%
  assert.equal(calculateServiceFee(100_000), 249); // cap
});

test("credit never drives the total negative", () => {
  const quote = buildQuote({
    lines: [{ productId: "p", name: "Snack", unitPrice: 200, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
    creditAvailable: 100_000,
  });
  assert.equal(quote.grandTotal, 0);
  assert.ok(quote.creditApplied > 0);
});

test("required age is the max across the basket", () => {
  assert.equal(requiredAgeForBasket([null, 16, 18]), 18);
  assert.equal(requiredAgeForBasket([null, undefined]), null);
  const dob = new Date("2008-01-01");
  assert.equal(isOldEnough(dob, 16, new Date("2026-01-01")), true);
  // You attain the age at the start of your birthday, so the boundary is inclusive.
  assert.equal(isOldEnough(dob, 18, new Date("2026-01-01")), true);
  assert.equal(isOldEnough(dob, 18, new Date("2025-12-31")), false);
});

test("order state machine rejects illegal transitions", () => {
  assert.ok(canTransition("AWAITING_MERCHANT", "PREPARING"));
  assert.ok(!canTransition("DELIVERED", "PREPARING"));
  assert.throws(() => assertTransition("DELIVERED", "PREPARING"), IllegalTransitionError);
  // A customer cannot mark their own order delivered.
  assert.throws(() => assertTransition("OUT_FOR_DELIVERY", "DELIVERED", "CUSTOMER"));
  assertTransition("OUT_FOR_DELIVERY", "DELIVERED", "COURIER");
});

test("cancellation tiers follow the order lifecycle", () => {
  assert.equal(cancellationPolicyFor("AWAITING_MERCHANT").tier, "FREE");
  assert.equal(cancellationPolicyFor("PREPARING").tier, "GOODS_ONLY");
  assert.equal(cancellationPolicyFor("PREPARING").refundDeliveryFee, true);
  assert.equal(cancellationPolicyFor("OUT_FOR_DELIVERY").tier, "FULL");
  assert.equal(cancellationPolicyFor("OUT_FOR_DELIVERY").customerMayCancel, false);
});

test("wage floor tops up a slow shift and uses the dated rate table", () => {
  assert.equal(minimumWageAt(new Date("2026-06-01")), 1390);
  assert.equal(minimumWageAt(new Date("2025-06-01")), 1282);

  const slow = enforceWageFloor({
    startedAt: new Date("2026-03-01T10:00:00Z"),
    endedAt: new Date("2026-03-01T14:00:00Z"),
    breakSeconds: 0,
    earnedCents: 4000, // 4h of work, only €40 earned
  });
  assert.equal(slow.floorCents, 5560); // 4 × €13.90
  assert.equal(slow.topUpCents, 1560);

  const busy = enforceWageFloor({
    startedAt: new Date("2026-03-01T10:00:00Z"),
    endedAt: new Date("2026-03-01T14:00:00Z"),
    breakSeconds: 0,
    earnedCents: 8000,
  });
  assert.equal(busy.topUpCents, 0);
});

test("working-time guards catch ArbZG breaches", () => {
  const issues = validateShift(
    {
      startedAt: new Date("2026-03-01T08:00:00Z"),
      endedAt: new Date("2026-03-01T19:00:00Z"),
      breakSeconds: 0,
    },
    new Date("2026-02-29T23:00:00Z"),
  );
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("MAX_DAILY_HOURS"));
  assert.ok(codes.includes("BREAK_45"));
  assert.ok(codes.includes("REST_11"));
});

test("dispatch prefers batching and excludes uncertified couriers for age-gated orders", () => {
  const candidates = [
    { courierId: "far", distanceToPickupKm: 5, activeAssignments: 0, earningsDeficit: 0, sameMerchantBatch: false, headingDeltaDeg: null, ageCheckCertified: true },
    { courierId: "batch", distanceToPickupKm: 2, activeAssignments: 1, earningsDeficit: 0, sameMerchantBatch: true, headingDeltaDeg: 10, ageCheckCertified: true },
    { courierId: "uncertified", distanceToPickupKm: 0.2, activeAssignments: 0, earningsDeficit: 0, sameMerchantBatch: false, headingDeltaDeg: null, ageCheckCertified: false },
  ];

  const ranked = scoreCouriers(candidates, { prepEtaSeconds: 600, requiresAgeCheck: true });
  assert.ok(!ranked.some((r) => r.courierId === "uncertified"));
  assert.equal(ranked[0]!.courierId, "batch");
  assert.ok(ranked[0]!.reasonCodes.includes("BATCH_SAME_MERCHANT"));
});

test("customer ETA is padded and rounded up to 5 minutes", () => {
  const eta = customerEtaMinutes(600, 600);
  assert.equal(eta % 5, 0);
  assert.ok(eta >= 20);
});

test("haversine roughly matches a known distance", () => {
  // Leipzig Hbf -> Völkerschlachtdenkmal, ~3.6 km straight line.
  const d = haversineKm({ latitude: 51.3459, longitude: 12.3810 }, { latitude: 51.3123, longitude: 12.4131 });
  assert.ok(d > 3 && d < 5, `expected ~3.6km, got ${d}`);
});

test("Grundpreis renders per kg and per litre", () => {
  // ICU inserts U+00A0/U+202F around the currency symbol; normalise before comparing.
  const norm = (s: string | null) => s?.replace(/[\u00a0\u202f]/g, " ") ?? null;
  assert.equal(norm(formatUnitPrice(199, 500, "g")), "3,98 € / kg");
  assert.equal(norm(formatUnitPrice(129, 330, "ml")), "3,91 € / l");
  assert.equal(formatUnitPrice(500, 1, "piece"), null);
});
