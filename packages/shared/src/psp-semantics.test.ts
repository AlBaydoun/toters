import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuote, cancellationPolicyFor, applyBps, calculateVat, vatFromGross } from "./index.js";

/**
 * These cover the money paths that only break in production: partial captures
 * after substitutions, refunds against cancellation tiers, and VAT after a
 * basket loses one of its rate buckets.
 */

test("removing the only standard-rate line changes the delivery fee's VAT", () => {
  // Mixed basket: the delivery fee is apportioned across both rates.
  const mixed = calculateVat({
    lines: [
      { gross: 1000, category: "FOOD_REDUCED" },
      { gross: 1000, category: "BEVERAGE_STANDARD" },
    ],
    deliveryFee: 400, serviceFee: 0, depositTotal: 0, discountTotal: 0, tipAmount: 0,
  });
  assert.ok(mixed.breakdown["1900"]! > 0);
  assert.ok(mixed.breakdown["700"]! > 0);

  // The beer goes out of stock. The whole fee now follows the 7% food supply —
  // it does not stay at 19% just because it started that way.
  const foodOnly = calculateVat({
    lines: [{ gross: 1000, category: "FOOD_REDUCED" }],
    deliveryFee: 400, serviceFee: 0, depositTotal: 0, discountTotal: 0, tipAmount: 0,
  });
  assert.equal(foodOnly.breakdown["1900"], undefined);
  assert.equal(foodOnly.breakdown["700"], vatFromGross(1400, 700));
});

test("a substitution that lowers the basket lowers the total", () => {
  const before = buildQuote({
    lines: [{ productId: "a", name: "Steak", unitPrice: 1800, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 2, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
  });
  const after = buildQuote({
    lines: [{ productId: "b", name: "Chicken", unitPrice: 1200, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 2, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
  });

  assert.ok(after.grandTotal < before.grandTotal);
  // Capturing less than authorised is always allowed; this is the safe direction.
  assert.ok(after.grandTotal <= before.grandTotal);
});

test("cancellation charge matches the tier at the moment of cancellation", () => {
  const order = { itemsSubtotal: 2000, depositTotal: 150, deliveryFee: 349, serviceFee: 160, grandTotal: 2659 };

  const free = cancellationPolicyFor("AWAITING_MERCHANT");
  const freeCharge = applyBps(order.itemsSubtotal + order.depositTotal, free.goodsChargeBps);
  assert.equal(freeCharge, 0);
  assert.equal(order.grandTotal - freeCharge, 2659); // fully refunded

  const goodsOnly = cancellationPolicyFor("PREPARING");
  const goodsCharge =
    applyBps(order.itemsSubtotal + order.depositTotal, goodsOnly.goodsChargeBps) +
    (goodsOnly.refundDeliveryFee ? 0 : order.deliveryFee + order.serviceFee);
  assert.equal(goodsCharge, 2150); // goods + deposit, delivery refunded

  const full = cancellationPolicyFor("OUT_FOR_DELIVERY");
  const fullCharge =
    applyBps(order.itemsSubtotal + order.depositTotal, full.goodsChargeBps) +
    (full.refundDeliveryFee ? 0 : order.deliveryFee + order.serviceFee);
  assert.equal(fullCharge, 2659); // everything
  assert.equal(order.grandTotal - fullCharge, 0);
});

test("credit-funded orders reach a zero total without going negative", () => {
  const quote = buildQuote({
    lines: [{ productId: "a", name: "Coffee", unitPrice: 300, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
    creditAvailable: 5000,
  });
  assert.equal(quote.grandTotal, 0);
  // Credit covers the whole order but never more than the order is worth.
  assert.ok(quote.creditApplied > 0 && quote.creditApplied < 5000);
});

test("a tip is added after credit, so credit never funds the courier's tip", () => {
  const quote = buildQuote({
    lines: [{ productId: "a", name: "Coffee", unitPrice: 300, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
    creditAvailable: 100_000,
    tipAmount: 200,
  });
  assert.equal(quote.grandTotal, 200);
  assert.equal(quote.tipAmount, 200);
});

test("discount never exceeds the basket and never touches the deposit", () => {
  const quote = buildQuote({
    lines: [
      { productId: "a", name: "Water", unitPrice: 100, quantity: 2, vatCategory: "BEVERAGE_STANDARD", depositScheme: "ONE_WAY_025" },
    ],
    delivery: { baseFee: 349, distanceKm: 1, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
    promotion: { type: "FIXED_OFF", value: 100_000 },
  });
  assert.equal(quote.discountTotal, 200);  // capped at the basket
  assert.equal(quote.depositTotal, 50);    // untouched
  assert.equal(quote.grandTotal, 50 + quote.deliveryFee + quote.serviceFee);
});

test("free-delivery promo zeroes the fee without zeroing the basket", () => {
  const quote = buildQuote({
    lines: [{ productId: "a", name: "Pizza", unitPrice: 1200, quantity: 1, vatCategory: "FOOD_REDUCED" }],
    delivery: { baseFee: 349, distanceKm: 3, demandRatio: 1, subtotal: 0, minimumBasket: 0 },
    promotion: { type: "FREE_DELIVERY", value: 0 },
  });
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.discountTotal, 0);
  assert.equal(quote.itemsSubtotal, 1200);
});

test("VAT reconciles exactly against the gross total it was derived from", () => {
  const quote = buildQuote({
    lines: [
      { productId: "a", name: "Bread", unitPrice: 349, quantity: 3, vatCategory: "FOOD_REDUCED" },
      { productId: "b", name: "Beer", unitPrice: 189, quantity: 6, vatCategory: "BEVERAGE_STANDARD", depositScheme: "ONE_WAY_025" },
      { productId: "c", name: "Charger", unitPrice: 1299, quantity: 1, vatCategory: "GOODS_STANDARD" },
    ],
    delivery: { baseFee: 349, distanceKm: 3.7, demandRatio: 1.2, subtotal: 0, minimumBasket: 1000 },
    promotion: { type: "PERCENTAGE_OFF", value: 1000, maxDiscount: 300 },
    tipAmount: 150,
  });

  const summed = Object.values(quote.vatBreakdown).reduce((a, b) => a + b, 0);
  // Largest-remainder apportionment must not lose or invent a cent.
  assert.equal(summed, quote.totalVat);

  const taxableGross = quote.grandTotal - quote.tipAmount + quote.creditApplied;
  assert.ok(quote.totalVat > 0 && quote.totalVat < taxableGross);
});
