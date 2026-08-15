# Germany & EU launch plan

## 1. Don't enter as a food delivery app

Germany's restaurant delivery market is effectively consolidated: Lieferando (Just Eat
Takeaway) holds dominant share, with Wolt and Uber Eats fighting for the remainder in
big cities. Quick-commerce grocery has already had its shakeout — Getir withdrew, Flink
survived by shrinking. Entering either head-on means buying share with discounts against
better-capitalised incumbents with a decade of density.

The Toters shape is different, and the difference is the whole opportunity:

> **One app that brings you anything from any local store — including stores that aren't
> partners.**

Nobody owns that in Germany.

## 2. Sequencing

**Phase 1 — Butler only (months 0–4).** Launch the errand/buy-anything service in a
single city. It requires **zero merchant integrations**, which means no
chicken-and-egg supply problem: on day one the addressable catalog is *every shop in
the city*. Revenue is a service fee plus distance-based delivery. Small courier fleet,
tight geography.

**Phase 2 — Partner merchants (months 4–10).** Convert the highest-frequency Butler
destinations into signed partners. You will know exactly which ones to sign, because
your own order data tells you — this is the sequencing advantage, and it inverts the
usual cold-start problem.

**Phase 3 — Verticals (months 10–18).** Grocery with substitutions, pharmacy (OTC first;
Rx requires `Apothekenbetriebsordnung` compliance and e-prescription/`E-Rezept`
integration), retail.

**Phase 4 — Second country (months 18+).** Austria first: same language, same VAT
structure, adjacent legal system. Then the Netherlands.

## 3. City selection

Rank on courier-serviceable density, not population. Best first-city profile: compact,
high student/young-professional share, high cycling modal share, and *not* a top-3
incumbent stronghold.

Strong candidates: **Leipzig**, **Münster**, **Freiburg**, **Karlsruhe**, **Bonn**.
Avoid Berlin, Munich and Hamburg for launch — highest incumbent density and highest
courier wage competition.

Target a launch polygon of roughly 15–25 km² with ≥3,000 addressable households per km².

## 4. Unit economics (per order, planning assumptions — validate in pilot)

| Line | Amount |
|---|---|
| Delivery fee | €3.49 |
| Service fee (~8 % of basket, capped) | €1.60 |
| Merchant commission (Phase 2+, 18–25 %) | €4.50 |
| **Revenue** | **€9.59** |
| Courier cost (employed, ~2.2 drops/h @ €13.90 + employer contributions ≈ €17.40/h loaded) | −€7.90 |
| Payment processing | −€0.45 |
| Support + ops allocation | −€0.60 |
| **Contribution** | **≈ €0.64** |

Contribution margin is thin and **entirely dependent on drops per hour**. At 1.8 drops/h
this business loses money on every order; at 2.6 it works comfortably. Batching and
launch-zone compactness are therefore not optimisations — they are the business model.

Butler orders carry no merchant commission, so they need a higher service fee (€2.50–4.00
depending on errand complexity) to clear the same bar.

## 5. Courier model

Employed, not contractor — see `docs/03-eu-compliance.md` §8. Budget:

- €13.90/h base (2026 statutory minimum; pay above it — €14.50–15.50 is competitive)
- ~21 % employer social contributions
- Equipment, insurance, e-bike leasing
- Loaded cost ≈ €17.00–18.50/h

`enforceWageFloor()` guarantees the statutory floor per shift regardless of drop volume.
Budget for this being binding during ramp-up, when volumes are low.

## 6. Pre-launch checklist

**Corporate**
- [ ] `GmbH` incorporation; `Handelsregister` entry
- [ ] `Gewerbeanmeldung`; tax number + `USt-IdNr.`
- [ ] `Berufsgenossenschaft` (BGHW/BG Verkehr) registration for employed couriers
- [ ] Employer's liability + fleet insurance

**Regulatory**
- [ ] LUCID / `Zentrale Stelle Verpackungsregister` registration + dual-system contract
- [ ] `Lebensmittelunternehmer` registration with the local `Veterinär- und
      Lebensmittelüberwachungsamt`; HACCP concept for any temperature-controlled handling
- [ ] DPO appointed; Art. 30 processing register; DPIA for courier location tracking
- [ ] `Impressum` + `Datenschutzerklärung` + AGB (T&Cs) drafted by German counsel
- [ ] DSA trader-traceability process for merchant onboarding
- [ ] Works council (`Betriebsrat`) readiness once headcount grows

**Technical**
- [ ] EU-region infrastructure only; DPAs with every processor
- [ ] PSP contract with SEPA + PayPal + Klarna + cards
- [ ] Play Store data-safety declaration matching the actual data flows
- [ ] German-first content: DE is the default locale, EN is the fallback

## 7. Naming and trademark

**`Liefero` in this repository is a placeholder.** Before any public use:

1. EUIPO search (Nice classes 39 transport/delivery, 42 software, 35 retail services)
2. DPMA search for German national marks
3. `.de` domain availability via DENIC
4. Google Play and App Store name availability

Do not print merchandise or file for the mark before all four clear.

## 8. What would make me stop

Honest failure conditions, worth writing down before you're emotionally committed:

- Pilot drops/hour stays below 2.0 after eight weeks of density work
- Courier attrition above 15 %/month at competitive pay
- Butler order frequency below 1.5/month per active user — implies novelty, not habit
- CAC above €25 with retention under 30 % at day 60
