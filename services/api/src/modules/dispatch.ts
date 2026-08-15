import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { customerEtaMinutes, haversineKm, scoreCouriers, type CourierCandidate } from "@liefero/shared";

const OFFER_TTL_SECONDS = 45;

export default async function dispatchRoutes(app: FastifyInstance) {
  /**
   * Assign the best courier to an order. Called when the merchant marks an order
   * ready, and re-run on decline or expiry.
   */
  app.post("/dispatch/:orderId/assign", async (request) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.params);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { merchant: true, address: true },
    });
    if (!order) throw notFound("Order");

    const pickup = order.merchant
      ? { latitude: order.merchant.latitude, longitude: order.merchant.longitude }
      : { latitude: order.address.latitude, longitude: order.address.longitude };

    const cityId = order.merchant?.cityId;
    const onShift = await prisma.courierShift.findMany({
      where: { endedAt: null, courier: { status: "ACTIVE", ...(cityId ? { cityId } : {}) } },
      include: { courier: true },
    });

    // Couriers we already offered this order to and who said no.
    const declined = await prisma.assignment.findMany({
      where: { orderId, status: { in: ["DECLINED", "EXPIRED"] } },
      select: { courierId: true },
    });
    const excluded = new Set(declined.map((d) => d.courierId));

    const candidates: CourierCandidate[] = [];
    for (const shift of onShift) {
      if (excluded.has(shift.courierId)) continue;

      const [lastFix, activeCount] = await Promise.all([
        prisma.courierLocation.findFirst({
          where: { courierId: shift.courierId },
          orderBy: { recordedAt: "desc" },
        }),
        prisma.assignment.count({
          where: { courierId: shift.courierId, status: { in: ["OFFERED", "ACCEPTED"] } },
        }),
      ]);
      if (!lastFix) continue;

      const sameMerchant = order.merchantId
        ? (await prisma.assignment.count({
            where: {
              courierId: shift.courierId,
              status: "ACCEPTED",
              order: { merchantId: order.merchantId },
            },
          })) > 0
        : false;

      // Earnings deficit levels work across the shift and keeps the statutory
      // wage top-up bill down.
      const hoursWorked = (Date.now() - shift.startedAt.getTime()) / 3_600_000;
      const expected = hoursWorked * shift.courier.hourlyRateCents;
      const earningsDeficit = Math.max(0, expected - shift.earnedCents);

      candidates.push({
        courierId: shift.courierId,
        distanceToPickupKm: haversineKm(lastFix, pickup),
        activeAssignments: activeCount,
        earningsDeficit,
        sameMerchantBatch: sameMerchant,
        headingDeltaDeg: null,
        ageCheckCertified: shift.courier.ageCheckCertifiedAt != null,
      });
    }

    const prepEtaSeconds = order.readyAt
      ? Math.max(0, (order.readyAt.getTime() - Date.now()) / 1000)
      : (order.merchant?.avgPrepSeconds ?? 900);

    const ranked = scoreCouriers(candidates, {
      prepEtaSeconds,
      requiresAgeCheck: order.requiredAge != null,
    });

    if (ranked.length === 0) {
      return { assigned: false, reason: "NO_AVAILABLE_COURIER", candidatesConsidered: candidates.length };
    }

    const best = ranked[0]!;
    const assignment = await prisma.assignment.create({
      data: {
        orderId,
        courierId: best.courierId,
        score: best.score,
        // Recorded so an automated assignment decision can actually be explained
        // to the courier — Platform Work Directive Art. 6–11.
        reasonCodes: best.reasonCodes,
        expiresAt: new Date(Date.now() + OFFER_TTL_SECONDS * 1000),
      },
    });

    const chosen = candidates.find((c) => c.courierId === best.courierId)!;
    const travelSeconds = (chosen.distanceToPickupKm / 16) * 3600;
    const eta = customerEtaMinutes(prepEtaSeconds, travelSeconds * 2);
    await prisma.order.update({ where: { id: orderId }, data: { etaMinutes: eta } });

    return {
      assigned: true,
      assignmentId: assignment.id,
      courierId: best.courierId,
      reasonCodes: best.reasonCodes,
      expiresAt: assignment.expiresAt,
      etaMinutes: eta,
    };
  });

  app.post("/dispatch/assignments/:id/respond", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { accept } = z.object({ accept: z.boolean() }).parse(request.body);

    const assignment = await prisma.assignment.findUnique({ where: { id } });
    if (!assignment) throw notFound("Assignment");

    const expired = assignment.expiresAt < new Date();
    const status = expired ? "EXPIRED" : accept ? "ACCEPTED" : "DECLINED";

    await prisma.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id },
        data: { status, respondedAt: new Date() },
      });
      if (status === "ACCEPTED") {
        await tx.order.update({
          where: { id: assignment.orderId },
          data: { courierId: assignment.courierId },
        });
      }
    });

    return { status };
  });

  /**
   * Courier position ping. Full-resolution fixes are retained only while a
   * delivery is active and purged at 30 days by the retention job.
   */
  app.post("/dispatch/location", { preHandler: app.requireAuth }, async (request) => {
    const body = z
      .object({
        courierId: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        accuracy: z.number().optional(),
        heading: z.number().optional(),
      })
      .parse(request.body);

    await prisma.courierLocation.create({ data: body });
    return { ok: true };
  });

  /** Explain an assignment decision to the courier it affected. */
  app.get("/dispatch/assignments/:id/explanation", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const assignment = await prisma.assignment.findUnique({ where: { id } });
    if (!assignment) throw notFound("Assignment");

    const EXPLANATIONS: Record<string, string> = {
      PROXIMITY: "You were close to the pickup point.",
      EARNINGS_BALANCE: "Your earnings this shift were below the expected rate.",
      BATCH_SAME_MERCHANT: "You already had an order from the same store.",
      BATCH_SAME_DIRECTION: "This delivery was on your current route.",
      IDLE: "You had no active deliveries.",
    };

    return {
      assignmentId: assignment.id,
      decidedAt: assignment.offeredAt,
      factors: assignment.reasonCodes.map((c) => ({ code: c, explanation: EXPLANATIONS[c] ?? c })),
      humanReviewContact: "fleet-support@liefero.de",
    };
  });
}
