// FASX manual-check writer — Cloudflare Worker
//
// Receives a POST from the dashboard with one logged check, and appends it
// as a row to data/manual_log.csv in your GitHub repo via the GitHub API.
// The GitHub token lives only here (as a Worker secret), never in the
// publicly-served dashboard page.
//
// Required environment variables (set in Cloudflare dashboard → Settings → Variables):
//   GITHUB_TOKEN   (secret)  — fine-grained PAT, Contents: Read and write, scoped to this repo only
//   GITHUB_OWNER   (var)     — your GitHub username
//   GITHUB_REPO    (var)     — the repo name, e.g. fasx-weather
//   GITHUB_BRANCH  (var)     — usually "main"
//   GITHUB_PATH    (var)     — usually "data/manual_log.csv"
//   ALLOWED_ORIGIN (var)     — your GitHub Pages URL, e.g. https://yourname.github.io
//                              (use "*" while testing, tighten it once working)

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";
    const path = env.GITHUB_PATH || "data/manual_log.csv";
    const token = env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return json({ error: "Worker not configured — missing GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN" }, 500, corsHeaders);
    }

    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const ghHeaders = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "fasx-dashboard-worker",
    };

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
      let existingContent = "";
      let sha = null;

      const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers: ghHeaders });
      if (getRes.status === 200) {
        const data = await getRes.json();
        sha = data.sha;
        existingContent = b64DecodeUtf8(data.content);
      } else if (getRes.status !== 404) {
        const errText = await getRes.text();
        return json({ error: "GitHub read failed", status: getRes.status, detail: errText }, 502, corsHeaders);
      }

      const newContent = existingContent ? existingContent + row : header + row;
      const putBody = {
        message: `Log manual check ${entry.dateStr} ${entry.time}`,
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
        return json({ error: "GitHub write failed", status: putRes.status, detail: errText }, 502, corsHeaders);
      }

      return json({ ok: true }, 200, corsHeaders);
    } catch (e) {
      return json({ error: e.message }, 500, corsHeaders);
    }
  },
};

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
