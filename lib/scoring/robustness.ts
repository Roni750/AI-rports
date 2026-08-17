import { COMPONENT_LABELS, DEFAULT_WEIGHTS } from "./config";
import { scoreAirports } from "./score";
import type { Cohort, ComponentKey, ScoringInput, Weights } from "./types";

/**
 * How much of a ranking is an artefact of the weights we chose?
 *
 * The weights are judgement calls and there is no outcome data to calibrate them against, so
 * "what is the correct weighting" has no answer. "Which conclusions survive any reasonable
 * weighting" does, and is more useful to someone deciding where to put capital.
 *
 * So every ranking answer carries a one-line note: which entries hold their place under all the
 * weightings tested, and which depend on the choice. An airport that only ranks under one
 * weighting is a materially weaker recommendation than one that ranks under all of them, and the
 * user should not have to ask to learn that.
 *
 * Kept deliberately small: a fixed scenario set, one pass, one sentence out. Not a full
 * sensitivity study.
 */

/**
 * The scenarios tested. Fixed rather than random so results are reproducible and explainable:
 * the default, an even split, and one scenario emphasising each individual component.
 */
export const ROBUSTNESS_SCENARIOS: { label: string; weights: Partial<Weights> }[] = [
  { label: "default", weights: {} },
  {
    label: "equal weights",
    weights: {
      demandPressure: 0.25,
      capacityStrain: 0.25,
      growthMomentum: 0.25,
      frequencyConstraint: 0.25,
    },
  },
  {
    label: "load-factor led",
    weights: {
      demandPressure: 0.55,
      capacityStrain: 0.15,
      growthMomentum: 0.15,
      frequencyConstraint: 0.15,
    },
  },
  {
    label: "delay led",
    weights: {
      demandPressure: 0.15,
      capacityStrain: 0.55,
      growthMomentum: 0.15,
      frequencyConstraint: 0.15,
    },
  },
  {
    label: "growth led",
    weights: {
      demandPressure: 0.15,
      capacityStrain: 0.15,
      growthMomentum: 0.55,
      frequencyConstraint: 0.15,
    },
  },
  {
    label: "gauge led",
    weights: {
      demandPressure: 0.15,
      capacityStrain: 0.15,
      growthMomentum: 0.15,
      frequencyConstraint: 0.55,
    },
  },
];

/** How far a position may drift across scenarios and still count as stable. */
export const STABLE_RANK_DRIFT = 1;

export interface RobustnessEntry {
  iata: string;
  /** Position in the default ranking, 1-based. */
  defaultRank: number;
  /** Best and worst position observed across all scenarios. */
  bestRank: number;
  worstRank: number;
  /** How many scenarios kept the position within STABLE_RANK_DRIFT of the default. */
  stableIn: number;
  robust: boolean;
  /** The component carrying this airport, named for a human. Explains WHY it is weight-dependent. */
  drivenBy: ComponentKey;
  drivenByLabel: string;
}

export interface RobustnessReport {
  scenariosTested: number;
  topN: number;
  /**
   * True when the filtered population fits entirely in the requested list, so no airport can drop
   * out and only the ORDER can vary. Changes which stability test is meaningful.
   */
  allCandidatesShown: boolean;
  /** Airports that held a top-N place under every scenario. */
  robust: RobustnessEntry[];
  /** Airports that appeared under some scenarios but not all. */
  weightDependent: RobustnessEntry[];
  /**
   * One sentence, ready to relay verbatim. Deliberately plain language -- this text reaches an
   * end user, so it avoids "percentile", "cohort" and component identifiers.
   */
  note: string;
}

export interface RobustnessOptions {
  cohort?: Cohort;
  states?: readonly string[];
  iataFilter?: readonly string[];
  topN?: number;
}

function applyFilter(
  rows: ReturnType<typeof scoreAirports>,
  options: RobustnessOptions,
) {
  let out = rows;
  if (options.cohort) out = out.filter((r) => r.cohort === options.cohort);
  if (options.states?.length) {
    const set = new Set(options.states.map((s) => s.toUpperCase()));
    out = out.filter((r) => r.state && set.has(r.state.toUpperCase()));
  }
  if (options.iataFilter?.length) {
    const set = new Set(options.iataFilter.map((s) => s.toUpperCase()));
    out = out.filter((r) => set.has(r.iata));
  }
  return out;
}

/**
 * Re-rank under each scenario and report which entries are stable.
 *
 * Cost is one scoring pass per scenario over an in-memory array of a few hundred rows, so this is
 * cheap enough to run on every ranking request.
 */
export function assessRobustness(
  inputs: ScoringInput[],
  options: RobustnessOptions = {},
): RobustnessReport {
  const topN = options.topN ?? 5;

  const ranksByIata = new Map<string, number[]>();
  for (const scenario of ROBUSTNESS_SCENARIOS) {
    const ranked = applyFilter(scoreAirports(inputs, { weights: scenario.weights }), options);
    ranked.forEach((row, i) => {
      const list = ranksByIata.get(row.iata) ?? [];
      list.push(i + 1);
      ranksByIata.set(row.iata, list);
    });
  }

  // Default ranking decides the order we report in, and supplies each airport's driving component.
  const defaultRanked = applyFilter(scoreAirports(inputs), options);
  const defaultTop = defaultRanked.slice(0, topN);

  /**
   * Which stability test applies depends on the shape of the question, because the two cases ask
   * genuinely different things:
   *
   *  - LONG list (more candidates than places): the useful question is "does this airport stay on
   *    the shortlist whatever weighting I choose?" -- i.e. top-N membership. Exact position is not
   *    what an investor acts on; being on the list is.
   *
   *  - SHORT list (every candidate is shown, e.g. the 5 LA-basin airports): membership is
   *    vacuously true for everyone, so it measures nothing. Here only the ORDER can vary, so
   *    stability means the position barely moves.
   */
  const allCandidatesShown = defaultRanked.length <= topN;

  const entries: RobustnessEntry[] = defaultTop.map((row, i) => {
    const strongest = row.components.reduce((best, c) =>
      c.contribution > best.contribution ? c : best,
    );
    const defaultRank = i + 1;
    const observed = ranksByIata.get(row.iata) ?? [defaultRank];
    const stableIn = allCandidatesShown
      ? observed.filter((r) => Math.abs(r - defaultRank) <= STABLE_RANK_DRIFT).length
      : observed.filter((r) => r <= topN).length;
    return {
      iata: row.iata,
      defaultRank,
      bestRank: Math.min(...observed),
      worstRank: Math.max(...observed),
      stableIn,
      robust: stableIn === ROBUSTNESS_SCENARIOS.length,
      drivenBy: strongest.key,
      drivenByLabel: COMPONENT_LABELS[strongest.key],
    };
  });

  const robust = entries.filter((e) => e.robust);
  const weightDependent = entries.filter((e) => !e.robust);

  return {
    scenariosTested: ROBUSTNESS_SCENARIOS.length,
    topN,
    allCandidatesShown,
    robust,
    weightDependent,
    note: buildNote(robust, weightDependent, ROBUSTNESS_SCENARIOS.length, allCandidatesShown),
  };
}

function list(codes: string[]): string {
  if (codes.length === 0) return "";
  if (codes.length === 1) return codes[0];
  return `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
}

/**
 * One sentence, plain language, no internal vocabulary.
 *
 * Reports the stable entries, then singles out the LEAST stable one with what it leans on. Naming
 * every shaky entry made the note unreadable; the weakest link is the useful caveat.
 */
function buildNote(
  robust: RobustnessEntry[],
  weightDependent: RobustnessEntry[],
  scenarios: number,
  allCandidatesShown: boolean,
): string {
  if (robust.length === 0 && weightDependent.length === 0) return "";

  const parts: string[] = [];
  const verbPhrase = allCandidatesShown ? "keep their order" : "stay on this list";
  const verbPhraseSingular = allCandidatesShown ? "keeps its order" : "stays on this list";

  if (robust.length > 0) {
    const codes = list(robust.map((e) => e.iata));
    parts.push(
      `${codes} ${robust.length === 1 ? verbPhraseSingular : verbPhrase} under all ` +
        `${scenarios} weightings tested`,
    );
  }

  if (weightDependent.length > 0) {
    // Sorted by how unstable they are, so the weakest link leads.
    const sorted = [...weightDependent].sort((a, b) => a.stableIn - b.stableIn);
    const worst = sorted[0];
    const others = sorted.slice(1);

    let clause =
      `${worst.iata} is the least certain (${worst.stableIn} of ${scenarios} weightings, ` +
      `ranking anywhere from ${worst.bestRank}${ordinal(worst.bestRank)} to ` +
      `${worst.worstRank}${ordinal(worst.worstRank)}) and rests mainly on ${worst.drivenByLabel}`;

    if (others.length > 0) {
      clause += `; ${list(others.map((e) => `${e.iata} (${e.stableIn}/${scenarios})`))} also move`;
    }
    parts.push(clause);
  }

  const sentence = parts.join(". ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** The weights actually in force, for answers that need to state them. */
export function describeWeights(weights: Weights = DEFAULT_WEIGHTS): string {
  return (Object.keys(weights) as (keyof Weights)[])
    .map((k) => `${COMPONENT_LABELS[k]} ${Math.round(weights[k] * 100)}%`)
    .join(", ");
}
