"""Quick look inside a downloaded BTS zip: columns, row count, and a couple of sanity aggregates."""

import sys
import zipfile

import pandas as pd

path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    print("members:", names)
    data_member = next(n for n in names if "documentation" not in n.lower() and n.lower().endswith(".csv"))
    print("reading:", data_member)
    with z.open(data_member) as fh:
        df = pd.read_csv(fh, low_memory=False)

print(f"\nshape: {df.shape[0]:,} rows x {df.shape[1]} cols")
print("\ncolumns:")
for c in df.columns:
    print(f"  {c}")

if "CLASS" in df:
    print("\nservice class counts:")
    print(df["CLASS"].value_counts().to_string())

if "CARRIER_GROUP" in df:
    print("\ncarrier group counts (which are foreign carriers?):")
    print(df["CARRIER_GROUP"].value_counts().to_string())

if {"ORIGIN", "PASSENGERS", "SEATS"} <= set(df.columns):
    sched = df[df["CLASS"] == "F"] if "CLASS" in df else df
    g = sched.groupby("ORIGIN")[["PASSENGERS", "SEATS"]].sum()
    g = g[g["SEATS"] > 0]
    g["LOAD_FACTOR"] = g["PASSENGERS"] / g["SEATS"] * 100
    print("\ntop 8 origins by passengers (CLASS F = scheduled passenger service):")
    print(g.sort_values("PASSENGERS", ascending=False).head(8).round(1).to_string())

if "DEST_COUNTRY" in df:
    intl = df[df["DEST_COUNTRY"] != "US"]
    print(f"\ninternational rows (DEST_COUNTRY != US): {len(intl):,} of {len(df):,}")
    print("top destination countries:")
    print(intl["DEST_COUNTRY"].value_counts().head(8).to_string())

if "FREIGHT" in df:
    print("\ntop 6 origins by freight (lbs) — expect Anchorage high:")
    print(df.groupby("ORIGIN")["FREIGHT"].sum().sort_values(ascending=False).head(6).map(lambda v: f"{v:,.0f}").to_string())
