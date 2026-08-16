import { test } from "node:test";
import assert from "node:assert/strict";
import { authoriseOrderAction, type ActorContext, type OrderOwnership } from "./authorisation.js";

const order: OrderOwnership = {
  userId: "user_owner",
  merchantId: "merchant_a",
  courierId: "courier_1",
};

const customer = (id: string): ActorContext => ({ type: "CUSTOMER", subjectId: id });
const merchant = (id: string): ActorContext => ({ type: "MERCHANT", subjectId: "staff_1", merchantId: id });
const courier = (id: string): ActorContext => ({ type: "COURIER", subjectId: id, courierId: id });

test("a customer may act only on their own order", () => {
  assert.equal(authoriseOrderAction(customer("user_owner"), order).allowed, true);
  assert.equal(authoriseOrderAction(customer("user_other"), order).allowed, false);
});

test("a customer cannot act as a merchant on someone else's order", () => {
  // The regression this guards: actorType used to come from the request body,
  // so a customer could send actorType: "MERCHANT" and accept any order.
  const impersonator: ActorContext = { type: "CUSTOMER", subjectId: "user_other", merchantId: "merchant_a" };
  assert.equal(authoriseOrderAction(impersonator, order).allowed, false);
});

test("a merchant may act only on their own orders", () => {
  assert.equal(authoriseOrderAction(merchant("merchant_a"), order).allowed, true);

  const other = authoriseOrderAction(merchant("merchant_b"), order);
  assert.equal(other.allowed, false);
  assert.match(other.allowed === false ? other.reason : "", /another merchant/);
});

test("a merchant token without a merchant id is refused, not trusted", () => {
  const malformed: ActorContext = { type: "MERCHANT", subjectId: "staff_1" };
  assert.equal(authoriseOrderAction(malformed, order).allowed, false);
});

test("a courier may act on their assigned order", () => {
  assert.equal(authoriseOrderAction(courier("courier_1"), order).allowed, true);
  assert.equal(authoriseOrderAction(courier("courier_2"), order).allowed, false);
});

test("a courier holding an open offer may act before acceptance is recorded", () => {
  const unassigned: OrderOwnership = { ...order, courierId: null, hasOpenAssignment: true };
  assert.equal(authoriseOrderAction(courier("courier_2"), unassigned).allowed, true);

  const noOffer: OrderOwnership = { ...order, courierId: null, hasOpenAssignment: false };
  assert.equal(authoriseOrderAction(courier("courier_2"), noOffer).allowed, false);
});

test("admin passes, unknown actor is refused by default", () => {
  assert.equal(authoriseOrderAction({ type: "ADMIN", subjectId: "admin_1" }, order).allowed, true);

  // Anything not explicitly handled must fail closed.
  const rogue = { type: "ROBOT", subjectId: "x" } as unknown as ActorContext;
  assert.equal(authoriseOrderAction(rogue, order).allowed, false);
});

test("a Butler order with no merchant cannot be claimed by any merchant", () => {
  const butler: OrderOwnership = { userId: "user_owner", merchantId: null, courierId: null };
  assert.equal(authoriseOrderAction(merchant("merchant_a"), butler).allowed, false);
});
