import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./modules/auth.js";
import catalogRoutes from "./modules/catalog.js";
import cartRoutes from "./modules/cart.js";
import checkoutRoutes from "./modules/checkout.js";
import orderRoutes from "./modules/orders.js";
import butlerRoutes from "./modules/butler.js";
import dispatchRoutes from "./modules/dispatch.js";
import gdprRoutes from "./modules/gdpr.js";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (request: import("fastify").FastifyRequest) => Promise<void>;
  }
}

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "info" : "warn",
      // Never log identifiers or tokens — the access log is itself personal data.
      redact: ["req.headers.authorization", "req.body.code", "req.body.destination"],
    },
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(authPlugin);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: error.message } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
  });

  app.get("/health", async () => ({ status: "ok", region: env.DATA_REGION }));

  await app.register(authRoutes, { prefix: "/v1" });
  await app.register(catalogRoutes, { prefix: "/v1" });
  await app.register(cartRoutes, { prefix: "/v1" });
  await app.register(checkoutRoutes, { prefix: "/v1" });
  await app.register(orderRoutes, { prefix: "/v1" });
  await app.register(butlerRoutes, { prefix: "/v1" });
  await app.register(dispatchRoutes, { prefix: "/v1" });
  await app.register(gdprRoutes, { prefix: "/v1" });

  return app;
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
