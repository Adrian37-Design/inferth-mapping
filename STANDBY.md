# Standby server — what to do when Railway is down

Railway outages pause builds and the dashboard but usually keep running
services alive. The real problem is deploying new code while they are down.
This setup gives every push a second place to land, and the domain a second
place to point.

```
GitHub push ──► Railway build (normal path)
           └──► GitHub Actions ──► GHCR image ──► standby VPS (always updated)

Postgres stays on Railway. The standby reaches it through Railway's public
TCP proxy, so both hosts serve the same live data — no replication needed.
```

Scope: **dashboards and API failover only.** Xcela trackers POST to
`inferth-mapping.up.railway.app` hard-coded in firmware, so their uploads stop
during a Railway outage regardless. Pointing `SERVER` at a dedicated hostname
(e.g. `track.inferthmapping.co.zw`) and reflashing fixes that later — TCP
port 9005 is already exposed on the standby for it.

---

## One-time setup (~1 hour)

### 1. VPS

- Provision an Ubuntu VPS (Hetzner/DigitalOcean, ~$5/mo). Note its IP.
- Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/inferth-standby
```

- Copy `deploy/standby/docker-compose.yml`, `Caddyfile` and `.env.example`
  into `/opt/inferth-standby/`.
- `cd /opt/inferth-standby && cp .env.example .env && chmod 600 .env` and fill
  in the values (see below).
- Log in to the container registry once (the image is private):

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME
# password: a GitHub PAT with read:packages
```

### 2. Railway — expose Postgres publicly

Dashboard → Postgres service → Settings/Connect → enable **Public Network /
TCP proxy**. Copy the proxy host and port into `.env` `DATABASE_URL`.

Then copy the app's service variables into `.env`: `JWT_SECRET` (must match
exactly), `TRACKER_AUTH_MODE`, `TRACKER_JWT_SECRETS`, Paynow and mail/SMS keys.

### 3. GitHub repo secrets

Settings → Secrets and variables → Actions:

| Secret            | Value                          |
|-------------------|--------------------------------|
| `STANDBY_HOST`    | VPS IP or hostname             |
| `STANDBY_USER`    | SSH user                       |
| `STANDBY_SSH_KEY` | private key (VPS `authorized_keys`) |
| `STANDBY_PORT`    | only if not 22                 |

From then on, every push to `main` builds an image and restarts the standby
with it. `https://<domain>/version` shows which commit is live.

### 4. Dry run (recommended)

- Add DNS `standby.inferthmapping.co.zw → <VPS IP>` at WebDev.
- Set `SITE_DOMAIN=standby.inferthmapping.co.zw` in `.env`,
  `docker compose up -d`.
- Browse `https://standby.inferthmapping.co.zw/version` and log in — the
  standby serves the live database read-write.

---

## During a Railway outage

1. Confirm it is actually Railway: `status.railway.com` plus
   `https://www.inferthmapping.co.zw/health`.
2. In `.env` set `SITE_DOMAIN=www.inferthmapping.co.zw` (the default) and
   `docker compose up -d` on the VPS if it isn't already running.
3. At WebDev, point the `www.inferthmapping.co.zw` (and apex) records at the
   VPS IP. Propagation depends on their TTL — this is why moving DNS to
   Cloudflare (free) is recommended: flips take ~5 min instead of hours.
4. First HTTPS visit triggers Let's Encrypt issuance — allow a few seconds.
5. Verify: `/version` shows the new commit, login works, map + positions load.

## When Railway recovers

1. Confirm the Railway deploy is current via `/version` on the railway.app URL.
2. Point the DNS records back at Railway.
3. Leave the standby running — it stays updated on every push and costs
   nothing extra while idle.

## Limits to remember

- **Trackers do not fail over** (they hard-code `railway.app`). Live positions
  pause during an outage; buffered data replays when Railway returns. Fix =
  firmware `SERVER` → dedicated hostname + reflash.
- If the outage also kills Railway's *data plane* (the Postgres container
  itself), the standby has no database — moving Postgres to an external
  managed host is the upgrade path for that.
- If `JWT_SECRET` or Paynow/mail keys differ from Railway, logins and
  notifications break during failover — keep `.env` in sync when secrets rotate.
