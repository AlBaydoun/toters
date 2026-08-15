import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { env } from "../lib/env.js";
import { unauthorized } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    actorType?: "CUSTOMER" | "MERCHANT" | "COURIER" | "ADMIN";
  }
}

export default fp(async (app: FastifyInstance) => {
  await app.register(jwt, { secret: env.JWT_ACCESS_SECRET });

  app.decorate("requireAuth", async (request: FastifyRequest) => {
    try {
      const payload = await request.jwtVerify<{ sub: string; actor: string }>();
      request.userId = payload.sub;
      request.actorType = payload.actor as FastifyRequest["actorType"];
    } catch {
      throw unauthorized();
    }
  });
});
