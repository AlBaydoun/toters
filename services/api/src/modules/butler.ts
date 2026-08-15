import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, orderReference } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";
import { zoneForPoint } from "../lib/geo.js";
import { calculateDeliveryFee, calculateVat } from "@liefero/shared";

/**
 * Butler: the buy-anything errand service. No catalog, no partner merchant — the
 * customer describes what they want and sets a spending ceiling.
 *
 * Strategically this is the cheapest thing to launch, because it needs zero
 * merchant integrations: on day one the addressable catalog is every shop in the
 * city. It is also the hardest to price, because we don't know the goods value
 * until the courier is standing at the till.
 */
export default async function butlerRoutes(app: FastifyInstance) {
  const createBody = z.object({
    addressId: z.string(),
    request: z.string().min(10).max(1000),
    /** Ceiling the courier may spend, gross cents. */
    budget: z.number().int().min(500).max(20_000),
    pickupLatitude: z.number().optional(),
    pickupLongitude: z.number().optional(),
    tipAmount: z.number().int().min(0).default(0),
  });

  /**
   * Butler carries no merchant commission, so the service fee has to be higher
   * to clear the same contribution bar. It scales with the budget because a
   * bigger purchase is more courier risk and more time at the counter.
   */
  function butlerServiceFee(budget: number): number {
    const scaled = Math.round(budget * 0.12);
    return Math.min(400, Math.max(250, scaled));
  }

  app.post("/butler", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const userId = request.userId!;

    const address = await prisma.address.findFirst({ where: { id: body.addressId, userId } });
    if (!address) throw notFound("Address");

    const zone = await zoneForPoint(address.latitude, address.longitude);
    if (!zone) throw badRequest("OUT_OF_ZONE", "Butler isn't available at this address yet.");

    const zoneRecord = await prisma.deliveryZone.findUniqueOrThrow({ where: { id: zone.id } });

    // Without a known pickup point, price the zone's typical errand distance and
    // reconcile on completion rather than guessing high and losing the order.
    const distanceKm =
      body.pickupLatitude != null && body.pickupLongitude != null
        ? haversine(address.latitude, address.longitude, body.pickupLatitude, body.pickupLongitude)
        : 2.5;

    const delivery = calculateDeliveryFee({
      baseFee: zoneRecord.baseDeliveryFee,
      distanceKm,
      demandRatio: 1,
      subtotal: body.budget,
      minimumBasket: 0,
    });

    const serviceFee = butlerServiceFee(body.budget);

    // The goods are third-party retail we do not sell, so we tax only our own
    // supply — the delivery and service fees — at the standard rate. The goods
    // are settled at cost against the courier's receipt.
    const vat = calculateVat({
      lines: [],
      deliveryFee: delivery.fee,
      serviceFee,
      depositTotal: 0,
      discountTotal: 0,
      tipAmount: body.tipAmount,
    });

    const order = await prisma.order.create({
      data: {
        reference: orderReference(),
        type: "BUTLER",
        status: "PENDING_PAYMENT",
        userId,
        addressId: address.id,
        butlerRequest: body.request,
        butlerBudget: body.budget,
        itemsSubtotal: 0,
        deliveryFee: delivery.fee,
        serviceFee,
        depositTotal: 0,
        discountTotal: 0,
        tipAmount: body.tipAmount,
        // Authorise against the ceiling; capture the actual receipt at delivery.
        grandTotal: body.budget + delivery.fee + serviceFee + body.tipAmount,
        vatBreakdown: vat.breakdown,
        placedAt: new Date(),
        events: { create: { status: "PENDING_PAYMENT", actorType: "CUSTOMER", actorId: userId } },
      },
    });

    reply.code(201);
    return {
      orderId: order.id,
      reference: order.reference,
      budget: body.budget,
      deliveryFee: delivery.fee,
      serviceFee,
      authorisedTotal: order.grandTotal,
      note: "You're charged what the courier actually spends, plus fees. The budget is an upper limit.",
    };
  });

  /**
   * The courier submits the real receipt total. Anything under budget is
   * released; over budget requires customer approval before capture, which is
   * also an SCA re-trigger.
   */
  app.post("/butler/:id/receipt", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { actualGoodsTotal } = z
      .object({ actualGoodsTotal: z.number().int().min(0) })
      .parse(request.body);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.type !== "BUTLER") throw notFound("Butler order");

    const overBudget = actualGoodsTotal > (order.butlerBudget ?? 0);
    const newTotal = actualGoodsTotal + order.deliveryFee + order.serviceFee + order.tipAmount;

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { itemsSubtotal: actualGoodsTotal, grandTotal: newTotal },
    });

    return {
      grandTotal: updated.grandTotal,
      overBudget,
      // Capturing more than was authorised needs a fresh mandate under PSD2.
      requiresCustomerApproval: overBudget,
    };
  });
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(toRad(lat1)) * Math.cos(toRad(lat2));
  return 2 * R * Math.asin(Math.sqrt(h));
}
