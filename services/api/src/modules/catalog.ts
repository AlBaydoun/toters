import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { merchantsNear, zoneForPoint } from "../lib/geo.js";
import { notFound } from "../lib/errors.js";
import { calculateDeliveryFee, formatUnitPrice, haversineKm } from "@liefero/shared";

/**
 * Discovery is address-first: nothing is browsable until we know where the
 * customer is, because delivery fee, availability and zone all depend on it.
 */
export default async function catalogRoutes(app: FastifyInstance) {
  const discoverQuery = z.object({
    latitude: z.coerce.number(),
    longitude: z.coerce.number(),
    type: z
      .enum(["RESTAURANT", "CAFE", "GROCERY", "PHARMACY", "RETAIL", "CONVENIENCE", "DARK_STORE"])
      .optional(),
    search: z.string().optional(),
  });

  app.get("/discover", async (request) => {
    const q = discoverQuery.parse(request.query);
    const zone = await zoneForPoint(q.latitude, q.longitude);

    if (!zone) {
      // Being explicit beats an empty list: "we don't deliver here yet" is a
      // waitlist opportunity, not a dead end.
      return { serviceable: false, zoneId: null, merchants: [], waitlistEligible: true };
    }

    const near = await merchantsNear(q.latitude, q.longitude);
    const ids = near.map((m) => m.id);

    const merchants = await prisma.merchant.findMany({
      where: {
        id: { in: ids },
        status: "ACTIVE",
        ...(q.type ? { type: q.type } : {}),
        ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
      },
      include: { openingHours: true, zone: true },
    });

    const zoneRecord = await prisma.deliveryZone.findUnique({ where: { id: zone.id } });
    const distances = new Map(near.map((m) => [m.id, m.distance_km]));

    // Demand ratio drives the surge multiplier and is shared by every card in
    // the list, so it is computed once per request rather than per merchant.
    const demandRatio = await currentDemandRatio(zone.cityId);

    const cards = merchants.map((m) => {
      const distanceKm = distances.get(m.id) ?? haversineKm(
        { latitude: q.latitude, longitude: q.longitude },
        { latitude: m.latitude, longitude: m.longitude },
      );
      const fee = calculateDeliveryFee({
        baseFee: m.zone?.baseDeliveryFee ?? zoneRecord?.baseDeliveryFee ?? 349,
        distanceKm,
        demandRatio,
        subtotal: 0,
        minimumBasket: m.minimumBasket ?? zoneRecord?.minimumBasket ?? 1000,
        freeDeliveryAbove: m.zone?.freeDeliveryAbove ?? zoneRecord?.freeDeliveryAbove,
      });

      return {
        id: m.id,
        slug: m.slug,
        name: m.name,
        type: m.type,
        logoUrl: m.logoUrl,
        coverUrl: m.coverUrl,
        rating: m.ratingAvg,
        ratingCount: m.ratingCount,
        distanceKm: Math.round(distanceKm * 10) / 10,
        deliveryFee: fee.fee,
        minimumBasket: m.minimumBasket ?? zoneRecord?.minimumBasket ?? 1000,
        etaMinutes: estimateEta(m.avgPrepSeconds, distanceKm),
        isOpen: isOpenNow(m.openingHours),
        // P2B: paid placement must be labelled. Nothing is boosted yet, so this
        // is always false — but the field exists so the client renders it from
        // day one rather than being retrofitted.
        sponsored: false,
      };
    });

    return { serviceable: true, zoneId: zone.id, demandRatio, merchants: cards };
  });

  app.get("/merchants/:slug", async (request) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);

    const merchant = await prisma.merchant.findUnique({
      where: { slug },
      include: {
        openingHours: true,
        categories: {
          orderBy: { sortOrder: "asc" },
          include: {
            products: {
              where: { isAvailable: true },
              include: { optionGroups: { include: { options: true } } },
            },
          },
        },
      },
    });
    if (!merchant || merchant.status !== "ACTIVE") throw notFound("Merchant");

    return {
      id: merchant.id,
      slug: merchant.slug,
      name: merchant.name,
      type: merchant.type,
      description: merchant.description,
      logoUrl: merchant.logoUrl,
      coverUrl: merchant.coverUrl,
      rating: merchant.ratingAvg,
      ratingCount: merchant.ratingCount,
      isOpen: isOpenNow(merchant.openingHours),
      openingHours: merchant.openingHours,
      // DSA Art. 30 trader traceability — this must be visible to consumers.
      trader: {
        legalName: merchant.legalName,
        legalAddress: merchant.legalAddress,
        registrationNo: merchant.registrationNo,
        vatId: merchant.vatId,
        contactEmail: merchant.contactEmail,
      },
      categories: merchant.categories.map((c) => ({
        id: c.id,
        name: c.name,
        products: c.products.map(serialiseProduct),
      })),
    };
  });
}

function serialiseProduct(p: {
  id: string; name: string; description: string | null; imageUrl: string | null;
  price: number; compareAtPrice: number | null; contentAmount: number | null;
  contentUnit: string | null; allergens: string[]; additives: string[];
  allergenDataComplete: boolean; minimumAge: number | null; depositScheme: string;
  nutriScore: string | null; stockCount: number | null;
  optionGroups?: { id: string; name: string; minSelect: number; maxSelect: number; options: { id: string; name: string; priceDelta: number; isAvailable: boolean }[] }[];
}) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    // PAngV: the Grundpreis must appear next to the selling price.
    unitPrice:
      p.contentAmount && p.contentUnit
        ? formatUnitPrice(p.price, p.contentAmount, p.contentUnit)
        : null,
    allergens: p.allergens,
    additives: p.additives,
    allergenDataComplete: p.allergenDataComplete,
    minimumAge: p.minimumAge,
    depositScheme: p.depositScheme,
    nutriScore: p.nutriScore,
    inStock: p.stockCount == null || p.stockCount > 0,
    optionGroups: p.optionGroups?.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.options.filter((o) => o.isAvailable),
    })),
  };
}

function isOpenNow(hours: { weekday: number; opensAt: string; closesAt: string }[]): boolean {
  const now = new Date();
  // JS getDay() is Sunday-based; our schema is ISO/Monday-based.
  const weekday = (now.getDay() + 6) % 7;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return hours.some((h) => h.weekday === weekday && h.opensAt <= hhmm && hhmm < h.closesAt);
}

function estimateEta(prepSeconds: number, distanceKm: number): number {
  const travelSeconds = (distanceKm / 16) * 3600;
  return Math.ceil(((prepSeconds + travelSeconds) * 1.15 + 240) / 60 / 5) * 5;
}

/**
 * Open orders per available courier. Capped at the surge ceiling downstream;
 * returns 1.0 (no surge) when supply data is missing rather than guessing high.
 */
async function currentDemandRatio(cityId: string): Promise<number> {
  const [openOrders, onShift] = await Promise.all([
    prisma.order.count({
      where: { status: { in: ["AWAITING_MERCHANT", "PREPARING", "AWAITING_COURIER"] }, merchant: { cityId } },
    }),
    prisma.courierShift.count({ where: { endedAt: null, courier: { cityId, status: "ACTIVE" } } }),
  ]);
  if (onShift === 0) return 1;
  return Math.max(1, openOrders / (onShift * 2.5));
}
