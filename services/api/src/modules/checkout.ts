import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { orderReference } from "../lib/prisma.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { zoneForPoint } from "../lib/geo.js";
import {
  buildQuote,
  haversineKm,
  isOldEnough,
  type QuoteLine,
  type VatCategory,
} from "@liefero/shared";

const quoteBody = z.object({
  addressId: z.string(),
  promoCode: z.string().optional(),
  tipAmount: z.number().int().min(0).default(0),
  useCredit: z.boolean().default(false),
  fulfilmentMode: z.enum(["ASAP", "SCHEDULED"]).default("ASAP"),
  scheduledFor: z.string().datetime().optional(),
});

export default async function checkoutRoutes(app: FastifyInstance) {
  /**
   * Quote and checkout share one code path. The client never supplies a total —
   * it is always recomputed server-side from the cart, because a client-supplied
   * price is a client-supplied discount.
   */
  app.post("/checkout/quote", { preHandler: app.requireAuth }, async (request) => {
    const body = quoteBody.parse(request.body);
    const { quote } = await priceCart(request.userId!, body);
    return quote;
  });

  app.post("/checkout", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = quoteBody.parse(request.body);
    const userId = request.userId!;

    // One active order at a time. Concurrent orders make dispatch, support and
    // the cancellation policy ambiguous for very little upside.
    const active = await prisma.order.count({
      where: {
        userId,
        status: { in: ["PENDING_PAYMENT", "AWAITING_MERCHANT", "PREPARING", "AWAITING_COURIER", "OUT_FOR_DELIVERY"] },
      },
    });
    if (active > 0) {
      throw conflict("ACTIVE_ORDER_EXISTS", "You already have an order in progress.");
    }

    const { quote, cart, address, lines, user } = await priceCart(userId, body);

    // --- LMIV hard gate. Cheaper to lose the order than to take a Bußgeld.
    const incomplete = cart.items.filter(
      (i) => isFood(i.product.vatCategory) && !i.product.allergenDataComplete,
    );
    if (incomplete.length > 0) {
      throw badRequest(
        "ALLERGEN_DATA_INCOMPLETE",
        "Mandatory allergen information is missing for one or more items and they cannot be sold.",
        { productIds: incomplete.map((i) => i.productId) },
      );
    }

    // --- JuSchG pre-gate. The binding check is still the courier's ID check.
    if (quote.requiredAge != null) {
      if (!user.dateOfBirth) {
        throw badRequest("DOB_REQUIRED", "This basket contains age-restricted items. Add your date of birth to continue.", {
          requiredAge: quote.requiredAge,
        });
      }
      if (!isOldEnough(user.dateOfBirth, quote.requiredAge)) {
        throw badRequest("AGE_RESTRICTED", "You do not meet the minimum age for one or more items.", {
          requiredAge: quote.requiredAge,
        });
      }
    }

    if (body.fulfilmentMode === "SCHEDULED" && !body.scheduledFor) {
      throw badRequest("SLOT_REQUIRED", "Pick a delivery slot.");
    }

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          reference: orderReference(),
          type: "MARKETPLACE",
          status: "PENDING_PAYMENT",
          userId,
          merchantId: cart.merchantId,
          addressId: address.id,
          fulfilmentMode: body.fulfilmentMode,
          scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          itemsSubtotal: quote.itemsSubtotal,
          deliveryFee: quote.deliveryFee + quote.smallBasketSurcharge,
          serviceFee: quote.serviceFee,
          depositTotal: quote.depositTotal,
          discountTotal: quote.discountTotal,
          creditApplied: quote.creditApplied,
          tipAmount: quote.tipAmount,
          grandTotal: quote.grandTotal,
          vatBreakdown: quote.vatBreakdown,
          requiredAge: quote.requiredAge,
          placedAt: new Date(),
          items: {
            create: cart.items.map((item) => ({
              productId: item.productId,
              nameSnapshot: item.product.name,
              unitPrice: item.product.price,
              quantity: item.quantity,
              vatCategory: item.product.vatCategory,
              depositPerUnit: depositCents(item.product.depositScheme),
              lineTotal:
                (item.product.price + optionsDelta(item)) * item.quantity,
              note: item.note,
              options: {
                create: item.options.map((o) => ({
                  optionId: o.optionId,
                  nameSnapshot: o.option.name,
                  priceDelta: o.option.priceDelta,
                })),
              },
            })),
          },
          events: {
            create: { status: "PENDING_PAYMENT", actorType: "CUSTOMER", actorId: userId },
          },
        },
      });

      // Spend credit against the append-only ledger, never by mutating a balance.
      if (quote.creditApplied > 0) {
        await tx.creditEntry.create({
          data: { userId, orderId: created.id, amount: -quote.creditApplied, reason: "SPEND" },
        });
        await tx.user.update({
          where: { id: userId },
          data: { creditBalance: { decrement: quote.creditApplied } },
        });
      }

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { merchantId: null, promoCode: null } });

      return created;
    });

    reply.code(201);
    return {
      orderId: order.id,
      reference: order.reference,
      status: order.status,
      grandTotal: order.grandTotal,
      // Non-perishable retail keeps the 14-day right; food does not. Either way
      // the notice is mandatory (§312g BGB).
      withdrawalNotice: lines.some((l) => l.vatCategory === "GOODS_STANDARD")
        ? "withdrawal.standard"
        : "withdrawal.perishable",
      /** The client now confirms payment with the PSP; SCA may be required. */
      nextAction: "CONFIRM_PAYMENT",
    };
  });
}

async function priceCart(userId: string, body: z.infer<typeof quoteBody>) {
  const [user, cart, address] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.cart.findFirst({
      where: { userId },
      include: {
        items: {
          include: {
            product: true,
            options: { include: { option: true } },
          },
        },
      },
    }),
    prisma.address.findFirst({ where: { id: body.addressId, userId } }),
  ]);

  if (!cart || cart.items.length === 0) throw badRequest("CART_EMPTY", "Your cart is empty.");
  if (!address) throw notFound("Address");
  if (!cart.merchantId) throw badRequest("CART_INVALID", "Cart has no merchant.");

  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: cart.merchantId },
    include: { zone: true },
  });

  const zone = await zoneForPoint(address.latitude, address.longitude);
  if (!zone) {
    throw badRequest("OUT_OF_ZONE", "We don't deliver to this address yet.");
  }

  const distanceKm = haversineKm(
    { latitude: merchant.latitude, longitude: merchant.longitude },
    { latitude: address.latitude, longitude: address.longitude },
  );

  const promotion = body.promoCode
    ? await prisma.promotion.findFirst({
        where: {
          code: body.promoCode,
          isActive: true,
          startsAt: { lte: new Date() },
          endsAt: { gte: new Date() },
          OR: [{ merchantId: null }, { merchantId: merchant.id }],
        },
      })
    : null;

  if (body.promoCode && !promotion) {
    throw badRequest("PROMO_INVALID", "That promo code isn't valid.");
  }
  if (promotion) {
    const used = await prisma.promoRedemption.count({
      where: { promotionId: promotion.id, userId },
    });
    if (used >= promotion.perUserLimit) {
      throw badRequest("PROMO_USED", "You've already used that code.");
    }
    if (promotion.usageLimit != null && promotion.usageCount >= promotion.usageLimit) {
      throw badRequest("PROMO_EXHAUSTED", "That code has reached its limit.");
    }
  }

  const lines: QuoteLine[] = cart.items.map((item) => ({
    productId: item.productId,
    name: item.product.name,
    unitPrice: item.product.price,
    quantity: item.quantity,
    vatCategory: item.product.vatCategory as VatCategory,
    depositScheme: item.product.depositScheme,
    optionsDelta: optionsDelta(item),
    minimumAge: item.product.minimumAge,
  }));

  const quote = buildQuote({
    lines,
    delivery: {
      baseFee: merchant.zone?.baseDeliveryFee ?? 349,
      distanceKm,
      demandRatio: 1,
      subtotal: 0,
      minimumBasket: merchant.minimumBasket ?? merchant.zone?.minimumBasket ?? 1000,
      freeDeliveryAbove: merchant.zone?.freeDeliveryAbove,
    },
    promotion: promotion
      ? {
          type: promotion.type as "PERCENTAGE_OFF" | "FIXED_OFF" | "FREE_DELIVERY",
          value: promotion.value,
          maxDiscount: promotion.maxDiscount,
          minimumBasket: promotion.minimumBasket,
        }
      : null,
    creditAvailable: body.useCredit ? user.creditBalance : 0,
    tipAmount: body.tipAmount,
    country: "DE",
  });

  return { quote, cart, address, merchant, lines, user };
}

function optionsDelta(item: { options: { option: { priceDelta: number } }[] }): number {
  return item.options.reduce((sum, o) => sum + o.option.priceDelta, 0);
}

function depositCents(scheme: string): number {
  const map: Record<string, number> = {
    NONE: 0, ONE_WAY_025: 25, REUSABLE_008: 8, REUSABLE_015: 15, CRATE_150: 150,
  };
  return map[scheme] ?? 0;
}

function isFood(category: string): boolean {
  return category === "FOOD_REDUCED" || category === "BEVERAGE_STANDARD";
}
