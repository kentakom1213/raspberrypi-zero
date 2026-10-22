# Workers frontend for temperature-logger

This is a Cloudflare Workers Static Assets frontend for the existing Flask monitor.
The GitHub repository remains the source of truth for HTML, CSS and JavaScript:
`../src/static/`. Running `npm run build` copies these into `dist/`
(no duplicate frontend source files). The UI stays at `/` and `/stats`;
requests for `/health`, `/api/readings`, and `/api/stats` go through a
read-only Worker to the private Raspberry Pi HTTP API.

## Status / safe defaults

- All public API routes are **disabled** by default, returning HTTP 503.
  Static pages can deploy before VPC is connected, but live charts will not
  work until the binding and explicit enablement below.
- The Worker accepts only GET for the three API routes, validates query
  arguments and caps ranges before forwarding. No arbitrary URL proxying.
- Anonymous API requests require a Cloudflare Rate Limiting binding
  (`API_RATE_LIMIT`, 120 requests/minute per client IP per Cloudflare
  location). **This is approximate, not a strict global origin limit.**
- The Cache API avoids repeated private origin requests for identical
  canonical queries (20 sec for health, 60 sec for readings / hourly stats,
  5 min for other stats). Cache entries are per data center; cache misses
  still reach the Pi. The Worker uses a minute-quantized time range for
  numeric `start_ms` / `end_ms` (up to 59 seconds of rounding).
- Raw `/health.last_error` messages from Flask are not sent to anonymous
  visitors.
- Do not expose a public Tunnel hostname for port 8000. Keep the existing
  SSH/Access hostname unchanged.

This is a small personal-site implementation, **not** a strict upstream
request budget. Before widespread public access, verify response times,
Cloudflare limits, and origin protection. Temperature records may reveal
occupancy patterns.

## Local development

From `temperature-logger/frontend/`:

```sh
npm install
npm run check
npm run dev
```

The build requires the parent repository (particularly `../src/static`)
to be present. Local API calls return HTTP 503 until a remote VPC Service
binding is configured; HTML/CSS/JS are still available.

## Cloudflare VPC setup

1. Check that the existing `cloudflared` Tunnel on the Raspberry Pi
   supports Workers VPC (compatible version and QUIC).
2. In Cloudflare, create a **VPC Service** for the existing Tunnel
   pointing to `127.0.0.1:8000` over HTTP.
3. Copy the actual VPC Service ID and add this property to
   `wrangler.jsonc` (not a secret):

```jsonc
"vpc_services": [
  {
    "binding": "PI_API",
    "service_id": "<actual-VPC-service-ID>",
    "remote": true
  }
]
```

4. Connect the Cloudflare Worker `temperature-monitor` to
   `kentakom1213/raspberrypi-zero` via **Workers Builds / GitHub**.
   Configure:
   - **Root directory**: `temperature-logger/frontend`
   - **Production branch**: `main`
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
   - **Build watch paths**: both `temperature-logger/frontend/**`
     and `temperature-logger/src/static/**`.
   Cloudflare's Git integration manages deployment authorization. No
   personal Cloudflare API token or GitHub Actions secret is required.
5. Deploy with `PUBLIC_API_ENABLED` still `false`. Confirm static
   routes work, and `/health` returns 503.
6. Test the private VPC binding while access is restricted. After verifying
   the rate limiting binding, VPC, and origin load, change
   `PUBLIC_API_ENABLED` to `true` **in the committed Wrangler config**.
   This avoids having dashboard edits overwritten by the next build.
7. Only then map a public custom domain, and consider closing the
   existing Flask public hostname if one exists. Keep Cloudflare Access
   enabled on the SSH hostname.

The Cloudflare dashboard and GitHub authorization need an account holder
to connect them initially. `wrangler.jsonc` intentionally has no
placeholder VPC Service ID, because an invalid binding would prevent
deploying even the static frontend.

## Deployment responsibilities

- Cloudflare serves the built static site and read-only API proxy.
- Raspberry Pi continues measuring, storing SQLite data and synchronizing
  Ambient. This change does not modify the Pi files or systemd.
- Workers Builds deploys the frontend from `main`; Pi deployments are
  still performed separately over SSH.
- Existing API paths and JSON formats are preserved, except that the
  public proxy may quantize numeric time boundaries and sanitize errors.
