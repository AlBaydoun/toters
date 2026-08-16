import { prisma } from "../lib/prisma.js";
import { purgeExpiredChat } from "./chat.js";

/**
 * Storage limitation (GDPR Art. 5(1)(e)). Run daily.
 *
 * Retention periods are policy decisions with legal consequences, so they live
 * in one table rather than being scattered across queries.
 */
export const RETENTION = {
  /** Courier GPS traces. Long enough to investigate a delivery dispute. */
  courierLocationDays: 30,
  /** Consumed or expired OTP challenges. */
  otpChallengeMinutes: 15,
  /** Revoked or expired refresh tokens. */
  refreshTokenDays: 60,
  /** Audit log. */
  auditLogDays: 365,
  /** Chat threads and their images — long enough to resolve a dispute. */
  chatDays: 90,
  /** Orders: §147 AO. Not swept here — this is a floor, not a ceiling. */
  orderYears: 10,
} as const;

export async function runRetentionSweep(now = new Date()) {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);

  const [locations, otps, tokens, audit] = await Promise.all([
    prisma.courierLocation.deleteMany({
      where: { recordedAt: { lt: cutoff(RETENTION.courierLocationDays) } },
    }),
    prisma.otpChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - RETENTION.otpChallengeMinutes * 60_000) } },
    }),
    prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { revokedAt: { lt: cutoff(RETENTION.refreshTokenDays) } },
          { expiresAt: { lt: cutoff(RETENTION.refreshTokenDays) } },
        ],
      },
    }),
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff(RETENTION.auditLogDays) } } }),
  ]);

  const chat = await purgeExpiredChat(now);

  return {
    chatConversations: chat.conversationsDeleted,
    chatMedia: chat.mediaDeleted,
    courierLocations: locations.count,
    otpChallenges: otps.count,
    refreshTokens: tokens.count,
    auditLogs: audit.count,
  };
}
