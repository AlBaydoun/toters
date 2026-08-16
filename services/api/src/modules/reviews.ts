import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { mediaStorage } from "../lib/media.js";

/**
 * Reviews for the merchant and for the courier.
 *
 * A courier review is feedback about an identified employee, which makes it
 * meaningfully different from a review of a restaurant:
 *
 *  - Structured compliments carry most of the signal. Free text about a named
 *    person is an abuse surface and is hard to act on, so it is visible to the
 *    courier and to ops, never published on a public profile.
 *  - A rating must never silently drive deactivation. Under the Platform Work
 *    Directive a decision that materially affects a worker needs human review,
 *    so a low rating raises a flag for a person to look at — it does nothing on
 *    its own.
 *  - The courier can contest feedback, and a contested review is excluded from
 *    their average until someone resolves it.
 */

const PHOTO_URL_TTL_SECONDS = 3600;
/** Below this, over a meaningful sample, a human is asked to look. */
const REVIEW_FLAG_THRESHOLD = 3.5;
const REVIEW_FLAG_MIN_SAMPLE = 20;

export default async function reviewRoutes(app: FastifyInstance) {
  /**
   * Submit feedback for a completed order. One call covers both the food and
   * the delivery — asking twice is how you get a 30% response rate.
   */
  app.post("/orders/:id/review", { preHandler: app.requireActor("CUSTOMER") }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(2000).optional(),
        courierRating: z.number().int().min(1).max(5).optional(),
        courierComment: z.string().max(1000).optional(),
        compliments: z
          .array(
            z.enum([
              "FRIENDLY", "FAST", "CAREFUL_WITH_FOOD",
              "GOOD_COMMUNICATION", "FOUND_TRICKY_ADDRESS", "WENT_ABOVE_AND_BEYOND",
            ]),
          )
          .default([]),
      })
      .parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id, userId: request.userId! },
      include: { review: true },
    });
    if (!order) throw notFound("Order");
    if (order.status !== "DELIVERED" && order.status !== "SETTLED") {
      throw badRequest("NOT_DELIVERED", "You can review an order once it's delivered.");
    }
    if (order.review) throw badRequest("ALREADY_REVIEWED", "You've already reviewed this order.");

    // Rating a courier who never delivered this order is not feedback.
    if ((body.courierRating != null || body.compliments.length > 0) && !order.courierId) {
      throw badRequest("NO_COURIER", "This order had no courier to rate.");
    }

    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          orderId: order.id,
          userId: order.userId,
          merchantId: order.merchantId,
          rating: body.rating,
          comment: body.comment ?? null,
          courierId: order.courierId,
          courierRating: body.courierRating ?? null,
          courierComment: body.courierComment ?? null,
          compliments: body.compliments,
        },
      });

      if (order.merchantId) await recomputeMerchantRating(tx, order.merchantId);
      // This is the half that was missing: courier aggregates were never
      // updated, so every courier's rating sat permanently at 0.
      if (order.courierId && body.courierRating != null) {
        await recomputeCourierRating(tx, order.courierId);
      }

      return created;
    });

    // Flag for human review rather than acting. Never automated.
    if (order.courierId && body.courierRating != null && body.courierRating <= 2) {
      await maybeFlagCourier(order.courierId);
    }

    return {
      id: review.id,
      rating: review.rating,
      courierRating: review.courierRating,
      compliments: review.compliments,
    };
  });

  /**
   * The courier card the customer sees while tracking: name, photo, rating and
   * what people most often say about them. Surname, phone and email are never
   * included — the customer needs to recognise a person at the door, not
   * identify them off the platform.
   */
  app.get("/couriers/:id/profile", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const courier = await prisma.courier.findUnique({
      where: { id },
      include: { photoMedia: true },
    });
    if (!courier) throw notFound("Courier");

    const reviews = await prisma.review.findMany({
      where: { courierId: id, courierRating: { not: null }, contestedAt: null },
      select: { compliments: true },
      take: 500,
      orderBy: { createdAt: "desc" },
    });

    const counts = new Map<string, number>();
    for (const review of reviews) {
      for (const compliment of review.compliments) {
        counts.set(compliment, (counts.get(compliment) ?? 0) + 1);
      }
    }
    const topCompliments = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, count]) => ({ code, count }));

    const deliveries = await prisma.order.count({
      where: { courierId: id, status: { in: ["DELIVERED", "SETTLED"] } },
    });

    return {
      id: courier.id,
      firstName: courier.firstName,
      vehicle: courier.vehicle,
      // Only served when the courier has actually consented to the photo.
      photoUrl:
        courier.photoMedia && courier.photoConsentAt
          ? await mediaStorage.signedUrl(courier.photoMedia.storageKey, PHOTO_URL_TTL_SECONDS)
          : null,
      rating: courier.ratingAvg > 0 ? Number(courier.ratingAvg.toFixed(2)) : null,
      ratingCount: courier.ratingCount,
      deliveries,
      topCompliments,
      // Deliberately absent: free-text comments. They go to the courier and to
      // ops, not onto a public profile.
    };
  });

  /**
   * Photo upload and consent. Separate from the rest of onboarding because
   * consent has to be a distinct, withdrawable act — bundling it into a terms
   * checkbox would not be freely given under GDPR Art. 7.
   */
  app.put("/me/courier/photo", { preHandler: app.requireActor("COURIER") }, async (request) => {
    const { mediaId, consent } = z
      .object({ mediaId: z.string(), consent: z.literal(true) })
      .parse(request.body);

    const media = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    if (!media) throw notFound("Photo");
    if (media.uploadedBy !== request.userId) {
      throw forbidden("You can only set a photo you uploaded.");
    }

    // A profile photo must outlive the 90-day chat purge that it was uploaded
    // under, or couriers silently lose their picture every quarter.
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { purgeAfter: new Date(Date.now() + 10 * 365 * 86_400_000) },
    });

    const courier = await prisma.courier.update({
      where: { id: request.courierId! },
      data: { photoMediaId: mediaId, photoConsentAt: consent ? new Date() : null },
    });

    return {
      photoUrl: await mediaStorage.signedUrl(media.storageKey, PHOTO_URL_TTL_SECONDS),
      consentAt: courier.photoConsentAt,
    };
  });

  app.delete("/me/courier/photo", { preHandler: app.requireActor("COURIER") }, async (request) => {
    const courier = await prisma.courier.findUniqueOrThrow({ where: { id: request.courierId! } });

    // Withdrawing consent must be as easy as giving it, and must actually
    // delete the image rather than just unlinking it.
    if (courier.photoMediaId) {
      const media = await prisma.mediaAsset.findUnique({ where: { id: courier.photoMediaId } });
      if (media) {
        await mediaStorage.delete(media.storageKey).catch(() => undefined);
        await prisma.courier.update({
          where: { id: courier.id },
          data: { photoMediaId: null, photoConsentAt: null },
        });
        await prisma.mediaAsset.delete({ where: { id: media.id } }).catch(() => undefined);
      }
    }

    return { removed: true };
  });

  /** The courier's own feedback, including the free text nobody else sees. */
  app.get("/me/courier/feedback", { preHandler: app.requireActor("COURIER") }, async (request) => {
    const courierId = request.courierId!;

    const [courier, reviews] = await Promise.all([
      prisma.courier.findUniqueOrThrow({ where: { id: courierId } }),
      prisma.review.findMany({
        where: { courierId, courierRating: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true, courierRating: true, courierComment: true, compliments: true,
          createdAt: true, contestedAt: true, upheld: true,
        },
      }),
    ]);

    const counts = new Map<string, number>();
    for (const review of reviews) {
      for (const compliment of review.compliments) {
        counts.set(compliment, (counts.get(compliment) ?? 0) + 1);
      }
    }

    return {
      rating: courier.ratingAvg > 0 ? Number(courier.ratingAvg.toFixed(2)) : null,
      ratingCount: courier.ratingCount,
      compliments: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({ code, count })),
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.courierRating,
        comment: r.courierComment,
        compliments: r.compliments,
        createdAt: r.createdAt,
        contested: r.contestedAt != null,
        resolved: r.upheld,
        // Contesting is only meaningful while the feedback is recent enough to
        // remember; after that the courier can still raise it with ops.
        canContest:
          r.contestedAt == null &&
          Date.now() - r.createdAt.getTime() < 14 * 86_400_000,
      })),
      yourRights: {
        explanation:
          "Ratings never deactivate an account automatically. A person reviews any decision that affects your work.",
        contact: "fleet-support@liefero.de",
      },
    };
  });

  /** Contest a review. Excluded from the average until a human resolves it. */
  app.post("/me/courier/feedback/:id/contest", { preHandler: app.requireActor("COURIER") }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().min(10).max(1000) }).parse(request.body);

    const review = await prisma.review.findFirst({
      where: { id, courierId: request.courierId! },
    });
    if (!review) throw notFound("Review");
    if (review.contestedAt) throw badRequest("ALREADY_CONTESTED", "You've already contested this.");

    await prisma.$transaction(async (tx) => {
      await tx.review.update({
        where: { id },
        data: { contestedAt: new Date(), contestReason: reason },
      });
      // Recompute immediately: the courier should not carry a disputed rating
      // while it is being looked at.
      await recomputeCourierRating(tx, request.courierId!);
      await tx.auditLog.create({
        data: {
          actorType: "COURIER",
          actorId: request.courierId!,
          action: "REVIEW_CONTESTED",
          entityType: "Review",
          entityId: id,
          metadata: { reason },
        },
      });
    });

    return {
      contested: true,
      message: "Diese Bewertung zählt nicht mehr zu deinem Schnitt, bis ein Mensch sie geprüft hat.",
    };
  });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Recompute from source so a deleted or contested review can't leave drift. */
async function recomputeMerchantRating(tx: Tx, merchantId: string) {
  const agg = await tx.review.aggregate({
    where: { merchantId, contestedAt: null },
    _avg: { rating: true },
    _count: true,
  });
  await tx.merchant.update({
    where: { id: merchantId },
    data: { ratingAvg: agg._avg.rating ?? 0, ratingCount: agg._count },
  });
}

async function recomputeCourierRating(tx: Tx, courierId: string) {
  const agg = await tx.review.aggregate({
    where: { courierId, courierRating: { not: null }, contestedAt: null },
    _avg: { courierRating: true },
    _count: true,
  });
  await tx.courier.update({
    where: { id: courierId },
    data: { ratingAvg: agg._avg.courierRating ?? 0, ratingCount: agg._count },
  });
}

/**
 * Raise a flag for a human. Explicitly does NOT change the courier's status:
 * an automated decision that materially affects a worker requires human review
 * under the Platform Work Directive, and "the algorithm dropped you" is exactly
 * the practice it exists to stop.
 */
async function maybeFlagCourier(courierId: string) {
  const courier = await prisma.courier.findUnique({ where: { id: courierId } });
  if (!courier) return;
  if (courier.ratingCount < REVIEW_FLAG_MIN_SAMPLE) return;
  if (courier.ratingAvg >= REVIEW_FLAG_THRESHOLD) return;

  await prisma.auditLog.create({
    data: {
      actorType: "SYSTEM",
      action: "COURIER_RATING_FLAGGED_FOR_REVIEW",
      entityType: "Courier",
      entityId: courierId,
      metadata: {
        ratingAvg: courier.ratingAvg,
        ratingCount: courier.ratingCount,
        note: "Flagged for human review. No automated action taken.",
      },
    },
  });
}
