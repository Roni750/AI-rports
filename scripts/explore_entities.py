"""
Which entities are stable enough to model as dimensions, and where does that break down?

Specifically tests the assumption that "cargo airline" is a property of the airline. It isn't
cleanly: passenger carriers also carry freight in the belly of passenger aircraft, so cargo is
partly a segment-level fact and only partly a carrier-level attribute.
"""

import os
import zipfile

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")

SCHEDULED_PAX = {"A", "C", "E", "F"}
CARGO = {"G", "P", "R"}

with zipfile.ZipFile(os.path.join(RAW, "t100_segment_all_carrier_2024.zip")) as z:
    member = next(n for n in z.namelist()
                  if n.lower().endswith(".csv") and "documentation" not in n.lower())
    with z.open(member) as fh:
        df = pd.read_csv(fh, low_memory=False)

print(f"2024 segment rows: {len(df):,}\n")

# --- Is "cargo carrier" a clean carrier-level attribute? ---
per_carrier = df.groupby("UNIQUE_CARRIER").agg(
    rows=("CLASS", "size"),
    pax_rows=("CLASS", lambda s: s.isin(SCHEDULED_PAX).sum()),
    cargo_rows=("CLASS", lambda s: s.isin(CARGO).sum()),
    passengers=("PASSENGERS", "sum"),
    freight=("FREIGHT", "sum"),
)
per_carrier["is_all_cargo"] = (per_carrier["pax_rows"] == 0) & (per_carrier["cargo_rows"] > 0)
per_carrier["is_mixed"] = (per_carrier["pax_rows"] > 0) & (per_carrier["cargo_rows"] > 0)
per_carrier["pax_only"] = (per_carrier["pax_rows"] > 0) & (per_carrier["cargo_rows"] == 0)

print("=== Carrier classification, 2024 ===")
print(f"  all-cargo operators      : {per_carrier['is_all_cargo'].sum()}")
print(f"  mixed (pax AND cargo ops): {per_carrier['is_mixed'].sum()}")
print(f"  passenger-only operators : {per_carrier['pax_only'].sum()}")
print(f"  total carriers           : {len(per_carrier)}")

print("\n=== Top all-cargo operators by freight ===")
print(per_carrier[per_carrier["is_all_cargo"]].nlargest(6, "freight")[["freight", "cargo_rows"]]
      .apply(lambda c: c.map(lambda v: f"{v:,.0f}")).to_string())

print("\n=== THE COMPLICATION: freight carried on SCHEDULED PASSENGER segments ===")
pax_seg = df[df["CLASS"].isin(SCHEDULED_PAX)]
belly = pax_seg.groupby("UNIQUE_CARRIER")["FREIGHT"].sum().sort_values(ascending=False)
print("Freight (lbs) moved on passenger-service segments, top 8 carriers:")
print(belly.head(8).map(lambda v: f"{v:,.0f}").to_string())
total_pax_freight = pax_seg["FREIGHT"].sum()
total_cargo_freight = df[df["CLASS"].isin(CARGO)]["FREIGHT"].sum()
print(f"\n  freight on passenger segments : {total_pax_freight:,.0f} lbs")
print(f"  freight on all-cargo segments : {total_cargo_freight:,.0f} lbs")
print(f"  passenger-segment share of all freight: "
      f"{total_pax_freight / (total_pax_freight + total_cargo_freight) * 100:.1f}%")

# --- Are IATA codes stable enough to be a primary key? ---
print("\n=== Identifier stability: do IATA codes map 1:1 to BTS airport IDs? ===")
ids = df[["ORIGIN", "ORIGIN_CITY_NAME"]].drop_duplicates()
dupes = ids[ids.duplicated("ORIGIN", keep=False)].sort_values("ORIGIN")
print(f"  distinct ORIGIN codes: {df['ORIGIN'].nunique():,}")
print(f"  ORIGIN codes with more than one city name: {dupes['ORIGIN'].nunique()}")
if len(dupes):
    print(dupes.head(10).to_string(index=False))

print("\n=== Carrier code reuse (BTS documents suffixes like PA, PA(1), PA(2)) ===")
suffixed = [c for c in df["UNIQUE_CARRIER"].dropna().unique() if "(" in str(c)]
print(f"  carrier codes carrying a reuse suffix in 2024: {len(suffixed)}")
if suffixed:
    print("  examples:", sorted(suffixed)[:10])

print("\n=== Aircraft types in use (a dimension we currently ignore) ===")
print(f"  distinct AIRCRAFT_TYPE codes: {df['AIRCRAFT_TYPE'].nunique()}")
top_ac = pax_seg.groupby("AIRCRAFT_TYPE")["SEATS"].sum().nlargest(5)
print("  top 5 by seats offered on passenger service:")
print(top_ac.map(lambda v: f"{v:,.0f}").to_string())
