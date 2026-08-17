"""
Transform raw BTS T-100 segment data into the compact dataset the application ships.

Runs offline on a developer machine. Input is ~180 MB of raw government CSVs; output is a
small SQLite database (a few MB) that gets committed and deployed. The web application never
sees a CSV and never performs this aggregation at request time.

Two output grains, per the design:

  airport_year -- one row per airport per year. Powers ranking, comparison, and growth.
  route_year   -- one row per origin-destination-year. Powers "which specific routes out of
                  SFO are constrained", which airport-level aggregates cannot answer.

Service-class handling is the subtle part. See SCHEDULED_PAX / CARGO below, and the assertion
against aggregate codes -- BTS defines K, V and Z as *sums* of other classes, so their presence
alongside their components would double-count traffic while still looking entirely plausible.
"""

import os
import sqlite3
import sys
import zipfile

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(OUT_DIR, "aviation.db")

YEARS = [2019, 2023, 2024]

# --- Service class semantics (from BTS lookup table L_SERVICE_CLASS) -------------------------
#
#   A  Scheduled First Class Passenger/Cargo
#   C  Scheduled Coach Passenger/Cargo
#   E  Scheduled Mixed First/Coach Passenger/Cargo
#   F  Scheduled Passenger/Cargo          <- the overwhelming majority of passenger rows
#   G  Scheduled All Cargo
#   L  Non-Scheduled Civilian Passenger/Cargo (charter)
#   P  Non-Scheduled Civilian All Cargo
#   N,R  Military.  H  Humane/non-revenue.  Q  Other non-scheduled.
#   K,V,Z  AGGREGATES of the above -- never mix these with their components.
#
# We score on *scheduled passenger service* because expansion decisions follow scheduled
# capacity, not charter activity. Charter (L) is excluded deliberately, not accidentally.
SCHEDULED_PAX = {"A", "C", "E", "F"}
CARGO = {"G", "P", "R"}
AGGREGATE_CODES = {"K", "V", "Z"}

# Haul bands in statute miles. OUR CONVENTION, not an industry standard -- stated as an
# assumption everywhere it surfaces in the product.
HAUL_SHORT_MAX = 800
HAUL_LONG_MIN = 2400


def log(msg):
    print(msg, flush=True)


def read_year(year):
    """Load one year of T-100 all-carrier segment data out of its zip."""
    path = os.path.join(RAW, f"t100_segment_all_carrier_{year}.zip")
    if not os.path.exists(path):
        raise FileNotFoundError(f"missing {path} -- run download_data.py first")
    with zipfile.ZipFile(path) as z:
        member = next(
            n for n in z.namelist()
            if n.lower().endswith(".csv") and "documentation" not in n.lower()
        )
        with z.open(member) as fh:
            df = pd.read_csv(fh, low_memory=False)
    df["YEAR"] = year
    return df


def validate(df, year):
    """Fail loudly on the data hazards that would silently corrupt every downstream number."""
    present = set(df["CLASS"].dropna().unique())

    overlap = present & AGGREGATE_CODES
    if overlap:
        raise ValueError(
            f"{year}: aggregate service classes {sorted(overlap)} present alongside components. "
            "Summing would double-count. Needs explicit handling before proceeding."
        )

    # Seats must never be less than passengers on a real segment; if it is, the row is suspect.
    pax_rows = df[df["CLASS"].isin(SCHEDULED_PAX)]
    bad = pax_rows[(pax_rows["SEATS"] > 0) & (pax_rows["PASSENGERS"] > pax_rows["SEATS"] * 1.02)]
    log(f"  {year}: classes present {sorted(present)}")
    log(f"  {year}: rows={len(df):,}  scheduled-pax rows={len(pax_rows):,}  "
        f"impossible load factor rows={len(bad):,}")
    return len(bad)


def build_airport_year(df):
    """One row per (airport, year): the metrics the score is computed from."""
    pax = df[df["CLASS"].isin(SCHEDULED_PAX)].copy()

    pax["IS_INTL"] = pax["DEST_COUNTRY"].fillna("US").ne("US") | pax["ORIGIN_COUNTRY"].fillna("US").ne("US")
    pax["HAUL"] = pd.cut(
        pax["DISTANCE"],
        bins=[-1, HAUL_SHORT_MAX, HAUL_LONG_MIN, float("inf")],
        labels=["short", "medium", "long"],
    )

    g = pax.groupby(["ORIGIN", "YEAR"], observed=True)
    base = g.agg(
        passengers=("PASSENGERS", "sum"),
        seats=("SEATS", "sum"),
        departures=("DEPARTURES_PERFORMED", "sum"),
        routes=("DEST", "nunique"),
        carriers=("UNIQUE_CARRIER", "nunique"),
        avg_distance=("DISTANCE", "mean"),
    ).reset_index()

    # Passengers split by haul band, then by domestic vs international.
    haul = (
        pax.pivot_table(index=["ORIGIN", "YEAR"], columns="HAUL", values="PASSENGERS",
                        aggfunc="sum", observed=True, fill_value=0)
        .rename(columns={"short": "pax_short", "medium": "pax_medium", "long": "pax_long"})
        .reset_index()
    )
    intl = (
        pax.pivot_table(index=["ORIGIN", "YEAR"], columns="IS_INTL", values="PASSENGERS",
                        aggfunc="sum", fill_value=0)
        .rename(columns={False: "pax_domestic", True: "pax_international"})
        .reset_index()
    )

    # Freight comes from cargo service classes, which carry no passengers at all.
    freight = (
        df[df["CLASS"].isin(CARGO)]
        .groupby(["ORIGIN", "YEAR"], observed=True)
        .agg(freight_lbs=("FREIGHT", "sum"), cargo_departures=("DEPARTURES_PERFORMED", "sum"))
        .reset_index()
    )

    # Human-readable identity, taken from the most frequent spelling in the data.
    ident = (
        df.groupby("ORIGIN", observed=True)
        .agg(city=("ORIGIN_CITY_NAME", lambda s: s.mode().iat[0] if len(s.mode()) else None),
             state=("ORIGIN_STATE_ABR", lambda s: s.mode().iat[0] if len(s.mode()) else None),
             country=("ORIGIN_COUNTRY", lambda s: s.mode().iat[0] if len(s.mode()) else None))
        .reset_index()
    )

    out = (
        base.merge(haul, on=["ORIGIN", "YEAR"], how="left")
        .merge(intl, on=["ORIGIN", "YEAR"], how="left")
        .merge(freight, on=["ORIGIN", "YEAR"], how="left")
        .merge(ident, on="ORIGIN", how="left")
    )

    for c in ["pax_short", "pax_medium", "pax_long", "pax_domestic",
              "pax_international", "freight_lbs", "cargo_departures"]:
        if c not in out:
            out[c] = 0
        out[c] = out[c].fillna(0)

    # --- derived metrics ---
    out["load_factor"] = (out["passengers"] / out["seats"] * 100).where(out["seats"] > 0)
    out["seats_per_departure"] = (out["seats"] / out["departures"]).where(out["departures"] > 0)
    out["pax_per_departure"] = (out["passengers"] / out["departures"]).where(out["departures"] > 0)
    denom = out[["pax_short", "pax_medium", "pax_long"]].sum(axis=1)
    out["long_haul_share"] = (out["pax_long"] / denom * 100).where(denom > 0)
    out["intl_share"] = (
        out["pax_international"] / (out["pax_domestic"] + out["pax_international"]) * 100
    ).where((out["pax_domestic"] + out["pax_international"]) > 0)

    return out.rename(columns={"ORIGIN": "iata", "YEAR": "year"})


def build_route_year(df):
    """One row per (origin, destination, year) for scheduled passenger service."""
    pax = df[df["CLASS"].isin(SCHEDULED_PAX)]
    r = (
        pax.groupby(["ORIGIN", "DEST", "YEAR"], observed=True)
        .agg(
            passengers=("PASSENGERS", "sum"),
            seats=("SEATS", "sum"),
            departures=("DEPARTURES_PERFORMED", "sum"),
            distance=("DISTANCE", "median"),
            carriers=("UNIQUE_CARRIER", "nunique"),
            dest_country=("DEST_COUNTRY", "first"),
        )
        .reset_index()
    )
    r["load_factor"] = (r["passengers"] / r["seats"] * 100).where(r["seats"] > 0)
    r["seats_per_departure"] = (r["seats"] / r["departures"]).where(r["departures"] > 0)
    r["is_international"] = r["dest_country"].fillna("US").ne("US").astype(int)
    r["haul"] = pd.cut(
        r["distance"],
        bins=[-1, HAUL_SHORT_MAX, HAUL_LONG_MIN, float("inf")],
        labels=["short", "medium", "long"],
    ).astype(str)
    return r.rename(columns={"ORIGIN": "origin", "DEST": "dest", "YEAR": "year"})


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    log("=== loading raw T-100 (all carriers, domestic + international) ===")
    frames = []
    suspect_total = 0
    for y in YEARS:
        df = read_year(y)
        suspect_total += validate(df, y)
        frames.append(df)
    all_df = pd.concat(frames, ignore_index=True)
    log(f"combined: {len(all_df):,} segment rows across {YEARS}")
    if suspect_total:
        log(f"NOTE: {suspect_total:,} rows had passengers > seats; retained but worth review")

    log("\n=== building airport_year ===")
    airport_year = build_airport_year(all_df)
    log(f"airport_year: {len(airport_year):,} rows, {airport_year['iata'].nunique():,} airports")

    log("=== building route_year ===")
    route_year = build_route_year(all_df)
    log(f"route_year: {len(route_year):,} rows")

    log(f"\n=== writing {DB_PATH} ===")
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    with sqlite3.connect(DB_PATH) as con:
        airport_year.to_sql("airport_year", con, index=False)
        route_year.to_sql("route_year", con, index=False)
        con.execute("CREATE INDEX idx_ay ON airport_year(iata, year)")
        con.execute("CREATE INDEX idx_ay_state ON airport_year(state, year)")
        con.execute("CREATE INDEX idx_ry_origin ON route_year(origin, year)")
        con.execute("CREATE INDEX idx_ry_pair ON route_year(origin, dest, year)")
    size_mb = os.path.getsize(DB_PATH) / 1024 / 1024
    log(f"done: {size_mb:.2f} MB")

    # ---- sanity output: these numbers must look like reality, not merely like numbers ----
    log("\n=== sanity check: 2024 scheduled passenger service ===")
    y24 = airport_year[airport_year["year"] == 2024].copy()
    cols = ["iata", "city", "passengers", "load_factor", "seats_per_departure",
            "long_haul_share", "intl_share", "routes"]
    top = y24.nlargest(10, "passengers")[cols]
    log(top.to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

    log("\n=== the four assignment questions, spot-checked ===")
    ne = ["ME", "NH", "VT", "MA", "RI", "CT"]
    ne_rows = y24[y24["state"].isin(ne)].nlargest(6, "passengers")[
        ["iata", "city", "state", "passengers", "load_factor", "seats_per_departure"]]
    log("\nNew England, top 6 by passengers:")
    log(ne_rows.to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

    log("\nLA basin vs Santa Ana (note SNA is itself in the LA metro):")
    la = y24[y24["iata"].isin(["LAX", "BUR", "LGB", "ONT", "SNA"])][
        ["iata", "city", "passengers", "load_factor", "seats_per_departure", "routes"]]
    log(la.to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

    anc = y24[y24["iata"] == "ANC"]
    if len(anc):
        a = anc.iloc[0]
        log(f"\nAnchorage 2024: long-haul share of passengers = {a['long_haul_share']:.1f}%")
        log(f"  scheduled passengers {a['passengers']:,.0f} | freight {a['freight_lbs']:,.0f} lbs")

    sfo = y24[y24["iata"] == "SFO"]
    if len(sfo):
        s = sfo.iloc[0]
        log(f"\nSFO 2024: load factor {s['load_factor']:.1f}%  seats/dep {s['seats_per_departure']:.0f}  "
            f"routes {s['routes']:.0f}")
        hist = airport_year[airport_year["iata"] == "SFO"][
            ["year", "passengers", "seats", "departures", "load_factor", "seats_per_departure"]]
        log("SFO across years (upgauging check -- seats/dep rising while departures flat?):")
        log(hist.to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
