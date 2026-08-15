import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import {
  applyBps,
  assertTransition,
  cancellationPolicyFor,
  isActive,
  type ActorType,
  type OrderStatus,
} from "@liefero/shared";
import { awardOrderRewards } from "./loyalty.js";

export default async function orderRoutes(app: FastifyInstance) {
  app.get("/orders", { preHandler: app.requireAuth }, async (request) => {
    const orders = await prisma.order.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { merchant: { select: { name: true, logoUrl: true } }, items: true },
    });
    return orders.map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      isActive: isActive(o.status as OrderStatus),
      merchantName: o.merchant?.name ?? "Butler",
      merchantLogo: o.merchant?.logoUrl ?? null,
      grandTotal: o.grandTotal,
      itemCount: o.items.length,
      etaMinutes: o.etaMinutes,
      placedAt: o.placedAt,
      deliveredAt: o.deliveredAt,
    }));
  });

  /** Live tracking payload. Courier position is only exposed once they're en route. */
  app.get("/orders/:id/tracking", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const order = await prisma.order.findFirst({
      where: { id, userId: request.userId! },
      include: {
        merchant: { select: { name: true, latitude: true, longitude: true } },
        address: true,
        courier: { select: { id: true, firstName: true, ratingAvg: true, vehicle: true } },
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!order) throw notFound("Order");

    let courierPosition = null;
    if (order.status === "OUT_FOR_DELIVERY" && order.courierId) {
      // Data minimisation: the customer sees the courier only while the courier
      // is actually delivering to them, and only the latest fix.
      const last = await prisma.courierLocation.findFirst({
        where: { courierId: order.courierId },
        orderBy: { recordedAt: "desc" },
      });
      if (last) {
        courierPosition = { latitude: last.latitude, longitude: last.longitude, recordedAt: last.recordedAt };
      }
    }

    return {
      id: order.id,
      reference: order.reference,
      status: order.status,
      etaMinutes: order.etaMinutes,
      requiredAge: order.requiredAge,
      ageVerifiedAt: order.ageVerifiedAt,
      merchant: order.merchant,
      destination: { latitude: order.address.latitude, longitude: order.address.longitude },
      courier: order.courier
        ? { firstName: order.courier.firstName, rating: order.courier.ratingAvg, vehicle: order.courier.vehicle }
        : null,
      courierPosition,
      timeline: order.events.map((e) => ({ status: e.status, at: e.createdAt })),
      cancellation: cancellationPolicyFor(order.status as OrderStatus),
    };
  });

  /**
   * Cancellation charges follow the tier the order is in when the request lands,
   * not when the customer opened the screen.
   */
  app.post("/orders/:id/cancel", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().optional() }).parse(request.body ?? {});

    const order = await prisma.order.findFirst({ where: { id, userId: request.userId! } });
    if (!order) throw notFound("Order");

    const policy = cancellationPolicyFor(order.status as OrderStatus);
    if (!policy.customerMayCancel) {
      throw badRequest("CANCELLATION_NOT_ALLOWED", "This order can no longer be cancelled.", {
        explanationKey: policy.explanationKey,
      });
    }

    const goodsCharge = applyBps(order.itemsSubtotal + order.depositTotal, policy.goodsChargeBps);
    const deliveryCharge = policy.refundDeliveryFee ? 0 : order.deliveryFee + order.serviceFee;
    const charge = goodsCharge + deliveryCharge;

    const updated = await prisma.$transaction(async (tx) => {
      assertTransition(order.status as OrderStatus, "CANCELLED", "CUSTOMER");

      // Refunds go back as platform credit, which is also what keeps the
      // customer in the funnel after a bad experience.
      const refund = Math.max(0, order.grandTotal - charge);
      if (refund > 0) {
        await tx.creditEntry.create({
          data: { userId: order.userId, orderId: order.id, amount: refund, reason: "REFUND_CANCELLATION" },
        });
        await tx.user.update({
          where: { id: order.userId },
          data: { creditBalance: { increment: refund } },
        });
      }

      await tx.orderEvent.create({
        data: { orderId: order.id, status: "CANCELLED", actorType: "CUSTOMER", actorId: request.userId!, metadata: { charge, refund } },
      });

      return tx.order.update({
        where: { id: order.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancellationReason: reason ?? null,
          cancellationCharge: charge,
        },
      });
    });

    return { status: updated.status, charged: charge, refundedAsCredit: Math.max(0, order.grandTotal - charge) };
  });

  /** Merchant and courier both drive the order forward through this one endpoint. */
  app.post("/orders/:id/transition", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { to, actorType } = z
      .object({
        to: z.enum(["PREPARING", "REJECTED", "AWAITING_COURIER", "OUT_FOR_DELIVERY", "DELIVERED"]),
        actorType: z.enum(["MERCHANT", "COURIER"]),
      })
      .parse(request.body);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw notFound("Order");

    // Throws on both an illegal transition and a wrong actor.
    assertTransition(order.status as OrderStatus, to, actorType as ActorType);

    // An age-restricted order cannot be completed without a recorded ID check.
    if (to === "DELIVERED" && order.requiredAge != null && !order.ageVerifiedAt) {
      throw forbidden("Age verification is required before this order can be completed.");
    }

    const timestamps: Record<string, Record<string, Date>> = {
      PREPARING: { acceptedAt: new Date() },
      AWAITING_COURIER: { readyAt: new Date() },
      OUT_FOR_DELIVERY: { pickedUpAt: new Date() },
      DELIVERED: { deliveredAt: new Date() },
    };

    const updated = await prisma.$transaction(async (tx) => {
      await tx.orderEvent.create({
        data: { orderId: order.id, status: to, actorType, actorId: request.userId ?? null },
      });
      return tx.order.update({
        where: { id: order.id },
        data: { status: to, ...(timestamps[to] ?? {}) },
      });
    });

    // A merchant rejection leaves an authorisation we will never capture.
    // Releasing it promptly matters: a stale hold on a customer's card is the
    // kind of thing that ends the relationship.
    if (to === "REJECTED") {
      await releaseAuthorisation(order.id);
    }

    // Delivery is where the money actually moves. These run after the status
    // transaction rather than inside it: a loyalty failure must never roll back
    // a delivery that physically happened.
    if (to === "DELIVERED") {
      const settlement = await settleDelivery(order.id, request.userId ?? null);
      return { status: updated.status, settlement };
    }

    return { status: updated.status };
  });

  /** The 1–5 rating prompt shown after delivery, feeding support triage. */
  app.post("/orders/:id/review", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        rating: z.number().int().min(1).max(5),
        courierRating: z.number().int().min(1).max(5).optional(),
        comment: z.string().max(2000).optional(),
      })
      .parse(request.body);

    const order = await prisma.order.findFirst({ where: { id, userId: request.userId! } });
    if (!order) throw notFound("Order");
    if (order.status !== "DELIVERED" && order.status !== "SETTLED") {
      throw badRequest("NOT_DELIVERED", "You can review an order once it's delivered.");
    }

    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          orderId: order.id,
          userId: order.userId,
          merchantId: order.merchantId,
          rating: body.rating,
          courierRating: body.courierRating ?? null,
          comment: body.comment ?? null,
        },
      });

      if (order.merchantId) {
        // Recompute the average from source rather than incrementally, so a
        // deleted review can never leave the aggregate drifting.
        const agg = await tx.review.aggregate({
          where: { merchantId: order.merchantId },
          _avg: { rating: true },
          _count: true,
        });
        await tx.merchant.update({
          where: { id: order.merchantId },
          data: { ratingAvg: agg._avg.rating ?? 0, ratingCount: agg._count },
        });
      }
      return created;
    });

    return { id: review.id, rating: review.rating };
  });
}

/**
 * Everything that must happen when goods reach the customer's door.
 *
 * Each step is isolated: the capture is the only one that can legitimately fail
 * in a way the courier needs to know about, and a failure in rewards or drop
 * accounting must not make a delivered order look undelivered.
 */
async function settleDelivery(orderId: string, actorId: string | null) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payments: true },
  });

  const result: {
    captured: boolean;
    capturedAmount: number;
    requiresNewAuthorisation: boolean;
    pointsAwarded: number | null;
  } = { captured: false, capturedAmount: 0, requiresNewAuthorisation: false, pointsAwarded: null };

  const payment = order.payments.find((p) => p.status === "AUTHORISED");
  if (payment) {
    // Substitutions may have moved the total since authorisation. Capturing
    // less is fine; capturing more needs a fresh mandate under PSD2.
    if (order.grandTotal > payment.authorisedAmount) {
      result.requiresNewAuthorisation = true;
    } else {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "CAPTURED",
          capturedAmount: order.grandTotal,
          capturedAt: new Date(),
        },
      });
      result.captured = true;
      result.capturedAmount = order.grandTotal;
    }
  }

  if (order.courierId) {
    const shift = await prisma.courierShift.findFirst({
      where: { courierId: order.courierId, endedAt: null },
    });
    if (shift) {
      await prisma.courierShift.update({
        where: { id: shift.id },
        data: { dropsCompleted: { increment: 1 }, earnedCents: { increment: 180 } },
      });
    }
    await prisma.assignment.updateMany({
      where: { orderId, courierId: order.courierId, status: "ACCEPTED" },
      data: { status: "COMPLETED" },
    });
  }

  try {
    const rewards = await awardOrderRewards(orderId);
    result.pointsAwarded = rewards?.pointsAwarded ?? null;
  } catch {
    // Loyalty is not worth failing a delivery over; ops can backfill.
  }

  if (result.captured) {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "SETTLED" } });
      await tx.orderEvent.create({
        data: { orderId, status: "SETTLED", actorType: "SYSTEM", actorId },
      });
    });
  }

  return result;
}

/** Release a hold on an order that will never be fulfilled. */
async function releaseAuthorisation(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payments: true },
  });

  const payment = order.payments.find(
    (p) => p.status === "AUTHORISED" || p.status === "REQUIRES_ACTION",
  );
  if (payment) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
  }

  if (order.creditApplied > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.creditEntry.create({
        data: {
          userId: order.userId,
          orderId,
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
}
