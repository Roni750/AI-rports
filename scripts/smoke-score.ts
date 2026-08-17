/**
 * End-to-end smoke test: load real data, score it, and check the output against reality.
 *
 * Unit tests prove the arithmetic. This proves the arithmetic applied to actual data produces
 * rankings a domain expert would recognise — the failure mode tests cannot catch.
 *
 * Run: npx tsx scripts/smoke-score.ts
 */

import { loadDelayMonths, loadScoringInputs } from "../lib/data/db";
import { NEW_ENGLAND_STATES } from "../lib/scoring/config";
import { scoreAirports } from "../lib/scoring/score";
import type { ScoredAirport } from "../lib/scoring/types";

const inputs = loadScoringInputs();
console.log(`loaded ${inputs.length} US airports with 2024 service`);
const withDelay = inputs.filter((i) => i.nasDelayMinutesPerArrival !== null).length;
console.log(`  of which ${withDelay} have usable delay data\n`);

const scored = scoreAirports(inputs);
console.log(`scored ${scored.length} airports (above the ranking floor)\n`);

const byCohort = new Map<string, number>();
for (const s of scored) byCohort.set(s.cohort, (byCohort.get(s.cohort) ?? 0) + 1);
console.log("cohort sizes:", Object.fromEntries(byCohort), "\n");

function table(rows: ScoredAirport[]) {
  const fmt = (n: number | null, d = 1) => (n === null ? "  n/a" : n.toFixed(d).padStart(6));
  console.log(
    "iata  score  cohort        " +
      "demand  strain  growth  freq   | LF     NASdly  growth%",
  );
  for (const r of rows) {
    const c = (k: string) => r.components.find((x) => x.key === k)!;
    console.log(
      `${r.iata.padEnd(5)} ${r.score.toFixed(1).padStart(5)}  ${r.cohort.padEnd(12)} ` +
        `${fmt(c("demandPressure").percentile)} ${fmt(c("capacityStrain").percentile)} ` +
        `${fmt(c("growthMomentum").percentile)} ${fmt(c("frequencyConstraint").percentile)}  | ` +
        `${fmt(c("demandPressure").rawValue)} ${fmt(c("capacityStrain").rawValue, 2)} ` +
        `${fmt(c("growthMomentum").rawValue)}`,
    );
  }
}

// Deliberately NOT a cross-cohort "overall" ranking. Percentiles are computed within cohort, so
// a medium hub's 97 and a large hub's 83 were measured against different populations and are not
// comparable. Reporting them in one ordered list would be a category error.
for (const cohort of ["large_hub", "medium_hub", "small_hub", "non_hub"] as const) {
  const rows = scored.filter((s) => s.cohort === cohort);
  if (rows.length === 0) continue;
  console.log(`\n=== TOP ${cohort.toUpperCase()} (${rows.length} in cohort) ===`);
  table(rows.slice(0, 10));
}

console.log("\n=== NEW ENGLAND (assignment question 1) ===");
table(scored.filter((s) => s.state && NEW_ENGLAND_STATES.includes(s.state as never)));

console.log("\n=== LA BASIN (assignment question 2) ===");
table(scored.filter((s) => ["LAX", "SNA", "ONT", "BUR", "LGB"].includes(s.iata)));

console.log("\n=== SFO score breakdown (assignment question 4) ===");
const sfo = scored.find((s) => s.iata === "SFO");
if (sfo) {
  console.log(`SFO  score ${sfo.score.toFixed(1)}  cohort ${sfo.cohort} (${sfo.cohortSize} peers)`);
  for (const c of sfo.components) {
    const pct = c.percentile === null ? "unavailable" : `${c.percentile.toFixed(1)}th pct`;
    const raw = c.rawValue === null ? "n/a" : c.rawValue.toFixed(2);
    console.log(
      `  ${c.key.padEnd(20)} raw=${raw.padStart(8)} ${c.unit.padEnd(58)} ` +
        `${pct.padStart(14)}  w=${c.weight.toFixed(2)}  contributes ${c.contribution.toFixed(1)}`,
    );
    if (c.unavailableReason) console.log(`      reason: ${c.unavailableReason}`);
  }
  const months = loadDelayMonths("SFO");
  const worst = months.reduce((a, b) =>
    (b.nasDelayMinPerArrival ?? 0) > (a.nasDelayMinPerArrival ?? 0) ? b : a,
  );
  const best = months.reduce((a, b) =>
    (b.nasDelayMinPerArrival ?? 99) < (a.nasDelayMinPerArrival ?? 99) ? b : a,
  );
  console.log(
    `  seasonality: worst month ${worst.month} at ${worst.nasDelayMinPerArrival?.toFixed(2)} ` +
      `NAS min/arrival, best month ${best.month} at ${best.nasDelayMinPerArrival?.toFixed(2)} ` +
      `(${((worst.nasDelayMinPerArrival ?? 0) / (best.nasDelayMinPerArrival ?? 1)).toFixed(1)}x swing)`,
  );
}

console.log("\n=== SENSITIVITY: does the large-hub ranking hold under different weights? ===");
const variants: { label: string; weights: Record<string, number> }[] = [
  { label: "default", weights: {} },
  { label: "demand-only", weights: { demandPressure: 1, capacityStrain: 0, growthMomentum: 0, frequencyConstraint: 0 } },
  { label: "strain-only", weights: { demandPressure: 0, capacityStrain: 1, growthMomentum: 0, frequencyConstraint: 0 } },
  { label: "growth-only", weights: { demandPressure: 0, capacityStrain: 0, growthMomentum: 1, frequencyConstraint: 0 } },
  { label: "equal", weights: { demandPressure: 0.25, capacityStrain: 0.25, growthMomentum: 0.25, frequencyConstraint: 0.25 } },
];
for (const v of variants) {
  const top = scoreAirports(inputs, { weights: v.weights })
    .filter((s) => s.cohort === "large_hub")
    .slice(0, 6)
    .map((s) => s.iata)
    .join(", ");
  console.log(`  ${v.label.padEnd(12)} ${top}`);
}
