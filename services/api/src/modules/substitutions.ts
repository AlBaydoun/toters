import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";
import { buildQuote, type QuoteLine, type VatCategory } from "@liefero/shared";

/**
 * Grocery substitutions.
 *
 * Catalog freshness is the hardest operational problem in grocery: stock drifts
 * constantly, so the courier regularly finds an item missing while shopping.
 * The naive fix — silently swap it — is the single biggest driver of refunds
 * and one-star ratings, and in Germany it is also a contract problem: the
 * customer agreed to buy a specific good at a specific price.
 *
 * So substitutions are always customer-approved, and the price can only move in
 * the customer's favour without a fresh authorisation.
 */

const SUBSTITUTION_TIMEOUT_SECONDS = 180;

export default async function substitutionRoutes(app: FastifyInstance) {
  /** Courier proposes a replacement for an out-of-stock line. */
  app.post("/orders/:orderId/substitutions", { preHandler: app.requireAuth }, async (request) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.params);
    const body = z
      .object({
        orderItemId: z.string(),
        replacementProductId: z.string().nullable(),
        /** Null replacement = the line is simply removed and refunded. */
        note: z.string().max(300).optional(),
      })
      .parse(request.body);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound("Order");
    if (order.status !== "PREPARING" && order.status !== "AWAITING_COURIER") {
      throw badRequest("NOT_SUBSTITUTABLE", "This order is past the point where items can be swapped.");
    }

    const item = await prisma.orderItem.findFirst({ where: { id: body.orderItemId, orderId } });
    if (!item) throw notFound("Order item");
    if (item.substitutionStatus === "PENDING") {
      throw badRequest("ALREADY_PENDING", "A substitution is already awaiting the customer.");
    }

    let replacement = null;
    if (body.replacementProductId) {
      replacement = await prisma.product.findUnique({ where: { id: body.replacementProductId } });
      if (!replacement) throw notFound("Replacement product");

      // A replacement must not smuggle in an age restriction the customer never
      // agreed to and may not be able to satisfy at the door.
      if (replacement.minimumAge != null && (order.requiredAge ?? 0) < replacement.minimumAge) {
        throw badRequest(
          "SUBSTITUTION_AGE_RESTRICTED",
          "This replacement is age-restricted and can't be swapped in automatically.",
        );
      }
      // LMIV applies to the substitute exactly as it did to the original.
      if (!replacement.allergenDataComplete) {
        throw badRequest(
          "SUBSTITUTION_ALLERGEN_DATA",
          "This replacement is missing mandatory allergen information.",
        );
      }
    }

    await prisma.orderItem.update({
      where: { id: item.id },
      data: {
        substitutionStatus: "PENDING",
        substitutedForId: body.replacementProductId,
      },
    });

    await prisma.orderEvent.create({
      data: {
        orderId,
        status: order.status,
        actorType: "COURIER",
        actorId: request.userId ?? null,
        metadata: {
          kind: "SUBSTITUTION_PROPOSED",
          orderItemId: item.id,
          original: item.nameSnapshot,
          replacement: replacement?.name ?? null,
          priceDelta: replacement ? replacement.price - item.unitPrice : -item.unitPrice,
          note: body.note ?? null,
        },
      },
    });

    return {
      orderItemId: item.id,
      original: { name: item.nameSnapshot, unitPrice: item.unitPrice },
      replacement: replacement
        ? {
            id: replacement.id,
            name: replacement.name,
            unitPrice: replacement.price,
            allergens: replacement.allergens,
          }
        : null,
      priceDelta: (replacement ? replacement.price : 0) - item.unitPrice,
      // If the customer is unreachable the courier can't wait indefinitely; the
      // default on timeout is to REMOVE the line, never to charge for a swap
      // the customer never saw.
      expiresInSeconds: SUBSTITUTION_TIMEOUT_SECONDS,
      defaultOnTimeout: "REMOVE",
    };
  });

  /** Customer accepts or rejects the proposal. */
  app.post("/orders/:orderId/substitutions/:itemId/respond", { preHandler: app.requireAuth }, async (request) => {
    const { orderId, itemId } = z
      .object({ orderId: z.string(), itemId: z.string() })
      .parse(request.params);
    const { accept } = z.object({ accept: z.boolean() }).parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: request.userId! },
      include: { items: true },
    });
    if (!order) throw notFound("Order");

    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw notFound("Order item");
    if (item.substitutionStatus !== "PENDING") {
      throw badRequest("NO_PENDING_SUBSTITUTION", "There's nothing to respond to on this item.");
    }

    const replacement = item.substitutedForId
      ? await prisma.product.findUnique({ where: { id: item.substitutedForId } })
      : null;

    const updated = await prisma.$transaction(async (tx) => {
      if (accept && replacement) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            productId: replacement.id,
            nameSnapshot: replacement.name,
            unitPrice: replacement.price,
            vatCategory: replacement.vatCategory,
            lineTotal: replacement.price * item.quantity,
            substitutionStatus: "ACCEPTED",
          },
        });
      } else {
        // Rejected, or accepted-as-removal: the line is dropped and its value
        // comes off the order.
        await tx.orderItem.update({
          where: { id: item.id },
          data: { quantity: 0, lineTotal: 0, substitutionStatus: accept ? "REMOVED" : "REJECTED" },
        });
      }

      return recalculateOrder(tx, orderId);
    });

    return {
      accepted: accept,
      newTotal: updated.grandTotal,
      previousTotal: order.grandTotal,
      // Under PSD2 we can capture less than we authorised, but never more.
      requiresNewAuthorisation: updated.grandTotal > order.grandTotal,
    };
  });

  /** Courier marks an item unavailable with no replacement offered. */
  app.post("/orders/:orderId/items/:itemId/unavailable", { preHandler: app.requireAuth }, async (request) => {
    const { orderId, itemId } = z
      .object({ orderId: z.string(), itemId: z.string() })
      .parse(request.params);

    const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
    if (!item) throw notFound("Order item");

    const updated = await prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: { quantity: 0, lineTotal: 0, substitutionStatus: "UNAVAILABLE" },
      });
      // Reflect reality in the catalog too, so the next customer doesn't hit
      // the same dead line.
      if (item.productId) {
        await tx.product.update({ where: { id: item.productId }, data: { isAvailable: false } });
      }
      return recalculateOrder(tx, orderId);
    });

    return { newTotal: updated.grandTotal };
  });
}

/**
 * Reprice an order after its lines changed. Fees are recomputed rather than
 * kept, because the delivery fee's VAT apportionment depends on the basket's
 * rate mix — dropping the only 19% line changes the tax on the delivery fee.
 */
async function recalculateOrder(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  orderId: string,
) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: true, merchant: { include: { zone: true } } },
  });

  const lines: QuoteLine[] = order.items
    .filter((i) => i.quantity > 0)
    .map((i) => ({
      productId: i.productId ?? i.id,
      name: i.nameSnapshot,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      vatCategory: i.vatCategory as VatCategory,
      // Deposits are already captured per unit on the line.
      optionsDelta: 0,
    }));

  const quote = buildQuote({
    lines,
    delivery: {
      // The fee already agreed at checkout is honoured; a stock problem on our
      // side must not make delivery more expensive for the customer.
      baseFee: order.deliveryFee,
      distanceKm: 0,
      demandRatio: 1,
      subtotal: 0,
      minimumBasket: 0,
    },
    tipAmount: order.tipAmount,
    country: "DE",
  });

  const depositTotal = order.items
    .filter((i) => i.quantity > 0)
    .reduce((sum, i) => sum + i.depositPerUnit * i.quantity, 0);

  return tx.order.update({
    where: { id: orderId },
    data: {
      itemsSubtotal: quote.itemsSubtotal,
      depositTotal,
      serviceFee: quote.serviceFee,
      vatBreakdown: quote.vatBreakdown,
      grandTotal: Math.max(
        0,
        quote.itemsSubtotal + depositTotal + order.deliveryFee + quote.serviceFee
          - order.discountTotal - order.creditApplied + order.tipAmount,
      ),
    },
  });
}
