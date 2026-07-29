import csv
import json
import os
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

LAT, LON = -34.0482, 20.4746
TZ = "Africa/Johannesburg"

IWEATHAR_KEY = os.environ.get("IWEATHAR_KEY", "")
IWEATHAR_URL = f"http://www.iweathar.co.za/live_data.php?key={IWEATHAR_KEY}&unit=kmh"
IWEATHAR_STATION_NAME = "Swellengrebel Airfield"

CRIT = {
    "wind_caution": 15, "wind_nofly": 25,
    "ceil_caution": 1500, "ceil_nofly": 1000,
    "vis_caution": 8, "vis_nofly": 5,
}


def kmh_to_kt(v):
    return v * 0.539957


def precip_category(mm_per_hr):
    if mm_per_hr >= 7.6:
        return "Heavy"
    if mm_per_hr >= 2.5:
        return "Moderate"
    if mm_per_hr >= 0.1:
        return "Light"
    return "None"


def estimate_ceiling(temp_c, dew_c, cloud_pct):
    if cloud_pct < 25:
        return None
    return round(max(0, (temp_c - dew_c) * 400) / 50) * 50


def verdict_for(gust, ceiling_ft, vis_km, precip):
    no_fly = (
        gust > CRIT["wind_nofly"]
        or (ceiling_ft is not None and ceiling_ft < CRIT["ceil_nofly"])
        or vis_km < CRIT["vis_nofly"]
        or precip in ("Moderate", "Heavy")
    )
    caution = (
        gust > CRIT["wind_caution"]
        or (ceiling_ft is not None and ceiling_ft < CRIT["ceil_caution"])
        or vis_km < CRIT["vis_caution"]
        or precip == "Light"
    )
    if no_fly:
        return "NO-FLY"
    if caution:
        return "CAUTION"
    return "FLYABLE"


def fetch_forecast():
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={LAT}&longitude={LON}"
        "&hourly=temperature_2m,dew_point_2m,precipitation,cloud_cover,"
        "wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility"
        f"&wind_speed_unit=kn&timezone={TZ.replace('/', '%2F')}&forecast_days=1"
    )
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def fetch_iweathar_station():
    """Fetch the live station feed (real XML, one <ITEM> per station) and
    return the Swellengrebel Airfield record. Returns None if unreachable/no
    key configured/not found; returns {'status': '...'} if found but not
    ON-LINE; otherwise returns the full parsed reading including the
    station's own ceiling (CLOUD_HEIGHT_M, corrected from MSL to AGL using
    its ASL_FEET elevation) and real rain rate (RAIN_RATE_MM_HR)."""
    if not IWEATHAR_KEY:
        print("IWEATHAR_KEY not set, skipping station fetch")
        return None
    req = urllib.request.Request(
        IWEATHAR_URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            )
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"iWeathar fetch failed: {e}")
        return None

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        print(f"iWeathar XML parse failed: {e} (response may be an access-denied message, not XML)")
        return None

    item = None
    for it in root.iter("ITEM"):
        loc = (it.findtext("LOCATION") or "").strip()
        if loc == IWEATHAR_STATION_NAME:
            item = it
            break

    if item is None:
        print("Swellengrebel Airfield not found in iWeathar feed")
        return None

    def gettext(tag):
        v = item.findtext(tag)
        return v.strip() if v is not None else ""

    status = gettext("STATUS")
    if status != "ON-LINE":
        print(f"iWeathar station status not ON-LINE, got: {status!r}")
        return {"status": status}

    try:
        wind_avg_kmh = float(gettext("WIND_AVG"))
        wind_gust_kmh = float(gettext("WIND_MAX"))
        wind_min_kmh = float(gettext("WIND_MIN"))
        dir_compass = gettext("WIND_DIR")
        dir_deg = float(gettext("WIND_ANG") or 0)
        rain_today_mm = float(gettext("RAINFALL_MM") or 0)
        rain_rate_txt = gettext("RAIN_RATE_MM_HR")
        rain_rate_mm_hr = float(rain_rate_txt) if rain_rate_txt else 0.0
        temp_c = float(gettext("TEMPERATURE_C"))
        humidity_pct = float(gettext("HUMIDITY_PERC") or 0)
        dewpoint_c = float(gettext("DEWPOINT_C"))
        pressure_hpa = float(gettext("PRESSURE_MB"))
        asl_ft = float(gettext("ASL_FEET") or 0)
        cloud_height_txt = gettext("CLOUD_HEIGHT_M")
        cloud_height_m = float(cloud_height_txt) if cloud_height_txt else None
        station_time = gettext("LASTUPDATE")
    except ValueError as e:
        print(f"iWeathar field parse failed: {e}")
        return None

    station_ceiling_ft = None
    if cloud_height_m is not None:
        cloud_height_ft_msl = cloud_height_m / 0.3048
        station_ceiling_ft = round(cloud_height_ft_msl - asl_ft)

    return {
        "status": status,
        "wind_avg_kt": round(kmh_to_kt(wind_avg_kmh), 1),
        "wind_gust_kt": round(kmh_to_kt(wind_gust_kmh), 1),
        "wind_min_kt": round(kmh_to_kt(wind_min_kmh), 1),
        "dir_compass": dir_compass,
        "dir_deg": dir_deg,
        "rain_today_mm": rain_today_mm,
        "rain_rate_mm_hr": rain_rate_mm_hr,
        "temp_c": temp_c,
        "humidity_pct": humidity_pct,
        "dewpoint_c": dewpoint_c,
        "pressure_hpa": pressure_hpa,
        "asl_ft": asl_ft,
        "station_ceiling_ft": station_ceiling_ft,
        "station_time": station_time,
    }


def main():
    data = fetch_forecast()
    times = data["hourly"]["time"]

    now_local = datetime.now(timezone.utc).astimezone().replace(tzinfo=None)
    best_idx, best_diff = 0, None
    for i, t in enumerate(times):
        dt = datetime.fromisoformat(t)
        diff = abs((dt - now_local).total_seconds())
        if best_diff is None or diff < best_diff:
            best_diff, best_idx = diff, i

    h = data["hourly"]
    fc_wind_dir = round(h["wind_direction_10m"][best_idx])
    fc_wind_speed = round(h["wind_speed_10m"][best_idx])
    fc_gust = round(h["wind_gusts_10m"][best_idx])
    fc_vis_km = round(h["visibility"][best_idx] / 1000, 1)
    fc_precip_mm = h["precipitation"][best_idx]
    fc_precip = precip_category(fc_precip_mm)
    fc_cloud = h["cloud_cover"][best_idx]
    fc_temp = h["temperature_2m"][best_idx]
    fc_dew = h["dew_point_2m"][best_idx]
    fc_ceiling = estimate_ceiling(fc_temp, fc_dew, fc_cloud)

    station = fetch_iweathar_station()

    if station and station.get("status") == "ON-LINE":
        st_ceiling = station.get("station_ceiling_ft")
        if st_ceiling is None:
            st_ceiling = estimate_ceiling(station["temp_c"], station["dewpoint_c"], fc_cloud)
        st_precip = precip_category(station["rain_rate_mm_hr"])
        verdict = verdict_for(station["wind_gust_kt"], st_ceiling, fc_vis_km, st_precip)
        verdict_source = "station"
    else:
        st_ceiling = None
        st_precip = None
        verdict = verdict_for(fc_gust, fc_ceiling, fc_vis_km, fc_precip)
        verdict_source = "forecast"

    row = [
        times[best_idx],
        fc_wind_dir, fc_wind_speed, fc_gust, fc_vis_km,
        fc_ceiling if fc_ceiling is not None else "", fc_precip,
        round(fc_temp, 1), round(fc_dew, 1), fc_cloud,
        station.get("status") if station else "UNREACHABLE",
        station.get("dir_compass", "") if station else "",
        station.get("wind_avg_kt", "") if station else "",
        station.get("wind_gust_kt", "") if station else "",
        station.get("temp_c", "") if station else "",
        station.get("dewpoint_c", "") if station else "",
        station.get("pressure_hpa", "") if station else "",
        station.get("rain_today_mm", "") if station else "",
        station.get("rain_rate_mm_hr", "") if station else "",
        st_ceiling if st_ceiling is not None else "",
        st_precip if st_precip is not None else "",
        station.get("station_time", "") if station else "",
        verdict, verdict_source,
    ]

    path = "data/forecast_log.csv"
    is_new = not os.path.exists(path)
    os.makedirs("data", exist_ok=True)
    with open(path, "a", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow([
                "LocalTime",
                "Fc_WindDir", "Fc_WindSpeed_kt", "Fc_Gust_kt", "Fc_Visibility_km",
                "Fc_CeilingEst_ft", "Fc_Precip", "Fc_Temp_C", "Fc_Dew_C", "Fc_Cloud_pct",
                "St_Status", "St_WindDir", "St_WindAvg_kt", "St_WindGust_kt",
                "St_Temp_C", "St_Dew_C", "St_Pressure_hPa", "St_RainToday_mm", "St_RainRate_mm_hr",
                "St_CeilingEst_ft", "St_Precip", "St_Time",
                "Verdict", "VerdictSource",
            ])
        writer.writerow(row)

    print(f"Logged {times[best_idx]}: {verdict} (source: {verdict_source})")


if __name__ == "__main__":
    main()
