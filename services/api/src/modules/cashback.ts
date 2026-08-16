import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";
import {
  calculateCashback, clawbackAmount, cashbackExpiryFrom, displayRateBps,
  TIER_CASHBACK_BPS, CASHBACK_CAP_PER_ORDER,
  type CashbackCampaign, type LoyaltyTier,
} from "@liefero/shared";

/**
 * Cashback: a share of what the customer actually paid, returned as credit when
 * the order is delivered.
 *
 * Earned on delivery rather than on placement — cashback on an order that never
 * arrives is a refund with extra steps.
 *
 * VAT note: the credit issued here is a multi-purpose voucher
 * (Mehrzweckgutschein, §3 Abs. 15 UStG). It can be spent across baskets carrying
 * different rates, so the rate is not fixed at issue. VAT therefore falls when
 * the credit is REDEEMED against goods, not when it is granted, which is why
 * granting cashback books no VAT correction here.
 */
export default async function cashbackRoutes(app: FastifyInstance) {
  /** What this customer would earn on the basket in front of them. */
  app.get("/cashback/preview", { preHandler: app.requireActor("CUSTOMER") }, async (request) => {
    const q = z
      .object({
        itemsSubtotal: z.coerce.number().int().min(0),
        discountTotal: z.coerce.number().int().min(0).default(0),
        creditApplied: z.coerce.number().int().min(0).default(0),
        merchantId: z.string().optional(),
      })
      .parse(request.query);

    const tier = await tierFor(request.userId!);
    const campaigns = await activeCampaigns(q.merchantId ?? null);

    const result = calculateCashback({
      itemsSubtotal: q.itemsSubtotal,
      discountTotal: q.discountTotal,
      creditApplied: q.creditApplied,
      depositTotal: 0,
      tipAmount: 0,
      tier,
      campaigns,
      merchantId: q.merchantId ?? null,
    });

    return {
      amount: result.amount,
      effectiveBps: result.effectiveBps,
      tierBps: result.tierBps,
      campaignBps: result.campaignBps,
      capped: result.capped,
      campaigns: result.appliedCampaigns,
      // Stated up front rather than discovered later in the T&Cs.
      exclusions:
        result.eligibleBase < q.itemsSubtotal
          ? "Auf mit Guthaben bezahlte Beträge und Rabatte gibt es kein Cashback."
          : null,
    };
  });

  /** The Bonus screen: balance, rate, and where it came from. */
  app.get("/me/cashback", { preHandler: app.requireActor("CUSTOMER") }, async (request) => {
    const userId = request.userId!;

    const [user, tier, awards, campaigns] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      tierFor(userId),
      prisma.cashbackAward.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { order: { select: { reference: true, merchant: { select: { name: true } } } } },
      }),
      activeCampaigns(null),
    ]);

    const lifetime = awards.reduce((sum, a) => sum + a.amount - a.clawedBack, 0);

    // Surfaced because credit that expires without warning is how a rewards
    // programme turns into a complaint.
    const expiringSoon = awards
      .filter((a) => a.expiresAt.getTime() < Date.now() + 60 * 86_400_000)
      .reduce((sum, a) => sum + a.amount - a.clawedBack, 0);

    return {
      balance: user.creditBalance,
      tier,
      currentRateBps: displayRateBps(tier, campaigns, null),
      tierRates: TIER_CASHBACK_BPS,
      capPerOrder: CASHBACK_CAP_PER_ORDER,
      lifetimeEarned: lifetime,
      expiringWithin60Days: expiringSoon,
      activeCampaigns: campaigns.map((c) => ({
        id: c.id, label: c.label, bonusBps: c.bonusBps, merchantId: c.merchantId ?? null,
      })),
      history: awards.slice(0, 50).map((a) => ({
        id: a.id,
        orderReference: a.order.reference,
        merchantName: a.order.merchant?.name ?? "Butler",
        amount: a.amount,
        clawedBack: a.clawedBack,
        net: a.amount - a.clawedBack,
        rateBps: a.effectiveBps,
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
      })),
    };
  });

  app.get("/cashback/campaigns", async (request) => {
    const { merchantId } = z.object({ merchantId: z.string().optional() }).parse(request.query);
    const campaigns = await activeCampaigns(merchantId ?? null);
    return campaigns.map((c) => ({
      id: c.id, label: c.label, bonusBps: c.bonusBps, merchantId: c.merchantId ?? null,
    }));
  });
}

/**
 * Grant cashback for a delivered order. Called from the delivery settlement.
 * Idempotent: the unique constraint on orderId means a retried settlement
 * cannot pay twice.
 */
export async function awardCashback(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { cashbackAward: true },
  });
  if (!order || !order.deliveredAt) return null;
  if (order.cashbackAward) return null;

  const tier = await tierFor(order.userId);
  const campaigns = await activeCampaigns(order.merchantId);

  const result = calculateCashback({
    itemsSubtotal: order.itemsSubtotal,
    discountTotal: order.discountTotal,
    creditApplied: order.creditApplied,
    depositTotal: order.depositTotal,
    tipAmount: order.tipAmount,
    tier,
    campaigns,
    merchantId: order.merchantId,
  });

  if (result.amount <= 0) return null;

  const expiresAt = cashbackExpiryFrom(new Date());

  await prisma.$transaction(async (tx) => {
    await tx.cashbackAward.create({
      data: {
        userId: order.userId,
        orderId: order.id,
        campaignId: result.appliedCampaigns[0]?.id ?? null,
        amount: result.amount,
        eligibleBase: result.eligibleBase,
        effectiveBps: result.effectiveBps,
        expiresAt,
      },
    });
    await tx.creditEntry.create({
      data: {
        userId: order.userId,
        orderId: order.id,
        amount: result.amount,
        reason: "CASHBACK",
        note: `${(result.effectiveBps / 100).toFixed(1)}% Cashback`,
        expiresAt,
      },
    });
    await tx.user.update({
      where: { id: order.userId },
      data: { creditBalance: { increment: result.amount } },
    });
  });

  return { amount: result.amount, effectiveBps: result.effectiveBps, expiresAt };
}

/**
 * Reverse cashback when an order is refunded. Without this, order-and-refund is
 * a way to farm credit.
 *
 * The balance is allowed to go negative rather than clamping at zero: a customer
 * who already spent farmed credit still owes it back, and silently forgiving
 * that makes the exploit profitable.
 */
export async function clawbackCashback(orderId: string, refundedGoods: number) {
  const award = await prisma.cashbackAward.findUnique({ where: { orderId } });
  if (!award) return null;

  const remaining = award.amount - award.clawedBack;
  if (remaining <= 0) return null;

  const reverse = Math.min(
    remaining,
    clawbackAmount(award.amount, refundedGoods, award.eligibleBase),
  );
  if (reverse <= 0) return null;

  await prisma.$transaction(async (tx) => {
    await tx.cashbackAward.update({
      where: { id: award.id },
      data: { clawedBack: { increment: reverse } },
    });
    await tx.creditEntry.create({
      data: {
        userId: award.userId,
        orderId,
        amount: -reverse,
        reason: "CASHBACK_CLAWBACK",
        note: "Cashback zurückgebucht (Erstattung)",
      },
    });
    await tx.user.update({
      where: { id: award.userId },
      data: { creditBalance: { decrement: reverse } },
    });
  });

  return { reversed: reverse };
}

async function tierFor(userId: string): Promise<LoyaltyTier> {
  const account = await prisma.loyaltyAccount.findUnique({ where: { userId } });
  const tier = account?.tier ?? "BRONZE";
  return (["BRONZE", "SILVER", "GOLD"].includes(tier) ? tier : "BRONZE") as LoyaltyTier;
}

async function activeCampaigns(merchantId: string | null): Promise<CashbackCampaign[]> {
  const now = new Date();
  const rows = await prisma.cashbackCampaign.findMany({
    where: {
      isActive: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
      OR: [{ merchantId: null }, ...(merchantId ? [{ merchantId }] : [])],
    },
  });

  return rows.map((c) => ({
    id: c.id,
    bonusBps: c.bonusBps,
    merchantId: c.merchantId,
    fundedBy: c.fundedBy === "MERCHANT" ? "MERCHANT" : "PLATFORM",
    label: c.label,
  }));
}
