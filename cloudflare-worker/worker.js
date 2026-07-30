// FASX dashboard — Cloudflare Worker
//
// Two jobs in one Worker:
//   1. fetch()     — receives a POST from the dashboard with one manually
//                    logged check, appends it to data/manual_log.csv.
//   2. scheduled() — fires on a Cron Trigger every 30 minutes, fetches the
//                    Open-Meteo forecast and the live iWeathar station
//                    reading, computes a verdict, and appends a row to
//                    data/forecast_log.csv. Replaces the old GitHub Actions
//                    workflow, which GitHub's free scheduler was silently
//                    skipping under load.
//
// The GitHub token lives only here (as a Worker secret), never in the
// publicly-served dashboard page or in GitHub Actions.
//
// Required environment variables (Cloudflare dashboard → Worker → Settings
// → Variables and Secrets):
//   GITHUB_TOKEN        (secret)  — fine-grained PAT, Contents: Read and write, scoped to this repo only
//   GITHUB_OWNER        (var)     — your GitHub username
//   GITHUB_REPO         (var)     — the repo name, e.g. FASX-Weather
//   GITHUB_BRANCH       (var)     — usually "main"
//   GITHUB_PATH         (var)     — usually "data/manual_log.csv" (manual checks)
//   GITHUB_PATH_FORECAST(var)     — usually "data/forecast_log.csv" (automated log)
//   ALLOWED_ORIGIN      (var)     — your GitHub Pages URL, e.g. https://yourname.github.io
//   IWEATHAR_KEY        (secret)  — the key Russell provided

const LAT = -34.0482, LON = 20.4746, TZ_OFFSET = "+02:00"; // Africa/Johannesburg, fixed UTC+2, no DST
const IWEATHAR_STATION_NAME = "Swellengrebel Airfield";

const CRIT = {
  windCaution: 15, windNoFly: 25,
  ceilCaution: 1500, ceilNoFly: 1000,
  visCaution: 8, visNoFly: 5,
};

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/live-station") {
      try {
        const station = await fetchIweatharStation(env.IWEATHAR_KEY);
        if (!station) {
          return json({ status: "UNREACHABLE" }, 200, corsHeaders);
        }
        return json(station, 200, corsHeaders);
      } catch (e) {
        return json({ status: "ERROR", error: e.message }, 500, corsHeaders);
      }
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    let entry;
    try {
      entry = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON body" }, 400, corsHeaders);
    }

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
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runAutomatedLog(env));
  },
};

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
      times[bestIdx],
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
    await appendToGithubCsv(env, path, header, row, `Log forecast ${times[bestIdx]} (${verdictSource})`);
    console.log(`Logged ${times[bestIdx]}: ${verdict} (source: ${verdictSource})`);
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
      stationCeilingFt,
      stationTime,
    };
  } catch (e) {
    console.log(`iWeathar field parse failed: ${e.message}`);
    return null;
  }
}

function round1(v) { return Math.round(v * 10) / 10; }

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

// --- Shared GitHub read-modify-write helper ---

async function appendToGithubCsv(env, path, header, row, commitMessage) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    const err = new Error("Worker not configured — missing GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN");
    err.status = 500;
    throw err;
  }

  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const ghHeaders = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "fasx-dashboard-worker",
  };

  let existingContent = "";
  let sha = null;

  const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers: ghHeaders });
  if (getRes.status === 200) {
    const data = await getRes.json();
    sha = data.sha;
    existingContent = b64DecodeUtf8(data.content);
  } else if (getRes.status !== 404) {
    const errText = await getRes.text();
    const err = new Error("GitHub read failed");
    err.status = 502; err.detail = errText;
    throw err;
  }

  const newContent = existingContent ? existingContent + row : header + row;
  const putBody = {
    message: commitMessage,
    content: b64EncodeUtf8(newContent),
    branch,
  };
  if (sha) putBody.sha = sha;

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    const err = new Error("GitHub write failed");
    err.status = 502; err.detail = errText;
    throw err;
  }
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
