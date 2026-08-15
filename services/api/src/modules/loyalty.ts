import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * Two loyalty mechanics running side by side, because they do different jobs:
 *
 *  - Platform points reward total spend and pull customers back to the app.
 *  - Merchant punch cards reward repeat visits to ONE store, which is what a
 *    merchant will actually co-fund.
 *
 * Points are an append-only ledger. A mutable balance column is the classic way
 * to end up with a number nobody can reconcile.
 */

/** Points per euro of item spend. Fees and tips don't earn. */
const POINTS_PER_EUR = 10;
/** Redemption rate: 200 points = €1.00 of credit. Deliberately less than the
 *  earn rate — an earn/burn parity makes the programme a pure discount. */
const POINTS_PER_CENT_REDEEMED = 2;
const MIN_REDEMPTION_POINTS = 400;
/** Points expire after a year of account inactivity, disclosed in the T&Cs. */
const POINTS_TTL_DAYS = 365;

const TIERS = [
  { name: "BRONZE", threshold: 0, bonusBps: 0 },
  { name: "SILVER", threshold: 5_000, bonusBps: 1000 },
  { name: "GOLD", threshold: 20_000, bonusBps: 2500 },
] as const;

function tierFor(lifetimePoints: number) {
  return [...TIERS].reverse().find((t) => lifetimePoints >= t.threshold) ?? TIERS[0];
}

export default async function loyaltyRoutes(app: FastifyInstance) {
  app.get("/me/loyalty", { preHandler: app.requireAuth }, async (request) => {
    const account = await getOrCreateAccount(request.userId!);
    const tier = tierFor(account.lifetimePoints);
    const next = TIERS.find((t) => t.threshold > account.lifetimePoints);

    return {
      pointsBalance: account.pointsBalance,
      lifetimePoints: account.lifetimePoints,
      tier: tier.name,
      earnBonusBps: tier.bonusBps,
      nextTier: next ? { name: next.name, pointsNeeded: next.threshold - account.lifetimePoints } : null,
      redeemableCredit: Math.floor(account.pointsBalance / POINTS_PER_CENT_REDEEMED),
      minimumRedemption: MIN_REDEMPTION_POINTS,
    };
  });

  app.get("/me/loyalty/transactions", { preHandler: app.requireAuth }, async (request) => {
    const account = await getOrCreateAccount(request.userId!);
    return prisma.loyaltyTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  /** Convert points into platform credit. */
  app.post("/me/loyalty/redeem", { preHandler: app.requireAuth }, async (request) => {
    const { points } = z
      .object({ points: z.number().int().min(MIN_REDEMPTION_POINTS) })
      .parse(request.body);

    const userId = request.userId!;
    const account = await getOrCreateAccount(userId);

    if (points > account.pointsBalance) {
      throw badRequest("INSUFFICIENT_POINTS", "You don't have that many points.", {
        pointsBalance: account.pointsBalance,
      });
    }
    // Only redeem in whole-cent multiples, so no fraction of a point is lost.
    if (points % POINTS_PER_CENT_REDEEMED !== 0) {
      throw badRequest("INVALID_REDEMPTION", `Redeem in multiples of ${POINTS_PER_CENT_REDEEMED} points.`);
    }

    const creditAmount = points / POINTS_PER_CENT_REDEEMED;

    await prisma.$transaction(async (tx) => {
      await tx.loyaltyTransaction.create({
        data: { accountId: account.id, points: -points, reason: "REDEEMED_FOR_CREDIT" },
      });
      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { pointsBalance: { decrement: points } },
      });
      await tx.creditEntry.create({
        data: { userId, amount: creditAmount, reason: "PROMOTION", note: `${points} Punkte eingelöst` },
      });
      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: creditAmount } },
      });
    });

    return { pointsRedeemed: points, creditAdded: creditAmount };
  });

  app.get("/me/punch-cards", { preHandler: app.requireAuth }, async (request) => {
    const cards = await prisma.punchCard.findMany({
      where: { userId: request.userId!, redeemedAt: null },
      include: { merchant: { select: { id: true, name: true, slug: true, logoUrl: true } } },
    });
    return cards.map((c) => ({
      id: c.id,
      merchant: c.merchant,
      punches: c.punches,
      punchesNeeded: c.punchesNeeded,
      complete: c.punches >= c.punchesNeeded,
      expiresAt: c.expiresAt,
    }));
  });

  app.post("/me/punch-cards/:id/redeem", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const card = await prisma.punchCard.findFirst({
      where: { id, userId: request.userId! },
    });
    if (!card) throw notFound("Punch card");
    if (card.redeemedAt) throw badRequest("ALREADY_REDEEMED", "This card has already been used.");
    if (card.punches < card.punchesNeeded) {
      throw badRequest("CARD_INCOMPLETE", `${card.punchesNeeded - card.punches} more to go.`);
    }
    if (card.expiresAt && card.expiresAt < new Date()) {
      throw badRequest("CARD_EXPIRED", "This card has expired.");
    }

    // Redeeming resets the card rather than deleting it — the customer keeps a
    // running relationship with the merchant instead of starting from nothing.
    await prisma.punchCard.update({
      where: { id },
      data: { redeemedAt: new Date(), punches: card.punches - card.punchesNeeded },
    });

    return { redeemed: true, remainingPunches: card.punches - card.punchesNeeded };
  });
}

async function getOrCreateAccount(userId: string) {
  const existing = await prisma.loyaltyAccount.findUnique({ where: { userId } });
  return existing ?? prisma.loyaltyAccount.create({ data: { userId } });
}

/**
 * Called when an order is delivered. Points earn on item spend only — paying
 * points on the delivery fee would mean rewarding customers for living far away.
 */
export async function awardOrderRewards(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || !order.deliveredAt) return null;

  const account = await getOrCreateAccount(order.userId);
  const tier = tierFor(account.lifetimePoints);

  const basePoints = Math.floor((order.itemsSubtotal / 100) * POINTS_PER_EUR);
  const bonusPoints = Math.floor((basePoints * tier.bonusBps) / 10_000);
  const points = basePoints + bonusPoints;

  await prisma.$transaction(async (tx) => {
    if (points > 0) {
      await tx.loyaltyTransaction.create({
        data: {
          accountId: account.id,
          points,
          reason: bonusPoints > 0 ? `ORDER_EARN_${tier.name}` : "ORDER_EARN",
          orderId,
          expiresAt: new Date(Date.now() + POINTS_TTL_DAYS * 86_400_000),
        },
      });
      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: {
          pointsBalance: { increment: points },
          lifetimePoints: { increment: points },
          tier: tierFor(account.lifetimePoints + points).name,
        },
      });
    }

    // One punch per order, not per item — otherwise a single large basket
    // completes the card and the mechanic stops driving repeat visits.
    if (order.merchantId) {
      await tx.punchCard.upsert({
        where: { userId_merchantId: { userId: order.userId, merchantId: order.merchantId } },
        create: { userId: order.userId, merchantId: order.merchantId, punches: 1 },
        update: { punches: { increment: 1 } },
      });
    }
  });

  return { pointsAwarded: points, tier: tier.name };
}
