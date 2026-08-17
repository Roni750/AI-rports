"""
Does the capacity-constraint signal actually discriminate between airports?

Before committing to a scoring formula, check that its inputs vary meaningfully across airports.
A metric that assigns everyone the same value is worthless regardless of how principled it sounds.

The constraint signature we hypothesised:
  high load factor           -> aircraft are full
  seats/departure RISING     -> carriers are upgauging (bigger aircraft)
  departures FLAT or FALLING -> ... while not adding flights, implying they cannot
  passengers GROWING         -> and demand is still increasing

All four together is a much stronger claim than any one alone.
"""

import os
import sqlite3

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "aviation.db")

con = sqlite3.connect(DB)
ay = pd.read_sql("SELECT * FROM airport_year", con)
con.close()

# US airports only -- international segments bring foreign origins into the table.
ay = ay[ay["country"] == "US"]

wide = ay.pivot_table(
    index=["iata", "city", "state"],
    columns="year",
    values=["passengers", "seats", "departures", "load_factor", "seats_per_departure"],
).reset_index()
wide.columns = ["_".join(str(c) for c in col).strip("_") for col in wide.columns]

# Only airports with real scheduled service in 2024 -- below ~500k passengers the year-on-year
# numbers are dominated by single route additions and the signal is noise.
wide = wide[wide["passengers_2024"] >= 500_000].copy()

wide["lf_2024"] = wide["load_factor_2024"]
wide["upgauge_pct"] = (wide["seats_per_departure_2024"] / wide["seats_per_departure_2019"] - 1) * 100
wide["dep_change_pct"] = (wide["departures_2024"] / wide["departures_2019"] - 1) * 100
wide["pax_growth_19_24"] = (wide["passengers_2024"] / wide["passengers_2019"] - 1) * 100
wide["pax_growth_23_24"] = (wide["passengers_2024"] / wide["passengers_2023"] - 1) * 100

print(f"US airports with >=500k scheduled passengers in 2024: {len(wide)}\n")

print("=== Do the inputs actually vary? (if these ranges are narrow, the score is useless) ===")
for col in ["lf_2024", "upgauge_pct", "dep_change_pct", "pax_growth_19_24", "pax_growth_23_24"]:
    s = wide[col].dropna()
    print(f"  {col:<20} min={s.min():7.1f}  p25={s.quantile(.25):7.1f}  "
          f"median={s.median():7.1f}  p75={s.quantile(.75):7.1f}  max={s.max():7.1f}  sd={s.std():6.1f}")

# The full constraint signature: full planes, bigger planes, no more flights, still growing.
sig = wide[
    (wide["lf_2024"] >= wide["lf_2024"].quantile(0.60))
    & (wide["upgauge_pct"] > 0)
    & (wide["dep_change_pct"] <= 0)
    & (wide["pax_growth_23_24"] > 0)
].copy()

cols = ["iata", "city", "state", "passengers_2024", "lf_2024", "upgauge_pct",
        "dep_change_pct", "pax_growth_19_24", "pax_growth_23_24"]

print(f"\n=== Airports matching ALL FOUR constraint conditions: {len(sig)} of {len(wide)} ===")
print(sig.sort_values("passengers_2024", ascending=False)[cols]
      .head(20).to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

print("\n=== For contrast: clearly NOT constrained (adding flights, emptier planes) ===")
loose = wide[(wide["dep_change_pct"] > 5) & (wide["lf_2024"] < wide["lf_2024"].median())]
print(loose.sort_values("passengers_2024", ascending=False)[cols]
      .head(10).to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

print("\n=== Highest load factors (the crude single-metric answer, for comparison) ===")
print(wide.nlargest(12, "lf_2024")[cols].to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

print("\n=== Strongest upgauging (bigger aircraft, same or fewer flights) ===")
ug = wide[wide["dep_change_pct"] <= 0]
print(ug.nlargest(12, "upgauge_pct")[cols].to_string(index=False, float_format=lambda v: f"{v:,.1f}"))

print("\n=== New England specifically (the assignment's first question) ===")
ne = wide[wide["state"].isin(["ME", "NH", "VT", "MA", "RI", "CT"])]
print(ne.sort_values("passengers_2024", ascending=False)[cols]
      .to_string(index=False, float_format=lambda v: f"{v:,.1f}"))
