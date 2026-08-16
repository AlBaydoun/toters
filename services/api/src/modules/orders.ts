import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { assertOrderActor } from "../plugins/auth.js";
import {
  applyBps,
  assertTransition,
  cancellationPolicyFor,
  isActive,
  type ActorType,
  type OrderStatus,
} from "@liefero/shared";
import { awardOrderRewards } from "./loyalty.js";
import { awardCashback } from "./cashback.js";
import { fetchRoute, straightLine } from "../lib/routing.js";
import { mediaStorage } from "../lib/media.js";

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
        courier: {
          select: {
            id: true, firstName: true, ratingAvg: true, ratingCount: true,
            vehicle: true, photoMediaId: true, photoConsentAt: true,
            photoMedia: { select: { storageKey: true } },
          },
        },
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!order) throw notFound("Order");

    let courierPosition = null;
    let route = null;
    let bearing: number | null = null;

    if (order.status === "OUT_FOR_DELIVERY" && order.courierId) {
      // Data minimisation: the customer sees the courier only while the courier
      // is actually delivering to them. Two fixes rather than one, so the client
      // can point the marker the way the courier is actually moving.
      const fixes = await prisma.courierLocation.findMany({
        where: { courierId: order.courierId },
        orderBy: { recordedAt: "desc" },
        take: 2,
      });

      const last = fixes[0];
      if (last) {
        courierPosition = {
          latitude: last.latitude,
          longitude: last.longitude,
          recordedAt: last.recordedAt,
        };

        const previous = fixes[1];
        if (previous) bearing = bearingBetween(previous, last);

        const destination = { latitude: order.address.latitude, longitude: order.address.longitude };
        route = await fetchRoute(last, destination);
      }
    } else if (order.status === "PREPARING" || order.status === "AWAITING_COURIER") {
      // Before pickup, show the leg the food still has to travel. It answers
      // "how far away is my food" without revealing where any courier is.
      if (order.merchant) {
        route = straightLine(
          { latitude: order.merchant.latitude, longitude: order.merchant.longitude },
          { latitude: order.address.latitude, longitude: order.address.longitude },
        );
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
        ? {
            id: order.courier.id,
            firstName: order.courier.firstName,
            vehicle: order.courier.vehicle,
            // Null until enough ratings exist to mean anything — showing "5.0"
            // off one review flatters nobody and misleads the customer.
            rating:
              order.courier.ratingCount >= 5
                ? Number(order.courier.ratingAvg.toFixed(1))
                : null,
            ratingCount: order.courier.ratingCount,
            // The photo exists so the customer can recognise the person at the
            // door. Served only where the courier consented to it.
            photoUrl:
              order.courier.photoMedia && order.courier.photoConsentAt
                ? await mediaStorage.signedUrl(order.courier.photoMedia.storageKey, 3600)
                : null,
          }
        : null,
      courierPosition,
      /** Heading in degrees, so the marker points where the courier is going. */
      courierBearing: bearing,
      route: route
        ? {
            points: route.points,
            distanceMeters: Math.round(route.distanceMeters),
            durationSeconds: Math.round(route.durationSeconds),
          }
        : null,
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

  /**
   * Merchant and courier both drive the order forward through this one endpoint.
   *
   * The actor comes from the token and the order is checked for ownership. An
   * earlier version took actorType from the request body, which let any
   * authenticated user accept, reject or complete any order in the system.
   */
  app.post("/orders/:id/transition", { preHandler: app.requireActor("MERCHANT", "COURIER", "ADMIN") }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { to } = z
      .object({
        to: z.enum(["PREPARING", "REJECTED", "AWAITING_COURIER", "OUT_FOR_DELIVERY", "DELIVERED"]),
      })
      .parse(request.body);

    await assertOrderActor(request, id);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw notFound("Order");

    const actorType = request.actorType as ActorType;
    // Throws on both an illegal transition and a wrong actor.
    assertTransition(order.status as OrderStatus, to, actorType);

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

  /**
   * Courier records the ID check for an age-restricted order.
   *
   * We store the outcome and the document TYPE only — never the document number
   * and never an image. Recording more would be a data-minimisation breach
   * (GDPR Art. 5(1)(c)) and would turn every courier phone into a liability.
   */
  app.post("/orders/:id/age-check", { preHandler: app.requireActor("COURIER", "ADMIN") }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await assertOrderActor(request, id);
    const body = z
      .object({
        verified: z.boolean(),
        documentType: z
          .enum(["PERSONALAUSWEIS", "REISEPASS", "AUFENTHALTSTITEL", "EU_DRIVING_LICENCE"])
          .nullable(),
      })
      .parse(request.body);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw notFound("Order");
    if (order.requiredAge == null) {
      throw badRequest("NO_AGE_CHECK_REQUIRED", "This order doesn't need an ID check.");
    }
    if (body.verified && !body.documentType) {
      throw badRequest("DOCUMENT_TYPE_REQUIRED", "Record which document you checked.");
    }

    if (!body.verified) {
      // A failed check means the goods go back. The customer is charged per the
      // cancellation tier they were in — this is a refusal at the door, not a
      // free cancellation, or the age gate becomes a way to order and refuse.
      const policy = cancellationPolicyFor(order.status as OrderStatus);
      const charge = applyBps(order.itemsSubtotal + order.depositTotal, policy.goodsChargeBps);

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancellationReason: "AGE_VERIFICATION_FAILED",
            cancellationCharge: charge,
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId: id,
            status: "CANCELLED",
            actorType: "COURIER",
            actorId: request.userId ?? null,
            metadata: { kind: "AGE_CHECK_FAILED" },
          },
        });
      });

      return { verified: false, orderCancelled: true, charged: charge };
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { ageVerifiedAt: new Date(), ageVerifiedBy: request.userId ?? null },
      });
      await tx.auditLog.create({
        data: {
          actorType: "COURIER",
          actorId: request.userId ?? null,
          action: "AGE_VERIFIED",
          entityType: "Order",
          entityId: id,
          // Type only. No number, no scan.
          metadata: { documentType: body.documentType, requiredAge: order.requiredAge },
        },
      });
    });

    return { verified: true, orderCancelled: false };
  });

  // Reviews live in modules/reviews.ts — courier feedback has its own rules.
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
    cashbackEarned: number | null;
  } = {
    captured: false, capturedAmount: 0, requiresNewAuthorisation: false,
    pointsAwarded: null, cashbackEarned: null,
  };

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

  // Cashback is earned on delivery, not on placement — paying it out for an
  // order that never arrived is a refund with extra steps. Isolated for the
  // same reason as loyalty: a credit failure must not un-deliver an order.
  try {
    const cashback = await awardCashback(orderId);
    result.cashbackEarned = cashback?.amount ?? null;
  } catch {
    // Backfillable; the award is idempotent on orderId.
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

/** Initial bearing from one point to another, in degrees clockwise from north. */
function bearingBetween(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);
  const dLon = toRad(to.longitude - from.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
