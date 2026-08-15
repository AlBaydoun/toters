import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { createPsp, OverCaptureError, type PspRail } from "../lib/psp.js";
import { applyBps, cancellationPolicyFor, type OrderStatus } from "@liefero/shared";

const psp = createPsp();

/**
 * Money movement.
 *
 * The shape is authorise-at-placement / capture-at-delivery, which is the right
 * model for delivery: the amount owed is not knowable until the goods are
 * actually handed over. Substitutions, out-of-stock lines and Butler receipts
 * all change the total after the customer has committed.
 *
 * The rule that governs everything here: capturing MORE than was authorised is
 * never allowed silently. Under PSD2 it needs a fresh authorisation and a fresh
 * SCA, so the flow surfaces it to the customer instead.
 */
export default async function paymentRoutes(app: FastifyInstance) {
  /** Called by the client immediately after checkout creates the order. */
  app.post("/payments/authorise", { preHandler: app.requireAuth }, async (request) => {
    const { orderId, methodId } = z
      .object({ orderId: z.string(), methodId: z.string().optional() })
      .parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: request.userId! },
      include: { payments: true },
    });
    if (!order) throw notFound("Order");
    if (order.status !== "PENDING_PAYMENT") {
      throw conflict("ORDER_NOT_PAYABLE", `Order is ${order.status}, not awaiting payment.`);
    }

    // Idempotency: a retried authorise must not create a second hold on the
    // customer's card.
    const existing = order.payments.find(
      (p) => p.status === "AUTHORISED" || p.status === "REQUIRES_ACTION",
    );
    if (existing) {
      return {
        paymentId: existing.id,
        status: existing.status,
        requiresAction: existing.status === "REQUIRES_ACTION",
        actionToken: (existing.providerPayload as { actionToken?: string } | null)?.actionToken ?? null,
      };
    }

    const method = methodId
      ? await prisma.paymentMethod.findFirst({ where: { id: methodId, userId: request.userId! } })
      : await prisma.paymentMethod.findFirst({
          where: { userId: request.userId!, isDefault: true },
        });

    // Cash still matters in Germany — it is a real acquisition lever, not a
    // legacy rail. There is nothing to authorise, so the order proceeds directly.
    if (method?.type === "CASH_ON_DELIVERY") {
      const payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          methodId: method.id,
          status: "AUTHORISED",
          authorisedAmount: order.grandTotal,
          authorisedAt: new Date(),
        },
      });
      await advanceToMerchant(order.id, order.status as OrderStatus);
      return { paymentId: payment.id, status: payment.status, requiresAction: false, actionToken: null };
    }

    // A fully credit-funded order has nothing left to charge.
    if (order.grandTotal === 0) {
      const payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          status: "CAPTURED",
          authorisedAmount: 0,
          capturedAmount: 0,
          authorisedAt: new Date(),
          capturedAt: new Date(),
        },
      });
      await advanceToMerchant(order.id, order.status as OrderStatus);
      return { paymentId: payment.id, status: payment.status, requiresAction: false, actionToken: null };
    }

    if (!method) throw badRequest("NO_PAYMENT_METHOD", "Add a payment method to continue.");

    const result = await psp.authorise({
      orderId: order.id,
      amount: order.grandTotal,
      rail: method.type as PspRail,
      methodRef: method.providerRef,
      customerRef: request.userId!,
      // Keyed on the order so a network retry reuses the same hold.
      idempotencyKey: `auth_${order.id}`,
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        methodId: method.id,
        status: result.requiresAction ? "REQUIRES_ACTION" : "AUTHORISED",
        authorisedAmount: result.authorisedAmount,
        providerRef: result.providerRef,
        providerPayload: { actionToken: result.actionToken },
        authorisedAt: result.requiresAction ? null : new Date(),
      },
    });

    // Only a completed authorisation releases the order to the merchant —
    // otherwise a kitchen starts cooking against a challenge that may fail.
    if (!result.requiresAction) {
      await advanceToMerchant(order.id, order.status as OrderStatus);
    }

    return {
      paymentId: payment.id,
      status: payment.status,
      requiresAction: result.requiresAction,
      actionToken: result.actionToken,
    };
  });

  /** The client calls this once the customer has completed the SCA challenge. */
  app.post("/payments/:id/confirm", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const payment = await prisma.payment.findFirst({
      where: { id, order: { userId: request.userId! } },
      include: { order: true },
    });
    if (!payment) throw notFound("Payment");
    if (payment.status === "AUTHORISED") {
      return { status: payment.status };
    }
    if (payment.status !== "REQUIRES_ACTION") {
      throw conflict("PAYMENT_NOT_PENDING", `Payment is ${payment.status}.`);
    }

    const updated = await prisma.payment.update({
      where: { id },
      data: { status: "AUTHORISED", authorisedAt: new Date() },
    });
    await advanceToMerchant(payment.orderId, payment.order.status as OrderStatus);

    return { status: updated.status };
  });

  /**
   * Capture on delivery. The captured amount is what was actually handed over,
   * which after substitutions may be less than authorised — and occasionally
   * more, which is the case that must never pass silently.
   */
  app.post("/payments/capture", async (request) => {
    const { orderId, finalAmount } = z
      .object({ orderId: z.string(), finalAmount: z.number().int().min(0).optional() })
      .parse(request.body);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw notFound("Order");

    const payment = order.payments.find((p) => p.status === "AUTHORISED");
    if (!payment) throw badRequest("NO_AUTHORISED_PAYMENT", "No authorised payment to capture.");

    const amount = finalAmount ?? order.grandTotal;

    if (amount > payment.authorisedAmount) {
      // PSD2: over-capture needs a fresh mandate. Return the shortfall so the
      // client can ask the customer to approve it rather than failing opaquely.
      return {
        captured: false,
        requiresNewAuthorisation: true,
        authorisedAmount: payment.authorisedAmount,
        requestedAmount: amount,
        shortfall: amount - payment.authorisedAmount,
      };
    }

    // Cash orders have no PSP-side hold to capture against.
    if (!payment.providerRef) {
      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "CAPTURED", capturedAmount: amount, capturedAt: new Date() },
      });
      return { captured: true, capturedAmount: updated.capturedAmount };
    }

    try {
      const result = await psp.capture(payment.providerRef, amount, payment.authorisedAmount);
      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "CAPTURED",
          capturedAmount: result.capturedAmount,
          capturedAt: new Date(),
        },
      });
      return { captured: true, capturedAmount: updated.capturedAmount };
    } catch (error) {
      if (error instanceof OverCaptureError) {
        return {
          captured: false,
          requiresNewAuthorisation: true,
          authorisedAmount: payment.authorisedAmount,
          requestedAmount: amount,
          shortfall: amount - payment.authorisedAmount,
        };
      }
      throw error;
    }
  });

  /**
   * Refunds. Grocery issues are settled in platform credit — it is instant,
   * which matters more to a customer than the rail, and it keeps them in the
   * funnel. Cancellations go back to the original method.
   */
  app.post("/payments/refund", { preHandler: app.requireAuth }, async (request) => {
    const { orderId, amount, reason, asCredit } = z
      .object({
        orderId: z.string(),
        amount: z.number().int().min(1),
        reason: z.enum(["REFUND_GROCERY_ISSUE", "REFUND_CANCELLATION", "GOODWILL"]),
        asCredit: z.boolean().default(true),
      })
      .parse(request.body);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw notFound("Order");

    const payment = order.payments.find((p) => p.status === "CAPTURED" || p.status === "PARTIALLY_REFUNDED");
    const alreadyRefunded = payment?.refundedAmount ?? 0;
    const refundable = (payment?.capturedAmount ?? 0) - alreadyRefunded;

    if (!asCredit && amount > refundable) {
      throw badRequest("REFUND_EXCEEDS_CAPTURE", "Cannot refund more than was captured.", {
        refundable,
      });
    }

    await prisma.$transaction(async (tx) => {
      if (asCredit) {
        await tx.creditEntry.create({
          data: { userId: order.userId, orderId: order.id, amount, reason },
        });
        await tx.user.update({
          where: { id: order.userId },
          data: { creditBalance: { increment: amount } },
        });
      } else if (payment?.providerRef) {
        await psp.refund(payment.providerRef, amount, reason);
        const total = alreadyRefunded + amount;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            refundedAmount: total,
            status: total >= payment.capturedAmount ? "REFUNDED" : "PARTIALLY_REFUNDED",
          },
        });
      }
    });

    return { refunded: amount, asCredit };
  });

  /** Release a hold we will never capture — merchant rejection, no courier found. */
  app.post("/payments/void", async (request) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.body);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw notFound("Order");

    const payment = order.payments.find(
      (p) => p.status === "AUTHORISED" || p.status === "REQUIRES_ACTION",
    );
    if (!payment) return { voided: false };

    if (payment.providerRef) await psp.void(payment.providerRef);
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });

    // Credit spent on a voided order has to come back, or the customer has paid
    // for nothing.
    if (order.creditApplied > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.creditEntry.create({
          data: {
            userId: order.userId,
            orderId: order.id,
            amount: order.creditApplied,
            reason: "REFUND_CANCELLATION",
          },
        });
        await tx.user.update({
          where: { id: order.userId },
          data: { creditBalance: { increment: order.creditApplied } },
        });
      });
    }

    return { voided: true };
  });

  /** Compute what a cancellation costs, without performing it. */
  app.get("/payments/cancellation-preview/:orderId", { preHandler: app.requireAuth }, async (request) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.params);
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: request.userId! },
    });
    if (!order) throw notFound("Order");

    const policy = cancellationPolicyFor(order.status as OrderStatus);
    const goodsCharge = applyBps(order.itemsSubtotal + order.depositTotal, policy.goodsChargeBps);
    const charge = goodsCharge + (policy.refundDeliveryFee ? 0 : order.deliveryFee + order.serviceFee);

    return {
      tier: policy.tier,
      customerMayCancel: policy.customerMayCancel,
      explanationKey: policy.explanationKey,
      charge,
      refund: Math.max(0, order.grandTotal - charge),
    };
  });

  app.get("/me/payment-methods", { preHandler: app.requireAuth }, async (request) => {
    return prisma.paymentMethod.findMany({
      where: { userId: request.userId! },
      // Never return providerRef or mandateRef to a client — they are credentials.
      select: {
        id: true, type: true, brand: true, last4: true,
        expiryMonth: true, expiryYear: true, isDefault: true, createdAt: true,
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
  });

  app.post("/me/payment-methods", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = z
      .object({
        type: z.enum([
          "CARD", "SEPA_DIRECT_DEBIT", "PAYPAL", "KLARNA",
          "APPLE_PAY", "GOOGLE_PAY", "CASH_ON_DELIVERY",
        ]),
        providerRef: z.string().optional(),
        brand: z.string().optional(),
        last4: z.string().length(4).optional(),
        expiryMonth: z.number().int().min(1).max(12).optional(),
        expiryYear: z.number().int().optional(),
        mandateRef: z.string().optional(),
        isDefault: z.boolean().default(false),
      })
      .parse(request.body);

    const userId = request.userId!;

    // SEPA mandates must be referenced before they can be debited, and carry an
    // 8-week no-questions chargeback window the ledger has to reserve against.
    if (body.type === "SEPA_DIRECT_DEBIT" && !body.mandateRef) {
      throw badRequest("MANDATE_REQUIRED", "A SEPA mandate reference is required.");
    }

    const method = await prisma.$transaction(async (tx) => {
      const isFirst = (await tx.paymentMethod.count({ where: { userId } })) === 0;
      const shouldDefault = body.isDefault || isFirst;
      if (shouldDefault) {
        await tx.paymentMethod.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.paymentMethod.create({ data: { ...body, userId, isDefault: shouldDefault } });
    });

    reply.code(201);
    return { id: method.id, type: method.type, last4: method.last4, isDefault: method.isDefault };
  });
}

/**
 * A funded order becomes the merchant's problem. Kept in one place so every
 * payment path releases the order identically.
 */
async function advanceToMerchant(orderId: string, from: OrderStatus) {
  if (from !== "PENDING_PAYMENT") return;
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { status: "AWAITING_MERCHANT" } });
    await tx.orderEvent.create({
      data: { orderId, status: "AWAITING_MERCHANT", actorType: "SYSTEM" },
    });
  });
}
