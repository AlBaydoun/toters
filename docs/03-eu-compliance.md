# EU / German compliance: the rules encoded in this codebase

Compliance here is not a legal appendix — most of these rules are *code*, and the file
that implements each one is named. This is engineering guidance, not legal advice; have
a German `Rechtsanwalt` review before launch.

---

## 1. VAT (`Umsatzsteuer`) — `packages/shared/src/vat.ts`

German rates that apply to this business:

| Supply | Rate | Note |
|---|---|---|
| Food delivered to the customer (`Lieferung von Speisen`) | **7 %** | Delivery, not on-premise service |
| Beverages (soft drinks, beer, wine, spirits, mineral water) | **19 %** | Milk-based drinks are 7 % |
| Prepared hot food, delivered | **7 %** | The 19 % restaurant rate applies to *on-premise* service, which we never do |
| Non-food retail, electronics | **19 %** | |
| Most groceries (staples) | **7 %** | Luxury items (caviar, lobster) are 19 % |
| Delivery fee | **apportioned** | See below |
| Service fee | **19 %** | |
| Pfand (deposit) | **19 %** | |
| Tip to courier | **outside scope** | Not consideration for a supply by us |

### The delivery fee is the subtle one

A delivery charge is a `Nebenleistung` (ancillary supply) to the goods supplied, so it
**follows the VAT rate of the main supply** rather than carrying a fixed 19 %. For a
mixed basket (7 % groceries + 19 % beer) the fee must be **apportioned pro rata across
the rate buckets** by net line value.

`calculateVat()` implements exactly that, and returns a per-rate breakdown so the
invoice can show `USt. 7 %` and `USt. 19 %` as separate lines — which §14 UStG requires.

Tips are excluded from the taxable base before apportionment.

### Cross-border (rest of EU)

Once we sell into other member states, B2C distance sales past the €10,000 EU-wide
threshold require **OSS (One-Stop-Shop)** registration and charging *destination-country*
VAT. The `VatProfile` abstraction is keyed by country for this reason — Germany is
implemented, other countries slot in without touching call sites.

---

## 2. Price display — `PAngV` (Preisangabenverordnung)

- **All consumer prices are gross** (VAT included). There is no "+ VAT" in a B2C flow.
  Enforced by storing every amount as gross cents and never exposing a net price to the
  customer app.
- **`Grundpreis` (unit price)** is mandatory for goods sold by weight/volume — the
  price per kg / per litre must be shown *next to* the selling price. `Product` carries
  `basePriceAmount` + `basePriceUnit`, and `formatUnitPrice()` renders it.
- Total price including all mandatory fees must be visible **before** the customer
  commits.

## 3. Food information — `LMIV` (EU 1169/2011) + `LMIDV`

For distance selling, mandatory food information must be available **before the order is
concluded** *and* again **at the moment of delivery** — free of charge, both times.

- The 14 EU allergens are an enum (`Allergen`), not free text, so they are filterable
  and translatable.
- German additive declarations (`Zusatzstoffe` — e.g. *mit Farbstoff*, *mit Konservierungsstoff*)
  are a second enum.
- `POST /checkout` **rejects** a basket containing a food product with
  `allergenDataComplete = false`. This is deliberately a hard block: it is cheaper to
  lose the order than to take a `Bußgeld`.
- Allergen data is re-sent in the delivery confirmation payload to satisfy the
  at-delivery limb.

## 4. Deposits — `Pfand` (VerpackG)

- One-way containers €0.25; reusable €0.08–€0.15 depending on type.
- Modelled as a **separate order line**, never folded into item price, because it is
  not discountable and must be separately visible.
- Promotions explicitly exclude `DEPOSIT` lines from their discount base.
- Operating the platform also requires **LUCID registration** with the
  `Zentrale Stelle Verpackungsregister` for any packaging we put into circulation, plus a
  dual-system contract. That is an ops task, tracked in the launch checklist.

## 5. Age-restricted goods — `JuSchG`

| Category | Minimum age |
|---|---|
| Beer, wine, sparkling wine | 16 |
| Spirits, alcopops | 18 |
| Tobacco / vapes | 18 |

- `Product.minimumAge` drives an order-level `requiredAge = max(items)`.
- The courier app forces an **ID check step** before completion on such orders; the
  courier records only *verified yes/no* and the document type — **never** the document
  number or a scan. That is data minimisation under Art. 5(1)(c) GDPR.
- Failed check → order returns to store, customer charged per the cancellation tier.

## 6. GDPR

| Requirement | Where it lives |
|---|---|
| Lawful basis per purpose | `ConsentRecord` + a documented processing register |
| Consent for marketing, granular and withdrawable | `POST /me/consents` |
| Right of access (Art. 15) / portability (Art. 20) | `POST /me/data-requests` → JSON export |
| Right to erasure (Art. 17) | Same endpoint; performs **anonymisation**, not deletion, on records under a statutory retention duty |
| Storage limitation | `retention.ts` — orders 10 years (§147 AO tax retention), location traces 30 days, OTP challenges 15 minutes |
| Data minimisation on location | Courier GPS retained at full resolution only while a delivery is active, then downsampled |
| EU data residency | `DATA_REGION` pinned; PSP, geocoder, routing and push providers all EU-hosted or SCC-covered |
| Records of processing (Art. 30) | `docs/` — to be maintained by the DPO |

**The tension to be aware of:** §147 AO requires invoice retention for 10 years, which
*overrides* an erasure request for the order record. The implementation anonymises the
customer link and keeps the financial record. Erasure requests must not silently
half-succeed — the export tells the user exactly what was kept and why.

## 7. Platform regulation

- **DSA** — we are an online marketplace, so trader traceability (Art. 30) applies:
  every merchant must supply legal name, address, `Handelsregister` number, VAT ID and a
  contactable representative *before* going live. These are non-nullable on `Merchant`.
  Also required: notice-and-action reporting and a statement-of-reasons flow.
- **P2B Regulation (2019/1150)** — merchant-facing ranking must be explainable. Our
  ranking inputs are recorded per-impression in `ranking.ts` and disclosed in the
  merchant T&Cs. Paid placement must be labelled as advertising.
- **Right of withdrawal** — §312g(2) BGB exempts perishables and made-to-order food, but
  **the exemption still has to be disclosed**. Checkout selects the correct notice from
  the basket composition; non-perishable retail items keep the full 14-day right.
- **Impressum** (§5 DDG) and a `Datenschutzerklärung` are mandatory on the site and
  reachable from the app.

## 8. Labour — the one that changes the schema

The **EU Platform Work Directive (2024/2831)** introduces a rebuttable presumption of
employment for platform workers, with member-state transposition due by December 2026.
Germany's `Scheinselbstständigkeit` doctrine already made contractor fleets risky, and
the incumbents (Lieferando, Flink) run **employed** riders.

We therefore model couriers as employees from day one:

- `Courier` has an employment type, contracted weekly hours, and a payroll reference.
- `CourierShift` records actual worked time — required by the ECJ *CCOO* ruling and
  §16(2) ArbZG, and now by the German time-recording obligation.
- **Minimum wage floor is enforced in code**, not in a spreadsheet: `enforceWageFloor()`
  compares per-shift earnings (base + per-drop + tips excluded) against
  `hours × statutory minimum` and books a top-up if short. The statutory rate is a dated
  table in `wage.ts` — €12.82 (2025), €13.90 (2026), €14.60 (2027) — so historical
  shifts recompute correctly.
- Working-time guards: max 8h/day extendable to 10h, 11h rest between shifts, break
  rules at 6h and 9h. `validateShift()` refuses non-compliant rosters.
- **Algorithmic management transparency** (Directive Art. 6–11): couriers get an
  explanation of assignment decisions and a human-review path for any automated
  deactivation. `Assignment.reasonCodes` exists to make that answerable.

## 9. The wallet — the one that could make us a bank

**This is the highest-consequence item in this document.** Holding customer funds
that can be spent is, by default, **issuing electronic money**. In Germany that
requires a BaFin licence under the **ZAG (Zahlungsdiensteaufsichtsgesetz)**, and
operating without one is a **criminal offence under §63 ZAG** — not a fine, a
prosecution.

What keeps the wallet legal is the **limited network exception**
(§2 Abs. 1 Nr. 10 ZAG, transposing PSD2 Art. 3(k)): a balance spendable only on
the issuer's own goods and services is not e-money.

Three properties preserve that exemption, and all three are enforced in
`packages/shared/src/wallet.ts` and `services/api/src/modules/wallet.ts`:

1. **Spendable only on our own orders.** There is deliberately no
   withdraw-to-bank endpoint and no user-to-user transfer. Redeemability for cash
   at par on demand is the defining characteristic of e-money — building either
   would forfeit the exemption immediately.
2. **Purchased balance is tracked separately from granted balance.**
   - `PURCHASED` — money the customer paid. Refundable to their original payment
     method, because that is consumer protection, not cash redemption.
   - `GRANTED` — cashback, top-up bonuses, goodwill. Never refundable as money.
     Paying it out would convert a marketing accrual into cash redemption.
   The split is a schema-level decision (`BalanceBucket`), not a report.
3. **Volume is monitored.** Exceeding **€1,000,000 over twelve months** under the
   exception triggers a **notification duty to BaFin (§2 Abs. 2 ZAG)**.
   `assessZagThreshold()` warns at 80% of that, because a BaFin notification is
   not a same-week task. `GET /admin/wallet/zag-status` reports it.

Spend order matters too: **granted balance drains before purchased**, because
granted balance expires and purchased does not. Spending the customer's own money
first while their cashback quietly expired would be indefensible, and in a
dispute it would look exactly as bad as it is.

Other wallet points:

- **VAT.** The balance is a **multi-purpose voucher** (`Mehrzweckgutschein`,
  §3 Abs. 15 UStG) — spendable across baskets carrying different rates, so the
  rate is not fixed at issue. VAT falls on **redemption**, not on top-up. Selling
  balance therefore books no output VAT; the sale is recognised when the balance
  is spent on goods.
- **Accounting.** Purchased balance is a liability (deferred revenue), not
  revenue. Granted balance is a marketing accrual. Conflating them overstates
  revenue and is the kind of error that surfaces at audit.
- **SCA.** A top-up is a card payment. PSD2 applies unchanged.
- **Balance cap.** €500 per wallet. Partly product sense, partly risk: a large
  stored balance makes the account a target and makes us look more like a bank.

### Tips

Tips can be added up to 48 hours after delivery. Two rules:

- **100% to the courier**, stated in the UI. Anything else needs disclosing, and
  skimming tips is both a trust catastrophe and, if undisclosed, a UWG problem.
- **Never funded from wallet balance.** A tip paid out of cashback we granted
  would mean paying the courier from our own marketing budget while the customer
  takes the credit for it.

## 10. Payments — PSD2

- **SCA / 3-D Secure** is mandatory for consumer card payments. We authorise at order
  placement and capture at delivery; if the authorisation expires or the captured amount
  exceeds the authorised amount (basket adjusted by substitutions), the flow re-triggers
  SCA rather than silently over-capturing.
- Rails to support for Germany, in rough order of importance: **SEPA Direct Debit
  (Lastschrift)**, **PayPal**, cards, **Klarna**, Apple/Google Pay, and **cash on
  delivery** — cash remains meaningfully used in Germany and is a real acquisition lever.
- SEPA mandates require pre-notification and carry an 8-week no-questions chargeback
  window; the ledger must hold a reserve against that.
