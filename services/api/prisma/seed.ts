import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Seeds a Leipzig launch zone — the recommended pilot city in
 * docs/04-germany-launch.md: compact, high student share, high cycling modal
 * share, and not an incumbent stronghold.
 */
async function main() {
  const city = await prisma.city.upsert({
    where: { slug: "leipzig" },
    update: {},
    create: { country: "DE", name: "Leipzig", slug: "leipzig", isLive: true, launchedAt: new Date() },
  });

  const zone = await prisma.deliveryZone.create({
    data: {
      cityId: city.id,
      name: "Leipzig Zentrum",
      // A rough box around the Ring — the compact launch polygon.
      boundaryWkt:
        "POLYGON((12.3400 51.3200, 12.4300 51.3200, 12.4300 51.3700, 12.3400 51.3700, 12.3400 51.3200))",
      baseDeliveryFee: 349,
      freeDeliveryAbove: 3500,
      minimumBasket: 1000,
    },
  });

  const merchant = await prisma.merchant.create({
    data: {
      slug: "kleine-kueche",
      name: "Kleine Küche",
      type: "RESTAURANT",
      description: "Saisonale Küche aus Leipzig.",
      status: "ACTIVE",
      cityId: city.id,
      zoneId: zone.id,
      street: "Karl-Liebknecht-Straße",
      houseNumber: "42",
      postalCode: "04275",
      addressCity: "Leipzig",
      latitude: 51.3305,
      longitude: 12.3747,
      // DSA Art. 30 — a merchant cannot go live without these.
      legalName: "Kleine Küche GmbH",
      legalAddress: "Karl-Liebknecht-Straße 42, 04275 Leipzig",
      registrationNo: "HRB 12345 Leipzig",
      vatId: "DE123456789",
      contactEmail: "kontakt@kleinekueche.example",
      contactPhone: "+49341123456",
      verifiedAt: new Date(),
      avgPrepSeconds: 1200,
      minimumBasket: 1200,
      openingHours: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          opensAt: "11:00",
          closesAt: "22:00",
        })),
      },
    },
  });

  const category = await prisma.category.create({
    data: { merchantId: merchant.id, name: "Hauptgerichte", sortOrder: 0 },
  });

  await prisma.product.createMany({
    data: [
      {
        merchantId: merchant.id,
        categoryId: category.id,
        name: "Kürbissuppe",
        description: "Mit Ingwer und Kürbiskernöl.",
        price: 690,
        vatCategory: "FOOD_REDUCED",
        allergens: ["CELERY", "MILK"],
        allergenDataComplete: true,
      },
      {
        merchantId: merchant.id,
        categoryId: category.id,
        name: "Leipziger Allerlei",
        description: "Saisonales Gemüse, Semmelklöße.",
        price: 1450,
        vatCategory: "FOOD_REDUCED",
        allergens: ["GLUTEN", "EGGS", "MILK"],
        allergenDataComplete: true,
      },
      {
        merchantId: merchant.id,
        categoryId: category.id,
        name: "Landbier 0,33 l",
        price: 290,
        vatCategory: "BEVERAGE_STANDARD",
        contentAmount: 330,
        contentUnit: "ml",
        depositScheme: "REUSABLE_008",
        // JuSchG: 16 for beer and wine.
        minimumAge: 16,
        allergens: ["GLUTEN"],
        allergenDataComplete: true,
      },
    ],
  });

  await prisma.promotion.create({
    data: {
      code: "WILLKOMMEN",
      type: "PERCENTAGE_OFF",
      value: 2000,
      maxDiscount: 500,
      minimumBasket: 1500,
      firstOrderOnly: true,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 365 * 86_400_000),
      perUserLimit: 1,
    },
  });

  console.log(`Seeded ${city.name}: zone ${zone.name}, merchant ${merchant.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
