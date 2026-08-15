import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePsp, OverCaptureError } from "./psp.js";

/**
 * The capture rules are the ones that move real money in the wrong direction
 * when they're wrong, so they get direct coverage.
 */

function authInput(amount: number, rail: "CARD" | "SEPA_DIRECT_DEBIT" = "CARD") {
  return {
    orderId: "order_1",
    amount,
    rail,
    methodRef: "pm_1",
    customerRef: "user_1",
    idempotencyKey: "key_1",
  } as const;
}

test("capturing less than authorised is allowed — substitutions shrink baskets", async () => {
  const psp = new FakePsp();
  const auth = await psp.authorise(authInput(2000));
  const captured = await psp.capture(auth.providerRef, 1500, auth.authorisedAmount);
  assert.equal(captured.capturedAmount, 1500);
});

test("capturing more than authorised is refused, never silently charged", async () => {
  const psp = new FakePsp();
  const auth = await psp.authorise(authInput(2000));
  await assert.rejects(
    () => psp.capture(auth.providerRef, 2500, auth.authorisedAmount),
    OverCaptureError,
  );
});

test("cards can demand SCA; SEPA direct debit does not", async () => {
  const psp = new FakePsp();
  const card = await psp.authorise(authInput(2001, "CARD"));
  assert.equal(card.requiresAction, true);
  assert.ok(card.actionToken);

  const sepa = await psp.authorise(authInput(2001, "SEPA_DIRECT_DEBIT"));
  assert.equal(sepa.requiresAction, false);
  assert.equal(sepa.actionToken, null);
});

test("a voided authorisation cannot later be captured", async () => {
  const psp = new FakePsp();
  const auth = await psp.authorise(authInput(2000));
  await psp.void(auth.providerRef);
  await assert.rejects(() => psp.capture(auth.providerRef, 2000, auth.authorisedAmount));
});

test("refunds cannot exceed what was captured", async () => {
  const psp = new FakePsp();
  const auth = await psp.authorise(authInput(2000));
  await psp.capture(auth.providerRef, 1500, auth.authorisedAmount);

  const refund = await psp.refund(auth.providerRef, 1500, "REFUND_GROCERY_ISSUE");
  assert.equal(refund.refundedAmount, 1500);

  await assert.rejects(() => psp.refund(auth.providerRef, 2000, "GOODWILL"));
});

test("a zero or negative authorisation is rejected outright", async () => {
  const psp = new FakePsp();
  await assert.rejects(() => psp.authorise(authInput(0)));
});
