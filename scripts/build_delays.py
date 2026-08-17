"""
Transform BTS On-Time Performance data into per-airport congestion metrics.

Adds two tables to data/aviation.db (built first by build_dataset.py):

  airport_delay_year   one row per airport per year
  airport_delay_month  one row per airport per month -- needed for seasonality, which is how
                       weather-driven capacity loss becomes visible

Processes one month at a time, reading only the needed columns. The raw monthly files are
~235 MB uncompressed each (~2.8 GB for the year), but the aggregates are tiny.

--- Two things about this dataset that materially affect interpretation ---

1. COVERAGE IS NARROWER THAN T-100. On-Time Performance covers "reporting carriers" -- the larger
   US airlines above a revenue threshold. Regional carriers operating under capacity-purchase
   agreements report under the mainline brand, and foreign carriers are absent entirely. T-100, by
   contrast, covers everyone. So delay metrics describe major-carrier operations at an airport,
   not all traffic.

2. CAUSE ATTRIBUTION IS CONDITIONAL. CarrierDelay / WeatherDelay / NASDelay / SecurityDelay /
   LateAircraftDelay are populated only for flights arriving 15+ minutes late (~26% of rows).
   We treat null as zero attributable minutes, which is correct in aggregate -- an on-time flight
   contributed no delay -- but it means these columns measure "minutes of attributed delay per
   flight", not "average delay when delayed".

--- Why NASDelay is the column that matters here ---

BTS defines NAS delay as air traffic control, heavy traffic volume, airport operations, and
NON-EXTREME weather. When an airport's arrival rate is cut because controllers must space aircraft
further apart in poor visibility, that lands in NASDelay, not WeatherDelay. WeatherDelay captures
extreme events -- storms that ground flights. For measuring capacity constraint, NASDelay is the
signal and WeatherDelay is context.
"""

import os
import sqlite3
import sys
import zipfile

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
DB_PATH = os.path.join(ROOT, "data", "aviation.db")

YEAR = 2024
MONTHS = range(1, 13)

USECOLS = [
    "Year", "Month", "Origin", "Dest", "Reporting_Airline",
    "DepDelayMinutes", "ArrDelayMinutes", "DepDel15", "ArrDel15",
    "TaxiOut", "TaxiIn", "Cancelled", "CancellationCode", "Diverted",
    "CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay", "LateAircraftDelay",
]

# BTS cancellation cause codes.
CANCEL_CARRIER, CANCEL_WEATHER, CANCEL_NAS, CANCEL_SECURITY = "A", "B", "C", "D"

CAUSE_COLS = ["CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay", "LateAircraftDelay"]


def log(msg):
    print(msg, flush=True)


def read_month(month):
    path = os.path.join(RAW, f"ontime_{YEAR}_{month:02d}.zip")
    if not os.path.exists(path):
        raise FileNotFoundError(f"missing {path} -- run download_data.py first")
    with zipfile.ZipFile(path) as z:
        member = next(
            n for n in z.namelist()
            if n.lower().endswith(".csv") and "readme" not in n.lower()
        )
        with z.open(member) as fh:
            df = pd.read_csv(fh, usecols=lambda c: c in USECOLS, low_memory=False)

    # Attributed-cause minutes are null on flights that were not significantly delayed.
    # Zero is the correct aggregate value: those flights contributed no delay.
    for c in CAUSE_COLS:
        if c in df:
            df[c] = df[c].fillna(0.0)
    return df


def aggregate_side(df, airport_col, prefix):
    """
    Aggregate from one airport's perspective.

    Departure-side metrics (taxi-out, departure delay) attribute to the ORIGIN airport, since that
    is where the aircraft queued. Arrival-side metrics attribute to the DEST airport. Cause
    attribution is reported against the arriving flight, so it is credited to the destination.
    """
    g = df.groupby([airport_col, "Year", "Month"], observed=True)
    out = g.agg(
        **{
            f"{prefix}_flights": ("Cancelled", "size"),
            f"{prefix}_cancelled": ("Cancelled", "sum"),
            f"{prefix}_diverted": ("Diverted", "sum"),
        }
    )

    if prefix == "dep":
        out[f"{prefix}_delay_min_mean"] = g["DepDelayMinutes"].mean()
        out[f"{prefix}_del15_rate"] = g["DepDel15"].mean()
        out["taxi_out_min_mean"] = g["TaxiOut"].mean()
    else:
        out[f"{prefix}_delay_min_mean"] = g["ArrDelayMinutes"].mean()
        out[f"{prefix}_del15_rate"] = g["ArrDel15"].mean()
        out["taxi_in_min_mean"] = g["TaxiIn"].mean()
        # Cause minutes are only meaningful on the arrival side.
        for c in CAUSE_COLS:
            out[f"{c.lower()}_min_total"] = g[c].sum()

    # Cancellations split by cause.
    for code, name in [
        (CANCEL_CARRIER, "cancel_carrier"),
        (CANCEL_WEATHER, "cancel_weather"),
        (CANCEL_NAS, "cancel_nas"),
        (CANCEL_SECURITY, "cancel_security"),
    ]:
        mask = df["CancellationCode"].eq(code)
        counts = df[mask].groupby([airport_col, "Year", "Month"], observed=True).size()
        out[f"{prefix}_{name}"] = counts.reindex(out.index, fill_value=0)

    out = out.reset_index().rename(columns={airport_col: "iata"})
    return out


def main():
    if not os.path.exists(DB_PATH):
        log(f"ERROR: {DB_PATH} not found. Run build_dataset.py first.")
        return 1

    monthly = []
    for m in MONTHS:
        df = read_month(m)
        dep = aggregate_side(df, "Origin", "dep")
        arr = aggregate_side(df, "Dest", "arr")
        merged = dep.merge(arr, on=["iata", "Year", "Month"], how="outer")
        monthly.append(merged)
        log(f"  {YEAR}-{m:02d}: {len(df):,} flights -> {len(merged):,} airport rows")
        del df

    by_month = pd.concat(monthly, ignore_index=True).fillna(0)
    by_month = by_month.rename(columns={"Year": "year", "Month": "month"})

    log(f"\nairport_delay_month: {len(by_month):,} rows, {by_month['iata'].nunique():,} airports")

    # --- roll up to the year ---
    sum_cols = [c for c in by_month.columns
                if c.endswith(("_flights", "_cancelled", "_diverted", "_min_total"))
                or "cancel_" in c]
    # Means must be re-derived as flight-weighted, never averaged across months.
    dep_w = by_month["dep_flights"].replace(0, pd.NA)
    arr_w = by_month["arr_flights"].replace(0, pd.NA)
    by_month["_dep_delay_weighted"] = by_month["dep_delay_min_mean"] * dep_w
    by_month["_taxi_out_weighted"] = by_month["taxi_out_min_mean"] * dep_w
    by_month["_dep_del15_weighted"] = by_month["dep_del15_rate"] * dep_w
    by_month["_arr_delay_weighted"] = by_month["arr_delay_min_mean"] * arr_w
    by_month["_taxi_in_weighted"] = by_month["taxi_in_min_mean"] * arr_w
    by_month["_arr_del15_weighted"] = by_month["arr_del15_rate"] * arr_w

    agg = {c: "sum" for c in sum_cols}
    agg.update({c: "sum" for c in by_month.columns if c.startswith("_")})
    by_year = by_month.groupby(["iata", "year"], observed=True).agg(agg).reset_index()

    by_year["dep_delay_min_mean"] = by_year["_dep_delay_weighted"] / by_year["dep_flights"]
    by_year["taxi_out_min_mean"] = by_year["_taxi_out_weighted"] / by_year["dep_flights"]
    by_year["dep_del15_rate"] = by_year["_dep_del15_weighted"] / by_year["dep_flights"]
    by_year["arr_delay_min_mean"] = by_year["_arr_delay_weighted"] / by_year["arr_flights"]
    by_year["taxi_in_min_mean"] = by_year["_taxi_in_weighted"] / by_year["arr_flights"]
    by_year["arr_del15_rate"] = by_year["_arr_del15_weighted"] / by_year["arr_flights"]
    by_year = by_year.drop(columns=[c for c in by_year.columns if c.startswith("_")])

    # The headline capacity-strain metric: NAS delay minutes per arrival.
    by_year["nas_delay_min_per_arrival"] = (
        by_year["nasdelay_min_total"] / by_year["arr_flights"].replace(0, pd.NA)
    )
    by_year["weather_delay_min_per_arrival"] = (
        by_year["weatherdelay_min_total"] / by_year["arr_flights"].replace(0, pd.NA)
    )
    by_year["cancel_rate"] = (
        by_year["dep_cancelled"] / by_year["dep_flights"].replace(0, pd.NA) * 100
    )

    # Same for the monthly grain, so seasonality is directly queryable.
    by_month["nas_delay_min_per_arrival"] = (
        by_month["nasdelay_min_total"] / by_month["arr_flights"].replace(0, pd.NA)
    )
    by_month["weather_delay_min_per_arrival"] = (
        by_month["weatherdelay_min_total"] / by_month["arr_flights"].replace(0, pd.NA)
    )
    by_month = by_month.drop(columns=[c for c in by_month.columns if c.startswith("_")])

    log(f"airport_delay_year: {len(by_year):,} rows")

    with sqlite3.connect(DB_PATH) as con:
        by_year.to_sql("airport_delay_year", con, index=False, if_exists="replace")
        by_month.to_sql("airport_delay_month", con, index=False, if_exists="replace")
        con.execute("CREATE INDEX IF NOT EXISTS idx_dy ON airport_delay_year(iata, year)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_dm ON airport_delay_month(iata, year, month)")
    log(f"written to {DB_PATH} ({os.path.getsize(DB_PATH) / 1024 / 1024:.2f} MB)")

    # ---------------- sanity checks ----------------
    log("\n=== coverage vs T-100 ===")
    with sqlite3.connect(DB_PATH) as con:
        t100_airports = pd.read_sql(
            "SELECT COUNT(DISTINCT iata) n FROM airport_year WHERE year=2024", con
        )["n"].iat[0]
    log(f"  T-100 airports (all carriers): {t100_airports:,}")
    log(f"  On-Time airports (reporting carriers only): {by_year['iata'].nunique():,}")

    log("\n=== most congested by NAS delay minutes per arrival (min 50k arrivals) ===")
    big = by_year[by_year["arr_flights"] >= 50_000]
    cols = ["iata", "arr_flights", "nas_delay_min_per_arrival", "weather_delay_min_per_arrival",
            "taxi_out_min_mean", "dep_del15_rate", "cancel_rate"]
    log(big.nlargest(12, "nas_delay_min_per_arrival")[cols]
        .to_string(index=False, float_format=lambda v: f"{v:,.2f}"))

    log("\n=== longest average taxi-out (ground congestion), min 50k departures ===")
    bigd = by_year[by_year["dep_flights"] >= 50_000]
    log(bigd.nlargest(10, "taxi_out_min_mean")[cols]
        .to_string(index=False, float_format=lambda v: f"{v:,.2f}"))

    log("\n=== SFO: is the constraint seasonal? (monthly NAS delay per arrival) ===")
    sfo = by_month[by_month["iata"] == "SFO"].sort_values("month")
    log(sfo[["month", "arr_flights", "nas_delay_min_per_arrival",
             "weather_delay_min_per_arrival", "taxi_out_min_mean", "arr_del15_rate"]]
        .to_string(index=False, float_format=lambda v: f"{v:,.2f}"))

    log("\n=== LA basin comparison ===")
    la = by_year[by_year["iata"].isin(["LAX", "SNA", "ONT", "BUR", "LGB"])]
    log(la[cols].to_string(index=False, float_format=lambda v: f"{v:,.2f}"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
