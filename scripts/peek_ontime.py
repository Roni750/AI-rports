"""Inspect the On-Time Performance schema before building on it."""

import os
import zipfile

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
path = os.path.join(RAW, "ontime_2024_01.zip")

with zipfile.ZipFile(path) as z:
    print("members:", z.namelist())
    member = next(n for n in z.namelist()
                  if n.lower().endswith(".csv") and "readme" not in n.lower())
    info = z.getinfo(member)
    print(f"{member}: {info.file_size / 1024 / 1024:.1f} MB uncompressed")
    with z.open(member) as fh:
        df = pd.read_csv(fh, nrows=50_000, low_memory=False)

print(f"\nsampled {len(df):,} rows, {len(df.columns)} columns\n")
print("ALL COLUMNS:")
for c in df.columns:
    print(f"  {c}")

delay_cols = [c for c in df.columns if "Delay" in c or "delay" in c]
print(f"\ndelay-related columns: {delay_cols}")

interesting = [c for c in ["Origin", "Dest", "DepDelayMinutes", "ArrDelayMinutes", "DepDel15",
                           "TaxiOut", "TaxiIn", "Cancelled", "CancellationCode", "Diverted",
                           "CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay",
                           "LateAircraftDelay"] if c in df.columns]
print(f"\nnull rate for the columns we care about (sample of {len(df):,}):")
for c in interesting:
    nn = df[c].notna().sum()
    print(f"  {c:<22} non-null {nn:>7,} ({nn / len(df) * 100:5.1f}%)   mean={df[c].mean() if pd.api.types.is_numeric_dtype(df[c]) else 'n/a'}")

if "CancellationCode" in df:
    print("\ncancellation codes present:", sorted(df["CancellationCode"].dropna().unique()))
