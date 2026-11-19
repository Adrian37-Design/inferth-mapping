# Enterprise Custom Quotation — Methodology, Calculator and Commercial Terms

Inferth Mapping (Pty) Ltd · Platform: multi-tenant GPS fleet tracking, Zimbabwe · Currency: USD
Companion tool: `frontend/enterprise-quotation.html` (platform admin → Settings → Enterprise quotations → **Open quotation calculator**)

> **Status of the numbers.** Every rate in this document comes from the structure you proposed. They are treated as
> starting assumptions, not approved tariffs. Where a band was unspecified ("negotiated", "custom quotation") the
> document says so and uses an explicitly labelled placeholder. No infrastructure cost, salary or margin figure has
> been invented: the sections that need real cost inputs list exactly which inputs are missing.

---

## 1. Recommended pricing methodology

### 1.1 The model

A hybrid model, priced every month per account:

```
Monthly fee = Platform fee
            + Progressive vehicle charges
            + Optional module charges
            + Support / SLA charge
            − Discounts (shown on their own line)

First invoice = Monthly fee + One-time charges
Annual contract value = Monthly fee × contract months
```

One-time charges are quoted once and never folded into the recurring price. Hardware, installation, SIM cards and
airtime stay outside the quotation unless you deliberately add them as a separate line.

### 1.2 Why progressive and not a flat rate

The cost of serving a vehicle does not fall in a straight line: a 10-vehicle customer and a 700-vehicle customer
consume almost the same fixed platform cost (one deployment, one support relationship, one billing relationship),
while per-vehicle delivery cost (connectivity, position storage, support minutes) is roughly flat. Progressive bands
are the fair way to express that: the first vehicles recover the fixed platform cost, later vehicles are priced close
to delivery cost plus a margin.

Applying the lowest band to the whole fleet (`vehicles × $4`) destroys the economics: 100 vehicles at $4 is $400
against $700 under the progressive structure, and the small customer pays the same per vehicle as the largest one,
which is what makes large accounts unprofitable.

### 1.3 Rules the methodology depends on

1. **Bands are cumulative.** Vehicles 51–100 are charged at $6 **in addition to** the first 50 at $8. Never bill the
   whole fleet at the rate of the last band reached.
2. **Bands must not fall faster than unit cost.** A band priced below the one before it means revenue falls as the
   customer grows (see §7.2).
3. **Only the deliverables in the quota are included.** Modules, retention and support are line items, not goodwill.
4. **Every discount is a line, never a silently reduced rate.** The customer must see list price and discount.
5. **Quotations run for a fixed validity (30 days)** so a quote cannot be accepted a year later against old costs.
6. **The person quoting enters the real cost** of serving that account into the calculator. The tool refuses to flag
   margin on invented numbers — with cost fields empty it warns that margin is unverified.

---

## 2. Progressive vehicle pricing formula

With `v` = active vehicles and bands `B1…B5`:

```
vehicle_charge(v) =  min(v, 50)                        × 8.00
                   + max(0, min(v,100)  −  50)         × 6.00
                   + max(0, min(v,250)  − 100)         × 5.00
                   + max(0, min(v,500)  − 250)         × 4.00
                   + max(0, min(v,1000) − 500)         × R_negotiated
                   + max(0,  v          − 1000)        × R_custom
```

| Band | Vehicles in band | Rate / vehicle / month | Status |
|---|---|---|---|
| B1 | first 50 | **$8.00** | proposed |
| B2 | 51 – 100 | **$6.00** | proposed |
| B3 | 101 – 250 | **$5.00** | proposed |
| B4 | 251 – 500 | **$4.00** | proposed |
| B5 | 501 – 1,000 | *negotiated* | **not set — placeholder $3.00 in the calculator** |
| B6 | above 1,000 | *custom quotation* | **not set — placeholder $2.50** |

`R_negotiated` and `R_custom` appear as editable fields in the calculator and are persisted in the administrator's
browser. They must be set by a commercial decision, not by whoever is preparing a quote.

---

## 3. The calculator

`frontend/enterprise-quotation.html` — a single self-contained page, no dependencies, no backend call, nothing to
deploy separately.

**Inputs**

- Customer, contact, prepared-by.
- Active vehicles, platform fee, contract term (month-to-month / 12 / 24 / 36), data retention.
- Rate card: the six band rates, editable and saved per administrator.
- Optional modules with editable prices: advanced reporting, custom analytics, custom roles, dedicated
  infrastructure, operational monitoring, remote immobilisation.
- Support level, with an override field for a negotiated retainer.
- One-time charges: onboarding, migration, API integration, custom reports, custom development, special deployment.
- Commercial discount %, annual prepayment (10 months for a 12-month term), VAT %.
- Cost inputs: hosting/infrastructure per month, delivery cost per vehicle, fixed support load, and the minimum
  gross margin floor.

**Outputs, computed live**

1. Progressive vehicle charge, band by band.
2. Platform fee.
3. Selected modules.
4. Support/SLA.
5. One-time charges.
6. Monthly total, then net monthly after prepayment and discount (both shown as separate lines).
7. Annual contract value over the term.
8. First invoice amount, plus VAT and the first invoice including VAT.
9. Effective rate per vehicle per month.
10. Delivered cost, gross margin in dollars and percent, and the guardrail warnings.

**Guardrails built in**

- Blocks a quote **below delivered cost** outright.
- Warns when gross margin is under the configured floor (default **55%**).
- Warns when a discount exceeds 15% (approval limit).
- Warns when the 501–1,000 band is priced below the 251–500 band (growth cliff).
- Warns when vehicles exceed 1,000 (custom basis).
- Warns when remote immobilisation is quoted (compatibility must be verified in writing).
- States plainly when cost inputs are empty, so margin cannot be "assumed".

**Output formats** — print / save as PDF, and copy as plain text for WhatsApp or email.

---

## 4. Quotation template

```
INFERTH MAPPING — ENTERPRISE SERVICE QUOTATION
Reference: QTE-YYYYMMDD-NNN        Date: DD Mon YYYY        Valid until: DD Mon YYYY
Prepared for: <Company>            Attention: <Contact>
Fleet: <n> active vehicles         Term: <12 months>       Currency: USD

MONTHLY RECURRING CHARGES
  First 50 vehicles × <n> @ $8.00 ................ $ 400.00
  51–100 vehicles × <n> @ $6.00 .................. $ 300.00
  Platform fee ................................... $  75.00
  Advanced fleet reporting ....................... $  30.00
  Extended data retention (24 months) ............ $  25.00
  Priority support ............................... $  40.00
  MONTHLY QUOTATION .............................. $ 870.00
  Annual prepayment (10 months for 12) ........... −$ 145.00   [if elected]
  Commercial discount ............................ −$   0.00
  NET MONTHLY FEE ................................ $ 870.00

ONE-TIME CHARGES (billed once, first invoice)
  Onboarding & configuration ..................... $ 250.00
  Data migration / API integration ............... $   0.00
  FIRST INVOICE .................................. $1,120.00
  VAT 15% ........................................ $ 168.00
  TOTAL DUE ON ACCEPTANCE ........................ $1,288.00

ANNUAL CONTRACT VALUE ........................... $10,440.00
EFFECTIVE RATE .................................. $  8.70 per vehicle / month

INCLUDED    Platform access, live tracking, trip history, geofences, alerts, standard support.
EXCLUDED    Trackers, installation, SIM cards & airtime, on-site attendance, third-party licences,
            and any development not listed above.
PAYMENT     USD. Recurring monthly in advance. One-time charges 50% on acceptance, balance on go-live.
TERM        <12> months from go-live, then 60 days written notice. Prices valid 30 days.
```

The reference format `QTE-YYYYMMDD-NNN` matches the quotation requests already recorded in
**Settings → Enterprise quotations**, so a printed quote and the request in the platform can be matched by eye.

---

## 5. Worked quotation — 100 vehicles

Your illustration, reproduced exactly by the calculator as it opens ($100 vehicles, $75 platform fee, advanced
reporting $30, priority support $40, 24-month retention $25):

| Component | Calculation | USD / month |
|---|---|---|
| Platform fee | fixed | 75.00 |
| First 50 vehicles | 50 × $8.00 | 400.00 |
| Next 50 vehicles | 50 × $6.00 | 300.00 |
| Advanced reporting | module | 30.00 |
| Priority support | module | 40.00 |
| Extended retention (24 months) | module | 25.00 |
| **Total monthly fee** | | **870.00** |

First invoice with onboarding at $250: **$1,120.00** (VAT 15%: $168.00 → $1,288.00).
Annual contract value at 12 months: **$10,440.00**. Effective rate: **$8.70 per vehicle per month**.

The arithmetic in §3 of your brief is correct — including the cumulative treatment of the two vehicle bands.

---

## 6. Worked examples — 50, 250, 500 and 1,000 vehicles

Same basis for comparability: $75 platform fee, advanced reporting $30, extended retention (24 months) $25,
priority support $40. B5 uses the **placeholder** $3.00.

| Vehicles | B1 | B2 | B3 | B4 | B5 | Platform + modules + support | **Monthly** | **Annual (12m)** | Per vehicle |
|---|---|---|---|---|---|---|---|---|---|
| 50 | 400 | – | – | – | – | 170 | **570.00** | 6,840.00 | 11.40 |
| 100 | 400 | 300 | – | – | – | 170 | **870.00** | 10,440.00 | 8.70 |
| 250 | 400 | 300 | 750 | – | – | 170 | **1,620.00** | 19,440.00 | 6.48 |
| 500 | 400 | 300 | 750 | 1,000 | – | 170 | **2,620.00** | 31,440.00 | 5.24 |
| 1,000 | 400 | 300 | 750 | 1,000 | 1,500 | 170 | **4,120.00** | 49,440.00 | 4.12 |

With the annual-prepayment option (10 months for 12), 12-month cash in advance is 10 × the monthly figure:
50 → $5,700; 100 → $8,700; 250 → $16,200; 500 → $26,200; 1,000 → $41,200.

**Platform-fee sensitivity.** The platform fee is the only line that carries fixed cost, and it barely moves with
fleet size. At $50 instead of $75 every figure above drops by $300/year at 12 months; at $100 it rises by the same.
For quotes with dedicated infrastructure, a second region, custom SSO or a written SLA, $75 is not the right number —
use $150+ and price the infrastructure as a module.

---

## 7. Financial assessment of the proposed rates

### 7.1 What the rates imply

Per-vehicle revenue under the progressive structure:

| Vehicles | 50 | 100 | 250 | 500 | 1,000 |
|---|---|---|---|---|---|
| Vehicle-only $/veh | 8.00 | 7.00 | 5.80 | 4.90 | 3.95 |
| Loaded $/veh (with $170 fixed lines) | 11.40 | 8.70 | 6.48 | 5.24 | 4.12 |

### 7.2 The 501–1,000 band is the structural weakness

At the B5 boundary the structure has a **revenue cliff**. With B5 at the placeholder $3.00:

- 500 vehicles: 400 + 300 + 750 + 1,000 = **$2,450**
- 501 vehicles: **$2,453** — the 501st vehicle adds only **$3** of revenue, and the *average* rate across the whole
  fleet starts falling rather than the marginal one.
- 1,000 vehicles: 2,450 + 500 × 3 = **$3,950**, i.e. $3.95 per vehicle for a fleet that costs the platform
  roughly the same fixed cost as 500 vehicles plus twice the delivery cost.

Two things follow:

1. **B5 needs a floor, not a negotiation range that starts low.** B5 must be set from delivery cost, not from what a
   customer asks for. If B5 lands below B4, the account becomes *less* profitable the larger it grows — and the
   customer gains leverage on every renewal.
2. **A "negotiated" band with no written floor is an open discount.** Put the floor in this document and in the
   calculator's rate card, and require sign-off to move it.

### 7.3 Maximum sustainable delivery cost at each scale

Gross margin = (net monthly − delivered cost) ÷ net monthly. Inverting it gives the ceiling on cost:

| Gross margin target | 50 veh | 100 veh | 250 veh | 500 veh | 1,000 veh |
|---|---|---|---|---|---|
| 60% → max COGS / month | 228.00 | 348.00 | 648.00 | 1,048.00 | 1,648.00 |
| 60% → max COGS **per vehicle** | 4.56 | 3.48 | 2.59 | 2.10 | 1.65 |
| 50% → max COGS **per vehicle** | 5.70 | 4.35 | 3.24 | 2.62 | 2.06 |

Read this carefully: **the allowed cost per vehicle falls as the fleet grows.** At 1,000 vehicles the whole delivery
cost — SIM data, position storage, support minutes, billing effort — has to sit under roughly $1.65 per vehicle per
month to hold a 60% gross margin. That is the number to test your per-vehicle economics against, and it is the
reason the existing flat module prices (§7.4) cannot be scaled unchanged.

### 7.4 Three line items that do not scale

These are not wrong prices for a small fleet; they are wrong because they are **flat**:

1. **Extended data retention at a flat $25.** A 10-second reporting interval produces 8,640 fixes per vehicle per
   day — about 259,000 rows per vehicle per month, ≈3.1 million rows per vehicle per year. At 1,000 vehicles,
   24-month retention is over **6 billion rows**. A flat $25 against that is a subsidy, not a price. Price retention
   per vehicle (e.g. $0.40–$0.75 per vehicle per month for 24 months) or tier it by fleet size.
2. **Priority support at a flat $40.** At 500 vehicles that is **$0.08 per vehicle per month** for a phone-and-WhatsApp
   channel. Support cost scales with fleet size, incident volume and immobilisation events. Price support as a band
   (e.g. 8–12% of the recurring subtotal, minimum $40) or as an incident retainer.
3. **Monitoring at a flat $150.** A watch desk is a headcount, not a licence. If you sell 24/7 monitoring, price it
   against the shifts it actually requires and cap the number of accounts one desk covers.

### 7.5 What is missing (do not quote until these exist)

The proposal cannot be called commercially sustainable until these inputs are known. None of them are invented here:

- **Connectivity cost per device per month** (Econet/NetOne/Telecel data bundle actually loaded per tracker).
- **Hosting and database cost per month**, and how it grows per 100 vehicles retained.
- **Position storage cost** per million rows retained, including backups.
- **Support minutes per vehicle per month**, costed at real salary + overhead.
- **Engineering hours** for onboarding, API integrations and custom reports, at a real internal rate.
- **Payment costs** on Paynow collections (EcoCash/OneMoney/Zimswitch) and any FX conversion spread.
- **Bad debt and churn assumptions** — one written-off enterprise invoice many months of margin.
- **VAT position** — whether quoted prices are VAT-inclusive or exclusive (the calculator shows VAT separately).
- **Tracker and installation margin**, kept deliberately outside these figures so platform economics are not
  flattered by hardware profit.

### 7.6 What is sustainable

- The **B1–B4 progression is sound** and correctly recovers fixed cost from small fleets.
- **One-time charges priced separately** is the single most important decision in the proposal: onboarding,
  migration and integration are where enterprise accounts quietly consume engineering time.
- **A 12-month minimum term** with monthly billing in advance is appropriate for Zimbabwean corporate procurement.
- **Annual prepayment at 10 months for 12** (16.7%) is defensible if the cash is used to fund infrastructure; it is
  expensive if the discount is granted without the cash arriving.

### 7.7 Recommended margin policy

| Item | Floor | Notes |
|---|---|---|
| Recurring services | **55% gross margin** minimum (60% target) | below that, an enterprise account is a distraction |
| One-time work | **cost + 40%**, minimum $250 | protects engineering time from "free" onboarding |
| Support & SLA | **cost + 50%** | support is labour, not software |
| Discount authority | sales 0–10%, founder 10–20%, above 20% requires term + prepayment | written approval on the quote |

---

## 8. Minimum contract terms and payment conditions

- **Term:** 12 months minimum for Enterprise; 24 months where a discount above 10% is granted. After the initial
  term, month-to-month with **60 days written notice**.
- **Price review:** annually on the anniversary, 30 days' written notice, capped at CPI plus 5% unless scope changes.
- **Currency:** USD. If settlement in ZWG is agreed, use the prevailing interbank rate on the invoice date and state
  the conversion on the invoice.
- **VAT:** prices exclude VAT; add 15% where Inferth Mapping is required to charge it, shown as a separate line.
- **Recurring billing:** monthly in advance, invoiced on the 1st, payable within **14 days** (30 days for listed
  corporates and parastatals with a purchase order).
- **One-time charges:** **50% on acceptance**, 50% on go-live. Custom development is milestone-billed.
- **Arrears:** after 14 days, service notice; after 30 days, suspension of non-safety features. **Safety exception:**
  if the account uses remote immobilisation, suspension must never leave vehicles immobilised or unreachable — disable
  the customer's ability to command immobilisation, not the vehicle's ability to be tracked in an emergency.
- **Fleet changes:** vehicles added are billed pro-rata from activation at the applicable band; removals take effect
  the following billing month. A fleet dropping below a band does not retro-price earlier months.
- **Data:** retention as quoted; on termination, data is exported once within 30 days, then deleted per the retention
  policy. No data is withheld to force payment.
- **Scope:** hardware, installation, SIM cards, airtime, on-site attendance and third-party licences are excluded
  unless explicitly quoted.
- **Remote immobilisation and CAN/OBD diagnostics:** quoted **only** after compatibility and functionality are
  verified in writing on the specific tracker model and vehicle. State the verification date in the quote.
- **Confidentiality and tenant isolation:** each customer's data stays inside its own tenant scope; no cross-tenant
  visibility, no shared credentials.

---

## 9. Recurring vs one-time — keep them apart

| Recurring (monthly) | One-time (first invoice) |
|---|---|
| Platform fee | Onboarding & configuration |
| Progressive vehicle charges | Data migration |
| Reporting, analytics, roles, monitoring | API / system integration |
| Dedicated infrastructure | Custom report development |
| Extended data retention | Custom software development |
| Support & SLA | Special deployment requirements |
| Remote immobilisation (per vehicle or flat) | Installation, commissioning, training |

Never capitalise a one-time cost into the monthly fee to "make it look smaller": it hides the real cost, and the
customer keeps paying for a project long after it finished.

---

## 10. Discounts, annual contracts and negotiation

**Discount rules**

- Discount the **marginal bands and modules**, never the platform fee — the platform fee is the fixed-cost recovery.
- Show list price, discount percentage and net price as three separate lines.
- No discount without something in return: term length, prepayment, volume commitment, case study, or a reference
  introduction are all acceptable consideration.
- The calculator blocks a quote below delivered cost and warns below the margin floor. Treat that warning as a stop,
  not a suggestion.

**Annual contracts**

- 10 months for 12 (16.7%) is the standard annual incentive.
- Only offer it on 12-month-plus terms, and only when the cash arrives up front — a promise of annual payment is a
  monthly account with extra paperwork.
- Use annual cash to fund the infrastructure that the account needs; otherwise the discount is a pure margin cut.

**Negotiation positions**

| Customer pressure | Response |
|---|---|
| "Your competitor is $3 per vehicle" | Compare scope: retention, support hours, SLA, immobilisation, reporting. Show the delivered cost ceiling (§7.3) and what $3 buys — a platform without a watch desk. |
| "We will grow to 1,000 vehicles" | Price the current fleet, with a written volume schedule: the B5 rate applies when the fleet actually passes 500, not before. |
| "Waive onboarding" | Reduce scope, not price: self-service setup, or a credit against the first three invoices. |
| "We need it this week" | Charge for it. Expedited deployment is a one-time line item. |
| "Give us 30% off for 3 years" | Decline, or take it in exchange for 36 months, annual prepayment and a published reference. |

---

## Appendix — implementation notes

- Calculator: `frontend/enterprise-quotation.html`, served at `/static/enterprise-quotation.html`, linked from
  **Settings → Enterprise quotations**.
- Band rates are editable in the calculator and stored in the administrator's browser (`localStorage`), so a change
  is per-administrator until the defaults in the file are updated with commercial sign-off.
- A quote prepared here does **not** itself create a subscription. After the customer accepts, record the price in
  **Settings → Enterprise quotations → Activate**, which sets the plan, billing cycle and next invoice date.
- Quotation requests submitted from the customer's Billing tab appear there as `QTE-<id>`, carrying fleet size,
  notes and contact details.
