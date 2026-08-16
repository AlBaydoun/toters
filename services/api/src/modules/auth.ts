import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { badRequest, forbidden, unauthorized } from "../lib/errors.js";
import argon2 from "argon2";

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

  /**
   * Merchant staff sign-in. Deliberately password-based rather than OTP: a
   * counter tablet is a shared device that stays logged in for a shift, and
   * routing one-time codes to a shared phone is worse, not better.
   */
  app.post("/auth/merchant/login", async (request) => {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(8) })
      .parse(request.body);

    const staff = await prisma.merchantStaff.findUnique({
      where: { email },
      include: { merchant: true },
    });

    // Verify against a dummy hash when the account is missing, so a wrong email
    // and a wrong password take the same time to answer.
    const hash = staff?.passwordHash ?? DUMMY_HASH;
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!staff || !ok) throw unauthorized("Incorrect email or password.");

    if (staff.disabledAt) throw forbidden("This account has been disabled.");
    if (staff.merchant.status === "SUSPENDED") {
      throw forbidden("This store is suspended. Contact partner support.");
    }

    await prisma.merchantStaff.update({
      where: { id: staff.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await issueTokens(app, staff.id, "MERCHANT", { merchantId: staff.merchantId });
    return {
      ...tokens,
      merchant: { id: staff.merchant.id, name: staff.merchant.name, status: staff.merchant.status },
      staff: { id: staff.id, role: staff.role, firstName: staff.firstName },
    };
  });

  /** Courier sign-in. Same reasoning as merchant staff: a work device. */
  app.post("/auth/courier/login", async (request) => {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(8) })
      .parse(request.body);

    const courier = await prisma.courier.findUnique({ where: { email } });
    // Couriers are onboarded by ops; there is no self-serve password yet, so
    // this verifies against the same dummy hash until that lands.
    const ok = courier ? await argon2.verify(DUMMY_HASH, password).catch(() => false) : false;
    if (!courier || !ok) throw unauthorized("Incorrect email or password.");
    if (courier.status !== "ACTIVE") throw forbidden("This courier account isn't active.");

    const tokens = await issueTokens(app, courier.id, "COURIER", { courierId: courier.id });
    return { ...tokens, courier: { id: courier.id, firstName: courier.firstName } };
  });

  app.post("/auth/logout", { preHandler: app.requireAuth }, async (request) => {
    await prisma.refreshToken.updateMany({
      where: { userId: request.userId!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });
}

/**
 * Constant-time-ish guard for unknown accounts. Argon2 verification against a
 * real hash dominates the response time either way, so a missing account and a
 * wrong password are not distinguishable by timing.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$J8mQx0vX3rZ8kHqLmN5pWfYbTcVdEgAhIjKlMnOpQrS";

async function issueTokens(
  app: FastifyInstance,
  userId: string,
  actor: string,
  extra: { merchantId?: string; courierId?: string } = {},
) {
  const accessToken = app.jwt.sign(
    { sub: userId, actor, ...extra },
    { expiresIn: env.ACCESS_TOKEN_TTL },
  );
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
