import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { assertOrderActor } from "../plugins/auth.js";
import {
  ingestImage,
  mediaStorage,
  MAX_UPLOAD_BYTES,
  MediaTooLargeError,
  UnsupportedMediaError,
} from "../lib/media.js";
import { isActive, type OrderStatus } from "@liefero/shared";

/**
 * Order chat between customer and courier.
 *
 * Design constraints that shaped this:
 *
 *  - Neither party ever learns the other's phone number. The thread is the
 *    channel, and it is scoped to one order.
 *  - The courier is on a bike. Typing is dangerous, so quick replies carry most
 *    of the traffic and the courier UI leads with them.
 *  - The thread closes when the order completes. An open-ended channel between
 *    two strangers who met once is a harassment vector.
 *  - Photos are the point ("I left it behind the blue bin"), but a doorstep
 *    photo is location data about someone's home, so it is stripped on ingest
 *    and purged on a shorter clock than text.
 */

/** Retained for dispute resolution, then hard-deleted. */
const CHAT_RETENTION_DAYS = 90;
/** Grace period after delivery during which the thread stays writable. */
const CLOSE_GRACE_MINUTES = 60;
const SIGNED_URL_TTL_SECONDS = 300;

/** Canned phrases. Ordered by how often they're actually needed. */
export const QUICK_REPLIES = {
  CUSTOMER: [
    "Ich komme runter.",
    "Bitte an der Tür abstellen.",
    "Bitte beim Nachbarn abgeben.",
    "Klingel funktioniert nicht — bitte anrufen lassen.",
    "Wie lange noch?",
  ],
  COURIER: [
    "Bin in 5 Minuten da.",
    "Ich bin unten an der Tür.",
    "Ich finde die Adresse nicht.",
    "Klingel geht nicht — bist du da?",
    "Alles abgegeben, guten Appetit!",
  ],
} as const;

/** Connected sockets per conversation. */
const rooms = new Map<string, Set<{ send(data: string): void }>>();

function broadcast(conversationId: string, payload: unknown) {
  const room = rooms.get(conversationId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const socket of room) {
    try {
      socket.send(data);
    } catch {
      // A dead socket is dropped on its own close handler; skip it here.
    }
  }
}

export default async function chatRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.requireActor("CUSTOMER", "COURIER", "ADMIN") };

  /** Open or fetch the thread for an order. */
  app.get("/orders/:orderId/chat", guard, async (request) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.params);
    const order = await assertOrderActor(request, orderId);

    const conversation = await getOrCreateConversation(orderId, order.status as OrderStatus);

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: { media: true },
    });

    // Mark the other side's messages read in one go.
    const mySide = request.actorType === "COURIER" ? "COURIER" : "CUSTOMER";
    await prisma.message.updateMany({
      where: { conversationId: conversation.id, sender: { not: mySide }, readAt: null },
      data: { readAt: new Date() },
    });

    return {
      conversationId: conversation.id,
      closed: conversation.closedAt != null,
      closedAt: conversation.closedAt,
      quickReplies: QUICK_REPLIES[mySide],
      messages: await Promise.all(messages.map(serialiseMessage)),
    };
  });

  app.post("/orders/:orderId/chat/messages", guard, async (request, reply) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.params);
    const body = z
      .object({
        kind: z.enum(["TEXT", "QUICK_REPLY", "LOCATION"]).default("TEXT"),
        body: z.string().min(1).max(1000).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        mediaId: z.string().optional(),
      })
      .parse(request.body);

    const order = await assertOrderActor(request, orderId);
    const conversation = await getOrCreateConversation(orderId, order.status as OrderStatus);

    if (conversation.closedAt) {
      throw forbidden("This conversation is closed. Contact support if you still need help.");
    }
    if (body.kind === "LOCATION" && (body.latitude == null || body.longitude == null)) {
      throw badRequest("LOCATION_REQUIRED", "A location message needs coordinates.");
    }
    if (body.kind !== "LOCATION" && !body.body && !body.mediaId) {
      throw badRequest("EMPTY_MESSAGE", "Nothing to send.");
    }

    const sender = request.actorType === "COURIER" ? "COURIER" : "CUSTOMER";

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender,
        senderId: request.userId ?? null,
        kind: body.mediaId ? "IMAGE" : body.kind,
        body: body.body ?? null,
        mediaId: body.mediaId ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
      },
      include: { media: true },
    });

    const serialised = await serialiseMessage(message);
    broadcast(conversation.id, { type: "message", message: serialised });

    reply.code(201);
    return serialised;
  });

  /**
   * Image upload. Kept separate from message creation so a slow upload on a
   * mobile connection does not block or duplicate the message itself.
   */
  app.post("/media/upload", guard, async (request, reply) => {
    const contentType = request.headers["content-type"] ?? "";
    const raw = request.body;

    if (!Buffer.isBuffer(raw)) {
      throw badRequest("INVALID_BODY", "Send the image as a raw binary body.");
    }

    try {
      const result = ingestImage(raw, contentType);
      await mediaStorage.put(result.storageKey, result.buffer, result.contentType);

      const asset = await prisma.mediaAsset.create({
        data: {
          storageKey: result.storageKey,
          contentType: result.contentType,
          byteSize: result.byteSize,
          uploadedBy: request.userId ?? null,
          uploaderType: request.actorType ?? null,
          purgeAfter: new Date(Date.now() + CHAT_RETENTION_DAYS * 86_400_000),
        },
      });

      reply.code(201);
      return {
        mediaId: asset.id,
        url: await mediaStorage.signedUrl(asset.storageKey, SIGNED_URL_TTL_SECONDS),
        byteSize: asset.byteSize,
        // Surfaced so the client can tell the user their location metadata was
        // removed. Silent privacy protection teaches nobody anything.
        metadataStripped: result.strippedBytes > 0,
      };
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        throw badRequest("FILE_TOO_LARGE", `Images must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      }
      if (error instanceof UnsupportedMediaError) {
        throw badRequest("UNSUPPORTED_TYPE", "Only JPEG, PNG and WebP images are accepted.");
      }
      throw error;
    }
  });

  /**
   * Live thread. Chat is the one place where polling genuinely reads as broken —
   * a courier standing at a door needs the reply now, not in eight seconds.
   */
  app.get("/orders/:orderId/chat/live", { websocket: true }, async (socket, request) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(request.params);

    // Sockets carry no preHandler, so authenticate explicitly before joining.
    try {
      await app.requireAuth(request);
      await assertOrderActor(request, orderId);
    } catch {
      socket.close(4401, "unauthorised");
      return;
    }

    const conversation = await prisma.conversation.findUnique({ where: { orderId } });
    if (!conversation) {
      socket.close(4404, "no conversation");
      return;
    }

    let room = rooms.get(conversation.id);
    if (!room) {
      room = new Set();
      rooms.set(conversation.id, room);
    }
    room.add(socket);

    socket.on("close", () => {
      room?.delete(socket);
      if (room?.size === 0) rooms.delete(conversation.id);
    });
  });
}

async function getOrCreateConversation(orderId: string, status: OrderStatus) {
  const existing = await prisma.conversation.findUnique({ where: { orderId } });

  if (existing) {
    // Close the thread once the order is done and the grace period has passed.
    if (!existing.closedAt && !isActive(status)) {
      const closeAt = new Date(existing.createdAt.getTime());
      if (Date.now() > closeAt.getTime() + CLOSE_GRACE_MINUTES * 60_000) {
        return prisma.conversation.update({
          where: { id: existing.id },
          data: { closedAt: new Date() },
        });
      }
    }
    return existing;
  }

  return prisma.conversation.create({
    data: {
      orderId,
      purgeAfter: new Date(Date.now() + CHAT_RETENTION_DAYS * 86_400_000),
    },
  });
}

async function serialiseMessage(message: {
  id: string; sender: string; kind: string; body: string | null;
  latitude: number | null; longitude: number | null; readAt: Date | null;
  createdAt: Date; media: { storageKey: string; contentType: string } | null;
}) {
  return {
    id: message.id,
    sender: message.sender,
    kind: message.kind,
    body: message.body,
    latitude: message.latitude,
    longitude: message.longitude,
    // Signed and short-lived: an image URL that outlives the conversation is a
    // permanent link to a photo of someone's front door.
    mediaUrl: message.media
      ? await mediaStorage.signedUrl(message.media.storageKey, SIGNED_URL_TTL_SECONDS)
      : null,
    readAt: message.readAt,
    createdAt: message.createdAt,
  };
}

/** Called by the retention sweep. */
export async function purgeExpiredChat(now = new Date()) {
  const assets = await prisma.mediaAsset.findMany({
    where: { purgeAfter: { lt: now } },
    select: { id: true, storageKey: true },
  });
  for (const asset of assets) {
    await mediaStorage.delete(asset.storageKey).catch(() => undefined);
  }

  const [media, conversations] = await Promise.all([
    prisma.mediaAsset.deleteMany({ where: { purgeAfter: { lt: now } } }),
    prisma.conversation.deleteMany({ where: { purgeAfter: { lt: now } } }),
  ]);

  return { mediaDeleted: media.count, conversationsDeleted: conversations.count };
}
