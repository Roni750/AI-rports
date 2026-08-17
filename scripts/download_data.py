"""
Offline data acquisition for the Airport Investment Intelligence Agent.

Downloads raw public aviation data from the US Bureau of Transportation Statistics (BTS).
Runs once on a developer machine; its output feeds build_dataset.py. Nothing here is deployed.

Two sources:

  1. T-100 Segment  -- flight volume: passengers, available seats, departures, distance.
     Fetched through the TranStats ASP.NET form, which requires harvesting the page's
     __VIEWSTATE / __EVENTVALIDATION tokens and posting them back with the field selection.
     Field checkbox names are literally the column names (SEATS, PASSENGERS, ...).

       FIM = T-100 Domestic Segment (U.S. Carriers)
       GDK = T-100 International Segment (U.S. Carriers)

     Note on coverage: foreign airlines are legally barred from operating U.S. domestic
     routes (cabotage), so "U.S. Carriers" is COMPLETE coverage for domestic traffic.
     The gap is international flights operated by foreign carriers -- documented in DESIGN.md.

  2. On-Time Performance -- flight punctuality and delay CAUSE (weather, carrier, air traffic
     control, late inbound aircraft, security). Published as one zip per month, served as
     static files, so no form handling needed.

Stdlib only, no third-party packages, so this can run before any pip install completes.
Already-downloaded files are skipped, making the script safe to re-run.
"""

import http.cookiejar
import os
import re
import sys
import time
import urllib.parse
import urllib.request

RAW = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "raw")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"

# ---------------------------------------------------------------- config

# FMG = T-100 Segment (All Carriers): domestic AND international, U.S. AND foreign carriers.
# Supersedes the narrower FIM (domestic, U.S. carriers) and GDK (international, U.S. carriers)
# tables, and additionally carries FREIGHT, CARRIER_GROUP, ORIGIN_COUNTRY and DEST_COUNTRY.
# Identified via the Content-Disposition filename the form returns -- the page itself does not
# label its tables. Sibling codes, for the record: FJE = international only, GEE = domestic only.
T100_TABLES = {
    "FMG": "t100_segment_all_carrier",
}
T100_YEARS = [2019, 2023, 2024]

# 2019 = clean pre-COVID structural baseline; 2023->2024 = recent momentum.
# 2020-2021 deliberately excluded: pandemic traffic collapse makes them useless as a baseline.

T100_FIELDS = [
    "ORIGIN", "ORIGIN_CITY_NAME", "ORIGIN_STATE_ABR", "ORIGIN_COUNTRY",
    "DEST", "DEST_CITY_NAME", "DEST_STATE_ABR", "DEST_COUNTRY",
    "PASSENGERS", "SEATS", "DEPARTURES_PERFORMED", "DISTANCE", "FREIGHT",
    "CLASS", "YEAR", "MONTH", "UNIQUE_CARRIER", "CARRIER_GROUP", "AIRCRAFT_TYPE",
]

ONTIME_YEAR = 2024
ONTIME_MONTHS = list(range(1, 13))
ONTIME_URL = (
    "https://transtats.bts.gov/PREZIP/"
    "On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{year}_{month}.zip"
)

# ---------------------------------------------------------------- helpers


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def opener_with_cookies():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def hidden_field(html, name):
    """Pull an ASP.NET hidden input value out of the raw page HTML."""
    for pattern in (
        rf'id="{name}"[^>]*value="([^"]*)"',
        rf'name="{name}"[^>]*value="([^"]*)"',
    ):
        m = re.search(pattern, html, re.I | re.S)
        if m:
            return m.group(1)
    return ""


def human(n_bytes):
    return f"{n_bytes / 1024 / 1024:.2f} MB"


# ---------------------------------------------------------------- T-100


def download_t100(table_code, label, year):
    dest = os.path.join(RAW, f"{label}_{year}.zip")
    if os.path.exists(dest) and os.path.getsize(dest) > 50_000:
        log(f"skip  {os.path.basename(dest)} (already present, {human(os.path.getsize(dest))})")
        return True

    page = (
        f"https://www.transtats.bts.gov/DL_SelectFields.aspx"
        f"?gnoyr_VQ={table_code}&QO_fu146_anzr=Nv4%20Pn44vr45"
    )
    op = opener_with_cookies()

    req = urllib.request.Request(page, headers={"User-Agent": UA})
    html = op.open(req, timeout=120).read().decode("utf-8", "replace")

    body = {
        "__EVENTTARGET": "",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": hidden_field(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": hidden_field(html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": hidden_field(html, "__EVENTVALIDATION"),
        "cboGeography": "All",
        "cboYear": str(year),
        "cboPeriod": "All",
        "chkDownloadZip": "on",
        "btnDownload": "Download",
    }
    for f in T100_FIELDS:
        body[f] = "on"

    data = urllib.parse.urlencode(body).encode()
    post = urllib.request.Request(
        page,
        data=data,
        headers={
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": page,
        },
    )

    log(f"POST  {label} {year} ...")
    with op.open(post, timeout=900) as resp:
        ctype = resp.headers.get("Content-Type", "")
        payload = resp.read()

    if "zip" not in ctype.lower() or payload[:2] != b"PK":
        log(f"FAIL  {label} {year}: expected zip, got '{ctype}' ({len(payload)} bytes)")
        return False

    with open(dest, "wb") as fh:
        fh.write(payload)
    log(f"OK    {os.path.basename(dest)}  {human(len(payload))}")
    return True


# ---------------------------------------------------------------- On-Time


def download_ontime(year, month):
    dest = os.path.join(RAW, f"ontime_{year}_{month:02d}.zip")
    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:
        log(f"skip  {os.path.basename(dest)} (already present, {human(os.path.getsize(dest))})")
        return True

    url = ONTIME_URL.format(year=year, month=month)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            tmp = dest + ".part"
            total = 0
            with open(tmp, "wb") as fh:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk)
                    total += len(chunk)
            os.replace(tmp, dest)
        log(f"OK    {os.path.basename(dest)}  {human(total)}")
        return True
    except Exception as exc:  # noqa: BLE001 - want the reason in the log, keep going
        log(f"FAIL  ontime {year}-{month:02d}: {exc}")
        return False


# ---------------------------------------------------------------- main


def main():
    os.makedirs(RAW, exist_ok=True)
    log(f"raw data directory: {RAW}")

    # --only lets the two sources be fetched independently, so a long On-Time run can continue
    # in one process while T-100 is re-fetched in another.
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]

    ok = fail = 0

    if only in (None, "t100"):
        log("=== T-100 volume data (all carriers, domestic + international) ===")
        for code, label in T100_TABLES.items():
            for year in T100_YEARS:
                if download_t100(code, label, year):
                    ok += 1
                else:
                    fail += 1

    if only in (None, "ontime"):
        log("=== On-Time Performance (delays and their causes), 12 months ===")
        for month in ONTIME_MONTHS:
            if download_ontime(ONTIME_YEAR, month):
                ok += 1
            else:
                fail += 1

    log(f"DONE  {ok} succeeded, {fail} failed")
    total = sum(
        os.path.getsize(os.path.join(RAW, f))
        for f in os.listdir(RAW)
        if f.endswith(".zip")
    )
    log(f"total downloaded: {human(total)}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
