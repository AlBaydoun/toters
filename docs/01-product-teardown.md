# Product teardown: what the Toters model actually is

Research date: 2026-08-15. Sources: totersapp.com (marketing site + FAQ), Google Play
listing for `com.toters.customer`, App Store listing, press coverage of the 2022 Series B.

This document separates **the business model** (freely reimplementable) from **their
specific expression of it** (their code, brand, copy, and artwork — which we do not copy).
Everything below is a description of mechanics, written to be built independently.

---

## 1. The shape of the business

Toters is a **three-sided, multi-vertical last-mile marketplace**, not a food delivery app.
That distinction drives most of the architecture.

| Side | App | Job to be done |
|---|---|---|
| Customer | `com.toters.customer` | Discover nearby stores across verticals, order, track |
| Merchant | `com.toters.totersmerchant` | Receive orders, accept/reject, control order journey |
| Courier ("shopper") | separate fleet app | Get assigned, shop/collect, deliver |

**Verticals in one basket-agnostic engine:** restaurants, coffee shops, grocery,
pharmacy, electronics/retail, convenience. Their own FAQ frames the service generically —
"deliveries from local stores" — rather than as a restaurant product. The catalog,
cart, pricing and dispatch layers are therefore vertical-neutral, with vertical-specific
behaviour bolted on (substitutions for grocery, prescription checks for pharmacy,
prep-time for restaurants).

**The "Butler" / buy-anything service** is the strategic differentiator: a courier will
purchase or collect *anything that fits on a bike*, from a store that is not a partner
and has no catalog. This converts the marketplace into a general-purpose errand network
and is what lets them claim coverage far beyond their signed merchant base.

**Markets:** founded 2017 in Lebanon (Tamim Khalfa, Nael Halwani), Iraq from 2019,
with the FAQ also claiming US coverage. $18M Series B in 2022 (incl. IFC) earmarked for
Iraq expansion. ~4,000+ partner SMEs at the time of that coverage.

### The insight worth stealing

Their core competence is **operating where addressing and payments infrastructure is
weak**: map-pin addressing rather than street addresses, cash on delivery as a
first-class payment rail, and VoIP calling in-app because courier↔customer coordination
is constant. Europe inverts every one of those constraints. That inversion is the single
biggest source of design divergence in this project — see §4.

---

## 2. Feature inventory (observed)

### Customer app
- **Multi-vertical discovery** — browse by store category, near a chosen address
- **Address book** with saved locations; availability is address-gated
- **Live order tracking** — from placement through prep to courier-at-door
- **VoIP calling** customer ↔ courier in-app (avoids sharing phone numbers, and works
  around unreliable local telephony)
- **Scheduled delivery** — ASAP (targeted within the hour) or booked into 1-hour slots
- **Dynamic delivery fee** — their FAQ states the fee varies by *store, hour, and
  customer location*. That is a three-variable pricing function, not a flat rate.
- **Payments** — major cards, plus cash; charge is captured *on drop-off*, not at
  order placement
- **Rewards** — points earned per order, redeemable for discounts, free items, offers
- **Punch cards** — a second, merchant-scoped loyalty mechanic (buy N, get one)
- **Platform credit** — refunds for grocery issues are issued as credit, not cash back
- **Order rating** — 1–5 stars per order, feeding support triage
- **Butler** — free-text errand request, no catalog

### Operating rules encoded in their policy
These are product decisions, and each one is a rule in our engine:
- **One active order per customer at a time**
- **No post-placement modification** — cancel and reorder is the only path
- **Tiered cancellation:** free before the store accepts → order charged minus delivery
  after the store accepts → fully charged once the courier has departed
- **Grocery returns:** same-day only, wrong/damaged items, original condition
- **Support SLA:** 24–48h response

---

## 3. Reconstructed architecture

Inferred from the observable behaviour; this is our target, not a claim about their stack.

```
                       ┌──────────────┐
   Customer app ──────▶│              │◀────── Merchant app
   (Android/iOS)       │  API gateway │        (order lifecycle)
                       │              │
   Courier app ───────▶│              │
                       └──────┬───────┘
                              │
        ┌────────────┬────────┼─────────┬──────────────┐
        ▼            ▼        ▼         ▼              ▼
    Catalog      Pricing   Orders   Dispatch      Payments
    service      engine    +FSM     (matching)    (PSP + ledger)
                              │         │
                              ▼         ▼
                        Event bus ─▶ Tracking / notifications / analytics
```

**The five hard parts**, in order of difficulty:

1. **Dispatch** — assigning couriers to orders under time pressure, with batching,
   prep-time prediction, and shift supply that you only partly control.
2. **Pricing** — a fee that must be computed *before* the order exists, cheap enough to
   run on every store card in a list view, yet responsive to distance, demand and time.
3. **Catalog freshness** — grocery stock and restaurant availability drift constantly;
   stale catalog is the top driver of substitutions and refunds.
4. **ETA accuracy** — customers forgive slow, they don't forgive *wrong*. Needs
   separate models for prep time and travel time.
5. **The money ledger** — multi-party (customer, merchant, courier, platform), with
   partial refunds, credits, tips and adjustments. Get this wrong and you cannot close
   your books.

---

## 4. Where Germany/EU forces us to diverge

This is the part a literal clone gets fatally wrong. Their design is shaped by Lebanese
and Iraqi operating conditions. Ours must be shaped by German ones.

| Dimension | Their context | Our context | Consequence for the build |
|---|---|---|---|
| Addressing | Map pins; streets often unusable | Precise street addresses + postcodes | Address model is structured (`street`, `houseNumber`, `postalCode`), geocoded and validated; pin is a *refinement*, not the source of truth. Plus floor/`Etage`, `c/o`, entry codes — German apartment blocks need them. |
| Payments | Cash is a primary rail | Cash still used, but SEPA/PayPal/Klarna/cards dominate | Multi-rail PSP integration with **SCA/3DS mandatory** (PSD2). Cash retained as an option — Germany is unusually cash-friendly for a Western market. |
| Charge timing | Captured at drop-off | Authorise at placement, capture at delivery | Same pattern, but auth expiry and SCA re-auth must be handled. |
| Labour | Independent contractor couriers | **EU Platform Work Directive (2024/2831)** presumption of employment | Couriers modelled as **employed** with shifts, minimum-wage floor enforcement, working-time tracking. This is a schema-level decision, not a policy toggle. |
| Price display | Loose | **PAngV**: gross prices mandatory, `Grundpreis` (per kg/l) mandatory on groceries | Every price in the system is stored gross, in cents. Unit price is a first-class product field. |
| VAT | Simple | 7% food / 19% beverages, service & delivery fees; mixed baskets must apportion | A real VAT engine, not a constant. See `docs/03-eu-compliance.md`. |
| Deposits | n/a | **Pfand** on bottles/cans (€0.08–€0.25) | Separate, non-discountable line item, VAT at 19%. |
| Food info | Light | **LMIV/LMIDV**: 14 allergens + additives disclosed *before* order conclusion | Allergens are required catalog data; checkout blocks on missing data for food items. |
| Age-restricted goods | n/a | **JuSchG**: 16 for beer/wine, 18 for spirits/tobacco | Courier-side ID verification step in the delivery flow, order-level age gate. |
| Data | Light-touch | **GDPR** | Consent records, DSAR export/erasure endpoints, retention policy, EU-only data residency, location data minimisation. |
| Marketplace duties | n/a | **DSA** (trader traceability, notice & action) + **P2B** (ranking transparency) | Merchant KYC fields are mandatory; ranking logic must be documented and disclosed. |
| Withdrawal right | n/a | §312g BGB — perishables exempt, but disclosure is mandatory | Checkout must present the correct withdrawal notice per basket composition. |
| Competition | Fragmented SMEs | Lieferando (JET) near-monopoly in DE, plus Wolt, Uber Eats, Flink, Getir's remains | Cannot win on "we deliver food". Must win on the **multi-vertical + Butler** wedge, which is genuinely underserved in DE. |

### The strategic read

Straight food delivery in Germany is a bad market to enter: Lieferando holds dominant
share and the unit economics are brutal at low density. But the *Toters shape* —
one app for restaurants **and** groceries **and** pharmacy **and** "just go buy me this"
— has no strong incumbent in Germany. Flink and Getir attacked quick-commerce groceries
only, burned capital, and retreated. The Butler/errand primitive is the least contested
and most defensible entry point, and it is also the cheapest to launch because it needs
**no merchant integrations at all**.

Recommended sequencing is in `docs/04-germany-launch.md`.

---

## 5. What we deliberately do not take

- No decompilation of their APK; no reuse of their code, layouts, or assets.
- No copying of their brand, name, wordmark, colour system, or marketing copy.
- No scraping of their merchant lists or catalog data.
- The name **Liefero** used throughout this repo is a placeholder pending an EUIPO
  trademark clearance search — see `docs/04-germany-launch.md` §7.

Business models, feature sets, and operating rules are not protectable by copyright;
specific code, text, and artwork are. This project stays firmly on the right side of
that line.
