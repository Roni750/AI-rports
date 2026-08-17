/** What the robustness note actually says on real data, for the questions in the brief. */

import { loadScoringInputs } from "../lib/data/db";
import { NEW_ENGLAND_STATES } from "../lib/scoring/config";
import { assessRobustness, describeWeights } from "../lib/scoring/robustness";
import { scoreAirports } from "../lib/scoring/score";

const inputs = loadScoringInputs();

console.log(`weights in force: ${describeWeights()}\n`);

const cases = [
  { label: "Large hubs, top 5", opts: { cohort: "large_hub" as const, topN: 5 } },
  { label: "New England, top 5", opts: { states: NEW_ENGLAND_STATES, topN: 5 } },
  { label: "Medium hubs, top 5", opts: { cohort: "medium_hub" as const, topN: 5 } },
  { label: "Small hubs, top 5", opts: { cohort: "small_hub" as const, topN: 5 } },
  { label: "LA basin", opts: { iataFilter: ["LAX", "SNA", "ONT", "BUR", "LGB"], topN: 5 } },
];

for (const c of cases) {
  const ranked = scoreAirports(inputs)
    .filter((r) => {
      if (c.opts.cohort && r.cohort !== c.opts.cohort) return false;
      if (c.opts.states && !(r.state && (c.opts.states as readonly string[]).includes(r.state))) return false;
      if (c.opts.iataFilter && !c.opts.iataFilter.includes(r.iata)) return false;
      return true;
    })
    .slice(0, c.opts.topN);

  const report = assessRobustness(inputs, c.opts);
  console.log(`--- ${c.label} ---`);
  console.log(`  ranking: ${ranked.map((r) => `${r.iata} ${r.score.toFixed(1)}`).join("  ")}`);
  console.log(`  NOTE: ${report.note}\n`);
}
