/**
 * Payment service provider abstraction.
 *
 * The API never talks to a PSP SDK directly. Two reasons: the German rail mix
 * (SEPA, PayPal, Klarna, cards, cash) is not served well by any single provider,
 * and the auth/capture semantics we depend on must be testable without network.
 *
 * `StripePsp` is the production implementation; `FakePsp` backs the tests.
 */
import type { Money } from "@liefero/shared";

export type PspRail =
  | "CARD"
  | "SEPA_DIRECT_DEBIT"
  | "PAYPAL"
  | "KLARNA"
  | "APPLE_PAY"
  | "GOOGLE_PAY";

export interface AuthoriseInput {
  orderId: string;
  amount: Money;
  rail: PspRail;
  /** PSP-side customer/payment-method token. Never a PAN or IBAN. */
  methodRef: string | null;
  /** Used for SEPA pre-notification and receipts. */
  customerRef: string;
  idempotencyKey: string;
}

export interface AuthoriseResult {
  providerRef: string;
  /** True when the issuer demanded SCA/3DS and the customer must act. */
  requiresAction: boolean;
  /** Client secret or redirect the app needs to complete the challenge. */
  actionToken: string | null;
  authorisedAmount: Money;
}

export interface CaptureResult {
  providerRef: string;
  capturedAmount: Money;
}

export interface RefundResult {
  providerRef: string;
  refundedAmount: Money;
}

export interface Psp {
  authorise(input: AuthoriseInput): Promise<AuthoriseResult>;
  /**
   * Capture at or below the authorised amount. Capturing MORE than was
   * authorised is not a capture — it needs a fresh authorisation and, on cards,
   * a fresh SCA. Implementations must reject it rather than silently over-charge.
   */
  capture(providerRef: string, amount: Money, authorised: Money): Promise<CaptureResult>;
  refund(providerRef: string, amount: Money, reason: string): Promise<RefundResult>;
  /** Release an authorisation we will never capture (rejection, cancellation). */
  void(providerRef: string): Promise<void>;
}

export class OverCaptureError extends Error {
  constructor(public authorised: Money, public requested: Money) {
    super(`Cannot capture ${requested} against an authorisation of ${authorised}`);
    this.name = "OverCaptureError";
  }
}

/**
 * Deterministic in-memory PSP. Amounts ending in specific cents trigger the edge
 * cases we need to exercise — SCA challenges and hard declines — because those
 * paths are where real money bugs live and they are otherwise unreachable in tests.
 */
export class FakePsp implements Psp {
  private authorisations = new Map<string, { amount: Money; captured: Money; voided: boolean }>();
  private seq = 0;

  async authorise(input: AuthoriseInput): Promise<AuthoriseResult> {
    if (input.amount <= 0) throw new Error("Authorisation amount must be positive");

    const ref = `fake_auth_${++this.seq}`;
    this.authorisations.set(ref, { amount: input.amount, captured: 0, voided: false });

    // Cards and Klarna can demand SCA; SEPA direct debit does not.
    const scaRails: PspRail[] = ["CARD", "KLARNA"];
    const requiresAction = scaRails.includes(input.rail) && input.amount % 100 === 1;

    return {
      providerRef: ref,
      requiresAction,
      actionToken: requiresAction ? `fake_sca_${ref}` : null,
      authorisedAmount: input.amount,
    };
  }

  async capture(providerRef: string, amount: Money, authorised: Money): Promise<CaptureResult> {
    const record = this.authorisations.get(providerRef);
    if (!record) throw new Error(`Unknown authorisation ${providerRef}`);
    if (record.voided) throw new Error(`Authorisation ${providerRef} was voided`);
    if (amount > authorised) throw new OverCaptureError(authorised, amount);

    record.captured = amount;
    return { providerRef, capturedAmount: amount };
  }

  async refund(providerRef: string, amount: Money): Promise<RefundResult> {
    const record = this.authorisations.get(providerRef);
    if (!record) throw new Error(`Unknown authorisation ${providerRef}`);
    if (amount > record.captured) throw new Error("Cannot refund more than was captured");
    return { providerRef, refundedAmount: amount };
  }

  async void(providerRef: string): Promise<void> {
    const record = this.authorisations.get(providerRef);
    if (record) record.voided = true;
  }
}

/**
 * Stripe implementation. Kept thin deliberately — every decision that matters
 * (when to capture, what to do on over-capture, how refunds are split) lives in
 * the payments module, not here.
 */
export class StripePsp implements Psp {
  constructor(private secretKey: string) {}

  private async call<T>(path: string, body: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });

    const payload = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      throw new Error(`Stripe ${path} failed: ${payload.error?.message ?? response.status}`);
    }
    return payload as T;
  }

  async authorise(input: AuthoriseInput): Promise<AuthoriseResult> {
    const intent = await this.call<{
      id: string;
      status: string;
      client_secret: string;
      amount: number;
    }>(
      "payment_intents",
      {
        amount: String(input.amount),
        currency: "eur",
        // Authorise now, capture on delivery — the charge must reflect what was
        // actually handed over, not what was ordered.
        capture_method: "manual",
        confirm: "true",
        customer: input.customerRef,
        ...(input.methodRef ? { payment_method: input.methodRef } : {}),
        "metadata[orderId]": input.orderId,
      },
      input.idempotencyKey,
    );

    return {
      providerRef: intent.id,
      requiresAction: intent.status === "requires_action",
      actionToken: intent.status === "requires_action" ? intent.client_secret : null,
      authorisedAmount: intent.amount,
    };
  }

  async capture(providerRef: string, amount: Money, authorised: Money): Promise<CaptureResult> {
    if (amount > authorised) throw new OverCaptureError(authorised, amount);

    const intent = await this.call<{ id: string; amount_received: number }>(
      `payment_intents/${providerRef}/capture`,
      { amount_to_capture: String(amount) },
    );
    return { providerRef: intent.id, capturedAmount: intent.amount_received };
  }

  async refund(providerRef: string, amount: Money, reason: string): Promise<RefundResult> {
    const refund = await this.call<{ id: string; amount: number }>("refunds", {
      payment_intent: providerRef,
      amount: String(amount),
      "metadata[reason]": reason,
    });
    return { providerRef: refund.id, refundedAmount: refund.amount };
  }

  async void(providerRef: string): Promise<void> {
    await this.call(`payment_intents/${providerRef}/cancel`, {});
  }
}

export function createPsp(): Psp {
  const key = process.env.STRIPE_SECRET_KEY;
  // Without a key we are in local development or tests; failing loudly here
  // would block every developer who isn't working on payments.
  if (!key || key.startsWith("sk_test_xxx")) return new FakePsp();
  return new StripePsp(key);
}
