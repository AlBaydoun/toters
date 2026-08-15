import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";
import { zoneForPoint } from "../lib/geo.js";

/**
 * German addressing is structured: street + house number + postcode are the
 * source of truth and the map pin is a refinement. That is the opposite of the
 * pin-first model used in markets without reliable street addressing, and it
 * lets us validate serviceability before the customer fills a basket.
 */
const addressBody = z.object({
  label: z.string().max(40).optional(),
  street: z.string().min(1).max(120),
  houseNumber: z.string().min(1).max(12),
  addressLine2: z.string().max(120).optional(),
  // German apartment blocks need these or the courier cannot complete the drop.
  floor: z.string().max(20).optional(),
  entryCode: z.string().max(20).optional(),
  careOf: z.string().max(80).optional(),
  postalCode: z.string().regex(/^\d{5}$/, "German postcodes are five digits."),
  city: z.string().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deliveryNote: z.string().max(300).optional(),
  isDefault: z.boolean().default(false),
});

export default async function addressRoutes(app: FastifyInstance) {
  app.get("/me/addresses", { preHandler: app.requireAuth }, async (request) => {
    const addresses = await prisma.address.findMany({
      where: { userId: request.userId! },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });

    // Tell the client which saved addresses we can actually deliver to, so it
    // can grey them out rather than failing at checkout.
    const withServiceability = await Promise.all(
      addresses.map(async (a) => ({
        ...a,
        serviceable: (await zoneForPoint(a.latitude, a.longitude)) != null,
      })),
    );
    return withServiceability;
  });

  app.post("/me/addresses", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = addressBody.parse(request.body);
    const userId = request.userId!;

    const zone = await zoneForPoint(body.latitude, body.longitude);

    const address = await prisma.$transaction(async (tx) => {
      const isFirst = (await tx.address.count({ where: { userId } })) === 0;
      const shouldDefault = body.isDefault || isFirst;

      if (shouldDefault) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.address.create({
        data: { ...body, userId, isDefault: shouldDefault },
      });
    });

    reply.code(201);
    // Saving an out-of-zone address is allowed — it is how we learn where to
    // expand — but the client must know it cannot be ordered to.
    return { ...address, serviceable: zone != null };
  });

  app.patch("/me/addresses/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = addressBody.partial().parse(request.body);
    const userId = request.userId!;

    const existing = await prisma.address.findFirst({ where: { id, userId } });
    if (!existing) throw notFound("Address");

    const updated = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.address.update({ where: { id }, data: body });
    });

    return updated;
  });

  app.delete("/me/addresses/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const userId = request.userId!;

    const existing = await prisma.address.findFirst({ where: { id, userId } });
    if (!existing) throw notFound("Address");

    // An address referenced by an order cannot be deleted — the delivery record
    // has to survive for the statutory retention period.
    const orderCount = await prisma.order.count({ where: { addressId: id } });
    if (orderCount > 0) {
      throw badRequest(
        "ADDRESS_IN_USE",
        "This address is attached to past orders and can't be deleted. You can rename it instead.",
      );
    }

    await prisma.address.delete({ where: { id } });

    // Never leave the account without a default if any address remains.
    if (existing.isDefault) {
      const next = await prisma.address.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      if (next) await prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }

    return { ok: true };
  });

  /** Serviceability probe used before the customer bothers saving an address. */
  app.get("/serviceability", async (request) => {
    const q = z
      .object({ latitude: z.coerce.number(), longitude: z.coerce.number() })
      .parse(request.query);

    const zone = await zoneForPoint(q.latitude, q.longitude);
    if (!zone) return { serviceable: false, zoneId: null, cityName: null };

    const city = await prisma.city.findUnique({ where: { id: zone.cityId } });
    return { serviceable: true, zoneId: zone.id, cityName: city?.name ?? null };
  });
}
