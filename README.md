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

**Merchant console** (`apps/merchant`) — live order queue with accept/reject and
prep-time capture, the LMIV allergen editor that unblocks selling, availability
toggles, store pause, and a statement showing commission as an explicit line.

**Customer app** (`apps/mobile`) — discovery, checkout with the full price and
VAT breakdown, live map tracking, order chat with photos, Butler.

**Wallet** — customers deposit money by card/SEPA/PayPal and spend it on future
orders, with a bonus of up to 8% on larger top-ups. Balance is split into
purchased (refundable, permanent) and granted (expires, not cashable) because
that split is what keeps the feature inside the ZAG limited-network exception
rather than making us an unlicensed e-money issuer. Tips can also be added up to
48h after delivery, charged to a card and passed 100% to the courier.

**Cashback bonus** — customers earn a percentage of what they actually paid back
as spendable credit on delivery: 2/3/5% by tier, stackable campaign boosts,
capped per order, clawed back on refund. Earned on money paid rather than basket
value, so credit-funded spend cannot mint more credit.

**Courier identity and ratings** — the courier's photo, first name and star
rating appear during tracking and in chat. Customers rate the food and the
delivery on one screen, with structured compliments alongside free text.
Couriers see everything said about them, can contest it, and control their own
photo.

**Live tracking and chat** — the courier moves on a real map with an animated
marker and a cycling route from OSRM; customer and courier chat in-thread with
photo sharing. Neither side ever sees the other's phone number, EXIF is stripped
from every upload on ingest, image URLs are signed and short-lived, and the
thread closes after delivery and is purged at 90 days.

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

## Security note

An earlier revision took `actorType` from the request body on
`/orders/:id/transition`, which let any authenticated customer accept, reject or
complete **any order in the system**. `/payroll/run`, `/payments/capture`,
`/payments/void`, `/dispatch/assign` and `/shifts/record-drop` were
unauthenticated outright — the first of those returned courier names and
earnings.

Both are fixed. The actor now comes from the signed token, ownership is checked
per order, and internal endpoints require a service token. The ownership
decision lives in `packages/shared/src/authorisation.ts` as a pure function with
its own tests, including a regression test for the impersonation case, so it
fails closed on any actor type nobody has explicitly handled.

If you fork this before that commit, take the fix.

## Not built

- Push notifications (chat currently relies on a WebSocket plus a poll fallback,
  so a backgrounded app won't alert)
- Voice calling — chat covers the need; a bridged-number call path is not built
- Media storage is in-memory (`MemoryStorage`); swap in an S3-compatible
  EU-region bucket before any real use
- No migration has been generated — run `prisma migrate dev` against a live
  Postgres to create one
- Points expiry is recorded per transaction but nothing sweeps expired points yet
- The retention sweep exists but nothing schedules it
- Merchant staff invite/management UI — accounts are created by seed or ops
- Courier passwords are not yet self-serve; `/auth/courier/login` verifies
  against a placeholder hash until onboarding lands

## Legal note

Business models and feature sets aren't protected by copyright; code, text and
artwork are. This project reimplements the former and copies none of the latter.
Have German counsel review `docs/03-eu-compliance.md` before launch — it is
engineering guidance, not legal advice.
