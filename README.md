# Liefero

A multi-vertical on-demand delivery marketplace for Germany and the EU —
restaurants, groceries, pharmacy and retail in one app, plus **Butler**, a
buy-anything errand service that works with stores that aren't partners.

Built after a study of the Toters model (Lebanon/Iraq), re-engineered from the
ground up for European operating conditions. It is an independent
implementation: no Toters code, branding, assets or data are used.

> **`Liefero` is a placeholder name** pending EUIPO/DPMA trademark clearance.
> See `docs/04-germany-launch.md` §7 before any public use.

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/01-product-teardown.md`](docs/01-product-teardown.md) | The Toters model, feature inventory, and where Germany forces divergence |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Stack rationale, order lifecycle, dispatch, pricing |
| [`docs/03-eu-compliance.md`](docs/03-eu-compliance.md) | VAT, PAngV, LMIV, Pfand, JuSchG, GDPR, DSA, platform-work rules — and where each is implemented |
| [`docs/04-germany-launch.md`](docs/04-germany-launch.md) | Market entry sequencing, city selection, unit economics, pre-launch checklist |

## Layout

```
packages/shared/     Pure domain logic: money, VAT, pricing, order FSM, wage rules
services/api/        Fastify + Prisma + Postgres/PostGIS
apps/mobile/         Expo React Native customer app (Android-first)
apps/courier/        Courier app (scaffold)
apps/merchant/       Merchant console (scaffold)
infra/               Local Postgres + Redis
```

## Getting started

```bash
npm install
cp .env.example .env

npm run db:up            # Postgres (PostGIS) + Redis
npm run db:migrate -w @liefero/api
npm run db:seed          # Seeds a Leipzig launch zone

npm run dev:api          # http://localhost:4000
npm run dev:mobile       # Expo; Android emulator reaches the API at 10.0.2.2
```

Run the domain tests — these cover the rules that are expensive to get wrong:

```bash
npm test -w @liefero/shared
```

## What's actually built

**Working:**
- Full domain model (36 Prisma models) for the three-sided marketplace
- German VAT engine with pro-rata fee apportionment across rate buckets
- Delivery fee with distance taper and capped, disclosed surge
- Order state machine with tiered cancellation charges
- Dispatch scoring with batching and courier earnings fairness
- Minimum-wage floor enforcement and ArbZG working-time guards
- API: auth (OTP), discovery, catalog, cart, checkout, orders, tracking,
  Butler, dispatch, GDPR data-subject rights, retention sweep
- Android app: discovery, checkout, live tracking, Butler

**Not built yet** — the honest list:
- Payment provider integration (schema and flow are in place; the Stripe/PSP
  calls are not wired)
- Merchant console and courier app beyond scaffolds
- Push notifications, in-app VoIP bridging
- Grocery substitution flow (modelled, not implemented)
- Loyalty points and punch cards (modelled, endpoints not written)
- No migration has been generated — run `prisma migrate dev` against a live
  Postgres to create one

## Legal note

Business models and feature sets aren't protected by copyright; code, text and
artwork are. This project reimplements the former and copies none of the latter.
Have German counsel review `docs/03-eu-compliance.md` before launch — it is
engineering guidance, not legal advice.
