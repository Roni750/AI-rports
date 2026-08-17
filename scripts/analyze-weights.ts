/**
 * Diagnostics for the composite index: are the components worth their weights?
 *
 * Three questions a composite index has to answer before anyone should trust it:
 *
 *   1. DISCRIMINATION -- does the component actually separate the population, or is everyone
 *      clustered together? A variable where every airport scores the same carries no information,
 *      however causally important it sounds.
 *
 *   2. REDUNDANCY -- are components correlated? Two highly-correlated components are the same
 *      measurement counted twice, which silently doubles its real weight.
 *
 *   3. ROBUSTNESS -- which conclusions survive any reasonable weighting? With hand-set weights and
 *      no outcome data to calibrate against, that is the only defensible kind of conclusion.
 *
 * Run: npx tsx scripts/analyze-weights.ts
 */

import { loadScoringInputs } from "../lib/data/db";
import { scoreAirports } from "../lib/scoring/score";
import type { ComponentKey, ScoredAirport, Weights } from "../lib/scoring/types";

const KEYS: ComponentKey[] = [
  "demandPressure",
  "capacityStrain",
  "growthMomentum",
  "frequencyConstraint",
];

const inputs = loadScoringInputs();
const scored = scoreAirports(inputs);

function stats(values: number[]) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
  return { n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: v[v.length - 1], mean, sd };
}

/** Spearman correlation = Pearson on ranks. Robust to the non-normal shapes here. */
function spearman(a: number[], b: number[]): number | null {
  const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 4) return null;
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(vals.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function raws(rows: ScoredAirport[], key: ComponentKey) {
  return rows
    .map((r) => r.components.find((c) => c.key === key)!.rawValue)
    .filter((v): v is number => v !== null);
}

function pcts(rows: ScoredAirport[], key: ComponentKey) {
  return rows.map((r) => r.components.find((c) => c.key === key)!.percentile ?? NaN);
}

for (const cohort of ["large_hub", "medium_hub", "small_hub"] as const) {
  const rows = scored.filter((s) => s.cohort === cohort);
  console.log(`\n${"=".repeat(96)}`);
  console.log(`COHORT: ${cohort}  (${rows.length} airports)`);
  console.log("=".repeat(96));

  console.log("\n--- 1. DISCRIMINATION: raw-value spread (CV = sd/|mean|, higher = more separation) ---");
  console.log("component              n     min     p25  median     p75     max      sd      CV");
  for (const k of KEYS) {
    const s = stats(raws(rows, k));
    if (!s) { console.log(`${k.padEnd(20)}  no data`); continue; }
    const cv = Math.abs(s.mean) > 1e-9 ? s.sd / Math.abs(s.mean) : NaN;
    console.log(
      `${k.padEnd(20)} ${String(s.n).padStart(3)} ${s.min.toFixed(1).padStart(7)} ${s.p25.toFixed(1).padStart(7)} ` +
      `${s.median.toFixed(1).padStart(7)} ${s.p75.toFixed(1).padStart(7)} ${s.max.toFixed(1).padStart(7)} ` +
      `${s.sd.toFixed(1).padStart(7)} ${(cv * 100).toFixed(0).padStart(6)}%`,
    );
  }

  console.log("\n--- 2. REDUNDANCY: Spearman correlation between component percentiles ---");
  console.log("                     " + KEYS.map((k) => k.slice(0, 8).padStart(9)).join(""));
  for (const a of KEYS) {
    let line = a.padEnd(20);
    for (const b of KEYS) {
      const r = spearman(pcts(rows, a), pcts(rows, b));
      line += (r === null ? "     n/a" : r.toFixed(2).padStart(9));
    }
    console.log(line);
  }
}

console.log(`\n${"=".repeat(96)}`);
console.log("3. ROBUSTNESS: which large hubs survive every reasonable weighting?");
console.log("=".repeat(96));

const scenarios: { label: string; w: Partial<Weights> }[] = [
  { label: "current default (35/25/25/15)", w: {} },
  { label: "proposed (30/25/25/20)", w: { demandPressure: 0.30, capacityStrain: 0.25, growthMomentum: 0.25, frequencyConstraint: 0.20 } },
  { label: "frequency-heavy (25/25/20/30)", w: { demandPressure: 0.25, capacityStrain: 0.25, growthMomentum: 0.20, frequencyConstraint: 0.30 } },
  { label: "equal (25/25/25/25)", w: { demandPressure: 0.25, capacityStrain: 0.25, growthMomentum: 0.25, frequencyConstraint: 0.25 } },
  { label: "demand-heavy (50/20/20/10)", w: { demandPressure: 0.50, capacityStrain: 0.20, growthMomentum: 0.20, frequencyConstraint: 0.10 } },
  { label: "strain-heavy (20/50/20/10)", w: { demandPressure: 0.20, capacityStrain: 0.50, growthMomentum: 0.20, frequencyConstraint: 0.10 } },
];

const appearances = new Map<string, number>();
const rankSums = new Map<string, number>();
for (const s of scenarios) {
  const top = scoreAirports(inputs, { weights: s.w })
    .filter((r) => r.cohort === "large_hub")
    .slice(0, 8);
  console.log(`  ${s.label.padEnd(32)} ${top.map((r) => r.iata).join(", ")}`);
  top.forEach((r, i) => {
    appearances.set(r.iata, (appearances.get(r.iata) ?? 0) + 1);
    rankSums.set(r.iata, (rankSums.get(r.iata) ?? 0) + i + 1);
  });
}

console.log(`\n  Robustness across ${scenarios.length} weightings (top-8 appearances):`);
[...appearances.entries()]
  .sort((a, b) => b[1] - a[1] || rankSums.get(a[0])! - rankSums.get(b[0])!)
  .forEach(([iata, n]) => {
    const avg = rankSums.get(iata)! / n;
    const flag = n === scenarios.length ? "  <- robust in ALL" : "";
    console.log(`    ${iata}  appears ${n}/${scenarios.length}  avg rank ${avg.toFixed(1)}${flag}`);
  });

console.log("\n  How much does the default-vs-proposed change actually move things?");
const base = scoreAirports(inputs).filter((r) => r.cohort === "large_hub");
const prop = scoreAirports(inputs, {
  weights: { demandPressure: 0.30, capacityStrain: 0.25, growthMomentum: 0.25, frequencyConstraint: 0.20 },
}).filter((r) => r.cohort === "large_hub");
const posBase = new Map(base.map((r, i) => [r.iata, i]));
let moved = 0, maxMove = 0, maxMover = "";
prop.forEach((r, i) => {
  const d = Math.abs(i - posBase.get(r.iata)!);
  if (d > 0) moved++;
  if (d > maxMove) { maxMove = d; maxMover = r.iata; }
});
console.log(`    ${moved} of ${prop.length} large hubs change position; largest move ${maxMove} places (${maxMover})`);
