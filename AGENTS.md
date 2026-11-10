# Agent Instructions & Project Context — Inferth Mapping

> **For AI Coding Agents (Cursor, Windsurf, Devin, Claude Code, Antigravity, Aider, GitHub Copilot):**
> Read this file first before inspecting code or proposing modifications.

---

## 1. Project Identity & Architecture
* **Repository:** `Adrian37-Design/inferth-mapping`
* **Local Path:** `c:\Users\Takudzwa\Projects\Inferth-Mapping`
* **Product:** Real-time telematics, fleet management, and vehicle immobilizer SaaS built for Southern Africa (Zimbabwe).
* **Stack:**
  * **Backend:** FastAPI (Python 3.11), Async SQLAlchemy, Alembic, PostgreSQL, Redis pub/sub.
  * **Ingestion:** Async TCP Socket Server (`backend/app/services/tcp_server.py`) handling GT06, Sinotrack, Teltonika, H02 protocols.
  * **Frontend:** Vanilla JS (`frontend/app.js`), HTML5 (`frontend/index.html`), CSS3, Leaflet.js.
  * **Deployment:** Hosted on Railway (`inferth-mapping.up.railway.app`).

---

## 2. Core Operational Rules for AI Agents

1. **Consult ROADMAP.md First:**
   * Always check `ROADMAP.md` at the project root for the authoritative list of live features, what to Protect, Improve, Reinvent, Replace, and the current priority queue.

2. **Data Hygiene Guardrails are Mandatory:**
   * Never bypass or alter the 3-step guardrail system in `backend/app/services/data_guardrails.py`:
     * Coordinates must be validated (no `0.0, 0.0` Null Island, no NaNs).
     * Speeds capped at 200 km/h; teleportation jumps (>250 km/h over distance) must be rejected.
     * Hardware clock drift (< 2024 resets) must be corrected to server time.

3. **Multi-Tenancy Isolation:**
   * Tenant isolation is enforced at the SQL query level on all endpoints. `tenant_id = 1` is the super-admin. Always preserve `current_user.tenant_id` filters on queries.

4. **Preserve Hardware Scar Tissue:**
   * Do not "simplify" or refactor binary decoder logic in `backend/app/services/decoders/` without checking actual hardware specs. Hardware quirks (e.g., GPS fix status bit `course_status & 0x1000` in GT06) exist because real Chinese clone trackers behave unexpectedly.

5. **No Blind Heavy Dependencies:**
   * Keep frontend vanilla and lightweight (no heavy Node build pipelines unless explicitly directed).
   * Paynow integration handles local Zimbabwean payments (EcoCash, OneMoney, Zimswitch). Do not replace it with Stripe/PayPal.

6. **Current Status of Features:**
   * **Remote Shutdown Button:** Live & functional (`POST /devices/{device_id}/command`).
   * **CAN/OBD Columns:** Migrated and live on `positions` table.
   * **AI Chatbot:** System design is drafted, but user has explicitly instructed: **Do not implement AI Chatbot until ground-truth outcome labeling is complete.**

7. **Founder Mode Directives (Always On):**
   * Operates under the **Founder Skill** (`.agents/skills/founder/SKILL.md`).
   * Prioritize commercial leverage, unit economics, zero-bloat architecture, and emerging market operational durability (Econet/NetOne connectivity, cheap tracker firmware quirks, ZERA \$2.04/L diesel benchmarks).
   * Push back on frivolous architecture changes or premature LLM features that do not directly increase fleet owner retention or cash runway.
