# Inferth Mapping — Platform Ledger & Living Strategic Roadmap

> **Document Purpose:** This is the single source of truth for Inferth Mapping's technical architecture, current live capabilities, strategic moat, and development roadmap. Any AI developer agent (Antigravity, Cursor, Windsurf, Devin, Claude Code, Aider) or human engineer must consult this file before making structural or strategic decisions.
>
> **Last Updated:** September 2026  
> **Repository:** `Adrian37-Design/inferth-mapping`  
> **Live Production:** `inferth-mapping.up.railway.app`

---

## 1. Executive Summary & Tech Stack

* **Domain:** Fleet telematics, asset tracking, remote immobilizer security, and fuel monitoring optimized for Southern Africa (Zimbabwe focus).
* **Backend:** FastAPI (Python 3.11, async SQLAlchemy, Alembic, Pydantic).
* **Ingestion Layer:** Asynchronous TCP socket server (`backend/app/services/tcp_server.py`) handling high-concurrency binary hardware streams.
* **Database:** PostgreSQL on Railway, equipped with partial indexes for high-frequency time-series coordinates and CAN-bus metrics.
* **Realtime Layer:** WebSockets and Redis pub/sub for sub-second position broadcasting to active client sessions.
* **Frontend:** Vanilla JS / HTML5 / CSS3 / Leaflet.js map engine (lightweight, zero-build step, responsive for mobile and desktop).
* **Payments:** Native Paynow gateway integration (EcoCash, OneMoney, Zimswitch).
* **Multi-Tenancy:** Strict tenant isolation enforced at SQL query level (`tenant_id = 1` reserved for global super-admin).

---

## 2. Live Platform State (What Currently Works in Production)

### A. Telematics Ingestion & Protocol Support
* **GT06 Protocol:** Decodes login, GPS location (with GPS fix validation bit `course_status & 0x1000`), status, and alarm packets.
* **Sinotrack Protocol:** Full text/binary command decoding with boundary sanitization.
* **Teltonika AVL:** AVL packet frame parsing into decoded dictionaries.
* **H02 & GPS103:** Decoders implemented for legacy clone hardware.

### B. 3-Step Data Guardrails Pipeline (`backend/app/services/data_guardrails.py`)
1. **Coordinate & Range Sanitization:** Null Island `(0.0, 0.0)` rejection, NaN filtering, and strict lat/long bounding.
2. **Speed & Clock Hygiene:** Speed clamping (>200 km/h anomaly cap), Haversine implied velocity checks (>250 km/h teleportation rejection), and hardware clock drift correction (<2024 reset filtering).
3. **Deduplication & State Resolution:** Stationary ping deduplication (<10m, <4s) and ignition-aware offline/idling state machine.

### C. Vehicle Control & Security
* **Remote Tracker Shutdown Button:** Live web UI modal with double-confirmation triggering `POST /devices/{device_id}/command` (`shutdown` / `restore`).
* **Audit Logging:** Every administrative action, tracker command, and login is immutably recorded in `AuditLog`.

### D. CAN-bus / OBD-II Database Schema
* Dedicated schema columns on `positions`: `fuel_level`, `rpm`, `engine_temp`, `battery_voltage`, `odometer`, `ignition`, `dtc_fault_codes`.
* Auto-migrating database schema with optimized partial indexes for zero-downtime startup.

---

## 3. Strategic Framework: The 5 Pillars

### Pillar 1: PROTECT (Defensible Strengths & Moats)
*What would set the venture back most if lost before scaling?*
1. **Hardware-to-Vehicle Scar Tissue:** Hard-won binary decoder logic handling quirks, clock resets, and packet bursts from Chinese clone trackers (GT06/Sinotrack) operating in real-world conditions.
2. **Auto-Electrician Installation Network:** Ground-level relationships with technicians trusted to splice immobilizer relays into vehicle harnesses without voiding manufacturer warranties.
3. **Live Road Vehicle Access & Trust:** Active trackers running on live Zimbabwean roads (Harare/Kadoma corridors), generating irreplaceable telemetry across cellular dead zones.

### Pillar 2: IMPROVE (Workable but Weak as Currently Designed)
*What functions today but requires architectural hardening?*
1. **Ground-Truth Outcome Verification:** Anomaly detection catches fuel drops and speed spikes, but lacks an operator "Incident Closure" UI to label whether an event was confirmed theft, rough-road slosh, or a sensor glitch.
2. **Teltonika Diagnostic Extraction:** Teltonika CAN/OBD fields remain nested in raw `io_elements` dictionaries rather than being extracted into dedicated columns.
3. **Automated SMS Fallback for Remote Cut-Off:** Engine shutdowns currently rely on active GPRS TCP sockets. If a vehicle enters a dead zone, the command stalls; it requires an automated SMS API fallback loop (`RELAY,1#` or `DY,123456#`).

### Pillar 3: REINVENT (Where the Industry Default is Broken)
*What would we design differently if nobody had done it before?*
1. **Behavior-Trained "Zero-Dashboard" Ops (WhatsApp-First):**
   * *The Problem:* African fleet operators live on WhatsApp, not complex desktop web dashboards.
   * *The Reinvention:* Use the web app as a behavioral training ground to learn which alerts the operator actually acts on. Once calibrated, distill 90% of daily operations into proactive, conversational WhatsApp summaries with 1-tap actions.
2. **Always-On Hybrid Satellite Telemetry for Remote Corridors:**
   * *The Problem:* Standard cellular trackers go blind for hours along mining, border, and agricultural corridors.
   * *The Reinvention:* Deploy hybrid cellular/satellite micro-packet hardware (Iridium/Astrocast/Swarm) so vehicles never drop off the grid.
3. **Crowdsourced Road & Network Hazard Intelligence:**
   * *The Reinvention:* Aggregate tracker accelerometer shocks and cellular disconnects to build a live map of regional road hazards (pothole clusters) and network dead zones.

### Pillar 4: REPLACE (Assumptions Carried Without Testing)
*What was in the plan only because other telematics companies do it?*
1. **REPLACE Flat Monthly SaaS Subscriptions ($15-$25/mo):**
   * *Why:* Creates payment friction, monthly debt collection headaches, and resistance during vehicle maintenance downtime.
   * *Replacement:* Prepaid Fleet Credits (pay-as-you-drive via EcoCash) or low-base + high-value incident fees (fuel recovery bounty).
2. **REPLACE Complex Analytics Dashboards:**
   * *Why:* Operators experience triage fatigue and rarely analyze trend graphs.
   * *Replacement:* Binary exception reporting (only alert when action is required).
3. **REPLACE Digital-Only Inbound Marketing:**
   * *Why:* Vehicle tracking is a physical trust business requiring hands-on wiring.
   * *Replacement:* Field-first distribution partnering with trusted mechanics, auto-electricians, and insurance brokers.

### Pillar 5: REMOVE / DEPRECATE (Waste & Tech Debt to Eliminate)
1. **Raw Heartbeat Ping Retention:** Deprecate indefinite storage of stationary zero-speed pings; use automated maintenance pruning (`POST /admin/storage/prune-heartbeats`).
2. **Redundant Mock Fleet Generators:** Remove mock tracking scripts once production vehicle counts scale.
3. **Double Commit Patterns:** Ensure all database transactions follow single-commit patterns to prevent async locking.

---

## 4. Priority Development Roadmap

| Phase | Milestone | Priority | Status |
|---|---|---|---|
| **Phase 1** | Remote Engine Shutdown UI & Endpoints | High | **COMPLETE** |
| **Phase 1** | 3-Step Telematics Data Guardrails & Tests | High | **COMPLETE** |
| **Phase 1** | CAN-bus Database Columns & Partial Indexes | High | **COMPLETE** |
| **Phase 2** | Incident Closure & Labeled Outcome UI (Theft vs Slosh) | Critical | **NEXT** |
| **Phase 2** | Teltonika OBD/CAN Nested Field Extraction in TCP Server | High | Planned |
| **Phase 2** | Automated Direct SMS Fallback for Tracker Shutdown | High | Planned |
| **Phase 3** | In-App Telematics AI Copilot (RAG on Postgres Telemetry) | Medium | Designed (Paused by User) |
| **Phase 3** | Operator Behavioral Profiling for Exception Reporting | Medium | Planned |
| **Phase 4** | WhatsApp Conversational Ops Bot (Zero-Dashboard Engine) | High | Planned |
| **Phase 4** | Prepaid Fleet Credits & EcoCash Token Billing Engine | Medium | Planned |
