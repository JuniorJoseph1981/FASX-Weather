# FASX Flyability Dashboard — hosted setup

Everything in this folder, once pushed to a GitHub repo, gives you:

- **A live dashboard** at a public URL (works from your phone, no PC needed) —
  `index.html`, served by GitHub Pages.
- **Automated logging** every ~30 minutes, running on GitHub's servers —
  `.github/workflows/forecast-log.yml` + `scripts/log_forecast.py`, writing to
  `data/forecast_log.csv`. It pulls **actual wind/temp/dew point from the
  on-site iWeathar station** (1945, Swellengrebel Airfield) when the station
  is online, and always pulls forecast data (visibility, ceiling estimate,
  precipitation) from Open-Meteo alongside it — the station doesn't measure
  visibility or cloud base, so those stay model-derived either way.
- **Manual checks that save themselves permanently** — `cloudflare-worker/worker.js`
  is a small server-side function that writes each "Log a check" entry
  straight into `data/manual_log.csv` in this repo, the moment you hit save.
  The GitHub token it needs lives only on Cloudflare, never in the page you
  or anyone else can view the source of.

Webcam checks stay manual (see the "Field webcam" link in the dashboard) —
FASX's own site explicitly disclaims the timestamp/heading on those photos
for aviation use, so there's no reliable way to automate that one usefully.

## Setup (10 minutes, one-time)

1. **Create a new repo** on GitHub — e.g. `fasx-weather`. Public or private
   both work; Pages is free either way on a personal account.

2. **Upload these files**, keeping the folder structure exactly as-is:
   ```
   index.html
   data/forecast_log.csv
   scripts/log_forecast.py
   .github/workflows/forecast-log.yml
   ```
   Easiest way: on the repo's GitHub page, use "Add file → Upload files" and
   drag the whole folder in, or use `git` locally if you're comfortable with it.

3. **Turn on write permission for Actions** (needed so the workflow can commit
   the updated log back to the repo):
   Repo → Settings → Actions → General → "Workflow permissions" →
   select **Read and write permissions** → Save.

4. **Add the iWeathar key as a secret** (keeps it out of the code entirely):
   Repo → Settings → Secrets and variables → Actions → "New repository secret" →
   Name: `IWEATHAR_KEY`, Value: the key Russell gave you → Add secret.
   If this is skipped, the automation still runs fine on forecast data alone —
   it just won't have the actual station readings.

5. **Turn on GitHub Pages**:
   Repo → Settings → Pages → under "Build and deployment", set
   Source = **Deploy from a branch**, Branch = **main**, folder = **/ (root)** → Save.
   GitHub will give you a URL like `https://<your-username>.github.io/fasx-weather/`
   within a minute or two — that's your permanent dashboard link.

6. **Kick off the first log entry manually** (don't wait for the schedule):
   Repo → Actions tab → "FASX forecast log" workflow → "Run workflow" button →
   Run workflow. After it finishes (~20 seconds), `data/forecast_log.csv` will
   have its first real row — check the "VerdictSource" column says `station`
   to confirm the key worked.

7. **Wire the dashboard to your log** — open `index.html` in the repo (use
   GitHub's "Edit" pencil icon), find this line near the top of the `<script>`:
   ```js
   const HISTORY_CSV_URL = "";
   ```
   and set it to your repo's raw file URL:
   ```js
   const HISTORY_CSV_URL = "https://raw.githubusercontent.com/<your-username>/fasx-weather/main/data/forecast_log.csv";
   ```
   Commit that change. Reload your Pages URL — you'll now see an "Automated
   forecast & station history" table on the dashboard, populated every ~30 minutes
   from then on, with a "source" column showing whether each row used the
   actual station or fell back to forecast (e.g. if the station was briefly
   offline).

## Making manual checks save themselves (Cloudflare Worker)

This part makes the "Log a check" form in the dashboard write directly into
your GitHub repo the instant you hit save — no download/paste needed, and it
works even if you close the tab immediately after.

1. **Create a fine-grained GitHub token, scoped to just this repo:**
   GitHub → your profile photo → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token.
   - Resource owner: you
   - Repository access: **Only select repositories** → pick this repo
   - Permissions → Repository permissions → **Contents: Read and write**
     (leave everything else as "No access")
   - Generate, and copy the token somewhere safe — GitHub only shows it once.

2. **Create a free Cloudflare account** at cloudflare.com if you don't have
   one (email + password, no card needed for this).

3. **Create the Worker:**
   Cloudflare dashboard → Workers & Pages → Create → **Create Worker** →
   give it a name (e.g. `fasx-log`) → Deploy (with the default placeholder
   code, you'll replace it next) → **Edit code**.
   Delete everything in the editor and paste in the contents of
   `cloudflare-worker/worker.js` from this folder → **Deploy**.

4. **Set the Worker's variables and secret:**
   Worker page → Settings → Variables and Secrets → Add:
   - `GITHUB_OWNER` (variable) → your GitHub username
   - `GITHUB_REPO` (variable) → your repo name, e.g. `fasx-weather`
   - `GITHUB_BRANCH` (variable) → `main`
   - `GITHUB_PATH` (variable) → `data/manual_log.csv`
   - `ALLOWED_ORIGIN` (variable) → your Pages URL, e.g.
     `https://<your-username>.github.io` (use `*` temporarily while testing
     if you hit CORS issues, then tighten it once it's working)
   - `GITHUB_TOKEN` (**secret** — use the "Encrypt" / secret option, not a
     plain variable) → paste the token from step 1
   Save/Deploy after adding these.

5. **Copy the Worker's URL** — shown at the top of the Worker's page, looks
   like `https://fasx-log.<your-cloudflare-subdomain>.workers.dev`.

6. **Wire it into the dashboard** — open `index.html` in the repo, find:
   ```js
   const WORKER_URL = "";
   const MANUAL_LOG_CSV_URL = "";
   ```
   and set both:
   ```js
   const WORKER_URL = "https://fasx-log.<your-cloudflare-subdomain>.workers.dev";
   const MANUAL_LOG_CSV_URL = "https://raw.githubusercontent.com/<your-username>/fasx-weather/main/data/manual_log.csv";
   ```
   Commit. Reload the dashboard, log a test check, and confirm you don't get
   the "GitHub sync failed" alert. Check the repo — `data/manual_log.csv`
   should appear with your entry in it within a few seconds.

## Notes

- GitHub's free `schedule` cron is best-effort — entries land roughly every
  30 minutes but can occasionally slip by 5–10 minutes during busy periods.
  That's fine for a conditions trend log; it's not meant to replace the
  on-demand "refresh" button for anything time-critical. If your repo is
  private, this uses about 1,440 of your 2,000 free monthly Actions minutes —
  public repos have no such limit.
- Your manually logged checks (the "Log a check" form) sync straight to
  `data/manual_log.csv` once `WORKER_URL` is set — they no longer depend on
  the browser or Claude's storage to survive. If `WORKER_URL` is left blank,
  it falls back to Claude's own session storage as before.
- The GitHub token used by the Worker is scoped to **only this repo, only
  Contents: Read and write** — worst case if it ever leaked is someone
  writing junk rows into your two CSV files, nothing more. It's never sent
  to or visible from the dashboard page itself.
- To change the check schedule or VFR thresholds, edit the `CRIT` object near
  the top of `index.html`'s script (dashboard) and `scripts/log_forecast.py`
  (automated log) — keep both in sync if you adjust limits.
