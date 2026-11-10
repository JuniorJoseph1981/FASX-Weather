# FASX Flyability Dashboard

Live site: https://juniorjoseph1981.github.io/FASX-Weather/

A single-page dashboard for Hendrik Swellengrebel Airfield (FASX, Swellendam): a
FLYABLE / CAUTION / NO-FLY verdict from the on-site iWeathar station and the Open-Meteo
forecast, a 7-day planner, history calendar, fleet status, and a **private Contract tab**
for the aircraft utilisation addenda (owner only, behind a password).

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Website | `index.html` | Everything the browser shows. No build step. |
| Publishing | `.github/workflows/deploy-pages.yml` | A push to `main` that changes `index.html` redeploys GitHub Pages. |
| Worker | `cloudflare-worker/worker.js` | Server side: logs the weather every 30 min, saves manual checks, grounds/releases aircraft, and stores the **private contract data**. |
| Worker deploy | `.github/workflows/deploy-worker.yml` + `cloudflare-worker/wrangler.toml` | Publishes the Worker to Cloudflare from GitHub. |
| Public data | `data/*.csv` | `forecast_log.csv` (every 30 min), `manual_log.csv`, `aircraft_status.csv`. **Public** — anyone can read them. |
| Private data | Cloudflare KV (`fasx-contract`) | Contract settings, invoiced hours, day overrides. Never in the repo. |
| Tests | `tests/` | `npm test` — Worker endpoints and the contract maths. |

`scripts/log_forecast.py` is a legacy GitHub-Actions logger that is no longer used (the Worker
does this now).

## Working on it (phone friendly)

1. Changes are made on a branch and opened as a pull request.
2. Merging the PR into `main` publishes the website (about a minute).
3. To undo a change, use **Revert** on the merged PR.

## The Contract tab (owner only)

Open **Info → Owner login** and enter the same password used to ground/release aircraft. Without
it the tab does not exist, and the figures are not in the page or the repo — the server checks
the password on every request (and locks an IP out for 15 minutes after 6 wrong attempts).

What it calculates, per aircraft, following the signed addenda:

- **Adjusted monthly baseline** = `40 × available days ÷ days in month`, rounded **down** to 0.1 h.
  Every calendar day counts (Sundays and holidays included).
- **Unavailable days** = maintenance days (from the Fleet grounding log) + non-flying weather days
  (decided automatically from this dashboard's own logged weather) + any days you add; a day
  that is both counts once. You can override any single day.
- **3-month cycles** starting 1 November (Nov–Jan, Feb–Apr, May–Jul, Aug–Oct): surplus hours are
  credit, shortfalls roll forward as deficit, and any deficit left at the end of the cycle is billed.
- You type in each month's **invoiced hours** (and any owner-flying hours to exclude); the page
  shows the surplus/shortfall, the running balance and the cycle-end deficit with a Rand estimate.

Everything adjustable lives under **Contract → Settings** (baseline hours, cycle length and start,
the weather-day rule, release-day rule, rate for the Rand estimate, each aircraft and the date its
addendum took effect) — no code change needed. **Download backup** saves everything as JSON.

The weather-day rule is an *estimate from this dashboard's data* and is kept separate from
Heritage's booking system. The contract only recognises weather days where booked flights were
cancelled and reported, so treat the figures as a working calculation, not a legal ruling.

## Cloudflare Worker: one-time setup

The Worker needs these (Cloudflare dashboard → Worker `fasx-log` → Settings → Variables and Secrets):

| Name | Type | Notes |
|---|---|---|
| `GITHUB_TOKEN` | secret | Fine-grained PAT, this repo only, Contents: Read and write |
| `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` | vars | `JuniorJoseph1981`, `FASX-Weather`, `main` |
| `GITHUB_PATH`, `GITHUB_PATH_FORECAST` | vars | `data/manual_log.csv`, `data/forecast_log.csv` |
| `GITHUB_PATH_AIRCRAFT` | var (optional) | defaults to `data/aircraft_status.csv` |
| `ALLOWED_ORIGIN` | var | `https://juniorjoseph1981.github.io` |
| `IWEATHAR_KEY` | secret | key supplied by the club |
| `OWNER_PASSWORD` | secret | password for grounding **and** the Contract tab (`AIRCRAFT_PASSWORD` also works) |
| `FASX_KV` | KV binding | created and bound automatically by the deploy workflow |

**Deploying from GitHub:** add two repository secrets (Settings → Secrets and variables → Actions):
`CLOUDFLARE_API_TOKEN` (permissions: *Workers Scripts: Edit* and *Workers KV Storage: Edit*) and
`CLOUDFLARE_ACCOUNT_ID`. Then run **Actions → Deploy Cloudflare Worker → Run workflow**. It runs the
tests, creates the KV namespace if needed, deploys, and checks `/health`. Dashboard variables and
secrets are kept. Once a manual deploy has been verified, enable automatic deploys by un-commenting
the `push:` trigger in `deploy-worker.yml`.

`GET <worker-url>/health` reports whether storage and the owner password are configured (booleans
only, no secrets).

## Tests

```bash
npm test
```

Covers the Worker (login, lockout, validation, storage, ground/release CSV handling) and the contract
engine (baseline rounding, cycle credit/deficit, the contract's worked example, weather-day rules).

## Thresholds

The VFR limits are the `CRIT` object near the top of the script in `index.html` and in
`cloudflare-worker/worker.js` — keep the two in sync.
