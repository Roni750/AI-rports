/**
 * Run the brief's four questions through the tool layer.
 *
 * These are almost certainly what an interviewer types into the demo, so they must work end to end
 * and the traps in each must be handled visibly.
 */

import {
  compareAirports,
  explainScore,
  flightMix,
  getAirportMetrics,
  rankAirports,
  resolveAirport,
} from "../lib/tools/airport-tools";

function show(label: string, result: unknown) {
  console.log(`\n${"─".repeat(92)}\n${label}\n${"─".repeat(92)}`);
  console.log(JSON.stringify(result, null, 2));
}

// ── Q1: "Which airports in New England are strong candidates for terminal expansion?"
const q1 = rankAirports({ region: "new_england", limit: 5 });
console.log("\n\n### Q1 — New England expansion candidates ###");
if (q1.ok) {
  for (const r of q1.data.rows) {
    console.log(
      `  ${r.rank}. ${r.iata} (${r.city}) score ${r.score.toFixed(1)} [${r.cohort}] ` +
        `LF ${r.loadFactorPct?.toFixed(1) ?? "n/a"}%  NAS ${r.nasDelayMinPerArrival?.toFixed(2) ?? "n/a"}  ` +
        `driven by ${r.topComponent}`,
    );
  }
  console.log(`  weights: ${q1.data.weightsUsed}`);
  console.log(`  ROBUSTNESS: ${q1.data.robustnessNote}`);
  console.log(`  cohorts in list: ${q1.data.cohortsIncluded.join(", ")}`);
  q1.data.rows.length && console.log(`  population screened: ${q1.data.populationSize}`);
  for (const c of q1.caveats) console.log(`  caveat: ${c}`);
} else {
  console.log("  FAILED:", q1.message);
}

// ── Q2: "Compare LA and Santa Ana airport congestion levels."
console.log("\n\n### Q2 — Compare LA and Santa Ana ###");
const la = resolveAirport("LA");
console.log("  resolveAirport('LA'):");
if (la.ok) {
  console.log(`    kind = ${la.data.kind}`);
  for (const i of la.data.interpretations ?? []) {
    console.log(`      option: ${i.label} -> [${i.airports.join(", ")}] — ${i.description}`);
  }
  for (const n of la.data.notes) console.log(`    note: ${n}`);
}
const sna = resolveAirport("Santa Ana");
console.log("  resolveAirport('Santa Ana'):");
if (sna.ok) {
  console.log(`    kind = ${sna.data.kind}, airport = ${sna.data.airport?.iata}`);
  for (const n of sna.data.notes) console.log(`    note: ${n}`);
}
const cmp = compareAirports(["LAX", "SNA"]);
if (cmp.ok) {
  console.log("  compareAirports(['LAX','SNA']):");
  for (const r of cmp.data.rows) {
    console.log(
      `    ${r.iata}: LF ${r.loadFactorPct?.toFixed(1)}%  NAS ${r.nasDelayMinPerArrival?.toFixed(2)}  ` +
        `taxi-out ${r.taxiOutMinMean?.toFixed(1)}min  routes ${r.routes}  pax ${Math.round(r.passengers).toLocaleString("en-US")}`,
    );
  }
  console.log(`    same cohort: ${cmp.data.sameCohort}`);
  for (const o of cmp.data.observations) console.log(`    → ${o}`);
}

// ── Q3: "What is the percentage of long haul flights out of Anchorage airport?"
console.log("\n\n### Q3 — Long-haul share out of Anchorage ###");
const anc = flightMix("ANC");
if (anc.ok) {
  const d = anc.data;
  console.log(
    `  passengers ${Math.round(d.totalPassengers).toLocaleString("en-US")}  |  ` +
      `short ${d.haul.shortPct.toFixed(1)}%  medium ${d.haul.mediumPct.toFixed(1)}%  long ${d.haul.longPct.toFixed(1)}%`,
  );
  console.log(`  international share ${d.internationalPct.toFixed(1)}%`);
  if (d.freightNote) console.log(`  FREIGHT NOTE: ${d.freightNote}`);
  console.log(`  top routes: ${d.topRoutes.slice(0, 5).map((r) => `${r.dest}(${r.haul})`).join(", ")}`);
  for (const m of anc.metricDefinitions) console.log(`  definition: ${m}`);
}

// ── Q4: "What is the unmet flight demand in SFO airport and why?"
console.log("\n\n### Q4 — Unmet demand at SFO, and why ###");
const sfo = explainScore("SFO");
if (sfo.ok) {
  const d = sfo.data;
  console.log(`  score ${d.score.toFixed(1)} in ${d.cohort} (${d.cohortSize} peers)`);
  for (const c of d.components) {
    console.log(
      `    ${c.plainLabel.padEnd(40)} raw ${c.rawValue?.toFixed(2).padStart(8) ?? "    n/a"} ` +
        `pct ${c.percentileInCohort?.toFixed(1).padStart(5) ?? "  n/a"}  w ${c.weight.toFixed(2)}  ` +
        `= ${c.pointsContributed.toFixed(1)} pts`,
    );
  }
  if (d.seasonality) {
    console.log(
      `  seasonality: month ${d.seasonality.worstMonth} worst at ${d.seasonality.worstNasDelay.toFixed(2)}, ` +
        `month ${d.seasonality.bestMonth} best at ${d.seasonality.bestNasDelay.toFixed(2)} ` +
        `(${d.seasonality.swingRatio.toFixed(1)}x)`,
    );
  }
  for (const i of d.interpretation) console.log(`  → ${i}`);
}
const sfoRoutes = flightMix("SFO");
if (sfoRoutes.ok && sfoRoutes.data.constrainedRoutes.length) {
  console.log("  route-level evidence (load factor >= 88%):");
  for (const r of sfoRoutes.data.constrainedRoutes.slice(0, 5)) {
    console.log(`    SFO-${r.dest}: ${r.loadFactorPct.toFixed(1)}% on ${r.departures.toLocaleString("en-US")} departures`);
  }
}

// ── Error handling
console.log("\n\n### Error handling ###");
for (const bad of ["ZZZ", "", "Springfield"]) {
  const r = resolveAirport(bad);
  console.log(
    `  resolveAirport(${JSON.stringify(bad)}): ` +
      (r.ok ? `ok, kind=${r.data.kind}` : `${r.code} — ${r.message}`) +
      (!r.ok && r.suggestions ? ` | ${r.suggestions.join(" ")}` : ""),
  );
}
const noScore = explainScore("ZZZ");
console.log(`  explainScore('ZZZ'): ${noScore.ok ? "ok" : `${noScore.code} — ${noScore.message}`}`);
const badRank = rankAirports({ states: ["ZZ"] });
console.log(`  rankAirports(states=['ZZ']): ${badRank.ok ? "ok" : `${badRank.code} — ${badRank.message}`}`);
const oneCompare = compareAirports(["SFO"]);
console.log(`  compareAirports(['SFO']): ${oneCompare.ok ? "ok" : `${oneCompare.code} — ${oneCompare.message}`}`);

// ── A cross-cohort ranking must warn
console.log("\n\n### Cross-cohort ranking warning ###");
const mixed = rankAirports({ limit: 5 });
if (mixed.ok) {
  console.log(`  cohorts: ${mixed.data.cohortsIncluded.join(", ")}`);
  for (const c of mixed.caveats) console.log(`  caveat: ${c}`);
}

void show;
void getAirportMetrics;
