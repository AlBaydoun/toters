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

## Verification

```bash
npm ci
npm run generate -w @liefero/api   # Prisma client — the API's types come from it
npm run build -w @liefero/shared   # consumers use its declarations, not its source
npm test                           # 32 tests
npm run typecheck                  # API + both apps
```

CI runs all of the above on every push.

## What's actually built

**Domain logic** (`packages/shared`, 26 tests) — German VAT with pro-rata fee
apportionment, delivery fee with distance taper and capped surge, order state
machine, tiered cancellation policy, statutory wage floor, ArbZG working-time
guards, dispatch scoring, PAngV unit pricing, JuSchG age rules.

**API** (`services/api`, 6 tests) — OTP auth, addresses with serviceability,
PostGIS discovery, catalog, cart, checkout, orders with live tracking, Butler,
dispatch with recorded decision reasons, payments, loyalty and punch cards,
grocery substitutions, courier shifts and payroll, age verification, GDPR
data-subject rights, retention sweep.

**Customer app** (`apps/mobile`) — discovery, checkout with the full price and
VAT breakdown, live tracking, Butler.

**Courier app** (`apps/courier`) — shift control with live earnings and the
visible wage guarantee, offers with an assignment explanation, delivery flow,
ID verification.

### Payments: what "built" means here

The flow is complete and tested — authorise at placement, capture at delivery,
over-capture refused and surfaced as needing fresh authorisation, SCA handling,
refunds, voids. `StripePsp` implements the calls against Stripe's API; `FakePsp`
backs the tests and local development. **It has not been run against a real
Stripe account**, so treat the Stripe implementation as unverified against the
live API even though its semantics are covered by tests.

## Not built

- Merchant console (`apps/merchant`) — scaffold only
- Push notifications and in-app VoIP bridging between customer and courier
- No migration has been generated — run `prisma migrate dev` against a live
  Postgres to create one
- Points expiry is recorded per transaction but nothing sweeps expired points yet
- The retention sweep exists but nothing schedules it
- No merchant-side order acceptance UI; merchants currently transition orders
  through the API directly

## Legal note

Business models and feature sets aren't protected by copyright; code, text and
artwork are. This project reimplements the former and copies none of the latter.
Have German counsel review `docs/03-eu-compliance.md` before launch — it is
engineering guidance, not legal advice.
