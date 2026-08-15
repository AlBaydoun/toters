import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";

export default async function cartRoutes(app: FastifyInstance) {
  app.get("/cart", { preHandler: app.requireAuth }, async (request) => {
    const cart = await getOrCreateCart(request.userId!);
    return serialiseCart(cart.id);
  });

  app.post("/cart/items", { preHandler: app.requireAuth }, async (request) => {
    const body = z
      .object({
        productId: z.string(),
        quantity: z.number().int().min(1).max(50).default(1),
        optionIds: z.array(z.string()).default([]),
        note: z.string().max(500).optional(),
      })
      .parse(request.body);

    const cart = await getOrCreateCart(request.userId!);
    const product = await prisma.product.findUnique({
      where: { id: body.productId },
      include: { optionGroups: { include: { options: true } } },
    });
    if (!product || !product.isAvailable) throw notFound("Product");

    // A cart holds one merchant: mixing stores would make dispatch, prep time
    // and the delivery fee meaningless. Switching stores clears the cart, which
    // the client warns about first.
    if (cart.merchantId && cart.merchantId !== product.merchantId) {
      throw badRequest("MERCHANT_MISMATCH", "Your cart contains items from another store.", {
        currentMerchantId: cart.merchantId,
      });
    }

    // Enforce the merchant's own option rules rather than trusting the client.
    for (const group of product.optionGroups) {
      const chosen = body.optionIds.filter((id) => group.options.some((o) => o.id === id));
      if (chosen.length < group.minSelect || chosen.length > group.maxSelect) {
        throw badRequest("OPTION_RULES", `Select between ${group.minSelect} and ${group.maxSelect} for "${group.name}".`);
      }
    }

    await prisma.$transaction(async (tx) => {
      if (!cart.merchantId) {
        await tx.cart.update({ where: { id: cart.id }, data: { merchantId: product.merchantId } });
      }
      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          productId: product.id,
          quantity: body.quantity,
          note: body.note ?? null,
          options: { create: body.optionIds.map((optionId) => ({ optionId })) },
        },
      });
    });

    return serialiseCart(cart.id);
  });

  app.patch("/cart/items/:itemId", { preHandler: app.requireAuth }, async (request) => {
    const { itemId } = z.object({ itemId: z.string() }).parse(request.params);
    const { quantity } = z.object({ quantity: z.number().int().min(0).max(50) }).parse(request.body);

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId, cart: { userId: request.userId! } },
      include: { cart: true },
    });
    if (!item) throw notFound("Cart item");

    if (quantity === 0) {
      await prisma.cartItem.delete({ where: { id: itemId } });
      const remaining = await prisma.cartItem.count({ where: { cartId: item.cartId } });
      if (remaining === 0) {
        await prisma.cart.update({ where: { id: item.cartId }, data: { merchantId: null } });
      }
    } else {
      await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
    }

    return serialiseCart(item.cartId);
  });

  app.delete("/cart", { preHandler: app.requireAuth }, async (request) => {
    const cart = await getOrCreateCart(request.userId!);
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cart.update({ where: { id: cart.id }, data: { merchantId: null, promoCode: null } });
    return { ok: true };
  });
}

async function getOrCreateCart(userId: string) {
  const existing = await prisma.cart.findFirst({ where: { userId } });
  return existing ?? prisma.cart.create({ data: { userId } });
}

async function serialiseCart(cartId: string) {
  const cart = await prisma.cart.findUniqueOrThrow({
    where: { id: cartId },
    include: {
      items: { include: { product: true, options: { include: { option: true } } } },
    },
  });

  const items = cart.items.map((item) => {
    const delta = item.options.reduce((s, o) => s + o.option.priceDelta, 0);
    return {
      id: item.id,
      productId: item.productId,
      name: item.product.name,
      imageUrl: item.product.imageUrl,
      unitPrice: item.product.price + delta,
      quantity: item.quantity,
      lineTotal: (item.product.price + delta) * item.quantity,
      note: item.note,
      allergens: item.product.allergens,
      minimumAge: item.product.minimumAge,
      options: item.options.map((o) => ({ id: o.optionId, name: o.option.name, priceDelta: o.option.priceDelta })),
    };
  });

  return {
    id: cart.id,
    merchantId: cart.merchantId,
    items,
    subtotal: items.reduce((s, i) => s + i.lineTotal, 0),
    requiredAge: items.reduce<number | null>(
      (max, i) => (i.minimumAge != null ? Math.max(max ?? 0, i.minimumAge) : max),
      null,
    ),
  };
}
