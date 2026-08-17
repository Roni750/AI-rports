import type { Cohort, Weights } from "./types";

/**
 * Every tunable value in the scoring model lives here.
 *
 * These are judgement calls, not measurements. Keeping them in one visible file -- rather than
 * scattered through the calculation -- is deliberate: a reviewer can see and challenge the whole
 * value system at once, and the API can override them at request time.
 */

/**
 * Default component weights.
 *
 * Rationale:
 *  - demandPressure (0.35) leads, because full aircraft are the most direct evidence that
 *    existing capacity is being consumed.
 *  - growthMomentum (0.25) and capacityStrain (0.25) are equal seconds: demand must be rising
 *    for expansion to pay back, and observable strain confirms the constraint is real today.
 *  - frequencyConstraint (0.15) is smallest despite being the most distinctive signal, because
 *    it is the most indirect -- carriers upgauge for fleet reasons as well as airport ones.
 *
 * These are a defensible starting prior. They are NOT calibrated against realised investment
 * returns, because no public dataset links airport expansion projects to their outcomes.
 */
export const DEFAULT_WEIGHTS: Weights = {
  demandPressure: 0.35,
  capacityStrain: 0.25,
  growthMomentum: 0.25,
  frequencyConstraint: 0.15,
};

/**
 * Cohort thresholds as share of national scheduled passenger boardings, in percent.
 * Mirrors the FAA's hub classification, computed from T-100 rather than transcribed, so it
 * stays reproducible from source data.
 */
export const COHORT_THRESHOLDS: { cohort: Cohort; minNationalSharePct: number }[] = [
  { cohort: "large_hub", minNationalSharePct: 1.0 },
  { cohort: "medium_hub", minNationalSharePct: 0.25 },
  { cohort: "small_hub", minNationalSharePct: 0.05 },
  { cohort: "non_hub", minNationalSharePct: 0 },
];

/**
 * Minimum annual scheduled passengers for an airport to enter the ranking at all.
 *
 * This is a DATA-QUALITY floor, not a judgement about which airports matter. Deliberately low:
 * small airports are legitimate -- often the most interesting -- expansion candidates, since they
 * are cheaper to expand and face less competition. Cohort ranking already prevents them being
 * compared unfairly against major hubs.
 *
 * The floor exists only to exclude airports whose "scheduled service" is a handful of flights,
 * where every metric is noise. The separate problem of unreliable growth rates from a small base
 * is handled by regularisation (see GROWTH_SHRINKAGE), not by exclusion.
 */
export const MIN_PASSENGERS_FOR_INCLUSION = 10_000;

/**
 * Blend of structural versus recent growth.
 *
 * 2019 is the last clean pre-pandemic year, so a 2019 comparison captures structural change.
 * But it also carries pandemic recovery distortion, so recent year-over-year growth is weighted
 * slightly higher to keep the measure current.
 */
export const GROWTH_BLEND = {
  structuralWeight: 0.45, // e.g. 2019 -> 2024
  recentWeight: 0.55, // e.g. 2023 -> 2024
};

/**
 * Regularisation constants for growth rates -- additive smoothing on the denominator.
 *
 * The problem: a percentage change computed from a small base is high-variance and not comparable
 * to the same percentage from a large base. It is the "100% positive reviews, from one review"
 * problem. New Haven grew passengers ~510% between 2019 and 2024 because a single carrier opened a
 * base there. That is real, but it is not evidence of the same weight as Boston's +4.7%.
 *
 * The fix: shrink toward zero by adding a constant to the denominator.
 *
 *     growth = (current - baseline) / (baseline + K) * 100
 *
 * Effect at K = 250,000 passengers:
 *     96k  ->  588k   raw +512%   shrunk +142%   (damped hard)
 *     20.7M -> 21.3M  raw   +2.9% shrunk   +2.9% (effectively untouched)
 *
 * So small airports must show real ABSOLUTE growth to score well, while large airports are
 * unaffected. This keeps every airport in the ranking rather than excluding any -- exclusion would
 * discard exactly the small-airport opportunities worth finding.
 *
 * K is a judgement call, set near the small-hub passenger scale: it encodes how much traffic we
 * require before believing a growth rate.
 */
export const GROWTH_SHRINKAGE = {
  passengers: 250_000,
  departures: 2_500,
  seats: 300_000,
};

/** Haul distance bands in statute miles. Our convention, not an industry standard. */
export const HAUL_BANDS = {
  shortMaxMiles: 800,
  longMinMiles: 2400,
};

/** US states comprising New England, needed for regional queries. */
export const NEW_ENGLAND_STATES = ["ME", "NH", "VT", "MA", "RI", "CT"] as const;

/**
 * Metro groupings where a city name maps to several airports.
 *
 * This exists because questions like "compare LA and Santa Ana" are ambiguous in a way the data
 * cannot resolve: "LA" could mean LAX alone or the whole basin, and Santa Ana (SNA) is itself
 * inside that basin. The agent surfaces the ambiguity rather than silently picking one.
 */
export const METRO_GROUPS: Record<string, { label: string; airports: string[] }> = {
  los_angeles: {
    label: "Greater Los Angeles",
    airports: ["LAX", "SNA", "ONT", "BUR", "LGB"],
  },
  new_york: { label: "New York metro", airports: ["JFK", "LGA", "EWR", "HPN", "ISP"] },
  san_francisco_bay: { label: "San Francisco Bay Area", airports: ["SFO", "OAK", "SJC"] },
  washington_dc: { label: "Washington DC metro", airports: ["DCA", "IAD", "BWI"] },
  chicago: { label: "Chicago metro", airports: ["ORD", "MDW"] },
  dallas: { label: "Dallas/Fort Worth metro", airports: ["DFW", "DAL"] },
  houston: { label: "Houston metro", airports: ["IAH", "HOU"] },
  miami: { label: "South Florida", airports: ["MIA", "FLL", "PBI"] },
  boston: { label: "Boston metro", airports: ["BOS", "MHT", "PVD"] },
};

/** The year the dataset is scored on, and the comparison years available. */
export const YEARS = {
  current: 2024,
  previous: 2023,
  baseline: 2019,
} as const;

/**
 * Provenance, attached to answers so a figure can always be traced to its source and vintage.
 */
export const DATA_PROVENANCE = {
  source: "US Bureau of Transportation Statistics, T-100 Segment (All Carriers)",
  coverage:
    "Scheduled passenger service, domestic and international, US and foreign carriers",
  years: [2019, 2023, 2024],
  excludedYears: "2020-2021 excluded as pandemic-distorted; 2022 excluded as still recovering",
  serviceClasses: "A, C, E, F (scheduled passenger). Cargo (G, P, R) reported separately.",
  notes:
    "T-100 is mandatory carrier-reported data, comprehensive but self-reported rather than independently measured.",
};
