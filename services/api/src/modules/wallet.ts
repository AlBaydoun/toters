import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { createPsp, type PspRail } from "../lib/psp.js";
import {
  quoteTopUp, validateTopUp, walletBalance, refundableBalance, planSpend,
  assessZagThreshold, validateLateTip,
  MIN_TOPUP, MAX_TOPUP, MAX_WALLET_BALANCE, TOPUP_TIERS, TIP_WINDOW_HOURS, MAX_TIP,
} from "@liefero/shared";

const psp = createPsp();

/**
 * Wallet: prepaid balance the customer tops up and spends on future orders.
 *
 * The regulatory shape matters more than the feature. Holding spendable customer
 * funds is issuing electronic money by default, which needs a BaFin licence
 * under the ZAG — operating without one is a criminal offence (§63 ZAG). This
 * stays legal via the limited network exception (§2 Abs. 1 Nr. 10 ZAG): balance
 * spendable only on our own services, never transferable, never cashable.
 *
 * So there is deliberately no "withdraw to bank" endpoint here, and no
 * user-to-user transfer. Both would break the exemption.
 */
export default async function walletRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.requireActor("CUSTOMER") };

  app.get("/me/wallet", guard, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! } });
    const balance = walletBalance(user.purchasedBalance, user.grantedBalance);

    const [topUps, expiring] = await Promise.all([
      prisma.topUp.findMany({
        where: { userId: user.id, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      prisma.creditEntry.findMany({
        where: {
          userId: user.id,
          amount: { gt: 0 },
          expiresAt: { not: null, lt: new Date(Date.now() + 60 * 86_400_000) },
        },
        select: { amount: true, expiresAt: true },
      }),
    ]);

    const refund = refundableBalance(balance);

    return {
      balance: balance.total,
      purchased: balance.purchased,
      granted: balance.granted,
      expiringWithin60Days: expiring.reduce((sum, e) => sum + e.amount, 0),
      limits: { minTopUp: MIN_TOPUP, maxTopUp: MAX_TOPUP, maxBalance: MAX_WALLET_BALANCE },
      topUpTiers: TOPUP_TIERS,
      refundable: refund.refundable,
      refundExplanation: refund.explanation,
      topUps: topUps.map((t) => ({
        id: t.id,
        amount: t.amount,
        bonus: t.bonusAmount,
        credited: t.amount + t.bonusAmount,
        refunded: t.refundedAmount,
        createdAt: t.createdAt,
      })),
    };
  });

  /** What a given deposit would credit, before committing to it. */
  app.get("/wallet/topup/quote", guard, async (request) => {
    const { amount } = z.object({ amount: z.coerce.number().int() }).parse(request.query);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! } });
    const validation = validateTopUp(amount, user.creditBalance);

    if (!validation.ok) {
      return { valid: false, reason: validation.reason, ...quoteTopUp(amount) };
    }
    return { valid: true, reason: null, ...quoteTopUp(amount) };
  });

  /**
   * Deposit money. SCA applies exactly as it does to an order — this is a card
   * payment, and the fact that it buys balance rather than food changes nothing
   * about PSD2.
   */
  app.post("/wallet/topup", guard, async (request, reply) => {
    const { amount, methodId } = z
      .object({
        amount: z.number().int().min(MIN_TOPUP).max(MAX_TOPUP),
        methodId: z.string().optional(),
      })
      .parse(request.body);

    const userId = request.userId!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const validation = validateTopUp(amount, user.creditBalance);
    if (!validation.ok) {
      throw badRequest("TOPUP_REJECTED", topUpRejectionMessage(validation.reason), {
        reason: validation.reason,
      });
    }

    const method = methodId
      ? await prisma.paymentMethod.findFirst({ where: { id: methodId, userId } })
      : await prisma.paymentMethod.findFirst({ where: { userId, isDefault: true } });

    if (!method) throw badRequest("NO_PAYMENT_METHOD", "Add a payment method to top up.");
    // You cannot buy balance with balance, and cash on delivery funds an order,
    // not an account.
    if (method.type === "CREDIT" || method.type === "CASH_ON_DELIVERY") {
      throw badRequest("UNSUPPORTED_METHOD", "Top up with a card, SEPA, PayPal or Klarna.");
    }

    const quote = quoteTopUp(amount);

    const topUp = await prisma.topUp.create({
      data: {
        userId,
        methodId: method.id,
        amount,
        bonusAmount: quote.bonus,
        bonusBps: quote.bonusBps,
        status: "REQUIRES_ACTION",
      },
    });

    const auth = await psp.authorise({
      orderId: `topup_${topUp.id}`,
      amount,
      rail: method.type as PspRail,
      methodRef: method.providerRef,
      customerRef: userId,
      idempotencyKey: `topup_${topUp.id}`,
    });

    await prisma.topUp.update({
      where: { id: topUp.id },
      data: { providerRef: auth.providerRef },
    });

    // Balance is credited only once the money is actually captured — crediting
    // on authorisation would hand out spendable balance against a hold that can
    // still fail.
    if (!auth.requiresAction) {
      await captureTopUp(topUp.id);
    }

    reply.code(201);
    return {
      topUpId: topUp.id,
      amount,
      bonus: quote.bonus,
      credited: quote.credited,
      requiresAction: auth.requiresAction,
      actionToken: auth.actionToken,
    };
  });

  /** Called after the customer completes the SCA challenge. */
  app.post("/wallet/topup/:id/confirm", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const topUp = await prisma.topUp.findFirst({ where: { id, userId: request.userId! } });
    if (!topUp) throw notFound("Top-up");
    if (topUp.status === "COMPLETED") return { status: topUp.status };
    if (topUp.status !== "REQUIRES_ACTION") {
      throw conflict("TOPUP_NOT_PENDING", `Top-up is ${topUp.status}.`);
    }

    const result = await captureTopUp(id);
    return { status: "COMPLETED", credited: result.credited, balance: result.balance };
  });

  /**
   * Pay back unused purchased balance.
   *
   * Only the customer's own money, and only to the original method. Paying out
   * granted balance would convert a marketing accrual into cash redemption,
   * which is the property that would make this e-money and cost us the
   * exemption.
   */
  app.post("/wallet/refund", guard, async (request) => {
    const userId = request.userId!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const balance = walletBalance(user.purchasedBalance, user.grantedBalance);
    const { refundable, explanation } = refundableBalance(balance);

    if (refundable <= 0) {
      throw badRequest("NOTHING_REFUNDABLE", explanation, {
        granted: balance.granted,
      });
    }

    // Refund against the most recent top-ups first — those are the ones whose
    // original payment methods are most likely to still be valid.
    const topUps = await prisma.topUp.findMany({
      where: { userId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });

    let remaining = refundable;
    const refunded: { topUpId: string; amount: number }[] = [];

    for (const topUp of topUps) {
      if (remaining <= 0) break;
      const available = topUp.amount - topUp.refundedAmount;
      if (available <= 0) continue;

      const take = Math.min(available, remaining);
      if (topUp.providerRef) {
        await psp.refund(topUp.providerRef, take, "TOPUP_REFUND").catch(() => undefined);
      }
      await prisma.topUp.update({
        where: { id: topUp.id },
        data: {
          refundedAmount: { increment: take },
          status: take >= available ? "REFUNDED" : topUp.status,
        },
      });
      refunded.push({ topUpId: topUp.id, amount: take });
      remaining -= take;
    }

    const paidOut = refundable - remaining;

    await prisma.$transaction(async (tx) => {
      await tx.creditEntry.create({
        data: {
          userId,
          bucket: "PURCHASED",
          amount: -paidOut,
          reason: "TOPUP_REFUND",
          note: "Auszahlung des aufgeladenen Guthabens",
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          purchasedBalance: { decrement: paidOut },
          creditBalance: { decrement: paidOut },
        },
      });
    });

    return { refunded: paidOut, remainingGranted: balance.granted, explanation, breakdown: refunded };
  });

  /**
   * Tip after delivery, which is when the customer actually knows how it went.
   *
   * Charged to a payment method, never funded from wallet balance: a tip paid
   * out of cashback we granted would mean paying the courier from our own
   * marketing budget while the customer takes the credit for it.
   */
  app.post("/orders/:id/tip", guard, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { amount, methodId } = z
      .object({
        amount: z.number().int().min(50).max(MAX_TIP),
        methodId: z.string().optional(),
      })
      .parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id, userId: request.userId! },
      include: { lateTips: true },
    });
    if (!order) throw notFound("Order");

    const validation = validateLateTip(amount, order.deliveredAt, order.courierId != null);
    if (!validation.ok) {
      throw badRequest("TIP_REJECTED", tipRejectionMessage(validation.reason), {
        reason: validation.reason,
        windowHours: TIP_WINDOW_HOURS,
      });
    }

    const method = methodId
      ? await prisma.paymentMethod.findFirst({ where: { id: methodId, userId: request.userId! } })
      : await prisma.paymentMethod.findFirst({
          where: { userId: request.userId!, isDefault: true },
        });
    if (!method) throw badRequest("NO_PAYMENT_METHOD", "Add a payment method to tip.");

    const tip = await prisma.lateTip.create({
      data: {
        orderId: order.id,
        userId: request.userId!,
        courierId: order.courierId!,
        amount,
        methodId: method.id,
        status: "PENDING",
      },
    });

    const auth = await psp.authorise({
      orderId: `tip_${tip.id}`,
      amount,
      rail: method.type as PspRail,
      methodRef: method.providerRef,
      customerRef: request.userId!,
      idempotencyKey: `tip_${tip.id}`,
    });

    if (!auth.requiresAction) {
      await psp.capture(auth.providerRef, amount, amount);
      await prisma.$transaction(async (tx) => {
        await tx.lateTip.update({
          where: { id: tip.id },
          data: { status: "CAPTURED", providerRef: auth.providerRef },
        });
        // 100% to the courier, credited to the open shift so it shows up in
        // their earnings the same day.
        const shift = await tx.courierShift.findFirst({
          where: { courierId: order.courierId!, endedAt: null },
        });
        if (shift) {
          await tx.courierShift.update({
            where: { id: shift.id },
            data: { earnedCents: { increment: amount } },
          });
        }
      });
    } else {
      await prisma.lateTip.update({
        where: { id: tip.id },
        data: { providerRef: auth.providerRef },
      });
    }

    reply.code(201);
    return {
      tipId: tip.id,
      amount,
      requiresAction: auth.requiresAction,
      actionToken: auth.actionToken,
      note: "Das Trinkgeld geht zu 100 % an deinen Kurier.",
    };
  });

  /**
   * Limited-network volume against the ZAG threshold. Admin-only, and worth
   * watching: crossing €1m over twelve months triggers a notification duty to
   * BaFin, and discovering that after the fact is far worse than tracking it.
   */
  app.get("/admin/wallet/zag-status", { preHandler: app.requireActor("ADMIN") }, async () => {
    const since = new Date(Date.now() - 365 * 86_400_000);
    const agg = await prisma.topUp.aggregate({
      where: { status: "COMPLETED", completedAt: { gte: since } },
      _sum: { amount: true },
    });
    return assessZagThreshold(agg._sum.amount ?? 0);
  });
}

/**
 * Capture a top-up and credit the wallet.
 *
 * The two buckets are written separately: the charged amount is the customer's
 * money and stays refundable, the bonus is ours and never is.
 */
async function captureTopUp(topUpId: string) {
  const topUp = await prisma.topUp.findUniqueOrThrow({ where: { id: topUpId } });
  if (topUp.status === "COMPLETED") {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: topUp.userId } });
    return { credited: 0, balance: user.creditBalance };
  }

  if (topUp.providerRef) {
    await psp.capture(topUp.providerRef, topUp.amount, topUp.amount);
  }

  const user = await prisma.$transaction(async (tx) => {
    await tx.topUp.update({
      where: { id: topUpId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    await tx.creditEntry.create({
      data: {
        userId: topUp.userId,
        bucket: "PURCHASED",
        amount: topUp.amount,
        reason: "TOPUP",
        note: "Guthaben aufgeladen",
      },
    });

    if (topUp.bonusAmount > 0) {
      await tx.creditEntry.create({
        data: {
          userId: topUp.userId,
          bucket: "GRANTED",
          amount: topUp.bonusAmount,
          reason: "TOPUP_BONUS",
          note: `${(topUp.bonusBps / 100).toFixed(1)}% Aufladebonus`,
          // Bonus balance expires; purchased balance does not.
          expiresAt: new Date(Date.now() + 3 * 365 * 86_400_000),
        },
      });
    }

    return tx.user.update({
      where: { id: topUp.userId },
      data: {
        purchasedBalance: { increment: topUp.amount },
        grantedBalance: { increment: topUp.bonusAmount },
        creditBalance: { increment: topUp.amount + topUp.bonusAmount },
      },
    });
  });

  return { credited: topUp.amount + topUp.bonusAmount, balance: user.creditBalance };
}

/**
 * Spend wallet balance, draining granted first because it expires. Exported for
 * checkout, so both paths split the buckets identically.
 */
export async function spendWallet(userId: string, amount: number, orderId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const plan = planSpend(walletBalance(user.purchasedBalance, user.grantedBalance), amount);

  if (plan.total <= 0) return plan;

  await prisma.$transaction(async (tx) => {
    if (plan.fromGranted > 0) {
      await tx.creditEntry.create({
        data: { userId, orderId, bucket: "GRANTED", amount: -plan.fromGranted, reason: "SPEND" },
      });
    }
    if (plan.fromPurchased > 0) {
      await tx.creditEntry.create({
        data: { userId, orderId, bucket: "PURCHASED", amount: -plan.fromPurchased, reason: "SPEND" },
      });
    }
    await tx.user.update({
      where: { id: userId },
      data: {
        grantedBalance: { decrement: plan.fromGranted },
        purchasedBalance: { decrement: plan.fromPurchased },
        creditBalance: { decrement: plan.total },
      },
    });
  });

  return plan;
}

function topUpRejectionMessage(reason: string): string {
  switch (reason) {
    case "BELOW_MINIMUM":
      return `Der Mindestbetrag beträgt ${(MIN_TOPUP / 100).toFixed(2)} €.`;
    case "ABOVE_MAXIMUM":
      return `Pro Aufladung sind höchstens ${(MAX_TOPUP / 100).toFixed(2)} € möglich.`;
    case "WOULD_EXCEED_WALLET_CAP":
      return `Dein Guthaben darf ${(MAX_WALLET_BALANCE / 100).toFixed(2)} € nicht überschreiten.`;
    default:
      return "Aufladung nicht möglich.";
  }
}

function tipRejectionMessage(reason: string): string {
  switch (reason) {
    case "WINDOW_CLOSED":
      return `Trinkgeld ist bis ${TIP_WINDOW_HOURS} Stunden nach der Lieferung möglich.`;
    case "NOT_DELIVERED":
      return "Diese Bestellung wurde noch nicht geliefert.";
    case "NO_COURIER":
      return "Zu dieser Bestellung gehört kein Kurier.";
    case "ABOVE_MAXIMUM":
      return `Höchstens ${(MAX_TIP / 100).toFixed(2)} € Trinkgeld.`;
    default:
      return "Trinkgeld nicht möglich.";
  }
}
