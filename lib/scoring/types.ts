/**
 * Types for the Expansion Opportunity Score.
 *
 * Naming note: this scores *demand-side expansion opportunity*, not profitability.
 * Profitability needs construction cost, financing terms and concession revenue, none of
 * which is public. See DESIGN.md.
 */

/** FAA-style size cohorts, derived from share of national passenger boardings. */
export type Cohort = "large_hub" | "medium_hub" | "small_hub" | "non_hub";

/** The four scoring components. */
export type ComponentKey =
  | "demandPressure"
  | "capacityStrain"
  | "growthMomentum"
  | "frequencyConstraint";

/** Raw per-airport metrics for one year, as produced by the Python build step. */
export interface AirportYear {
  iata: string;
  year: number;
  city: string | null;
  state: string | null;
  country: string | null;
  passengers: number;
  seats: number;
  departures: number;
  routes: number;
  carriers: number;
  freightLbs: number;
  cargoDepartures: number;
  paxShort: number;
  paxMedium: number;
  paxLong: number;
  paxDomestic: number;
  paxInternational: number;
  loadFactor: number | null;
  seatsPerDeparture: number | null;
  paxPerDeparture: number | null;
  longHaulShare: number | null;
  intlShare: number | null;
  avgDistance: number | null;
}

/**
 * One airport assembled across years, ready to score.
 * `current` is the scoring year; `baseline` and `previous` drive the trend components.
 */
export interface ScoringInput {
  iata: string;
  city: string | null;
  state: string | null;
  current: AirportYear;
  previous: AirportYear | null; // year-over-year, e.g. 2023
  baseline: AirportYear | null; // structural comparison, e.g. 2019
  /**
   * Mean NAS (National Airspace System) delay minutes per ARRIVAL.
   *
   * Per arrival, not per departure: BTS attributes delay cause against the arriving flight, so
   * crediting it to departures would misalign numerator and denominator.
   *
   * Null when the airport is not covered by the On-Time Performance dataset, which reaches only
   * larger reporting carriers.
   */
  nasDelayMinutesPerArrival: number | null;
}

/** Weights are a value judgement, so they live in config and travel with every result. */
export interface Weights {
  demandPressure: number;
  capacityStrain: number;
  growthMomentum: number;
  frequencyConstraint: number;
}

/** What one component contributed, and the arithmetic behind it. */
export interface ComponentScore {
  key: ComponentKey;
  /** The underlying measurement in its natural unit (e.g. 83.2 percent load factor). */
  rawValue: number | null;
  /** Human-readable unit, for display and for the agent to quote accurately. */
  unit: string;
  /** Rank within the airport's cohort, 0-100. Null when rawValue is null. */
  percentile: number | null;
  weight: number;
  /** percentile * weight -- what this component added to the final score. */
  contribution: number;
  /** Set when the component could not be computed, so absence is never silent. */
  unavailableReason?: string;
}

export interface ScoredAirport {
  iata: string;
  city: string | null;
  state: string | null;
  cohort: Cohort;
  /** Share of national scheduled passengers, percent. Determines the cohort. */
  nationalShare: number;
  /** 0-100. Comparable only within the same cohort. */
  score: number;
  components: ComponentScore[];
  /** Cohort size, so callers know how meaningful the percentiles are. */
  cohortSize: number;
  /** Weights actually used, so a result can never be misread under different weights. */
  weights: Weights;
}
