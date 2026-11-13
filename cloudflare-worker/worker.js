// FASX dashboard — Cloudflare Worker
//
// Jobs in one Worker:
//   1. scheduled()  — Cron Trigger every 30 minutes: fetches the Open-Meteo forecast and the
//                     live iWeathar station reading, computes a verdict and appends a row to
//                     data/forecast_log.csv.
//   2. Public routes (no password):
//        GET  /live-station   fresh on-site station reading
//        GET  /health         deployment check (booleans only, no secrets)
//        POST /               one manually logged weather check -> data/manual_log.csv
//   3. Owner routes (password in the JSON body, checked on EVERY request):
//        POST /aircraft-ground, /aircraft-unground   update data/aircraft_status.csv
//        POST /owner/login | /owner/state            unlock / read the private contract data
//        POST /owner/save-month | /owner/override | /owner/settings   change it
//      The private contract data (settings, invoiced hours, day overrides) is stored in
//      Workers KV (binding FASX_KV) — it is NEVER written to the public GitHub repo.
//
// Secrets and variables never appear in the public dashboard page or the repo.
//
// Environment (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets,
// or set automatically by the deploy workflow where noted):
//   GITHUB_TOKEN         (secret)  fine-grained PAT, Contents: Read and write, this repo only
//   GITHUB_OWNER         (var)     your GitHub username
//   GITHUB_REPO          (var)     the repo name, e.g. FASX-Weather
//   GITHUB_BRANCH        (var)     usually "main"
//   GITHUB_PATH          (var)     usually "data/manual_log.csv"
//   GITHUB_PATH_FORECAST (var)     usually "data/forecast_log.csv"
//   GITHUB_PATH_AIRCRAFT (var)     optional, default "data/aircraft_status.csv"
//   ALLOWED_ORIGIN       (var)     your GitHub Pages origin, e.g. https://yourname.github.io
//   IWEATHAR_KEY         (secret)  the key Russell provided
//   AIRCRAFT_PASSWORD    (secret)  the password for grounding aircraft AND the Contract tab
//                                  (the existing secret; OWNER_PASSWORD is accepted as an alternative name)
//   FASX_KV              (KV binding) storage for the private contract data

const WORKER_VERSION = "2026-11-13-jog-sep";
const LAT = -34.0482, LON = 20.4746, TZ_OFFSET = "+02:00"; // Africa/Johannesburg, fixed UTC+2, no DST
const IWEATHAR_STATION_NAME = "Swellengrebel Airfield";

const CRIT = {
  windCaution: 15, windNoFly: 25,
  ceilCaution: 1500, ceilNoFly: 1000,
  visCaution: 8, visNoFly: 5,
};

const MAX_PASSWORD_FAILS = 6;        // per IP ...
const LOCKOUT_SECONDS = 900;         // ... within this window

// Defaults for the contract maths. Everything here can be changed from the dashboard's
// Contract -> Settings screen; the dashboard never needs a code change for these.
//
// Each aircraft has its OWN contract clock, so a new aircraft can start whenever its first
// invoice period begins:
//   startMonth      first month of HOURS that counts ("YYYY-MM"); its invoice is issued the following month
//                   (October hours arrive on the November invoice). Cycles run invoice-to-invoice from it
//   cycleMonths     length of one cycle (3 = quarterly)
//   baselineHours   guaranteed billed hours per month
//   rates           hourly price history [{from, perHour}] (ex VAT); the rate in force on the last day
//                   of a cycle is used for the cycle-end estimate, so a price rise never changes old cycles
const DEFAULT_START_MONTH = "2026-08";   // ZS-ESE: its current cycle (Aug-Oct hours) ends with October, invoiced in November
const JOG_START_MONTH = "2026-09";       // ZS-JOG is on a different cycle: Sep-Nov hours, then Dec-Feb, ...
const DEFAULT_SETTINGS = {
  billing: { multiplier: 1, vatPercent: 15 },      // multiplier on deficit hours; 1 because invoiced hours already include the tacho x 1.2
  weatherRule: {
    enabled: true,
    windowStart: "07:00",                          // daylight window the logged checks are judged over
    windowEnd: "18:00",
    minFlyableHours: 4,                            // fewer flyable hours than this = non-flying (weather) day
    cautionCountsAsFlyable: true,
  },
  releaseDayCountsAsUnavailable: false,            // is the day an aircraft is released still "unavailable"?
  report: { lessor: "VMC Aviation (Pty) Ltd", lessee: "Heritage Aviation (Pty) Ltd" },   // names on the printed PDF
  aircraft: {
    "ZS-ESE": { label: "Siai-Marchetti S205", agreement: "Aircraft Utilization Agreement 12 December 2025 \u00b7 Addendum No. 1", startMonth: DEFAULT_START_MONTH, cycleMonths: 3, baselineHours: 40, rates: [{ from: DEFAULT_START_MONTH + "-01", perHour: 1800 }], enabled: true },
    "ZS-JOG": { label: "Cessna 172N", agreement: "Aircraft Utilization Agreement 18 July 2025 \u00b7 Addendum 23 October 2025 \u00b7 Addendum No. 2", startMonth: JOG_START_MONTH, cycleMonths: 3, baselineHours: 40, rates: [{ from: JOG_START_MONTH + "-01", perHour: 1800 }], enabled: true },
  },
};

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/live-station") {
        try {
          const station = await fetchIweatharStation(env.IWEATHAR_KEY);
          return json(station || { status: "UNREACHABLE" }, 200, corsHeaders);
        } catch (e) {
          return json({ status: "ERROR", error: e.message }, 500, corsHeaders);
        }
      }

      if (request.method === "GET" && path === "/health") {
        return json({
          ok: true, version: WORKER_VERSION,
          storage: !!env.FASX_KV, ownerPasswordSet: !!getOwnerPassword(env),
          github: !!(env.GITHUB_OWNER && env.GITHUB_REPO && env.GITHUB_TOKEN),
        }, 200, corsHeaders);
      }

      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, corsHeaders);

      if (path === "/aircraft-ground" || path === "/aircraft-unground" || path.startsWith("/owner/")) {
        return await handleOwner(path, request, env, corsHeaders);
      }
      return await handleManualLog(request, env, corsHeaders);
    } catch (e) {
      return json({ error: e.message || "Server error", detail: e.detail || "" }, e.status || 500, corsHeaders);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runAutomatedLog(env));
  },
};

// ---------------------------------------------------------------- public: manual weather check

async function handleManualLog(request, env, corsHeaders) {
  let entry;
  try { entry = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, 400, corsHeaders); }

  const required = ["dateStr", "time", "windDir", "windSpeed", "gust", "visKm", "precip"];
  for (const key of required) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === "") {
      return json({ error: `Missing field: ${key}` }, 400, corsHeaders);
    }
  }

  const path = env.GITHUB_PATH || "data/manual_log.csv";
  const header = "Date,Time,Observer,WindDir,WindSpeed,Gust,Visibility,Ceiling,Precipitation,WebcamChecked,WebcamNote,StationChecked,StationNote\n";
  const row = [
    entry.dateStr, entry.time, csvSafe(entry.observer || ""),
    entry.windDir, entry.windSpeed, entry.gust, entry.visKm,
    entry.ceilingFt === null || entry.ceilingFt === undefined ? "" : entry.ceilingFt,
    entry.precip,
    entry.webcamChecked ? "yes" : "no", csvSafe(entry.webcamNote || ""),
    entry.stationChecked ? "yes" : "no", csvSafe(entry.stationNote || ""),
  ].join(",") + "\n";

  try {
    await appendToGithubCsv(env, path, header, row, `Log manual check ${entry.dateStr} ${entry.time}`);
    return json({ ok: true }, 200, corsHeaders);
  } catch (e) {
    return json({ error: e.message, status: e.status || 500, detail: e.detail || "" }, e.status || 500, corsHeaders);
  }
}

// ---------------------------------------------------------------- owner (password) routes

function getOwnerPassword(env) {
  return env.AIRCRAFT_PASSWORD || env.OWNER_PASSWORD || "";
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)));
}

// Constant-time comparison (of the hashes, so length differences leak nothing).
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Returns null when the password is right, otherwise a ready-made error Response.
async function checkOwner(request, env, body, corsHeaders) {
  const expected = getOwnerPassword(env);
  if (!expected) return json({ error: "Owner password is not configured on the server" }, 503, corsHeaders);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const lockKey = "lock:" + ip;
  let fails = 0;
  if (env.FASX_KV) {
    fails = parseInt((await env.FASX_KV.get(lockKey)) || "0", 10) || 0;
    if (fails >= MAX_PASSWORD_FAILS) {
      return json({ error: "Too many wrong passwords. Try again in 15 minutes." }, 429, corsHeaders);
    }
  }

  const supplied = typeof body.password === "string" ? body.password : "";
  if (!(await safeEqual(supplied, expected))) {
    if (env.FASX_KV) await env.FASX_KV.put(lockKey, String(fails + 1), { expirationTtl: LOCKOUT_SECONDS });
    return json({ error: "Incorrect password" }, 401, corsHeaders);
  }
  if (env.FASX_KV && fails > 0) await env.FASX_KV.delete(lockKey);
  return null;
}

async function handleOwner(path, request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, 400, corsHeaders); }
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400, corsHeaders);

  const denied = await checkOwner(request, env, body, corsHeaders);
  if (denied) return denied;

  if (path === "/owner/login") return json({ ok: true }, 200, corsHeaders);

  if (path === "/aircraft-ground" || path === "/aircraft-unground") {
    return handleAircraft(path === "/aircraft-ground", body, env, corsHeaders);
  }

  if (!env.FASX_KV) {
    return json({ error: "Storage (KV binding FASX_KV) is not configured on the server" }, 503, corsHeaders);
  }

  const contract = await loadContract(env);
  const err = (msg, status = 400) => json({ error: msg }, status, corsHeaders);
  const regs = Object.keys(contract.settings.aircraft);

  if (path === "/owner/state") {
    return json({ ok: true, data: contract }, 200, corsHeaders);
  }

  if (path === "/owner/settings") {
    contract.settings = sanitizeSettings(body.settings, contract.settings);
    contract.settingsSaved = true;
    await saveContract(env, contract);
    return json({ ok: true, data: contract }, 200, corsHeaders);
  }

  if (path === "/owner/save-month") {
    const reg = String(body.aircraft || "");
    const month = String(body.month || "");
    if (!regs.includes(reg)) return err("Unknown aircraft");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return err("Month must look like 2026-11");
    const key = `${reg}|${month}`;
    if (body.invoicedHours === null || body.invoicedHours === "") {
      delete contract.months[key];                       // clearing a month
    } else {
      const inv = Number(body.invoicedHours);
      const own = body.ownerHours === null || body.ownerHours === undefined || body.ownerHours === "" ? 0 : Number(body.ownerHours);
      if (!Number.isFinite(inv) || inv < 0 || inv > 744) return err("Invoiced hours must be between 0 and 744");
      if (!Number.isFinite(own) || own < 0 || own > inv) return err("Owner-flying hours must be between 0 and the invoiced hours");
      contract.months[key] = {
        invoicedHours: round2(inv), ownerHours: round2(own),
        note: String(body.note || "").slice(0, 300), updatedAt: new Date().toISOString(),
      };
    }
    await saveContract(env, contract);
    return json({ ok: true, data: contract }, 200, corsHeaders);
  }

  if (path === "/owner/override") {
    const reg = String(body.aircraft || "");
    const date = String(body.date || "");
    const status = body.status;
    if (!regs.includes(reg)) return err("Unknown aircraft");
    if (!isIsoDate(date)) return err("Date must look like 2026-11-05");
    if (status !== null && status !== "unavailable" && status !== "available") {
      return err("Status must be 'unavailable', 'available' or null");
    }
    contract.overrides[reg] = contract.overrides[reg] || {};
    if (status === null) delete contract.overrides[reg][date];
    else contract.overrides[reg][date] = status;
    if (Object.keys(contract.overrides[reg]).length === 0) delete contract.overrides[reg];
    await saveContract(env, contract);
    return json({ ok: true, data: contract }, 200, corsHeaders);
  }

  return json({ error: "Not found" }, 404, corsHeaders);
}

// ---------------------------------------------------------------- aircraft grounding (GitHub CSV)

const AIRCRAFT_HEADER = "Registration,GroundedDate,GroundedNote,UngroundedDate,UngroundedNote,LoggedAt";

async function handleAircraft(isGround, body, env, corsHeaders) {
  const reg = String(body.registration || "").toUpperCase();
  const date = String(body.date || "");
  const note = String(body.note || "").slice(0, 200);
  if (!/^[A-Z0-9-]{3,10}$/.test(reg)) return json({ error: "Invalid registration" }, 400, corsHeaders);
  if (!isIsoDate(date)) return json({ error: "Invalid date" }, 400, corsHeaders);

  const path = env.GITHUB_PATH_AIRCRAFT || "data/aircraft_status.csv";
  const loggedAt = nowSastString();
  let conflict = null;

  try {
    await updateGithubFile(env, path, (existing) => {
      const lines = (existing || AIRCRAFT_HEADER + "\n").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
      if (lines[0] !== AIRCRAFT_HEADER) lines.unshift(AIRCRAFT_HEADER);
      const rows = lines.slice(1).map(parseCsvLine);
      let openIdx = -1;
      rows.forEach((r, i) => { if (r[0] === reg && !r[3]) openIdx = i; });

      if (isGround) {
        if (openIdx !== -1) { conflict = `${reg} is already grounded`; return null; }
        rows.push([reg, date, note, "", "", loggedAt]);
      } else {
        if (openIdx === -1) { conflict = `${reg} is not currently grounded`; return null; }
        if (date < rows[openIdx][1]) { conflict = "Serviceable date is before the grounded date"; return null; }
        rows[openIdx][3] = date;
        rows[openIdx][4] = note;
      }
      return [AIRCRAFT_HEADER, ...rows.map((r) => r.map(csvSafe).join(","))].join("\n") + "\n";
    }, `${isGround ? "Ground" : "Unground"} ${reg} ${isGround ? "from" : "on"} ${date}`);
  } catch (e) {
    return json({ error: e.message, detail: e.detail || "" }, e.status || 500, corsHeaders);
  }
  if (conflict) return json({ error: conflict }, 409, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------- contract storage + validation

function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function round2(v) { return Math.round(v * 100) / 100; }
function clampNum(v, def, min, max) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}
function hhmm(v, def) { return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : def; }

function isYearMonth(v) { return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v); }

function sanitizeRates(input, prev, startMonth) {
  const src = Array.isArray(input) ? input : (Array.isArray(prev) ? prev : []);
  const byDate = new Map();
  for (const r of src.slice(0, 40)) {
    if (!r || !isIsoDate(r.from)) continue;
    const perHour = Number(r.perHour);
    if (!Number.isFinite(perHour) || perHour < 0 || perHour > 100000) continue;
    byDate.set(r.from, { from: r.from, perHour: round2(perHour) });
  }
  const out = [...byDate.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
  return out.length ? out : [{ from: startMonth + "-01", perHour: 1800 }];
}

function sanitizeAircraftEntry(a, prev) {
  const x = a && typeof a === "object" ? a : {};
  const p = prev || {};
  const startMonth = isYearMonth(x.startMonth) ? x.startMonth : (isYearMonth(p.startMonth) ? p.startMonth : DEFAULT_START_MONTH);
  return {
    label: String(x.label !== undefined ? x.label : (p.label || "")).slice(0, 60),
    agreement: String(x.agreement !== undefined ? x.agreement : (p.agreement || "")).slice(0, 140),
    startMonth,
    cycleMonths: Math.round(clampNum(x.cycleMonths, p.cycleMonths || 3, 1, 12)),
    baselineHours: clampNum(x.baselineHours, p.baselineHours !== undefined ? p.baselineHours : 40, 0, 744),
    rates: sanitizeRates(x.rates, p.rates, startMonth),
    enabled: typeof x.enabled === "boolean" ? x.enabled : (p.enabled !== false),
  };
}

// Merge `input` over `base`, keeping only known keys with valid values.
function sanitizeSettings(input, base) {
  const b = base || DEFAULT_SETTINGS;
  const i = input && typeof input === "object" ? input : {};
  const bill = i.billing && typeof i.billing === "object" ? i.billing : {};
  const wr = i.weatherRule && typeof i.weatherRule === "object" ? i.weatherRule : {};
  const out = {
    billing: {
      multiplier: clampNum(bill.multiplier, b.billing.multiplier, 0, 100),
      vatPercent: clampNum(bill.vatPercent, b.billing.vatPercent, 0, 100),
    },
    weatherRule: {
      enabled: typeof wr.enabled === "boolean" ? wr.enabled : b.weatherRule.enabled,
      windowStart: hhmm(wr.windowStart, b.weatherRule.windowStart),
      windowEnd: hhmm(wr.windowEnd, b.weatherRule.windowEnd),
      minFlyableHours: clampNum(wr.minFlyableHours, b.weatherRule.minFlyableHours, 0, 24),
      cautionCountsAsFlyable: typeof wr.cautionCountsAsFlyable === "boolean" ? wr.cautionCountsAsFlyable : b.weatherRule.cautionCountsAsFlyable,
    },
    releaseDayCountsAsUnavailable: typeof i.releaseDayCountsAsUnavailable === "boolean" ? i.releaseDayCountsAsUnavailable : b.releaseDayCountsAsUnavailable,
    report: {
      lessor: String(i.report && i.report.lessor !== undefined ? i.report.lessor : b.report.lessor).slice(0, 80),
      lessee: String(i.report && i.report.lessee !== undefined ? i.report.lessee : b.report.lessee).slice(0, 80),
    },
    aircraft: {},
  };
  if (out.weatherRule.windowEnd <= out.weatherRule.windowStart) {
    out.weatherRule.windowStart = b.weatherRule.windowStart;
    out.weatherRule.windowEnd = b.weatherRule.windowEnd;
  }
  // Aircraft already known are kept (an update only changes the ones it mentions); stop tracking one
  // with enabled:false rather than deleting it, so its invoices and history stay intact.
  const inAc = i.aircraft && typeof i.aircraft === "object" ? i.aircraft : {};
  const regs = [...new Set([...Object.keys(b.aircraft), ...Object.keys(inAc)])].slice(0, 20);
  for (const reg of regs) {
    if (!/^[A-Z0-9-]{3,10}$/.test(reg)) continue;
    out.aircraft[reg] = sanitizeAircraftEntry(inAc[reg], b.aircraft[reg]);
  }
  if (Object.keys(out.aircraft).length === 0) out.aircraft = JSON.parse(JSON.stringify(b.aircraft));
  return out;
}

function normalizeContract(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  // Stored settings only count once they were saved explicitly from the Settings screen. Before that they are
  // just a copy of whatever the defaults were when an invoice or day override was saved, so the current
  // defaults are used instead (this is how a change of default reaches settings nobody has touched).
  const settingsSaved = c.settingsSaved === true;
  return {
    version: 1,
    settingsSaved,
    settings: sanitizeSettings(settingsSaved ? c.settings : null, DEFAULT_SETTINGS),
    months: c.months && typeof c.months === "object" ? c.months : {},
    overrides: c.overrides && typeof c.overrides === "object" ? c.overrides : {},
    updatedAt: c.updatedAt || null,
  };
}

async function loadContract(env) {
  return normalizeContract(await env.FASX_KV.get("contract", "json"));
}

async function saveContract(env, contract) {
  const prev = await env.FASX_KV.get("contract");
  if (prev) await env.FASX_KV.put("contract:prev", prev);        // one-step undo / backup
  contract.updatedAt = new Date().toISOString();
  await env.FASX_KV.put("contract", JSON.stringify(contract));
}

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  while (out.length < 6) out.push("");
  return out;
}

// ---------------------------------------------------------------- automated weather log (unchanged)
async function runAutomatedLog(env) {
  try {
    const forecast = await fetchForecast();
    const times = forecast.hourly.time;
    const nowMs = Date.now();
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(Date.parse(times[i] + TZ_OFFSET) - nowMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }

    const h = forecast.hourly;
    const fcWindDir = Math.round(h.wind_direction_10m[bestIdx]);
    const fcWindSpeed = Math.round(h.wind_speed_10m[bestIdx]);
    const fcGust = Math.round(h.wind_gusts_10m[bestIdx]);
    const fcVisKm = Math.round((h.visibility[bestIdx] / 1000) * 10) / 10;
    const fcPrecip = precipCategory(h.precipitation[bestIdx]);
    const fcCloud = h.cloud_cover[bestIdx];
    const fcTemp = h.temperature_2m[bestIdx];
    const fcDew = h.dew_point_2m[bestIdx];
    const fcCeiling = estimateCeiling(fcTemp, fcDew, fcCloud);

    const station = await fetchIweatharStation(env.IWEATHAR_KEY);

    let verdict, verdictSource, stCeiling = null, stPrecip = null;
    if (station && station.status === "ON-LINE") {
      stCeiling = station.stationCeilingFt !== null ? station.stationCeilingFt : estimateCeiling(station.tempC, station.dewpointC, fcCloud);
      stPrecip = precipCategory(station.rainRateMmHr);
      verdict = verdictFor(station.windGustKt, stCeiling, fcVisKm, stPrecip);
      verdictSource = "station";
    } else {
      verdict = verdictFor(fcGust, fcCeiling, fcVisKm, fcPrecip);
      verdictSource = "forecast";
    }

    const row = [
      nowSastString(),
      fcWindDir, fcWindSpeed, fcGust, fcVisKm,
      fcCeiling === null ? "" : fcCeiling, fcPrecip,
      round1(fcTemp), round1(fcDew), fcCloud,
      station ? station.status : "UNREACHABLE",
      station ? station.dirCompass : "",
      station ? station.windAvgKt : "",
      station ? station.windGustKt : "",
      station ? station.tempC : "",
      station ? station.dewpointC : "",
      station ? station.pressureHpa : "",
      station ? station.rainTodayMm : "",
      station ? station.rainRateMmHr : "",
      stCeiling === null ? "" : stCeiling,
      stPrecip === null ? "" : stPrecip,
      station ? station.stationTime : "",
      verdict, verdictSource,
    ].join(",") + "\n";

    const header = "LocalTime,Fc_WindDir,Fc_WindSpeed_kt,Fc_Gust_kt,Fc_Visibility_km,Fc_CeilingEst_ft,Fc_Precip,Fc_Temp_C,Fc_Dew_C,Fc_Cloud_pct,St_Status,St_WindDir,St_WindAvg_kt,St_WindGust_kt,St_Temp_C,St_Dew_C,St_Pressure_hPa,St_RainToday_mm,St_RainRate_mm_hr,St_CeilingEst_ft,St_Precip,St_Time,Verdict,VerdictSource\n";

    const path = env.GITHUB_PATH_FORECAST || "data/forecast_log.csv";
    const localTime = nowSastString();
    await appendToGithubCsv(env, path, header, row, `Log forecast ${localTime} (${verdictSource})`);
    console.log(`Logged ${localTime}: ${verdict} (source: ${verdictSource})`);
  } catch (e) {
    console.log(`Scheduled run failed: ${e.message} ${e.detail || ""}`);
  }
}

async function fetchForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,dew_point_2m,precipitation,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility` +
    `&wind_speed_unit=kn&timezone=Africa%2FJohannesburg&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  return res.json();
}

function kmhToKt(v) { return v * 0.539957; }

async function fetchIweatharStation(key) {
  if (!key) { console.log("IWEATHAR_KEY not set, skipping station fetch"); return null; }
  const url = `http://www.iweathar.co.za/live_data.php?key=${key}&unit=kmh`;
  let raw;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    });
    raw = await res.text();
  } catch (e) {
    console.log(`iWeathar fetch failed: ${e.message}`);
    return null;
  }

  const locTag = `<LOCATION>${IWEATHAR_STATION_NAME}</LOCATION>`;
  const locIdx = raw.indexOf(locTag);
  if (locIdx === -1) {
    console.log("Swellengrebel Airfield not found in iWeathar feed");
    return null;
  }
  const itemStart = raw.lastIndexOf("<ITEM>", locIdx);
  const itemEndTag = raw.indexOf("</ITEM>", locIdx);
  if (itemStart === -1 || itemEndTag === -1) {
    console.log("Could not isolate ITEM block for station");
    return null;
  }
  const itemXml = raw.slice(itemStart, itemEndTag + "</ITEM>".length);

  const tag = (name) => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(itemXml);
    return m ? m[1].trim() : "";
  };

  const status = tag("STATUS");
  if (status !== "ON-LINE") {
    console.log(`iWeathar station status not ON-LINE, got: ${JSON.stringify(status)}`);
    return { status };
  }

  try {
    const windAvgKmh = parseFloat(tag("WIND_AVG"));
    const windGustKmh = parseFloat(tag("WIND_MAX"));
    const dirCompass = tag("WIND_DIR");
    const rainRateTxt = tag("RAIN_RATE_MM_HR");
    const rainRateMmHr = rainRateTxt ? parseFloat(rainRateTxt) : 0;
    const rainTodayMm = parseFloat(tag("RAINFALL_MM") || "0");
    const tempC = parseFloat(tag("TEMPERATURE_C"));
    const dewpointC = parseFloat(tag("DEWPOINT_C"));
    const pressureHpa = parseFloat(tag("PRESSURE_MB"));
    const aslFt = parseFloat(tag("ASL_FEET") || "0");
    const cloudHeightTxt = tag("CLOUD_HEIGHT_M");
    const cloudHeightM = cloudHeightTxt ? parseFloat(cloudHeightTxt) : null;
    const stationTime = tag("LASTUPDATE");

    let stationCeilingFt = null;
    if (cloudHeightM !== null && !isNaN(cloudHeightM)) {
      stationCeilingFt = Math.round((cloudHeightM / 0.3048) - aslFt);
    }

    // iWeathar's PRESSURE_MB is already sea-level-corrected (station software convention), so it is
    // used directly as QNH -- no additional barometric reduction, which would double-correct it.
    const qnhHpa = pressureHpa;

    return {
      status,
      windAvgKt: round1(kmhToKt(windAvgKmh)),
      windGustKt: round1(kmhToKt(windGustKmh)),
      dirCompass,
      rainTodayMm,
      rainRateMmHr,
      tempC,
      dewpointC,
      pressureHpa,
      aslFt,
      qnhHpa,
      stationCeilingFt,
      stationTime,
    };
  } catch (e) {
    console.log(`iWeathar field parse failed: ${e.message}`);
    return null;
  }
}

function round1(v) { return Math.round(v * 10) / 10; }

// Actual current time as Africa/Johannesburg wall-clock (fixed UTC+2, no DST), to the minute. Used for
// log rows so two 30-minute-apart entries within the same hour never collapse into one label.
function nowSastString() {
  return new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 16);
}

function precipCategory(mmPerHr) {
  if (mmPerHr >= 7.6) return "Heavy";
  if (mmPerHr >= 2.5) return "Moderate";
  if (mmPerHr >= 0.1) return "Light";
  return "None";
}

function estimateCeiling(tempC, dewC, cloudPct) {
  if (cloudPct < 25) return null;
  return Math.round(Math.max(0, (tempC - dewC) * 400) / 50) * 50;
}

function verdictFor(gust, ceilingFt, visKm, precip) {
  const noFly = gust > CRIT.windNoFly ||
    (ceilingFt !== null && ceilingFt < CRIT.ceilNoFly) ||
    visKm < CRIT.visNoFly ||
    precip === "Moderate" || precip === "Heavy";
  const caution = gust > CRIT.windCaution ||
    (ceilingFt !== null && ceilingFt < CRIT.ceilCaution) ||
    visKm < CRIT.visCaution ||
    precip === "Light";
  if (noFly) return "NO-FLY";
  if (caution) return "CAUTION";
  return "FLYABLE";
}

// --- Shared GitHub read-modify-write helpers ---

function ghConfig(env) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO, token = env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    const err = new Error("Worker not configured — missing GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN");
    err.status = 500;
    throw err;
  }
  return {
    branch: env.GITHUB_BRANCH || "main",
    apiBase: (path) => `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "fasx-dashboard-worker",
    },
  };
}

// Read a file's text and sha, or null if it does not exist yet.
// GitHub's normal JSON read only works up to 1 MB. The weather log grows ~6 KB a day, so past ~1 MB the
// JSON read is refused (403 "too_large") and logging would silently stop. For bigger files (up to 100 MB)
// fall back to the directory listing (which still gives the sha) plus the raw media type.
async function readGithubFile(cfg, path) {
  const apiBase = cfg.apiBase(path);
  const res = await fetch(`${apiBase}?ref=${cfg.branch}`, { headers: cfg.headers });
  if (res.status === 404) return null;
  let tooLarge = res.status === 403;
  if (res.status === 200) {
    const data = await res.json();
    if (data.encoding !== "none" && typeof data.content === "string") {
      return { sha: data.sha, text: b64DecodeUtf8(data.content) };
    }
    tooLarge = true;                                   // 200 with empty content = too large for the JSON read
  }
  if (!tooLarge) {
    const err = new Error("GitHub read failed");
    err.status = 502; err.detail = await res.text();
    throw err;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const listRes = await fetch(`${cfg.apiBase(dir)}?ref=${cfg.branch}`, { headers: cfg.headers });
  const list = listRes.ok ? await listRes.json() : null;
  const entry = Array.isArray(list) ? list.find((e) => e.name === name && e.type === "file") : null;
  if (!entry) {
    const err = new Error("GitHub read failed (large file: could not find it in the directory listing)");
    err.status = 502; err.detail = listRes.ok ? "" : await listRes.text();
    throw err;
  }
  const rawRes = await fetch(`${apiBase}?ref=${cfg.branch}`, { headers: { ...cfg.headers, Accept: "application/vnd.github.raw+json" } });
  if (!rawRes.ok) {
    const err = new Error("GitHub read failed (large file)");
    err.status = 502; err.detail = await rawRes.text();
    throw err;
  }
  return { sha: entry.sha, text: await rawRes.text() };
}

// Read a file, let `mutate(existingText|"")` return the new text (or null to cancel), write it back.
async function updateGithubFile(env, path, mutate, commitMessage) {
  const cfg = ghConfig(env);
  const existing = await readGithubFile(cfg, path);
  const newContent = mutate(existing ? existing.text : "");
  if (newContent === null) return false;

  const putBody = { message: commitMessage, content: b64EncodeUtf8(newContent), branch: cfg.branch };
  if (existing) putBody.sha = existing.sha;

  const putRes = await fetch(cfg.apiBase(path), {
    method: "PUT",
    headers: { ...cfg.headers, "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    const err = new Error("GitHub write failed");
    err.status = 502; err.detail = errText;
    throw err;
  }
  return true;
}

async function appendToGithubCsv(env, path, header, row, commitMessage) {
  await updateGithubFile(env, path, (existing) => (existing ? existing + row : header + row), commitMessage);
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function csvSafe(s) {
  const str = String(s);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}
