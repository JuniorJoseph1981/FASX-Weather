// Tests for cloudflare-worker/worker.js — run with:  node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/worker.js";

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.has(k) ? this.m.get(k) : null; return type === "json" && v !== null ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}

// In-memory stand-in for the GitHub "contents" API, including its 1 MB rule: files over 1 MB cannot be read as JSON
// (403 too_large) - only via the raw media type - but directory listings still return each file's sha.
function installGithub(files) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname !== "api.github.com") throw new Error("unexpected fetch " + url);
    const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\/?/, "");
    const accept = (opts.headers && opts.headers.Accept) || "";
    if ((opts.method || "GET") === "GET") {
      if (files.has(path)) {
        const f = files.get(path);
        if (accept.includes("raw")) return new Response(f.text);
        if (f.text.length > 1000000) return new Response(JSON.stringify({ message: "too large", errors: [{ code: "too_large" }] }), { status: 403 });
        return Response.json({ sha: "sha-" + f.v, content: Buffer.from(f.text).toString("base64") });
      }
      const prefix = path === "" ? "" : path + "/";
      const kids = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
      if (kids.length) return Response.json(kids.map((k) => ({ name: k.slice(prefix.length), path: k, type: "file", sha: "sha-" + files.get(k).v, size: files.get(k).text.length })));
      return new Response("{}", { status: 404 });
    }
    const body = JSON.parse(opts.body);
    const cur = files.get(path);
    if (cur && body.sha !== "sha-" + cur.v) return new Response("sha mismatch", { status: 409 });
    files.set(path, { text: Buffer.from(body.content, "base64").toString("utf8"), v: (cur ? cur.v : 0) + 1 });
    return Response.json({ ok: true });
  };
  return () => { globalThis.fetch = real; };
}

const baseEnv = () => ({
  AIRCRAFT_PASSWORD: "s3cret", FASX_KV: new MockKV(), ALLOWED_ORIGIN: "https://x.github.io",
  GITHUB_OWNER: "o", GITHUB_REPO: "r", GITHUB_TOKEN: "t",
});
const post = (path, body, env, ip = "1.1.1.1") =>
  worker.fetch(new Request("https://w.example" + path, {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body),
  }), env);
const owner = (path, body, env) => post(path, { password: "s3cret", ...body }, env);

test("health reports configuration without secrets", async () => {
  const res = await worker.fetch(new Request("https://w.example/health"), baseEnv());
  const j = await res.json();
  assert.equal(j.ok, true); assert.equal(j.storage, true); assert.equal(j.ownerPasswordSet, true);
  assert.equal(JSON.stringify(j).includes("s3cret"), false);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://x.github.io");
});

test("login: right password ok, wrong password 401, missing config 503", async () => {
  const env = baseEnv();
  assert.equal((await owner("/owner/login", {}, env)).status, 200);
  assert.equal((await post("/owner/login", { password: "nope" }, env)).status, 401);
  assert.equal((await post("/owner/login", {}, env)).status, 401);
  const noPw = { ...baseEnv(), AIRCRAFT_PASSWORD: undefined };
  assert.equal((await post("/owner/login", { password: "" }, noPw)).status, 503);   // fails closed
});

test("the existing AIRCRAFT_PASSWORD secret is the one used; OWNER_PASSWORD works as an alternative name", async () => {
  const env = { ...baseEnv(), AIRCRAFT_PASSWORD: "old", OWNER_PASSWORD: "new" };
  assert.equal((await post("/owner/login", { password: "old" }, env)).status, 200);     // existing secret wins
  const alt = { ...baseEnv(), AIRCRAFT_PASSWORD: undefined, OWNER_PASSWORD: "new" };
  assert.equal((await post("/owner/login", { password: "new" }, alt)).status, 200);
});

test("lockout after repeated wrong passwords, per IP, and success resets", async () => {
  const env = baseEnv();
  for (let i = 0; i < 6; i++) assert.equal((await post("/owner/login", { password: "x" }, env, "9.9.9.9")).status, 401);
  assert.equal((await post("/owner/login", { password: "x" }, env, "9.9.9.9")).status, 429);
  assert.equal((await post("/owner/login", { password: "s3cret" }, env, "9.9.9.9")).status, 429);   // even the right one
  assert.equal((await post("/owner/login", { password: "s3cret" }, env, "2.2.2.2")).status, 200);   // other IP unaffected
});

test("owner endpoints never answer without the password", async () => {
  const env = baseEnv();
  for (const p of ["/owner/state", "/owner/save-month", "/owner/override", "/owner/settings", "/aircraft-ground", "/aircraft-unground"]) {
    assert.equal((await post(p, {}, env)).status, 401, p);
  }
});

test("state returns defaults on an empty store", async () => {
  const j = await (await owner("/owner/state", {}, baseEnv())).json();
  const a = j.data.settings.aircraft;
  assert.deepEqual(Object.keys(a).sort(), ["ZS-ESE", "ZS-JOG"]);
  // ZS-ESE starts with August hours (cycle Aug-Oct ends now); ZS-JOG is on a different cycle starting with September hours (Sep-Nov)
  const start = { "ZS-ESE": "2026-08", "ZS-JOG": "2026-09" };
  for (const reg of ["ZS-ESE", "ZS-JOG"]) {          // R1,800/h, 40 h, 3-month cycles
    assert.equal(a[reg].startMonth, start[reg]); assert.equal(a[reg].cycleMonths, 3);
    assert.equal(a[reg].baselineHours, 40); assert.deepEqual(a[reg].rates, [{ from: start[reg] + "-01", perHour: 1800 }]);
  }
  assert.deepEqual(j.data.months, {});
});

test("save-month stores, validates and clears", async () => {
  const env = baseEnv();
  let j = await (await owner("/owner/save-month", { aircraft: "ZS-ESE", month: "2026-10", invoicedHours: "12.456", ownerHours: 3.5, note: "inv 1" }, env)).json();
  assert.equal(j.data.months["ZS-ESE|2026-10"].invoicedHours, 12.46);
  assert.equal(j.data.months["ZS-ESE|2026-10"].ownerHours, 3.5);
  assert.equal((await owner("/owner/save-month", { aircraft: "ZS-XXX", month: "2026-10", invoicedHours: 1 }, env)).status, 400);
  assert.equal((await owner("/owner/save-month", { aircraft: "ZS-ESE", month: "2026-13", invoicedHours: 1 }, env)).status, 400);
  assert.equal((await owner("/owner/save-month", { aircraft: "ZS-ESE", month: "2026-10", invoicedHours: -1 }, env)).status, 400);
  assert.equal((await owner("/owner/save-month", { aircraft: "ZS-ESE", month: "2026-10", invoicedHours: 5, ownerHours: 6 }, env)).status, 400);
  j = await (await owner("/owner/save-month", { aircraft: "ZS-ESE", month: "2026-10", invoicedHours: null }, env)).json();
  assert.deepEqual(j.data.months, {});
});

test("override set / replace / clear", async () => {
  const env = baseEnv();
  let j = await (await owner("/owner/override", { aircraft: "ZS-JOG", date: "2026-11-05", status: "unavailable" }, env)).json();
  assert.equal(j.data.overrides["ZS-JOG"]["2026-11-05"], "unavailable");
  j = await (await owner("/owner/override", { aircraft: "ZS-JOG", date: "2026-11-05", status: "available" }, env)).json();
  assert.equal(j.data.overrides["ZS-JOG"]["2026-11-05"], "available");
  j = await (await owner("/owner/override", { aircraft: "ZS-JOG", date: "2026-11-05", status: null }, env)).json();
  assert.deepEqual(j.data.overrides, {});
  assert.equal((await owner("/owner/override", { aircraft: "ZS-JOG", date: "2026-02-31", status: "unavailable" }, env)).status, 400);
  assert.equal((await owner("/owner/override", { aircraft: "ZS-JOG", date: "2026-11-05", status: "maybe" }, env)).status, 400);
});

test("settings: valid changes applied, junk ignored, previous version kept", async () => {
  const env = baseEnv();
  const j = await (await owner("/owner/settings", { settings: {
    billing: { multiplier: -3, vatPercent: "15.5" },
    weatherRule: { minFlyableHours: 5, windowStart: "08:00", windowEnd: "07:00", cautionCountsAsFlyable: "yes" },
    aircraft: {
      "ZS-ESE": { startMonth: "2027-02", baselineHours: 42, cycleMonths: 4, rates: [{ from: "2027-02-01", perHour: 1900 }, { from: "bad", perHour: 5 }, { from: "2026-11-01", perHour: "1800" }, { from: "2027-09-01", perHour: -1 }] },
      "ZS-JOG": { startMonth: "2026-13", cycleMonths: 99 },
      "bad reg!": {}, "ZU-FZS": { label: "Partenavia", startMonth: "2026-12" },
    },
    evil: "<script>",
  } }, env)).json();
  const s = j.data.settings;
  assert.equal(s.billing.multiplier, 1);                     // invalid -> kept (default 1: invoiced hours already include tacho x 1.2)
  assert.equal(s.billing.vatPercent, 15.5);
  assert.equal(s.weatherRule.minFlyableHours, 5);
  assert.equal(s.weatherRule.windowStart, "07:00");          // inverted window rejected
  assert.equal(s.weatherRule.cautionCountsAsFlyable, true);  // non-boolean ignored
  assert.deepEqual(Object.keys(s.aircraft).sort(), ["ZS-ESE", "ZS-JOG", "ZU-FZS"]);
  const ese = s.aircraft["ZS-ESE"];
  assert.equal(ese.startMonth, "2027-02"); assert.equal(ese.baselineHours, 42); assert.equal(ese.cycleMonths, 4);
  assert.deepEqual(ese.rates, [{ from: "2026-11-01", perHour: 1800 }, { from: "2027-02-01", perHour: 1900 }]);   // sorted, junk dropped
  assert.equal(s.aircraft["ZS-JOG"].startMonth, "2026-09");  // invalid month -> kept
  assert.equal(s.aircraft["ZS-JOG"].cycleMonths, 3);         // out of range -> kept
  const nu = s.aircraft["ZU-FZS"];                           // a new aircraft gets its own clock and a default rate
  assert.equal(nu.startMonth, "2026-12"); assert.deepEqual(nu.rates, [{ from: "2026-12-01", perHour: 1800 }]);
  assert.equal("evil" in s, false);
  assert.ok(env.FASX_KV.m.has("contract:prev") === false);   // first write has nothing to back up
  await owner("/owner/settings", { settings: { aircraft: { "ZS-ESE": { baselineHours: 30 } } } }, env);
  assert.ok(env.FASX_KV.m.has("contract:prev"));
});

test("an update only changes the aircraft it mentions; others are kept", async () => {
  const env = baseEnv();
  const j = await (await owner("/owner/settings", { settings: { aircraft: { "ZS-JOG": { baselineHours: 35 } } } }, env)).json();
  assert.deepEqual(Object.keys(j.data.settings.aircraft).sort(), ["ZS-ESE", "ZS-JOG"]);
  assert.equal(j.data.settings.aircraft["ZS-JOG"].baselineHours, 35);
  assert.equal(j.data.settings.aircraft["ZS-ESE"].baselineHours, 40);
  const k = await (await owner("/owner/settings", { settings: { aircraft: { "ZS-ESE": { enabled: false } } } }, env)).json();
  assert.equal(k.data.settings.aircraft["ZS-ESE"].enabled, false);          // untracked, not deleted
});

test("price changes are kept as dated lines and can be removed again", async () => {
  const env = baseEnv();
  let j = await (await owner("/owner/settings", { settings: { aircraft: { "ZS-JOG": { rates: [{ from: "2026-11-01", perHour: 1800 }, { from: "2027-11-01", perHour: 1950 }] } } } }, env)).json();
  assert.equal(j.data.settings.aircraft["ZS-JOG"].rates.length, 2);
  j = await (await owner("/owner/settings", { settings: { aircraft: { "ZS-JOG": { rates: [{ from: "2026-11-01", perHour: 1800 }] } } } }, env)).json();
  assert.deepEqual(j.data.settings.aircraft["ZS-JOG"].rates, [{ from: "2026-11-01", perHour: 1800 }]);
});

test("owner data never touches GitHub", async () => {
  const files = new Map(); const restore = installGithub(files);
  try {
    const env = baseEnv();
    await owner("/owner/save-month", { aircraft: "ZS-ESE", month: "2026-10", invoicedHours: 10 }, env);
    await owner("/owner/settings", { settings: { aircraft: { "ZS-ESE": { baselineHours: 41 } } } }, env);
    assert.equal(files.size, 0);
  } finally { restore(); }
});

test("ground / unground keep the CSV format and reject conflicts", async () => {
  const files = new Map([["data/aircraft_status.csv", { v: 1, text:
    "Registration,GroundedDate,GroundedNote,UngroundedDate,UngroundedNote,LoggedAt\n" +
    "ZS-ESE,2026-10-17,Cowling,2026-10-26,Cowl repaired,2026-10-19T09:29\n" +
    "ZS-ESE,2026-10-30,Mpi,,,2026-10-29T21:25\n" }]]);
  const restore = installGithub(files);
  try {
    const env = baseEnv();
    assert.equal((await owner("/aircraft-ground", { registration: "ZS-ESE", date: "2026-11-01", note: "x" }, env)).status, 409);   // already grounded
    assert.equal((await owner("/aircraft-ground", { registration: "ZS-JOG", date: "2026-11-07", note: "Wx, in George" }, env)).status, 200);
    assert.equal((await owner("/aircraft-unground", { registration: "ZS-JOG", date: "2026-11-09", note: "Picked up" }, env)).status, 200);
    assert.equal((await owner("/aircraft-unground", { registration: "ZS-JOG", date: "2026-11-10", note: "" }, env)).status, 409);   // not grounded
    assert.equal((await owner("/aircraft-unground", { registration: "ZS-ESE", date: "2026-10-01", note: "" }, env)).status, 409);   // before grounded date
    assert.equal((await owner("/aircraft-unground", { registration: "ZS-ESE", date: "2026-11-03", note: "Fixed" }, env)).status, 200);
    const lines = files.get("data/aircraft_status.csv").text.trimEnd().split("\n");
    assert.equal(lines[0], "Registration,GroundedDate,GroundedNote,UngroundedDate,UngroundedNote,LoggedAt");
    assert.equal(lines[1], "ZS-ESE,2026-10-17,Cowling,2026-10-26,Cowl repaired,2026-10-19T09:29");
    assert.equal(lines[2].startsWith("ZS-ESE,2026-10-30,Mpi,2026-11-03,Fixed,2026-10-29T21:25"), true);
    assert.match(lines[3], /^ZS-JOG,2026-11-07,"Wx, in George",2026-11-09,Picked up,\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    assert.equal(lines.length, 4);
  } finally { restore(); }
});

test("ground still works when KV is not bound yet (so nothing regresses mid-rollout)", async () => {
  const files = new Map(); const restore = installGithub(files);
  try {
    const env = { ...baseEnv(), FASX_KV: undefined };
    assert.equal((await owner("/aircraft-ground", { registration: "ZS-JOG", date: "2026-11-07", note: "t" }, env)).status, 200);
    assert.equal((await owner("/owner/state", {}, env)).status, 503);
  } finally { restore(); }
});

test("legacy manual check POST still appends to the manual log", async () => {
  const files = new Map(); const restore = installGithub(files);
  try {
    const res = await post("/", { dateStr: "2026-11-10", time: "08:00", windDir: 10, windSpeed: 5, gust: 8, visKm: 20, ceilingFt: null, precip: "None", observer: "J" }, baseEnv());
    assert.equal(res.status, 200);
    const t = files.get("data/manual_log.csv").text;
    assert.ok(t.startsWith("Date,Time,Observer"));
    assert.ok(t.includes("2026-11-10,08:00,J,10,5,8,20,,None,no,,no,"));
    assert.equal((await post("/", { dateStr: "2026-11-10" }, baseEnv())).status, 400);
  } finally { restore(); }
});

// ---- regression guards for behaviour the live Worker already has ----
const STATION_XML = `<DATA><ITEM><LOCATION>Swellengrebel Airfield</LOCATION><STATUS>ON-LINE</STATUS><WIND_AVG>10</WIND_AVG><WIND_MAX>20</WIND_MAX>
<WIND_DIR>NW</WIND_DIR><RAIN_RATE_MM_HR>0</RAIN_RATE_MM_HR><RAINFALL_MM>0</RAINFALL_MM><TEMPERATURE_C>14</TEMPERATURE_C><DEWPOINT_C>13</DEWPOINT_C>
<PRESSURE_MB>1018.4</PRESSURE_MB><ASL_FEET>407</ASL_FEET><CLOUD_HEIGHT_M>300</CLOUD_HEIGHT_M><LASTUPDATE>2026-11-10 07:00:00</LASTUPDATE></ITEM></DATA>`;
const FORECAST = { hourly: { time: ["2026-11-10T07:00", "2026-11-10T08:00"], wind_direction_10m: [200, 210], wind_speed_10m: [5, 6], wind_gusts_10m: [9, 10],
  visibility: [40000, 40000], precipitation: [0, 0], cloud_cover: [50, 50], temperature_2m: [14, 15], dew_point_2m: [13, 13] } };
function installWeather(files) {
  const restoreGh = installGithub(files);
  const gh = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("iweathar.co.za")) return new Response(STATION_XML);
    if (String(url).includes("open-meteo.com")) return Response.json(FORECAST);
    return gh(url, opts);
  };
  return restoreGh;
}

test("live-station keeps serving qnhHpa and aslFt (the dashboard's QNH tile reads them)", async () => {
  const restore = installWeather(new Map());
  try {
    const res = await worker.fetch(new Request("https://w.example/live-station"), { ...baseEnv(), IWEATHAR_KEY: "k" });
    const j = await res.json();
    assert.equal(j.status, "ON-LINE"); assert.equal(j.qnhHpa, 1018.4); assert.equal(j.aslFt, 407);
    assert.equal(j.windGustKt, 10.8); assert.equal(j.stationCeilingFt, 577);
  } finally { restore(); }
});

test("the scheduled weather log stamps rows with the actual current SAST minute", async () => {
  const files = new Map(); const restore = installWeather(files);
  try {
    const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(" "));
    let done; const p = new Promise((r) => { done = r; });
    await worker.scheduled({}, { ...baseEnv(), IWEATHAR_KEY: "k" }, { waitUntil: (pr) => pr.then(done) });
    await p; console.log = realLog;
    const text = files.get("data/forecast_log.csv").text.trimEnd().split("\n");
    const first = text[1].split(",")[0];
    assert.match(first, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    const sast = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 16);
    assert.ok(Math.abs(Date.parse(first + "Z") - Date.parse(sast + "Z")) <= 120000, "not the current time: " + first);
    assert.equal(text[1].split(",").slice(-2)[1], "station");
  } finally { restore(); }
});

test("the weather log keeps being written after it passes GitHub's 1 MB read limit", async () => {
  const header = "LocalTime,Fc_WindDir,Fc_WindSpeed_kt,Fc_Gust_kt,Fc_Visibility_km,Fc_CeilingEst_ft,Fc_Precip,Fc_Temp_C,Fc_Dew_C,Fc_Cloud_pct,St_Status,St_WindDir,St_WindAvg_kt,St_WindGust_kt,St_Temp_C,St_Dew_C,St_Pressure_hPa,St_RainToday_mm,St_RainRate_mm_hr,St_CeilingEst_ft,St_Precip,St_Time,Verdict,VerdictSource\n";
  const row = "2026-07-29T21:00,61,3,8,44.8,,None,10.3,7.0,2,ON-LINE,NW,1.1,2.2,10.2,8.5,1024.68,0.0,0.0,712,None,2026-07-29 23:01:04,NO-FLY,station\n";
  const big = header + row.repeat(Math.ceil(1100000 / row.length));          // ~1.1 MB
  const files = new Map([["data/forecast_log.csv", { v: 1, text: big }]]);
  const restore = installWeather(files);
  try {
    let done; const p = new Promise((r) => { done = r; });
    await worker.scheduled({}, { ...baseEnv(), IWEATHAR_KEY: "k" }, { waitUntil: (pr) => pr.then(done) });
    await p;
    const after = files.get("data/forecast_log.csv");
    assert.equal(after.v, 2, "the big file was not updated");
    assert.ok(after.text.startsWith(big), "existing history must be preserved");
    const added = after.text.slice(big.length);
    assert.match(added, /^\d{4}-\d\d-\d\dT\d\d:\d\d,.*,station\n$/);
  } finally { restore(); }
});

test("settings never saved explicitly follow the current defaults; explicitly saved ones are kept", async () => {
  // An invoice saved earlier stored the old defaults (start 2026-10) without anyone choosing them.
  const env = baseEnv();
  env.FASX_KV.m.set("contract", JSON.stringify({
    settings: { aircraft: { "ZS-ESE": { startMonth: "2026-10" }, "ZS-JOG": { startMonth: "2026-10" } } },
    months: { "ZS-ESE|2026-10": { invoicedHours: 12, ownerHours: 0 } }, overrides: {},
  }));
  let j = await (await owner("/owner/state", {}, env)).json();
  assert.equal(j.data.settings.aircraft["ZS-ESE"].startMonth, "2026-08");              // default applies
  assert.equal(j.data.months["ZS-ESE|2026-10"].invoicedHours, 12);                     // invoices untouched
  // Once the owner saves Settings, their choice is theirs.
  await owner("/owner/settings", { settings: { aircraft: { "ZS-ESE": { startMonth: "2026-11" } } } }, env);
  j = await (await owner("/owner/state", {}, env)).json();
  assert.equal(j.data.settings.aircraft["ZS-ESE"].startMonth, "2026-11");
  assert.equal(j.data.settingsSaved, true);
  assert.equal(j.data.months["ZS-ESE|2026-10"].invoicedHours, 12);
});

test("printed-report names and each aircraft's agreement line are settings with sensible defaults", async () => {
  const env = baseEnv();
  let j = await (await owner("/owner/state", {}, env)).json();
  assert.equal(j.data.settings.report.lessor, "VMC Aviation (Pty) Ltd");
  assert.equal(j.data.settings.report.lessee, "Heritage Aviation (Pty) Ltd");
  assert.match(j.data.settings.aircraft["ZS-ESE"].agreement, /12 December 2025.*Addendum No\. 1/);
  assert.match(j.data.settings.aircraft["ZS-JOG"].agreement, /18 July 2025.*Addendum No\. 2/);
  j = await (await owner("/owner/settings", { settings: { report: { lessee: "Heritage Aviation" }, aircraft: { "ZS-JOG": { agreement: "x".repeat(300) } } } }, env)).json();
  assert.equal(j.data.settings.report.lessee, "Heritage Aviation");
  assert.equal(j.data.settings.report.lessor, "VMC Aviation (Pty) Ltd");           // untouched
  assert.equal(j.data.settings.aircraft["ZS-JOG"].agreement.length, 140);           // capped
});
