import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { enforceWageFloor, minimumWageAt, validateShift } from "@liefero/shared";

/**
 * Courier shifts and payroll.
 *
 * Couriers here are employees, not contractors — see docs/03-eu-compliance.md §8.
 * That makes three things obligations rather than features:
 *
 *  - Working time must be recorded (ECJ CCOO, §16(2) ArbZG).
 *  - The statutory minimum wage must be met per shift regardless of how many
 *    drops happened, so a slow shift produces an employer top-up.
 *  - Rest and break rules must be enforced, not merely reported on.
 */

/** Per-drop piece rate, gross cents. Sits on top of nothing — the hourly floor
 *  is guaranteed separately, so this is upside, not the base. */
const PER_DROP_CENTS = 180;

export default async function shiftRoutes(app: FastifyInstance) {
  app.post("/shifts/start", { preHandler: app.requireAuth }, async (request) => {
    const { courierId } = z.object({ courierId: z.string() }).parse(request.body);

    const courier = await prisma.courier.findUnique({ where: { id: courierId } });
    if (!courier) throw notFound("Courier");
    if (courier.status !== "ACTIVE") {
      throw badRequest("COURIER_NOT_ACTIVE", "This courier account isn't active.");
    }

    const open = await prisma.courierShift.findFirst({
      where: { courierId, endedAt: null },
    });
    if (open) throw conflict("SHIFT_ALREADY_OPEN", "You already have a shift running.");

    // §5 ArbZG: 11 hours uninterrupted rest. Blocking at start is the only
    // point where we can actually prevent the breach rather than report it.
    const previous = await prisma.courierShift.findFirst({
      where: { courierId, endedAt: { not: null } },
      orderBy: { endedAt: "desc" },
    });
    if (previous?.endedAt) {
      const restHours = (Date.now() - previous.endedAt.getTime()) / 3_600_000;
      if (restHours < 11) {
        throw badRequest(
          "REST_PERIOD",
          `You need 11 hours rest between shifts. ${(11 - restHours).toFixed(1)} hours to go.`,
          { availableAt: new Date(previous.endedAt.getTime() + 11 * 3_600_000) },
        );
      }
    }

    const shift = await prisma.courierShift.create({
      data: { courierId, startedAt: new Date() },
    });

    return {
      shiftId: shift.id,
      startedAt: shift.startedAt,
      guaranteedHourlyRate: Math.max(minimumWageAt(new Date()), courier.hourlyRateCents),
    };
  });

  app.post("/shifts/:id/end", { preHandler: app.requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { breakSeconds } = z
      .object({ breakSeconds: z.number().int().min(0).default(0) })
      .parse(request.body ?? {});

    const shift = await prisma.courierShift.findUnique({
      where: { id },
      include: { courier: true },
    });
    if (!shift) throw notFound("Shift");
    if (shift.endedAt) throw conflict("SHIFT_CLOSED", "This shift is already closed.");

    const endedAt = new Date();

    const previous = await prisma.courierShift.findFirst({
      where: { courierId: shift.courierId, endedAt: { not: null }, id: { not: id } },
      orderBy: { endedAt: "desc" },
    });

    // Recorded, not blocked: refusing to end a shift would strand the courier.
    // Breaches surface to ops for correction and are auditable.
    const issues = validateShift(
      { startedAt: shift.startedAt, endedAt, breakSeconds },
      previous?.endedAt ?? undefined,
    );

    const wage = enforceWageFloor({
      startedAt: shift.startedAt,
      endedAt,
      breakSeconds,
      earnedCents: shift.earnedCents,
      contractedHourlyRate: shift.courier.hourlyRateCents,
    });

    const updated = await prisma.courierShift.update({
      where: { id },
      data: { endedAt, breakSeconds, topUpCents: wage.topUpCents },
    });

    if (issues.length > 0) {
      await prisma.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "WORKING_TIME_BREACH",
          entityType: "CourierShift",
          entityId: id,
          metadata: {
            courierId: shift.courierId,
            issues: issues.map((i) => ({ code: i.code, message: i.message })),
          },
        },
      });
    }

    return {
      shiftId: updated.id,
      workedSeconds: wage.workedSeconds,
      dropsCompleted: shift.dropsCompleted,
      earnedCents: wage.earnedCents,
      wageFloorCents: wage.floorCents,
      topUpCents: wage.topUpCents,
      // The courier sees the top-up explicitly. An invisible guarantee is not a
      // guarantee they can rely on when deciding whether to take a slow shift.
      totalPayableCents: wage.earnedCents + wage.topUpCents,
      complianceIssues: issues,
    };
  });

  /** Credit a completed drop to the open shift. */
  app.post("/shifts/record-drop", async (request) => {
    const { courierId, orderId } = z
      .object({ courierId: z.string(), orderId: z.string() })
      .parse(request.body);

    const shift = await prisma.courierShift.findFirst({
      where: { courierId, endedAt: null },
    });
    if (!shift) throw badRequest("NO_OPEN_SHIFT", "No open shift to credit this drop to.");

    const updated = await prisma.courierShift.update({
      where: { id: shift.id },
      data: {
        dropsCompleted: { increment: 1 },
        earnedCents: { increment: PER_DROP_CENTS },
      },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "DROP_RECORDED",
        entityType: "Order",
        entityId: orderId,
        metadata: { courierId, shiftId: shift.id, amount: PER_DROP_CENTS },
      },
    });

    return { dropsCompleted: updated.dropsCompleted, earnedCents: updated.earnedCents };
  });

  /** What the courier has earned so far today, including any top-up owed. */
  app.get("/shifts/current", { preHandler: app.requireAuth }, async (request) => {
    const { courierId } = z.object({ courierId: z.string() }).parse(request.query);

    const shift = await prisma.courierShift.findFirst({
      where: { courierId, endedAt: null },
      include: { courier: true },
    });
    if (!shift) return { active: false };

    // Projected against "now" so the courier can see the guarantee working
    // during the shift, not only after it.
    const projected = enforceWageFloor({
      startedAt: shift.startedAt,
      endedAt: new Date(),
      breakSeconds: shift.breakSeconds,
      earnedCents: shift.earnedCents,
      contractedHourlyRate: shift.courier.hourlyRateCents,
    });

    return {
      active: true,
      shiftId: shift.id,
      startedAt: shift.startedAt,
      dropsCompleted: shift.dropsCompleted,
      earnedCents: shift.earnedCents,
      projectedFloorCents: projected.floorCents,
      projectedTopUpCents: projected.topUpCents,
      projectedTotalCents: projected.earnedCents + projected.topUpCents,
    };
  });

  /**
   * Payroll run for a period. Returns per-courier totals including statutory
   * top-ups, ready for export to the payroll provider — this system never holds
   * bank details.
   */
  app.get("/payroll/run", async (request) => {
    const { from, to } = z
      .object({ from: z.string().datetime(), to: z.string().datetime() })
      .parse(request.query);

    const shifts = await prisma.courierShift.findMany({
      where: {
        startedAt: { gte: new Date(from) },
        endedAt: { lte: new Date(to), not: null },
      },
      include: { courier: true },
    });

    const byCourier = new Map<
      string,
      {
        courierId: string; payrollRef: string | null; name: string;
        workedSeconds: number; drops: number; earnedCents: number;
        topUpCents: number; totalCents: number; shifts: number;
      }
    >();

    for (const shift of shifts) {
      const wage = enforceWageFloor({
        startedAt: shift.startedAt,
        endedAt: shift.endedAt!,
        breakSeconds: shift.breakSeconds,
        earnedCents: shift.earnedCents,
        contractedHourlyRate: shift.courier.hourlyRateCents,
      });

      const entry = byCourier.get(shift.courierId) ?? {
        courierId: shift.courierId,
        payrollRef: shift.courier.payrollRef,
        name: `${shift.courier.firstName} ${shift.courier.lastName}`,
        workedSeconds: 0, drops: 0, earnedCents: 0, topUpCents: 0, totalCents: 0, shifts: 0,
      };

      entry.workedSeconds += wage.workedSeconds;
      entry.drops += shift.dropsCompleted;
      entry.earnedCents += wage.earnedCents;
      entry.topUpCents += wage.topUpCents;
      entry.totalCents += wage.earnedCents + wage.topUpCents;
      entry.shifts += 1;
      byCourier.set(shift.courierId, entry);
    }

    const rows = [...byCourier.values()];
    return {
      period: { from, to },
      couriers: rows,
      totals: {
        couriers: rows.length,
        grossCents: rows.reduce((s, r) => s + r.totalCents, 0),
        // Worth watching: a rising top-up share means volume is too thin to
        // sustain the fleet, which is the leading indicator of unit-economics
        // trouble in docs/04-germany-launch.md §4.
        topUpCents: rows.reduce((s, r) => s + r.topUpCents, 0),
      },
    };
  });
}
