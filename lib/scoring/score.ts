import {
  COHORT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  GROWTH_BLEND,
  GROWTH_SHRINKAGE,
  MIN_PASSENGERS_FOR_INCLUSION,
} from "./config";
import { percentileRankAll } from "./percentile";
import type {
  Cohort,
  ComponentKey,
  ComponentScore,
  ScoredAirport,
  ScoringInput,
  Weights,
} from "./types";

/**
 * The Expansion Opportunity Score.
 *
 * Deterministic by construction: same inputs and weights always produce identical output. No
 * language model is involved at any point in this file. The model's role is to choose which
 * question to ask of this code and to narrate the answer -- never to compute it.
 *
 * Four components, each converted to a percentile within the airport's size cohort, then combined
 * as a weighted sum:
 *
 *   demandPressure       load factor -- are the aircraft full?
 *   capacityStrain       delay minutes per departure -- is the airport struggling today?
 *   growthMomentum       passenger growth -- is demand still rising?
 *   frequencyConstraint  seat growth delivered by larger aircraft rather than more flights
 *
 * frequencyConstraint deserves explanation. If an airport's seat capacity grew mostly through
 * bigger aircraft rather than additional departures, that is consistent with carriers being
 * unable to add flights -- a slot or gate constraint. Crucially it is measured as a percentile
 * against peers, not absolutely, because between 2019 and 2024 the median US airport upgauged
 * 12.5% while losing 2.8% of departures. That industry-wide fleet shift would otherwise mark
 * nearly every airport as constrained.
 */

// ------------------------------------------------------------------ cohorts

/** Assign a cohort from an airport's share of national scheduled passengers. */
export function cohortForShare(nationalSharePct: number): Cohort {
  for (const t of COHORT_THRESHOLDS) {
    if (nationalSharePct >= t.minNationalSharePct) return t.cohort;
  }
  return "non_hub";
}

// ------------------------------------------------------------ raw components

/** Load factor: passengers as a percentage of available seats. */
function rawDemandPressure(input: ScoringInput): number | null {
  return input.current.loadFactor;
}

/** Observable strain today. Null when delay data has not been loaded. */
function rawCapacityStrain(input: ScoringInput): number | null {
  return input.nasDelayMinutesPerArrival;
}

/**
 * Regularised growth rate: additive smoothing on the denominator.
 *
 *     (current - baseline) / (baseline + shrinkage) * 100
 *
 * Without the shrinkage term, a percentage change from a small base is high-variance and not
 * comparable to the same percentage from a large base -- the "100% positive reviews, from one
 * review" problem. Adding a constant damps small-base rates hard while leaving large airports
 * essentially untouched, so small airports stay in the ranking (they are legitimate, often
 * cheaper, expansion candidates) but must show real absolute growth to score well.
 */
function shrunkGrowth(current: number, baseline: number, shrinkage: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  const denom = baseline + shrinkage;
  if (denom <= 0) return null;
  return ((current - baseline) / denom) * 100;
}

/**
 * Blended passenger growth: structural (vs baseline year) and recent (vs previous year).
 * Falls back to whichever is available rather than returning null when only one exists.
 */
function rawGrowthMomentum(input: ScoringInput): number | null {
  const { current, previous, baseline } = input;
  const k = GROWTH_SHRINKAGE.passengers;

  const structural = baseline
    ? shrunkGrowth(current.passengers, baseline.passengers, k)
    : null;
  const recent = previous ? shrunkGrowth(current.passengers, previous.passengers, k) : null;

  if (structural === null && recent === null) return null;
  if (structural === null) return recent;
  if (recent === null) return structural;

  return structural * GROWTH_BLEND.structuralWeight + recent * GROWTH_BLEND.recentWeight;
}

/**
 * How much of the airport's seat growth came from larger aircraft rather than more flights.
 *
 * seatGrowth - departureGrowth, in percentage points. Positive means capacity was added by
 * upgauging; strongly positive alongside flat or falling departures is the constraint signature.
 *
 * Both rates are regularised, for the same reason as growth momentum: at a tiny airport, adding
 * one larger aircraft swings both ratios wildly and the difference between them is noise.
 *
 * Measured as a percentile against cohort peers, never absolutely -- between 2019 and 2024 the
 * median US airport upgauged 12.5% while losing 2.8% of departures, an industry-wide fleet shift
 * that would otherwise mark nearly every airport as constrained.
 */
function rawFrequencyConstraint(input: ScoringInput): number | null {
  const { current, baseline } = input;
  if (!baseline) return null;

  const seatGrowth = shrunkGrowth(current.seats, baseline.seats, GROWTH_SHRINKAGE.seats);
  const departureGrowth = shrunkGrowth(
    current.departures,
    baseline.departures,
    GROWTH_SHRINKAGE.departures,
  );
  if (seatGrowth === null || departureGrowth === null) return null;
  return seatGrowth - departureGrowth;
}

const COMPONENT_SPECS: {
  key: ComponentKey;
  unit: string;
  raw: (i: ScoringInput) => number | null;
  unavailableReason: string;
}[] = [
  {
    key: "demandPressure",
    unit: "% load factor",
    raw: rawDemandPressure,
    unavailableReason: "no seats reported for scheduled passenger service",
  },
  {
    key: "capacityStrain",
    unit: "NAS delay minutes per arrival",
    raw: rawCapacityStrain,
    unavailableReason:
      "not covered by the On-Time Performance dataset, which reaches only larger reporting carriers",
  },
  {
    key: "growthMomentum",
    unit: "% passenger growth (blended)",
    raw: rawGrowthMomentum,
    unavailableReason: "no comparison year available",
  },
  {
    key: "frequencyConstraint",
    unit: "percentage points of seat growth from gauge rather than frequency",
    raw: rawFrequencyConstraint,
    unavailableReason: "no baseline year available",
  },
];

// -------------------------------------------------------------------- scoring

/**
 * Redistribute the weights of unavailable components across the available ones.
 *
 * Without this, an airport missing delay data would score 25 points lower than an identical
 * airport that has it -- penalised for a gap in our data rather than for anything about the
 * airport. Renormalising keeps scores comparable; `unavailableReason` on the component records
 * that it happened so the omission is visible rather than hidden.
 */
function renormalise(weights: Weights, available: ComponentKey[]): Weights {
  const total = available.reduce((sum, k) => sum + weights[k], 0);
  const out = { ...weights };
  for (const k of Object.keys(out) as ComponentKey[]) {
    out[k] = available.includes(k) && total > 0 ? weights[k] / total : 0;
  }
  return out;
}

export interface ScoreOptions {
  weights?: Partial<Weights>;
  /**
   * Drop the data-quality passenger floor entirely, including airports with only a handful of
   * scheduled flights. Off by default because their metrics are noise, not because small airports
   * are uninteresting -- the floor is set low precisely so small airports are ranked normally.
   */
  includeAllAirports?: boolean;
}

/**
 * Score a population of airports.
 *
 * Takes the whole population rather than one airport at a time, because percentiles are only
 * meaningful relative to peers. Scoring a single airport in isolation is not a supported
 * operation -- by design, since it would have no defensible answer.
 */
export function scoreAirports(
  inputs: ScoringInput[],
  options: ScoreOptions = {},
): ScoredAirport[] {
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };

  const eligible = options.includeAllAirports
    ? inputs
    : inputs.filter((i) => i.current.passengers >= MIN_PASSENGERS_FOR_INCLUSION);
  if (eligible.length === 0) return [];

  // National share is computed over the eligible population, and the denominator is stated in
  // DESIGN.md so the cohort boundaries can be reproduced exactly.
  const nationalPassengers = eligible.reduce((sum, i) => sum + i.current.passengers, 0);

  const withCohort = eligible.map((input) => {
    const nationalShare =
      nationalPassengers > 0 ? (input.current.passengers / nationalPassengers) * 100 : 0;
    return { input, nationalShare, cohort: cohortForShare(nationalShare) };
  });

  // Percentiles are computed within cohort, so each airport is ranked against its peers.
  const byCohort = new Map<Cohort, typeof withCohort>();
  for (const row of withCohort) {
    const list = byCohort.get(row.cohort) ?? [];
    list.push(row);
    byCohort.set(row.cohort, list);
  }

  const results: ScoredAirport[] = [];

  for (const [cohort, members] of byCohort) {
    // One percentile map per component, across this cohort only.
    const percentiles = new Map<ComponentKey, Map<string, number | null>>();
    for (const spec of COMPONENT_SPECS) {
      percentiles.set(
        spec.key,
        percentileRankAll(
          members.map((m) => ({ key: m.input.iata, value: spec.raw(m.input) })),
        ),
      );
    }

    for (const m of members) {
      const rawByKey = new Map<ComponentKey, number | null>();
      for (const spec of COMPONENT_SPECS) rawByKey.set(spec.key, spec.raw(m.input));

      const available = COMPONENT_SPECS.filter(
        (s) => percentiles.get(s.key)!.get(m.input.iata) !== null,
      ).map((s) => s.key);

      const effective = renormalise(weights, available);

      const components: ComponentScore[] = COMPONENT_SPECS.map((spec) => {
        const pct = percentiles.get(spec.key)!.get(m.input.iata) ?? null;
        const weight = effective[spec.key];
        return {
          key: spec.key,
          rawValue: rawByKey.get(spec.key) ?? null,
          unit: spec.unit,
          percentile: pct,
          weight,
          contribution: pct === null ? 0 : pct * weight,
          ...(pct === null ? { unavailableReason: spec.unavailableReason } : {}),
        };
      });

      results.push({
        iata: m.input.iata,
        city: m.input.city,
        state: m.input.state,
        cohort,
        nationalShare: m.nationalShare,
        score: components.reduce((sum, c) => sum + c.contribution, 0),
        components,
        cohortSize: members.length,
        weights: effective,
      });
    }
  }

  // Deterministic ordering: score descending, then IATA code so ties never reorder between runs.
  return results.sort((a, b) => b.score - a.score || a.iata.localeCompare(b.iata));
}
