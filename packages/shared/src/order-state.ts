/**
 * One explicit state machine governs every order across all verticals.
 * Illegal transitions throw rather than silently no-op — a silently dropped
 * transition in a delivery system means a customer waiting for food that nobody
 * is making.
 */

export type OrderStatus =
  | "DRAFT"
  | "PENDING_PAYMENT"
  | "PAYMENT_FAILED"
  | "AWAITING_MERCHANT"
  | "REJECTED"
  | "PREPARING"
  | "AWAITING_COURIER"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "SETTLED"
  | "CANCELLED";

export type ActorType = "CUSTOMER" | "MERCHANT" | "COURIER" | "SYSTEM";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["PENDING_PAYMENT", "CANCELLED"],
  PENDING_PAYMENT: ["AWAITING_MERCHANT", "PAYMENT_FAILED", "CANCELLED"],
  PAYMENT_FAILED: ["PENDING_PAYMENT", "CANCELLED"],
  AWAITING_MERCHANT: ["PREPARING", "REJECTED", "CANCELLED"],
  REJECTED: ["CANCELLED"],
  PREPARING: ["AWAITING_COURIER", "CANCELLED"],
  // Back to PREPARING covers an approved grocery substitution.
  AWAITING_COURIER: ["OUT_FOR_DELIVERY", "PREPARING", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "CANCELLED"],
  DELIVERED: ["SETTLED"],
  SETTLED: [],
  CANCELLED: [],
};

/** Who is allowed to drive each transition. SYSTEM may always act. */
const PERMITTED_ACTORS: Partial<Record<OrderStatus, ActorType[]>> = {
  PREPARING: ["MERCHANT"],
  REJECTED: ["MERCHANT"],
  AWAITING_COURIER: ["MERCHANT"],
  OUT_FOR_DELIVERY: ["COURIER"],
  DELIVERED: ["COURIER"],
};

export class IllegalTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Illegal order transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class UnauthorisedTransitionError extends Error {
  constructor(actor: ActorType, to: OrderStatus) {
    super(`Actor ${actor} may not move an order to ${to}`);
    this.name = "UnauthorisedTransitionError";
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: ActorType = "SYSTEM"): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);

  const permitted = PERMITTED_ACTORS[to];
  if (permitted && actor !== "SYSTEM" && !permitted.includes(actor)) {
    throw new UnauthorisedTransitionError(actor, to);
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses in which the customer can still see live progress. */
export function isActive(status: OrderStatus): boolean {
  return (
    status === "AWAITING_MERCHANT" ||
    status === "PREPARING" ||
    status === "AWAITING_COURIER" ||
    status === "OUT_FOR_DELIVERY"
  );
}

// ---------------------------------------------------------------------------
// Cancellation policy
// ---------------------------------------------------------------------------

export type CancellationTier = "FREE" | "GOODS_ONLY" | "FULL";

export interface CancellationPolicy {
  tier: CancellationTier;
  /** Fraction of the goods total charged, in basis points. */
  goodsChargeBps: number;
  refundDeliveryFee: boolean;
  customerMayCancel: boolean;
  explanationKey: string;
}

/**
 * Mirrors the operating rules: free before the merchant accepts; goods charged
 * (delivery refunded) once they accept; everything charged once the courier has
 * left with the order.
 */
export function cancellationPolicyFor(status: OrderStatus): CancellationPolicy {
  switch (status) {
    case "DRAFT":
    case "PENDING_PAYMENT":
    case "PAYMENT_FAILED":
    case "AWAITING_MERCHANT":
      return {
        tier: "FREE",
        goodsChargeBps: 0,
        refundDeliveryFee: true,
        customerMayCancel: true,
        explanationKey: "cancellation.free",
      };
    case "PREPARING":
    case "AWAITING_COURIER":
      return {
        tier: "GOODS_ONLY",
        goodsChargeBps: 10_000,
        refundDeliveryFee: true,
        customerMayCancel: true,
        explanationKey: "cancellation.goodsOnly",
      };
    case "OUT_FOR_DELIVERY":
      return {
        tier: "FULL",
        goodsChargeBps: 10_000,
        refundDeliveryFee: false,
        // Past this point cancellation is a support action, not a self-serve one.
        customerMayCancel: false,
        explanationKey: "cancellation.full",
      };
    default:
      return {
        tier: "FULL",
        goodsChargeBps: 10_000,
        refundDeliveryFee: false,
        customerMayCancel: false,
        explanationKey: "cancellation.notPossible",
      };
  }
}
