# Architecture

## Repository layout

```
liefero/
├── packages/shared/     Domain logic with no I/O: money, VAT, pricing, FSM, wage rules
├── services/api/        Fastify + Prisma + Postgres/PostGIS. The whole backend.
├── apps/mobile/         Expo React Native — customer app (Android-first)
├── apps/courier/        Expo React Native — courier app
├── apps/merchant/       Merchant order-management console
├── infra/               docker-compose for local Postgres/Redis
└── docs/                This.
```

`packages/shared` is deliberately pure. VAT apportionment, delivery-fee curves, the order
state machine and the wage floor are the rules most likely to be wrong and most expensive
to get wrong, so they live in one place, are unit-tested, and are imported by every app.

## Why this stack

- **Fastify over Nest** — the domain logic is in `shared`; the HTTP layer should be thin
  and fast, not a DI framework.
- **Postgres + PostGIS** — delivery zones are polygons and "which stores serve this
  address" is a spatial query. Doing that in application code is a mistake you make once.
- **Prisma** — the schema is the domain model and needs to be readable by non-backend
  people (ops, finance, legal). It is the most reviewable schema format available.
- **Expo/React Native** — one codebase for the Android customer app and the courier app,
  with an iOS path that costs nearly nothing later. Android-first matches the brief.
- **EU-hosted everything** — Hetzner/Scaleway/AWS `eu-central-1`, EU-hosted routing
  (OSRM) and geocoding (Nominatim/Photon) rather than Google Maps, which materially
  simplifies the GDPR transfer-impact assessment.

## Money representation

Every monetary value is an **integer of cents in EUR**, gross (VAT-inclusive), typed as
`Money`. No floats anywhere. No net prices in customer-facing surfaces (PAngV). VAT is
derived *out* of gross totals rather than added to net ones, which is the direction
German B2C law requires and avoids a class of rounding bugs.

## The order lifecycle

A single explicit state machine (`packages/shared/src/order-state.ts`) governs every
order across all verticals. Illegal transitions throw rather than silently no-op.

```
      DRAFT
        │ place()
        ▼
   PENDING_PAYMENT ──auth fail──▶ PAYMENT_FAILED ─▶ CANCELLED
        │ authorised
        ▼
   AWAITING_MERCHANT ──reject──▶ REJECTED ─▶ CANCELLED
        │ accept
        ▼
     PREPARING ◀──────────┐
        │ ready           │ substitution approved
        ▼                 │
   AWAITING_COURIER ──────┘
        │ assigned + picked up
        ▼
    OUT_FOR_DELIVERY
        │ (age check, if required)
        ▼
     DELIVERED ─▶ capture payment ─▶ SETTLED
```

Cancellation windows mirror the operating rules in the teardown and are computed by
`cancellationPolicyFor(state)`:

| State at cancellation | Customer charged |
|---|---|
| before `AWAITING_MERCHANT` accepted | nothing |
| after merchant accepted, before pickup | goods, delivery fee refunded |
| after courier departed | full amount |

## Dispatch

`services/api/src/modules/dispatch/` implements a scoring assigner rather than
nearest-courier, because nearest-courier degrades badly under load.

Score per (order, courier) pair:

```
score = w_eta   · predictedPickupEta
      + w_fair  · shiftEarningsDeficit     (levels earnings across the shift)
      + w_batch · batchCompatibility       (same store / same direction)
      + w_load  · currentAssignmentCount
```

Prep-time prediction is a per-merchant rolling estimate — restaurants and grocery stores
have completely different curves, and a global constant is the most common cause of
couriers idling at counters.

Every assignment records `reasonCodes`, which is what makes the Platform Work Directive's
algorithmic-transparency obligation answerable rather than aspirational.

## Pricing

The delivery fee is a pure function evaluated on every store card in a list view, so it
must be cheap and side-effect free:

```
fee = base(zone)
    + distanceComponent(km, tapered)
    + demandMultiplier(supply/demand ratio, capped)
    + smallBasketSurcharge(subtotal, threshold)
    − subscriptionWaiver
```

The demand multiplier is **capped and disclosed** — surge pricing that is not visible
before commitment runs straight into German unfair-competition law (UWG).

## Multi-tenancy across countries

`Country` is a first-class dimension, not a config flag. VAT profile, wage floor,
age limits, deposit scheme and payment rails all resolve per-country. Germany is fully
implemented; Austria and the Netherlands are the intended second and third markets and
need only a profile each.
