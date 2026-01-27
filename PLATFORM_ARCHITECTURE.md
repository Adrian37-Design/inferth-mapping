# Inferth Mapping - Platform Architecture Goals & Roadmap

**Vision:** To build a top-notch tracking platform structured as infrastructure, not just a GPS app. The focus is on separation of concerns, extensibility, reliability, and intelligence.

## 1. Core Architecture (Non-Negotiable)
**Goal:** strict separation of layers.
- [ ] **Device Layer**: Hardware interface.
- [ ] **Ingestion Layer**: Data intake.
- [ ] **Data & Intelligence Layer**: Processing & storage.
- [ ] **Application Layer**: User interface.

---

## 2. Device Layer (Hardware-Agnostic)
**Goal:** Accept data from any tracker without business logic pollution.
- [ ] **Protocol Support:** Implement common protocols (GT06, TK103, etc.).
- [ ] **Device Tagging:** Tag every device by type, protocol, and firmware.
- [ ] **Matrix:** Maintain a "Supported Devices Matrix".
- [ ] **Rule:** No business logic in this layer.

---

## 3. Ingestion Layer (High Reliability)
**Goal:** Reliable data intake that can restart without data loss.
- [ ] **Listeners:** TCP/UDP listeners for devices.
- [ ] **Auth:** IMEI validation.
- [ ] **Parsing:** Packet parsing and timestamp normalization.
- [ ] **Resilience:** Error handling, retries, and message queues (e.g., RabbitMQ/Redis).
- [ ] **Storage:** Raw data storage for audits (before processing).

---

## 4. Data & Intelligence Layer (The "Money Maker")
**Goal:** Convert raw dots into business intelligence.
- [ ] **Storage Separation:** 
    - Immunatble raw telemetry.
    - Derived processed events.
    - Aggregated business metrics.
- [ ] **Baseline Modules (MVP):**
    - Trip detection.
    - Idle time analysis.
    - Speed violations.
    - Geofence entry/exit.
    - Ignition on/off events.
- [ ] **Advanced Modules (Differentiators):**
    - Fuel anomaly detection.
    - Route deviation scoring.
    - Driver behavior profiling (braking, cornering).
    - Asset utilization KPIs.
    - Predictive maintenance signals.

---

## 5. Application Layer (The Client View)
**Goal:** Actionable interface answering "Where?", "What happened?", "What now?".
- [ ] **Core Views:**
    - Live Map (Clean, fast, clustered).
    - Fleet Summary (High-level KPIs).
    - Asset Timeline (History playback).
    - Reports (PDF/Excel exports).
    - Alerts & Notification Center.
- [ ] **Role-Based Access Control (RBAC):**
    - Admin (System owner).
    - Manager (Fleet controller).
    - Viewer (Passive monitoring).
    - Auditor (Compliance/NGO access).

---

## 6. Subscription & Monetization Layer
**Goal:** System-enforced tiering.
- [ ] **Tiered Logic:**
    - **Basic:** Live tracking only.
    - **Pro:** Reports + Alerts.
    - **Enterprise:** Analytics + API + Audits.
- [ ] **Enforcement:** strict feature gating based on subscription status.
- [ ] **Usage Tracking:** Monitor limits (e.g., SMS alerts sent, API calls).

---

## 7. Reliability & Trust (Zimbabwe Context)
**Goal:** Resilience against local infrastructure challenges.
- [ ] **Data Buffering:** Handle outages gracefully.
- [ ] **Fallback Alerts:** SMS/Email integration for low-data areas.
- [ ] **Time-zones:** Robust timestamp handling.
- [ ] **Status Page:** Transparent uptime reporting.
- [ ] **Integrity Checks:** Automated data validation.

---

## 8. Compliance & Auditability
**Goal:** Win corporate and NGO contracts.
- [ ] **Immutable Logs:** Audit trail of all actions.
- [ ] **Versioning:** Report version history.
- [ ] **User Activity:** Track who viewed/edited what.
- [ ] **Audit Packages:** One-click export for auditors.

---

## 9. Security
**Goal:** Enterprise-grade security.
- [ ] **Device Auth:** Verify device identity.
- [ ] **Encryption:** TLS/SSL for all connections.
- [ ] **Rate Limiting:** Protect ingestion and API.
- [ ] **Backup:** Automated backup & recovery strategy.

---

## 10. Developer & Growth
**Goal:** Maintainability and extensibility.
- [ ] **Internal:** Modular services, config over code, documentation.
- [ ] **External:** Preparation for Public API and Webhooks.

---

## 11. Zimbabwe-Specific Enhancements
**Goal:** "Smart Plays" for the local market.
- [ ] **Offline Tolerance:** App works well with spotty networks.
- [ ] **SMS Alerts:** Robust SMS gateway integration.
- [ ] **Fuel Price Awareness:** Integration with local fuel cost data for true cost analysis.
- [ ] **Power Resilience:** System stays up even if local power fails (cloud hosting).

---

## 12. Immediate Build Priority (90-Day Roadmap)
**Phase 1: Foundation (Weeks 1-4)**
1. [ ] Reliable Ingestion (TCP/UDP, Queueing).
2. [ ] Clean Data Model (User, Tenant, Device, Position).

**Phase 2: Intelligence (Weeks 5-8)**
3. [ ] Basic Analytics (Trips, Stops, Speeding).
4. [ ] Clear Reports (Daily summary, Trip logs).

**Phase 3: Experience & Sales (Weeks 9-12)**
5. [ ] Simple but Solid UI (Live Map, Asset List).
6. [ ] Subscription Enforcement (Billing integration, Feature gating).

---

**Philosophy:** Works with any device, rarely loses data, explains events (not just locations), sells intelligence.
