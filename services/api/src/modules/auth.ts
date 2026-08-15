import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { badRequest, unauthorized } from "../lib/errors.js";

const OTP_TTL_MINUTES = 15;
const MAX_OTP_ATTEMPTS = 5;

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export default async function authRoutes(app: FastifyInstance) {
  /** Phone-first OTP: fewer signup fields, higher conversion, no password to leak. */
  app.post("/auth/otp/request", async (request) => {
    const { destination, channel } = z
      .object({ destination: z.string().min(6), channel: z.enum(["sms", "email"]).default("sms") })
      .parse(request.body);

    const code = String(crypto.randomInt(100_000, 999_999));

    await prisma.otpChallenge.create({
      data: {
        destination,
        channel,
        codeHash: sha256(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
      },
    });

    // Delivery is handled by the SMS/email provider in production. Never log the
    // code outside development.
    if (env.NODE_ENV === "development") {
      app.log.info({ destination, code }, "OTP issued (development only)");
    }
    return { sent: true, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  });

  app.post("/auth/otp/verify", async (request) => {
    const { destination, code } = z
      .object({ destination: z.string(), code: z.string().length(6) })
      .parse(request.body);

    const challenge = await prisma.otpChallenge.findFirst({
      where: { destination, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge) throw badRequest("OTP_INVALID", "That code has expired. Request a new one.");
    if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
      throw badRequest("OTP_LOCKED", "Too many attempts. Request a new code.");
    }

    if (challenge.codeHash !== sha256(code)) {
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw unauthorized("Incorrect code.");
    }

    const isEmail = destination.includes("@");
    const user = await prisma.user.upsert({
      where: isEmail ? { email: destination } : { phone: destination },
      create: isEmail
        ? { email: destination, emailVerifiedAt: new Date() }
        : { phone: destination, phoneVerifiedAt: new Date() },
      update: isEmail ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date() },
    });

    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

    return issueTokens(app, user.id, "CUSTOMER");
  });

  app.post("/auth/refresh", async (request) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(request.body);

    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw unauthorized("Session expired. Sign in again.");
    }

    // Rotate on every use: a replayed token is then detectably stale.
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return issueTokens(app, stored.userId, "CUSTOMER");
  });

  app.post("/auth/logout", { preHandler: app.requireAuth }, async (request) => {
    await prisma.refreshToken.updateMany({
      where: { userId: request.userId!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });
}

async function issueTokens(app: FastifyInstance, userId: string, actor: string) {
  const accessToken = app.jwt.sign({ sub: userId, actor }, { expiresIn: env.ACCESS_TOKEN_TTL });
  const refreshToken = crypto.randomBytes(48).toString("base64url");

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
    },
  });

  return { accessToken, refreshToken, expiresIn: env.ACCESS_TOKEN_TTL };
}
