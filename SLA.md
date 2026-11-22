# INFERTH MAPPING — SERVICE LEVEL AGREEMENT (SLA)

**Effective Date:** November 22, 2026  
**Scope:** Telematics, Fleet Monitoring, and Ingestion Platform Services  

### Parties to this Agreement:

**Provider:**  
Inferth Projects (Private) Limited  
Trading as/operating the service known as Inferth Mapping  
**Registered Address:** 792 Goodhope Road, Westgate, Harare, Zimbabwe  
**Registration Number:** 83217A0222026  
**Email:** inferthprojects@gmail.com  

**Client / Platform Renter:**  
Console Telematics (Operating under Platform Fleet Rental)  
**Trading / Business Address:** _____________________________  
**Contact Representative:** _____________________________  
**Email:** _______________________________  

---

## 1. Overview & Purpose
Inferth Mapping is a fleet tracking and telematics platform owned and operated by Inferth Projects (Private) Limited. All services provided under this Agreement are supplied by Inferth Projects (Private) Limited through the Inferth Mapping platform.

This Service Level Agreement ("SLA") defines the service availability, performance commitments, support tiers, and remedies provided by **Inferth Projects (Private) Limited** ("Company", "Provider", "we", "us") to the **Client** ("Customer", "you") across all active commercial plans and licensing models offered on the platform:
* **Monthly / Annual Subscriptions:** Basic, Premium, and Enterprise.
* **Once-Off Lifetime Pass:** Starter Pass (perpetual vehicle software tracking license).
* **Pay-As-You-Drive (PAYD):** Hourly usage billing ($0.02/tracked hour, settled every 5 minutes, capped at a maximum of $0.48/vehicle/day + modular feature passes).
* **Platform Fleet Rental:** Dedicated console and cloud infrastructure for independent tracking companies, fleet management operators, and white-label resellers.

---

## 2. Service Availability & Uptime Commitments

### 2.1 Monthly Uptime Target by Service Model
Inferth Mapping guarantees the following Core Platform Uptime across each calendar month:

| Service Model / Subscription Tier | Monthly Availability Target | Service Credit Eligibility |
| :--- | :--- | :--- |
| **Enterprise Plan** | **99.9%** | Yes (See Section 7) |
| **Platform Fleet Rental** | **99.9%** | Yes (See Section 7) |
| **Premium Plan** | **99.5%** | Standard support escalation |
| **Basic Plan** | Best-effort (Target 99.0%) | Standard support escalation |
| **Once-Off Lifetime Pass** | **99.0%** (Platform continuity) | Standard support escalation |
| **Pay-As-You-Drive (PAYD)** | **99.0%** (Active tracking days) | Day-fee credit on validated outage |

---

## 3. Commercial Plan Specific Terms

### 3.1 Once-Off Lifetime Pass (Starter Pass)
* **Scope of Guarantee:** Platform software access and GPS tracking continuity for the registered tracker hardware/IMEI for its functional hardware lifespan.
* **Hardware Independence:** Does not cover physical tracker replacement, SIM cellular airtime/data replenishment, or battery wear.
* **Data Retention:** Standard 30-day rolling journey history and trip playback.

### 3.2 Pay-As-You-Drive (PAYD)
* **Usage & Cap Model:** PAYD tracking is billed at $0.02 per active tracked hour (settled incrementally every 5 minutes) up to a maximum daily cap of $0.48 per vehicle per 24-hour day. Deductions only apply while the vehicle is reporting active telemetry.
* **Service Availability Remedy:** If a verified core gateway outage exceeds 3 consecutive hours on an active billing day, any tracking charges and activated daily add-on fees for that calendar day are credited back to the customer's prepaid wallet balance.
* **Prepaid Wallet:** Wallet balances do not expire while the account remains in good standing.

### 3.3 Platform Fleet Rental (Console Telematics & Wholesale Operators)
* **Wholesale & White-Label Infrastructure:** Console Telematics and approved wholesale operators rent the platform (Inferth Mapping) to operate independent vehicle tracking and telematics businesses with dedicated multi-tenant isolation, custom branding, and autonomous customer administration.
* **Authorized Retail Monetization Packages:** Through the rented Inferth Mapping platform, the Client is authorized to package and sell tracking services to its retail customers under three core monetization models:
  1. **Monthly Subscription:** Recurring monthly or yearly fleet tracking (Basic and Premium tiers).
  2. **Once-Off Lifetime Pass:** Perpetual software tracking access per registered vehicle with 30-day location history retention.
  3. **Pay-As-You-Drive (PAYD):** Hourly pay-as-you-go telemetry ($0.02/tracked hour, settled every 5 minutes, capped at max $0.48/vehicle/day).
* **Tenant Isolation SLA:** Platform updates, high concurrency, or system load on other accounts will not degrade, disrupt, or expose the Client's isolated fleet database.
* **Escalated Support:** Platform Fleet Rental operators receive Enterprise-grade P1 (< 1 hour) support priority.

---

## 4. Support Response Tiers & Severity Levels

Support tickets and operational incidents are prioritized and acknowledged according to the following matrix:

| Severity Level | Definition | Enterprise & Fleet Rental Target | Premium Target | Basic, Once-Off & PAYD Target |
| :--- | :--- | :--- | :--- | :--- |
| **P1 — Critical** | Ingestion gateway offline, complete dashboard outage, or remote shutdown failure across the fleet. | **< 1 hour** (24/7) | **< 4 hours** (Business hrs) | **< 12 hours** (Business hrs) |
| **P2 — Major** | Degraded performance, delayed WhatsApp reports/alerts, or vehicle history playback unavailable. | **< 2 hours** (24/7) | **< 8 hours** (Business hrs) | **< 24 hours** (Business hrs) |
| **P3 — Minor** | UI inconsistencies, minor export glitches, or single-device configuration assistance. | **< 6 hours** (24/7) | **< 24 hours** (Business hrs) | **< 48 hours** (Business hrs) |
| **P4 — General** | Feature inquiries, billing questions, or hardware compatibility assessments. | **< 12 hours** (24/7) | **< 48 hours** (Business hrs) | **< 72 hours** (Business hrs) |

---

## 5. Maintenance Windows

### 5.1 Scheduled Maintenance
* Inferth Mapping performs regular database pruning, infrastructure upgrades, and system improvements.
* Scheduled maintenance will occur between **00:00 and 04:00 CAT (UTC+2)**.
* Customers will receive at least **48 hours advance notice** via WhatsApp notification or email.
* Scheduled maintenance is excluded from downtime calculations.

### 5.2 Emergency Maintenance
In the event of critical security patches, zero-day vulnerabilities, or upstream hosting facility emergencies, Inferth Mapping reserves the right to perform emergency maintenance with immediate notice.

---

## 6. Exclusions & Emerging Market Limitations

Inferth Mapping operates specialized telematics infrastructure designed for Southern Africa. The following events are **strictly excluded** from downtime and SLA breaches:

1. **GSM & Cellular Network Outages:**
   * Cellular carrier dropouts, network congestion, roaming degradation, or BTS tower failures (including Econet Wireless, NetOne, and Telecel).
2. **Tracker Hardware Quirks & Power Loss:**
   * Tracker battery depletion, improper OBD/CAN wiring, disconnected backup batteries, antenna obstruction, or hardware firmware lockups on non-certified 3rd-party BYOT devices.
3. **Upstream Payment Gateway Latency:**
   * Temporary delays, downtimes, or bank-switch timeouts originating within third-party payment rails (Paynow, EcoCash, Zimswitch, InnBucks, OneMoney).
4. **Local Infrastructure Power Drops:**
   * Grid shedding, national power grid failures, or local device power starvation outside server cloud regions.
5. **Malicious Attacks:**
   * External Distributed Denial of Service (DDoS) attacks exceeding standard cloud mitigations.

---

## 7. Service Credits (Enterprise & Platform Fleet Rental)

If Inferth Mapping fails to meet the guaranteed monthly availability commitment (99.9%) for an **Enterprise** or **Platform Fleet Rental** contract, the Client is eligible to receive a service credit applied to their subsequent billing invoice:

| Monthly Uptime Percentage | Service Credit Percentage (% of monthly base fee) |
| :--- | :--- |
| **99.0% – 99.89%** | **10%** |
| **95.0% – 98.99%** | **25%** |
| **< 95.0%** | **50%** |

### Credit Terms:
* Service credits must be claimed in writing within **30 calendar days** of the month in which the incident occurred.
* Credits are non-refundable and cannot be exchanged for cash or transferred between accounts.
* The total service credits awarded in any single calendar month shall not exceed **50%** of the customer's monthly recurring software subscription charges.
* For **PAYD**, verified platform downtime exceeding 3 consecutive hours on an active tracking day is credited as a 100% refund of that day's tracking charges (up to $0.48/vehicle) back to the user's prepaid wallet.

---

## 8. Customer Responsibilities

To maintain SLA coverage, Customers agree to:
* Ensure trackers are configured to report to designated server ports with verified APN settings.
* Promptly report suspected platform anomalies via designated support channels (WhatsApp Business hotline or `inferthprojects@gmail.com`).
* Keep billing accounts and prepaid wallet balances in good standing.
