/**
 * Who may act on an order.
 *
 * This is deliberately a pure function with no database access, because it is
 * security-critical and therefore has to be exhaustively testable. An earlier
 * version of this system read the actor type from the request body, which meant
 * any authenticated customer could accept, reject or complete any order in the
 * system. Keeping the decision here, in one place, with tests, is the fix that
 * stops that class of bug returning.
 */

export type Actor = "CUSTOMER" | "MERCHANT" | "COURIER" | "ADMIN";

export interface ActorContext {
  type: Actor;
  /** Subject id from the token: user id, staff id, or courier id. */
  subjectId: string;
  /** Present on MERCHANT tokens only. */
  merchantId?: string | undefined;
  /** Present on COURIER tokens only. */
  courierId?: string | undefined;
}

export interface OrderOwnership {
  userId: string;
  merchantId: string | null;
  courierId: string | null;
  /** True when the courier holds an open or accepted offer for this order. */
  hasOpenAssignment?: boolean;
}

export type AuthorisationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function authoriseOrderAction(
  actor: ActorContext,
  order: OrderOwnership,
): AuthorisationResult {
  switch (actor.type) {
    case "ADMIN":
      return { allowed: true };

    case "CUSTOMER":
      return order.userId === actor.subjectId
        ? { allowed: true }
        : { allowed: false, reason: "This isn't your order." };

    case "MERCHANT":
      // Being *a* merchant is not authorisation to act on *this* merchant's
      // orders. The token must name the merchant, and it must match.
      if (!actor.merchantId) {
        return { allowed: false, reason: "Merchant token is missing a merchant id." };
      }
      return order.merchantId === actor.merchantId
        ? { allowed: true }
        : { allowed: false, reason: "This order belongs to another merchant." };

    case "COURIER":
      if (!actor.courierId) {
        return { allowed: false, reason: "Courier token is missing a courier id." };
      }
      // A courier may act on an order assigned to them, or one they hold an
      // open offer for — they need to move it before acceptance is recorded.
      if (order.courierId === actor.courierId) return { allowed: true };
      if (order.hasOpenAssignment) return { allowed: true };
      return { allowed: false, reason: "This order isn't assigned to you." };

    default: {
      // Exhaustiveness guard: a new actor type must be handled explicitly
      // rather than silently falling through to allowed.
      const exhaustive: never = actor.type;
      return { allowed: false, reason: `Unknown actor: ${String(exhaustive)}` };
    }
  }
}
