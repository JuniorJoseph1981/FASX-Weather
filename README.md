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

- **Adjusted monthly baseline** = `guaranteed hours × available days ÷ days in month`, rounded
  **down** to 0.1 h (40 h today). Every calendar day counts (Sundays and holidays included).
- **Unavailable days** = maintenance days (from the Fleet grounding log) + non-flying weather days
  (decided automatically from this dashboard's own logged weather) + any days you add; a day
  that is both counts once. You can override any single day.
- **Cycles run invoice to invoice** (3 invoices by default): surplus hours are credit, shortfalls
  roll forward as deficit, and any deficit left at the end of the cycle is billed. Credit does not
  carry into the next cycle.
- You type in each month's **invoiced hours** (and any owner-flying hours to exclude); the page
  shows the surplus/shortfall, the running balance and the cycle-end deficit with a Rand estimate.

**Hours are labelled by the month they were flown.** You prepare each invoice the month after, using
the previous month's hours and flying days, and date it the last day of the month it covers. In
November you work out **October** (October's flyable/unavailable days, October's hours) and issue the
invoice **dated 31 October**; November's hours are done in December and dated 30 November. Every card
reads "October 2026 hours — invoice dated 31 October · prepared in November", and a banner at the top
opens the invoice you are due to prepare.

**Each aircraft has its own contract clock.**
- **ZS-ESE** starts with the **August 2026 hours**: its current cycle is Aug–Sep–Oct hours (invoices dated 31 Aug,
  30 Sep and 31 Oct; October is prepared in November and is the cycle's last month). Next: Nov–Jan, then Feb–Apr, …
- **ZS-JOG** is on a different cycle and starts with the **September 2026 hours**: Sep–Oct–Nov hours (invoices dated
  30 Sep, 31 Oct and 30 Nov), then Dec–Feb, Mar–May, … September and October are entered now; November is prepared in December.

The page opens on the cycle that still needs hours and a banner lists the months to work through, oldest first (each
month carries its credit or deficit into the next). A new aircraft gets its own start month, so its cycles run from its own first invoice and never roll
from a mid-month date.

Everything adjustable lives under **Contract → Settings**, no code change needed:
per aircraft — first month of hours tracked, cycle length, guaranteed hours, whether it is tracked, and the **hourly
rate (R1,800 ex VAT today)**; when prices rise, add a **price change** with the date it applies from
(a cycle is estimated at the rate in force on its last day, so old cycles never change). Also the
a multiplier on deficit hours (1, because invoiced hours already include the tacho × 1.2) and VAT for the estimate, the weather-day rule, and the release-day rule.
**Download backup** saves everything as JSON.

The weather-day rule is an *estimate from this dashboard's data* and is kept separate from
Heritage's booking system. The contract only recognises weather days where booked flights were
cancelled and reported, so treat the figures as a working calculation, not a legal ruling.

## PDF summary for the customer

**Contract → PDF** builds a printable A4 report to send with the invoices (the browser's Print → "Save as PDF").
Pick **one aircraft** (2 pages) or **all aircraft** (a summary page plus one detail page per aircraft). Each aircraft
is reported on **its own cycle**, chosen in the dialog (it defaults to the cycle being invoiced).

- **Page 1:** guaranteed vs counted hours, the month-by-month working, charts (hours against guarantee, how the
  surplus/shortfall builds up, every day of the cycle coloured available / maintenance / weather), and the cycle-end billing.
- **Page 2:** every maintenance period with the reason from the grounding log and how it returned to service; a chart of
  flyable hours per day; and every weather day with **why it was not flyable** (hours lost to low cloud, gusts,
  visibility or rain, with the worst readings and the no-fly periods). The report is a record of what happened and why; it has no sign-off section.
- Months without hours show "—". Footers say the weather is live data from the airfield (the on-site station, logged every 30 minutes; visibility is model-derived).
- The two company names and each aircraft's agreement line are editable under **Contract → Settings**.

## How much history can it hold?

- **Contract data (private, in Cloudflare KV):** a month's record is about 0.2 KB, a day override about 0.03 KB.
  Decades of history for several aircraft is well under 1 MB; the limit per stored value is 25 MB. In practice
  there is no limit to worry about.
- **Weather log (`data/forecast_log.csv`, public):** about 6.4 KB a day (~2.3 MB a year). GitHub only lets the
  Worker read files up to 1 MB the normal way, so the Worker falls back to GitHub's raw read for bigger files
  (supported up to 100 MB, i.e. decades). The practical limit is the page: it downloads the whole log on every
  visit, so it is comfortable for roughly the first 2-3 years. After that, splitting the log into one file per
  month is the next step.

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
| `AIRCRAFT_PASSWORD` | secret | already set — the same password now also unlocks the Contract tab (`OWNER_PASSWORD` works as an alternative name) |
| `FASX_KV` | KV binding | created and bound automatically by the deploy workflow |

**Deploying from GitHub (automatic):** add two repository **secrets** (Settings → Secrets and variables → Actions → *Secrets*):
`CLOUDFLARE_API_TOKEN` (a custom token with *Account → Workers Scripts: Edit* and *Account → Workers KV Storage: Edit*)
and `CLOUDFLARE_ACCOUNT_ID`. No repository *variables* are needed. After that, every merge to `main` that changes
the Worker deploys it by itself (**Actions → Deploy Cloudflare Worker**; it can also be run by hand). It runs the
tests first, so a broken Worker never goes live, then creates the KV namespace if needed, deploys, and checks
`/health` (which shows the Worker's `version`). Dashboard variables and secrets are kept.

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
