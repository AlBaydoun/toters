import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { assertTransition, applyBps, type OrderStatus } from "@liefero/shared";

/**
 * The merchant console's API.
 *
 * Every route here is scoped to `request.merchantId` from the token — a merchant
 * can only ever see and act on their own data, and the merchant id is never
 * taken from the request.
 */

/** Roles allowed to change money-adjacent or legal settings. */
function requireRole(request: { merchantId?: string }, role: string, allowed: string[]) {
  if (!allowed.includes(role)) {
    throw forbidden(`This action requires one of: ${allowed.join(", ")}.`);
  }
}

async function staffOf(staffId: string) {
  const staff = await prisma.merchantStaff.findUnique({ where: { id: staffId } });
  if (!staff) throw forbidden("Unknown staff account.");
  return staff;
}

export default async function merchantRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.requireActor("MERCHANT") };

  // -------------------------------------------------------------------------
  // Order queue — the console's reason to exist
  // -------------------------------------------------------------------------

  app.get("/merchant/orders", guard, async (request) => {
    const { scope } = z
      .object({ scope: z.enum(["live", "today", "history"]).default("live") })
      .parse(request.query);

    const live: OrderStatus[] = ["AWAITING_MERCHANT", "PREPARING", "AWAITING_COURIER", "OUT_FOR_DELIVERY"];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const where =
      scope === "live"
        ? { merchantId: request.merchantId!, status: { in: live } }
        : scope === "today"
          ? { merchantId: request.merchantId!, createdAt: { gte: startOfDay } }
          : { merchantId: request.merchantId! };

    const orders = await prisma.order.findMany({
      where,
      orderBy: scope === "live" ? { placedAt: "asc" } : { createdAt: "desc" },
      take: scope === "history" ? 100 : 50,
      include: {
        items: { include: { options: true } },
        // The courier's surname and phone are not the merchant's business.
        courier: { select: { firstName: true, vehicle: true } },
        address: { select: { postalCode: true, city: true } },
      },
    });

    return orders.map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      placedAt: o.placedAt,
      acceptedAt: o.acceptedAt,
      scheduledFor: o.scheduledFor,
      fulfilmentMode: o.fulfilmentMode,
      // Merchants are paid on goods, so goods is what they see. Showing the
      // customer's grand total would misrepresent what the merchant earns.
      itemsSubtotal: o.itemsSubtotal,
      requiredAge: o.requiredAge,
      courier: o.courier,
      /** Coarse destination only — the merchant never needs the street. */
      destination: `${o.address.postalCode} ${o.address.city}`,
      minutesWaiting: o.placedAt
        ? Math.floor((Date.now() - o.placedAt.getTime()) / 60_000)
        : null,
      items: o.items
        .filter((i) => i.quantity > 0)
        .map((i) => ({
          id: i.id,
          name: i.nameSnapshot,
          quantity: i.quantity,
          note: i.note,
          substitutionStatus: i.substitutionStatus,
          options: i.options.map((opt) => opt.nameSnapshot),
        })),
    }));
  });

  /** Accept an order, optionally overriding the prep estimate. */
  app.post("/merchant/orders/:id/accept", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { prepMinutes } = z
      .object({ prepMinutes: z.number().int().min(1).max(120).optional() })
      .parse(request.body ?? {});

    const order = await prisma.order.findFirst({
      where: { id, merchantId: request.merchantId! },
    });
    if (!order) throw notFound("Order");

    assertTransition(order.status as OrderStatus, "PREPARING", "MERCHANT");

    const updated = await prisma.$transaction(async (tx) => {
      await tx.orderEvent.create({
        data: {
          orderId: id,
          status: "PREPARING",
          actorType: "MERCHANT",
          actorId: request.userId ?? null,
          metadata: prepMinutes ? { prepMinutes } : undefined,
        },
      });
      return tx.order.update({
        where: { id },
        data: { status: "PREPARING", acceptedAt: new Date() },
      });
    });

    // Feed the accepted prep time back into the rolling estimate. A merchant who
    // consistently needs 25 minutes should stop having couriers sent at 15.
    if (prepMinutes) {
      const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: request.merchantId! } });
      const blended = Math.round(merchant.avgPrepSeconds * 0.8 + prepMinutes * 60 * 0.2);
      await prisma.merchant.update({
        where: { id: request.merchantId! },
        data: { avgPrepSeconds: blended },
      });
    }

    return { status: updated.status, acceptedAt: updated.acceptedAt };
  });

  app.post("/merchant/orders/:id/reject", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { reason } = z
      .object({
        reason: z.enum(["OUT_OF_STOCK", "TOO_BUSY", "CLOSING", "CANNOT_FULFIL"]),
      })
      .parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id, merchantId: request.merchantId! },
    });
    if (!order) throw notFound("Order");

    assertTransition(order.status as OrderStatus, "REJECTED", "MERCHANT");

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { status: "REJECTED", cancellationReason: reason, cancelledAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          status: "REJECTED",
          actorType: "MERCHANT",
          actorId: request.userId ?? null,
          metadata: { reason },
        },
      });
      // The customer paid nothing and gets their credit back — a rejection is
      // never the customer's fault.
      if (order.creditApplied > 0) {
        await tx.creditEntry.create({
          data: {
            userId: order.userId,
            orderId: id,
            amount: order.creditApplied,
            reason: "REFUND_CANCELLATION",
          },
        });
        await tx.user.update({
          where: { id: order.userId },
          data: { creditBalance: { increment: order.creditApplied } },
        });
      }
    });

    return { status: "REJECTED", reason };
  });

  app.post("/merchant/orders/:id/ready", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const order = await prisma.order.findFirst({
      where: { id, merchantId: request.merchantId! },
    });
    if (!order) throw notFound("Order");

    assertTransition(order.status as OrderStatus, "AWAITING_COURIER", "MERCHANT");

    const updated = await prisma.$transaction(async (tx) => {
      await tx.orderEvent.create({
        data: { orderId: id, status: "AWAITING_COURIER", actorType: "MERCHANT", actorId: request.userId ?? null },
      });
      return tx.order.update({
        where: { id },
        data: { status: "AWAITING_COURIER", readyAt: new Date() },
      });
    });

    return { status: updated.status, readyAt: updated.readyAt };
  });

  // -------------------------------------------------------------------------
  // Store controls
  // -------------------------------------------------------------------------

  app.get("/merchant/store", guard, async (request) => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: request.merchantId! },
      include: { openingHours: { orderBy: { weekday: "asc" } } },
    });

    const incompleteAllergens = await prisma.product.count({
      where: {
        merchantId: merchant.id,
        allergenDataComplete: false,
        vatCategory: { in: ["FOOD_REDUCED", "BEVERAGE_STANDARD"] },
      },
    });

    return {
      id: merchant.id,
      name: merchant.name,
      status: merchant.status,
      type: merchant.type,
      avgPrepMinutes: Math.round(merchant.avgPrepSeconds / 60),
      minimumBasket: merchant.minimumBasket,
      commissionBps: merchant.commissionBps,
      rating: merchant.ratingAvg,
      ratingCount: merchant.ratingCount,
      openingHours: merchant.openingHours,
      trader: {
        legalName: merchant.legalName,
        registrationNo: merchant.registrationNo,
        vatId: merchant.vatId,
        verifiedAt: merchant.verifiedAt,
      },
      // Surfaced prominently: these products cannot legally be sold, so they are
      // silently costing the merchant orders until fixed.
      compliance: {
        productsBlockedByMissingAllergens: incompleteAllergens,
      },
    };
  });

  /** Pause the store — the one control a busy kitchen actually reaches for. */
  app.post("/merchant/store/pause", guard, async (request) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
    const staff = await staffOf(request.userId!);
    requireRole(request, staff.role, ["OWNER", "MANAGER", "STAFF"]);

    const merchant = await prisma.merchant.update({
      where: { id: request.merchantId! },
      data: { status: paused ? "PAUSED" : "ACTIVE" },
    });
    return { status: merchant.status };
  });

  app.patch("/merchant/store", guard, async (request) => {
    const body = z
      .object({
        avgPrepMinutes: z.number().int().min(1).max(120).optional(),
        minimumBasket: z.number().int().min(0).max(10_000).optional(),
      })
      .parse(request.body);

    const staff = await staffOf(request.userId!);
    requireRole(request, staff.role, ["OWNER", "MANAGER"]);

    const merchant = await prisma.merchant.update({
      where: { id: request.merchantId! },
      data: {
        ...(body.avgPrepMinutes ? { avgPrepSeconds: body.avgPrepMinutes * 60 } : {}),
        ...(body.minimumBasket != null ? { minimumBasket: body.minimumBasket } : {}),
      },
    });

    return {
      avgPrepMinutes: Math.round(merchant.avgPrepSeconds / 60),
      minimumBasket: merchant.minimumBasket,
    };
  });

  app.put("/merchant/store/hours", guard, async (request) => {
    const { hours } = z
      .object({
        hours: z.array(
          z.object({
            weekday: z.number().int().min(0).max(6),
            opensAt: z.string().regex(/^\d{2}:\d{2}$/),
            closesAt: z.string().regex(/^\d{2}:\d{2}$/),
          }),
        ),
      })
      .parse(request.body);

    const staff = await staffOf(request.userId!);
    requireRole(request, staff.role, ["OWNER", "MANAGER"]);

    for (const h of hours) {
      if (h.closesAt <= h.opensAt) {
        throw badRequest("INVALID_HOURS", `Closing time must be after opening on weekday ${h.weekday}.`);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.openingHours.deleteMany({ where: { merchantId: request.merchantId! } });
      await tx.openingHours.createMany({
        data: hours.map((h) => ({ ...h, merchantId: request.merchantId! })),
      });
    });

    return { hours };
  });

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  app.get("/merchant/products", guard, async (request) => {
    const products = await prisma.product.findMany({
      where: { merchantId: request.merchantId! },
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ isAvailable: "desc" }, { name: "asc" }],
    });

    return products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      vatCategory: p.vatCategory,
      isAvailable: p.isAvailable,
      stockCount: p.stockCount,
      allergens: p.allergens,
      additives: p.additives,
      allergenDataComplete: p.allergenDataComplete,
      minimumAge: p.minimumAge,
      depositScheme: p.depositScheme,
      contentAmount: p.contentAmount,
      contentUnit: p.contentUnit,
      /**
       * Why a product is not sellable right now. The merchant needs the reason,
       * not just a red dot — "missing allergen data" and "out of stock" have
       * completely different fixes.
       */
      blockedReason: !p.allergenDataComplete && isFoodCategory(p.vatCategory)
        ? "MISSING_ALLERGEN_DATA"
        : !p.isAvailable
          ? "UNAVAILABLE"
          : p.stockCount === 0
            ? "OUT_OF_STOCK"
            : null,
    }));
  });

  /** The 86 button. Fastest path in the console, used dozens of times a shift. */
  app.post("/merchant/products/:id/availability", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(request.body);

    const product = await prisma.product.findFirst({
      where: { id, merchantId: request.merchantId! },
    });
    if (!product) throw notFound("Product");

    const updated = await prisma.product.update({
      where: { id },
      data: { isAvailable },
    });
    return { id: updated.id, isAvailable: updated.isAvailable };
  });

  /**
   * Allergen and additive declaration (LMIV / LMIDV).
   *
   * Checkout hard-blocks food products where this is incomplete, so this is the
   * endpoint that unblocks selling. `allergenDataComplete` is set by an explicit
   * confirmation rather than inferred from a non-empty list — "contains nothing
   * from the 14" is a valid and common declaration, and inferring completeness
   * from emptiness would make it unexpressable.
   */
  app.put("/merchant/products/:id/food-info", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        allergens: z.array(
          z.enum([
            "GLUTEN", "CRUSTACEANS", "EGGS", "FISH", "PEANUTS", "SOYBEANS", "MILK",
            "NUTS", "CELERY", "MUSTARD", "SESAME", "SULPHITES", "LUPIN", "MOLLUSCS",
          ]),
        ),
        additives: z.array(
          z.enum([
            "MIT_FARBSTOFF", "MIT_KONSERVIERUNGSSTOFF", "MIT_ANTIOXIDATIONSMITTEL",
            "MIT_GESCHMACKSVERSTAERKER", "GESCHWEFELT", "GESCHWAERZT", "GEWACHST",
            "MIT_PHOSPHAT", "MIT_SUESSUNGSMITTEL", "KOFFEINHALTIG", "CHININHALTIG",
          ]),
        ).default([]),
        /** Explicit confirmation that the declaration is complete and accurate. */
        confirmed: z.boolean(),
        minimumAge: z.number().int().min(16).max(18).nullable().optional(),
        nutriScore: z.enum(["A", "B", "C", "D", "E"]).nullable().optional(),
      })
      .parse(request.body);

    const product = await prisma.product.findFirst({
      where: { id, merchantId: request.merchantId! },
    });
    if (!product) throw notFound("Product");

    const updated = await prisma.product.update({
      where: { id },
      data: {
        allergens: body.allergens,
        additives: body.additives,
        allergenDataComplete: body.confirmed,
        ...(body.minimumAge !== undefined ? { minimumAge: body.minimumAge } : {}),
        ...(body.nutriScore !== undefined ? { nutriScore: body.nutriScore } : {}),
      },
    });

    // The declaration is a legal statement by the merchant, so who confirmed it
    // and when has to be reconstructable.
    await prisma.auditLog.create({
      data: {
        actorType: "MERCHANT",
        actorId: request.userId ?? null,
        action: "FOOD_INFO_DECLARED",
        entityType: "Product",
        entityId: id,
        metadata: {
          allergens: body.allergens,
          additives: body.additives,
          confirmed: body.confirmed,
        },
      },
    });

    return {
      id: updated.id,
      allergens: updated.allergens,
      additives: updated.additives,
      allergenDataComplete: updated.allergenDataComplete,
      sellable: updated.allergenDataComplete && updated.isAvailable,
    };
  });

  app.patch("/merchant/products/:id", guard, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(500).nullable().optional(),
        price: z.number().int().min(1).max(100_000).optional(),
        stockCount: z.number().int().min(0).nullable().optional(),
        contentAmount: z.number().int().min(1).nullable().optional(),
        contentUnit: z.enum(["g", "ml", "kg", "l", "piece"]).nullable().optional(),
      })
      .parse(request.body);

    const staff = await staffOf(request.userId!);
    requireRole(request, staff.role, ["OWNER", "MANAGER"]);

    const product = await prisma.product.findFirst({
      where: { id, merchantId: request.merchantId! },
    });
    if (!product) throw notFound("Product");

    // PAngV: goods sold by weight or volume need a unit price, which needs both
    // the amount and the unit. Half of the pair is not usable.
    const amount = body.contentAmount !== undefined ? body.contentAmount : product.contentAmount;
    const unit = body.contentUnit !== undefined ? body.contentUnit : product.contentUnit;
    if ((amount == null) !== (unit == null)) {
      throw badRequest(
        "INCOMPLETE_UNIT_PRICE",
        "Set both the content amount and its unit, or neither — the Grundpreis needs both.",
      );
    }

    const updated = await prisma.product.update({ where: { id }, data: body });
    return { id: updated.id, name: updated.name, price: updated.price };
  });

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  /**
   * What the merchant is owed. Commission is shown as an explicit line rather
   * than netted off silently — the P2B Regulation requires the terms to be
   * transparent, and a merchant who cannot see the deduction will not trust it.
   */
  app.get("/merchant/statement", guard, async (request) => {
    const { from, to } = z
      .object({ from: z.string().datetime(), to: z.string().datetime() })
      .parse(request.query);

    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: request.merchantId! },
    });

    const orders = await prisma.order.findMany({
      where: {
        merchantId: merchant.id,
        status: { in: ["DELIVERED", "SETTLED"] },
        deliveredAt: { gte: new Date(from), lte: new Date(to) },
      },
      select: {
        id: true, reference: true, deliveredAt: true,
        itemsSubtotal: true, depositTotal: true, vatBreakdown: true,
      },
    });

    const goodsTotal = orders.reduce((s, o) => s + o.itemsSubtotal, 0);
    const depositTotal = orders.reduce((s, o) => s + o.depositTotal, 0);
    const commission = applyBps(goodsTotal, merchant.commissionBps);

    return {
      period: { from, to },
      orderCount: orders.length,
      goodsTotal,
      // Pfand is a statutory pass-through; taking commission on it would be
      // charging the merchant for collecting a deposit on the state's behalf.
      depositTotal,
      commissionBps: merchant.commissionBps,
      commission,
      payout: goodsTotal + depositTotal - commission,
      orders: orders.map((o) => ({
        reference: o.reference,
        deliveredAt: o.deliveredAt,
        goods: o.itemsSubtotal,
        deposit: o.depositTotal,
        commission: applyBps(o.itemsSubtotal, merchant.commissionBps),
      })),
    };
  });
}

function isFoodCategory(category: string): boolean {
  return category === "FOOD_REDUCED" || category === "BEVERAGE_STANDARD";
}
