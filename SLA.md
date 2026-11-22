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

**Client:**  
Client: _______________________________  
Address: _____________________________  
Contact: _____________________________  
Email: _______________________________  

---

## 1. Overview & Purpose
Inferth Mapping is a fleet tracking and telematics platform owned and operated by Inferth Projects (Private) Limited. All services provided under this Agreement are supplied by Inferth Projects (Private) Limited through the Inferth Mapping platform.

This Service Level Agreement ("SLA") defines the service availability, performance commitments, support tiers, and remedies provided by **Inferth Projects (Private) Limited** ("Company", "Provider", "we", "us") to the **Client** ("Customer", "you") across active subscription plans (**Basic**, **Premium**, and **Enterprise**).

---

## 2. Service Availability & Uptime Commitments

### 2.1 Monthly Uptime Target
Inferth Mapping guarantees the following Core Platform Uptime across each calendar month:

| Subscription Tier | Monthly Availability Commitment |
| :--- | :--- |
| **Enterprise Plan** | **99.9%** |
| **Premium Plan** | **99.5%** |
| **Basic Plan** | Best-effort (Target 99.0%) |

### 2.2 Measurement & Availability Definition
Uptime is calculated as:
$$\text{Uptime Percentage} = \frac{\text{Total Operational Minutes} - \text{Unscheduled Downtime Minutes}}{\text{Total Minutes in Month}} \times 100$$

**Covered Services:**
* Web Console access (`https://inferthmapping.co.zw` & platform dashboards).
* REST API endpoints for fleet status, reporting, and live coordinates.
* TCP Socket Gateway ingestion servers (GT06, SinoTrack, Teltonika AVL, H02).

---

## 3. Support Response Tiers & Severity Levels

Support tickets and operational incidents are prioritized and acknowledged according to the following matrix:

| Severity Level | Definition | Enterprise Target | Premium Target | Basic Target |
| :--- | :--- | :--- | :--- | :--- |
| **P1 — Critical** | Ingestion gateway offline, complete dashboard outage, or remote shutdown failure across the fleet. | **< 1 hour** (24/7) | **< 4 hours** (Business hrs) | **< 12 hours** (Business hrs) |
| **P2 — Major** | Degraded performance, delayed WhatsApp reports/alerts, or vehicle history playback unavailable. | **< 2 hours** (24/7) | **< 8 hours** (Business hrs) | **< 24 hours** (Business hrs) |
| **P3 — Minor** | UI inconsistencies, minor export glitches, or single-device configuration assistance. | **< 6 hours** (24/7) | **< 24 hours** (Business hrs) | **< 48 hours** (Business hrs) |
| **P4 — General** | Feature inquiries, billing questions, or hardware compatibility assessments. | **< 12 hours** (24/7) | **< 48 hours** (Business hrs) | **< 72 hours** (Business hrs) |

---

## 4. Maintenance Windows

### 4.1 Scheduled Maintenance
* Inferth Mapping performs regular database pruning, infrastructure upgrades, and system improvements.
* Scheduled maintenance will occur between **00:00 and 04:00 CAT (UTC+2)**.
* Customers will receive at least **48 hours advance notice** via WhatsApp notification or email.
* Scheduled maintenance is excluded from downtime calculations.

### 4.2 Emergency Maintenance
In the event of critical security patches, zero-day vulnerabilities, or upstream hosting facility emergencies, Inferth Mapping reserves the right to perform emergency maintenance with immediate notice.

---

## 5. Exclusions & Emerging Market Limitations

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

## 6. Service Credits (Enterprise Tier Only)

If Inferth Mapping fails to meet the guaranteed monthly availability commitment for an Enterprise contract, the Customer is eligible to receive a service credit applied to their subsequent billing invoice:

| Monthly Uptime Percentage | Service Credit Percentage (% of monthly fee) |
| :--- | :--- |
| **99.0% – 99.89%** | **10%** |
| **95.0% – 98.99%** | **25%** |
| **< 95.0%** | **50%** |

### Credit Terms:
* Service credits must be claimed in writing within **30 calendar days** of the month in which the incident occurred.
* Credits are non-refundable and cannot be exchanged for cash or transferred between accounts.
* The total service credits awarded in any single calendar month shall not exceed **50%** of the customer's monthly recurring software subscription charges.

---

## 7. Customer Responsibilities

To maintain SLA coverage, Customers agree to:
* Ensure trackers are configured to report to designated server ports with verified APN settings.
* Promptly report suspected platform anomalies via designated support channels (WhatsApp Business hotline or `support@inferthmapping.co.zw`).
* Keep billing accounts active and in good standing.
