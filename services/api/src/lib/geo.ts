import { prisma } from "./prisma.js";

/**
 * "Which zone serves this address" is a spatial containment query. Doing it in
 * application code is a mistake you make once — PostGIS does it with an index.
 */
export async function zoneForPoint(latitude: number, longitude: number) {
  const rows = await prisma.$queryRaw<{ id: string; cityId: string }[]>`
    SELECT z.id, z."cityId"
    FROM "DeliveryZone" z
    WHERE z."isActive" = true
      AND ST_Contains(
        ST_GeomFromText(z."boundaryWkt", 4326),
        ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
      )
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Merchants that both serve this point and are within their own radius of it. */
export async function merchantsNear(latitude: number, longitude: number, radiusKm = 6) {
  return prisma.$queryRaw<
    { id: string; name: string; type: string; distance_km: number }[]
  >`
    SELECT m.id, m.name, m.type,
           ST_DistanceSphere(
             ST_MakePoint(m.longitude, m.latitude),
             ST_MakePoint(${longitude}, ${latitude})
           ) / 1000 AS distance_km
    FROM "Merchant" m
    WHERE m.status = 'ACTIVE'
      AND ST_DistanceSphere(
            ST_MakePoint(m.longitude, m.latitude),
            ST_MakePoint(${longitude}, ${latitude})
          ) <= ${radiusKm * 1000}
    ORDER BY distance_km ASC
    LIMIT 100
  `;
}
