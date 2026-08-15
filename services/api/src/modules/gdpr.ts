import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { notFound } from "../lib/errors.js";

/**
 * GDPR data-subject rights.
 *
 * The hard part is Art. 17 (erasure) colliding with §147 AO, which requires
 * invoice records to be kept for 10 years. We anonymise the personal link and
 * keep the financial record — and we tell the user exactly what was kept and
 * why, because an erasure request must never silently half-succeed.
 */
export default async function gdprRoutes(app: FastifyInstance) {
  app.post("/me/consents", { preHandler: app.requireAuth }, async (request) => {
    const body = z
      .object({
        purpose: z.enum([
          "MARKETING_EMAIL",
          "MARKETING_PUSH",
          "ANALYTICS",
          "PERSONALISATION",
          "LOCATION_BACKGROUND",
        ]),
        granted: z.boolean(),
        version: z.string().default("2026-01"),
      })
      .parse(request.body);

    // Append-only: withdrawal is a new record, not an edit. The history is the
    // evidence that consent was freely given and as easily withdrawn.
    const record = await prisma.consentRecord.create({
      data: {
        userId: request.userId!,
        purpose: body.purpose,
        granted: body.granted,
        version: body.version,
        ipAddress: request.ip,
      },
    });
    return { purpose: record.purpose, granted: record.granted, recordedAt: record.createdAt };
  });

  app.get("/me/consents", { preHandler: app.requireAuth }, async (request) => {
    const all = await prisma.consentRecord.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: "desc" },
    });
    // Latest record per purpose wins.
    const latest = new Map<string, (typeof all)[number]>();
    for (const r of all) if (!latest.has(r.purpose)) latest.set(r.purpose, r);
    return [...latest.values()].map((r) => ({
      purpose: r.purpose,
      granted: r.granted,
      recordedAt: r.createdAt,
    }));
  });

  app.post("/me/data-requests", { preHandler: app.requireAuth }, async (request) => {
    const { type } = z
      .object({ type: z.enum(["ACCESS", "PORTABILITY", "ERASURE"]) })
      .parse(request.body);

    const created = await prisma.dataRequest.create({
      data: { userId: request.userId!, type, status: "PROCESSING" },
    });

    const result =
      type === "ERASURE"
        ? await performErasure(request.userId!)
        : await buildExport(request.userId!);

    const completed = await prisma.dataRequest.update({
      where: { id: created.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        retainedNote: "retainedNote" in result ? result.retainedNote : null,
      },
    });

    return {
      id: completed.id,
      type,
      status: completed.status,
      // Art. 12(3): one month. We complete synchronously, but the deadline is
      // stated so the user knows the entitlement.
      statutoryDeadline: new Date(Date.now() + 30 * 86_400_000),
      dpoContact: env.DPO_EMAIL,
      ...result,
    };
  });

  app.get("/me/data-requests", { preHandler: app.requireAuth }, async (request) => {
    return prisma.dataRequest.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: "desc" },
    });
  });
}

/** Art. 15 / 20: everything we hold, in a machine-readable structure. */
async function buildExport(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      addresses: true,
      consents: true,
      loyaltyAccount: { include: { transactions: true } },
      creditEntries: true,
      reviews: true,
      paymentMethods: {
        // Never export PSP tokens — they are credentials, not user data.
        select: { type: true, brand: true, last4: true, createdAt: true },
      },
      orders: {
        include: { items: { include: { options: true } }, events: true },
      },
    },
  });
  if (!user) throw notFound("User");

  const { passwordHash, ...safe } = user as Record<string, unknown> & { passwordHash?: string };
  return {
    format: "application/json",
    generatedAt: new Date(),
    data: safe,
  };
}

/**
 * Art. 17 erasure, reconciled with statutory retention.
 * Personal identifiers are destroyed; the financial record survives in
 * pseudonymised form until the §147 AO period expires.
 */
async function performErasure(userId: string) {
  const anonymousId = `deleted-${userId.slice(-8)}`;

  await prisma.$transaction(async (tx) => {
    await tx.address.deleteMany({ where: { userId } });
    await tx.device.deleteMany({ where: { userId } });
    await tx.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
    await tx.paymentMethod.deleteMany({ where: { userId } });
    await tx.review.updateMany({ where: { userId }, data: { comment: null } });

    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        phone: null,
        firstName: anonymousId,
        lastName: null,
        dateOfBirth: null,
        passwordHash: null,
        status: "DELETED",
        anonymisedAt: new Date(),
      },
    });
  });

  return {
    erased: [
      "contact details",
      "name and date of birth",
      "saved addresses",
      "payment methods",
      "devices and push tokens",
      "review comments",
    ],
    retainedNote:
      "Order and invoice records are retained in pseudonymised form for 10 years under §147 AO " +
      "(statutory tax retention). They are no longer linked to your contact details and will be " +
      "destroyed once that period expires.",
  };
}
