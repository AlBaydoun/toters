import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { env } from "../lib/env.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { authoriseOrderAction } from "@liefero/shared";

export type Actor = "CUSTOMER" | "MERCHANT" | "COURIER" | "ADMIN";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    actorType?: Actor;
    /** Set for MERCHANT tokens: the merchant this staff account may act for. */
    merchantId?: string;
    /** Set for COURIER tokens. */
    courierId?: string;
  }
}

interface TokenPayload {
  sub: string;
  actor: Actor;
  merchantId?: string;
  courierId?: string;
}

export default fp(async (app: FastifyInstance) => {
  await app.register(jwt, { secret: env.JWT_ACCESS_SECRET });

  /**
   * The actor type comes from the SIGNED TOKEN, never from the request body.
   * Reading it from the body means any authenticated user can claim to be a
   * merchant and act on orders that aren't theirs.
   */
  app.decorate("requireAuth", async (request: FastifyRequest) => {
    let payload: TokenPayload;
    try {
      payload = await request.jwtVerify<TokenPayload>();
    } catch {
      throw unauthorized();
    }
    request.userId = payload.sub;
    request.actorType = payload.actor;
    request.merchantId = payload.merchantId;
    request.courierId = payload.courierId;
  });

  /** Restrict a route to specific actor types. */
  app.decorate("requireActor", (...allowed: Actor[]) => {
    return async (request: FastifyRequest) => {
      await app.requireAuth(request);
      if (!request.actorType || !allowed.includes(request.actorType)) {
        throw forbidden(`This endpoint requires one of: ${allowed.join(", ")}.`);
      }
    };
  });

  /**
   * Internal service-to-service calls (dispatch, capture, drop accounting).
   * These are not user-facing and must not be reachable with a customer token —
   * or with no token at all, which is where they started.
   */
  app.decorate("requireService", async (request: FastifyRequest) => {
    const header = request.headers["x-service-token"];
    if (typeof header !== "string" || header.length === 0 || header !== env.SERVICE_TOKEN) {
      throw unauthorized("Service authentication required.");
    }
  });
});

/**
 * Assert the authenticated actor is entitled to act on this specific order.
 *
 * The decision itself lives in @liefero/shared as a pure, exhaustively tested
 * function; this only gathers the facts it needs. Actor type alone is not
 * authorisation: being *a* merchant does not entitle you to *this* merchant's
 * orders.
 */
export async function assertOrderActor(request: FastifyRequest, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, merchantId: true, courierId: true, userId: true,
      status: true, requiredAge: true, ageVerifiedAt: true,
    },
  });
  // Deliberately the same error as an ownership failure: distinguishing them
  // would let an attacker enumerate which order ids exist.
  if (!order) throw forbidden("Order not found or not yours.");

  // Only looked up when it can change the answer.
  let hasOpenAssignment = false;
  if (request.actorType === "COURIER" && order.courierId !== request.courierId) {
    hasOpenAssignment =
      (await prisma.assignment.count({
        where: {
          orderId,
          courierId: request.courierId ?? "",
          status: { in: ["OFFERED", "ACCEPTED"] },
        },
      })) > 0;
  }

  const decision = authoriseOrderAction(
    {
      type: request.actorType ?? "CUSTOMER",
      subjectId: request.userId ?? "",
      merchantId: request.merchantId,
      courierId: request.courierId,
    },
    {
      userId: order.userId,
      merchantId: order.merchantId,
      courierId: order.courierId,
      hasOpenAssignment,
    },
  );

  if (!decision.allowed) throw forbidden(decision.reason);
  return order;
}
