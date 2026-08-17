import {
  findAirports,
  findAirportsByStates,
  loadAirportHistory,
  loadDelayMonths,
  loadDelayYear,
  loadRoutes,
  loadScoringInputs,
} from "../data/db";
import {
  DATA_PROVENANCE,
  HAUL_BANDS,
  METRO_GROUPS,
  NEW_ENGLAND_STATES,
  YEARS,
} from "../scoring/config";
import { assessRobustness, describeWeights } from "../scoring/robustness";
import { scoreAirports } from "../scoring/score";
import type { Cohort, ScoredAirport, Weights } from "../scoring/types";
import { fail, ok, type ResultEnvelope, type ToolResult } from "./types";

/**
 * The tool surface the agent is allowed to call.
 *
 * Six tools, each mapping to a shape of question in the brief:
 *   resolveAirport      turn a name into airports, and surface ambiguity instead of guessing
 *   getAirportMetrics   the numbers for one airport
 *   rankAirports        ranking with a robustness note
 *   compareAirports     side-by-side, with the meaningful difference called out
 *   explainScore        component-by-component arithmetic behind a score
 *   flightMix           haul distribution and cargo
 *
 * Scoring inputs are loaded once and cached: percentiles require the whole population, and the
 * dataset is a few hundred rows.
 */

let cachedInputs: ReturnType<typeof loadScoringInputs> | null = null;
function inputs() {
  if (!cachedInputs) cachedInputs = loadScoringInputs();
  return cachedInputs;
}

let cachedScored: ScoredAirport[] | null = null;
function scoredDefault() {
  if (!cachedScored) cachedScored = scoreAirports(inputs());
  return cachedScored;
}

// --------------------------------------------------------------- shared envelope pieces

const VINTAGE = `${DATA_PROVENANCE.source}; years ${DATA_PROVENANCE.years.join(", ")}. Delay data: BTS On-Time Performance ${YEARS.current}.`;

const BASE_ASSUMPTIONS = [
  "Figures cover scheduled passenger service only (BTS service classes A, C, E, F). Charter is excluded; cargo is reported separately.",
  DATA_PROVENANCE.excludedYears,
];

const BASE_CAVEATS = [
  "T-100 is mandatory but self-reported by carriers, not independently measured.",
  "Delay data covers only larger reporting carriers, so roughly 195 of 728 US airports have usable congestion figures.",
];

function envelope(over: Partial<ResultEnvelope> = {}): ResultEnvelope {
  return {
    metricDefinitions: [],
    assumptions: BASE_ASSUMPTIONS,
    dataVintage: VINTAGE,
    caveats: BASE_CAVEATS,
    confidence: "high",
    ...over,
  };
}

// --------------------------------------------------------------- 1. resolveAirport

/**
 * Common informal names that map to a metro area rather than one airport.
 *
 * This exists because of questions like "compare LA and Santa Ana". "LA" could mean LAX alone or
 * the whole basin, and Santa Ana (SNA) is itself inside that basin — so the question compares a
 * metro to one of its own airports. The data cannot resolve that; only the user can. Guessing
 * silently would produce a confident answer to a question nobody asked.
 */
const METRO_ALIASES: Record<string, keyof typeof METRO_GROUPS> = {
  la: "los_angeles",
  "l.a.": "los_angeles",
  "los angeles": "los_angeles",
  nyc: "new_york",
  "new york": "new_york",
  "new york city": "new_york",
  "bay area": "san_francisco_bay",
  "san francisco bay area": "san_francisco_bay",
  "washington": "washington_dc",
  "washington dc": "washington_dc",
  "dc": "washington_dc",
  chicago: "chicago",
  dallas: "dallas",
  "dallas fort worth": "dallas",
  houston: "houston",
  "south florida": "miami",
  miami: "miami",
  boston: "boston",
};

export interface ResolvedAirport {
  iata: string;
  city: string | null;
  state: string | null;
  passengers: number;
  /** Metro area this airport belongs to, when it belongs to one. */
  metro: { key: string; label: string; siblingAirports: string[] } | null;
}

export interface ResolveResult {
  kind: "resolved" | "ambiguous";
  /** Populated when kind === "resolved". */
  airport?: ResolvedAirport;
  /** Populated when kind === "ambiguous": the readings the user might have meant. */
  interpretations?: {
    label: string;
    airports: string[];
    description: string;
  }[];
  /** Relationship facts the user probably needs, e.g. that SNA sits inside Greater LA. */
  notes: string[];
}

function metroFor(iata: string) {
  for (const [key, group] of Object.entries(METRO_GROUPS)) {
    if (group.airports.includes(iata)) {
      return {
        key,
        label: group.label,
        siblingAirports: group.airports.filter((a) => a !== iata),
      };
    }
  }
  return null;
}

export function resolveAirport(query: string): ToolResult<ResolveResult> {
  const raw = query.trim();
  if (!raw) return fail("invalid_parameters", "No airport name or code was provided.");

  const lower = raw.toLowerCase();

  // A metro alias is ambiguous by nature: report the readings rather than picking one.
  const metroKey = METRO_ALIASES[lower];
  if (metroKey) {
    const group = METRO_GROUPS[metroKey];
    const present = group.airports.filter((code) =>
      scoredDefault().some((s) => s.iata === code) || findAirports(code, 1).length > 0,
    );
    const primary = present[0] ?? group.airports[0];
    return ok(
      {
        kind: "ambiguous",
        interpretations: [
          {
            label: `${primary} only`,
            airports: [primary],
            description: `The main airport serving ${group.label}.`,
          },
          {
            label: `All of ${group.label}`,
            airports: present,
            description: `Treats the metro as one market: ${present.join(", ")}.`,
          },
        ],
        notes: [
          `"${raw}" can mean a single airport or a whole metro area, and the two give different answers.`,
        ],
      },
      envelope({ confidence: "high", metricDefinitions: [] }),
    );
  }

  const matches = findAirports(raw, 12);
  if (matches.length === 0) {
    return fail(
      "airport_not_found",
      `No US airport matched "${raw}".`,
      ["Try a 3-letter IATA code (e.g. SFO), a city name, or a 2-letter state code."],
    );
  }

  // Exact IATA match wins outright.
  const exact = matches.find((m) => m.iata.toUpperCase() === raw.toUpperCase());
  const chosen = exact ?? matches[0];

  // More than one airport in the same city or state is a real ambiguity worth surfacing.
  if (!exact && matches.length > 1) {
    const top = matches.slice(0, 6);
    return ok(
      {
        kind: "ambiguous",
        interpretations: top.map((m) => ({
          label: `${m.iata} — ${m.city ?? "unknown city"}`,
          airports: [m.iata],
          description: `${Math.round(m.passengers).toLocaleString("en-US")} scheduled passengers in ${YEARS.current}.`,
        })),
        notes: [`"${raw}" matched ${matches.length} US airports.`],
      },
      envelope(),
    );
  }

  const metro = metroFor(chosen.iata);
  const notes: string[] = [];
  if (metro) {
    notes.push(
      `${chosen.iata} is part of ${metro.label}, alongside ${metro.siblingAirports.join(", ")}. ` +
        `Comparisons against "the metro" would double-count it.`,
    );
  }

  return ok(
    {
      kind: "resolved",
      airport: {
        iata: chosen.iata,
        city: chosen.city,
        state: chosen.state,
        passengers: chosen.passengers,
        metro,
      },
      notes,
    },
    envelope(),
  );
}

// --------------------------------------------------------------- 2. getAirportMetrics

export interface AirportMetricsResult {
  iata: string;
  city: string | null;
  state: string | null;
  cohort: Cohort | null;
  cohortSize: number | null;
  score: number | null;
  year: number;
  passengers: number;
  seats: number;
  departures: number;
  routes: number;
  carriers: number;
  loadFactorPct: number | null;
  seatsPerDeparture: number | null;
  internationalSharePct: number | null;
  longHaulSharePct: number | null;
  freightLbs: number;
  nasDelayMinPerArrival: number | null;
  weatherDelayMinPerArrival: number | null;
  taxiOutMinMean: number | null;
  depDelayed15Pct: number | null;
  cancelPct: number | null;
  history: { year: number; passengers: number; seats: number; departures: number; loadFactorPct: number | null; seatsPerDeparture: number | null }[];
}

export function getAirportMetrics(iata: string): ToolResult<AirportMetricsResult> {
  const code = iata.trim().toUpperCase();
  const history = loadAirportHistory(code);
  const current = history.find((h) => h.year === YEARS.current);

  if (!current) {
    const alt = findAirports(code, 5);
    return fail(
      "no_data_for_airport",
      `No ${YEARS.current} scheduled passenger service found for ${code}.`,
      alt.length ? [`Closest matches: ${alt.map((a) => a.iata).join(", ")}`] : undefined,
    );
  }

  const scored = scoredDefault().find((s) => s.iata === code) ?? null;
  const delay = loadDelayYear(code);

  const caveats = [...BASE_CAVEATS];
  if (!delay) {
    caveats.push(
      `${code} is not covered by the On-Time Performance dataset, so no congestion figures are available for it.`,
    );
  }
  if (!scored) {
    caveats.push(
      `${code} is below the ranking threshold, so it has no comparative score — only its own figures.`,
    );
  }

  return ok(
    {
      iata: code,
      city: current.city,
      state: current.state,
      cohort: scored?.cohort ?? null,
      cohortSize: scored?.cohortSize ?? null,
      score: scored?.score ?? null,
      year: current.year,
      passengers: current.passengers,
      seats: current.seats,
      departures: current.departures,
      routes: current.routes,
      carriers: current.carriers,
      loadFactorPct: current.loadFactor,
      seatsPerDeparture: current.seatsPerDeparture,
      internationalSharePct: current.intlShare,
      longHaulSharePct: current.longHaulShare,
      freightLbs: current.freightLbs,
      nasDelayMinPerArrival: delay?.nasDelayMinPerArrival ?? null,
      weatherDelayMinPerArrival: delay?.weatherDelayMinPerArrival ?? null,
      taxiOutMinMean: delay?.taxiOutMinMean ?? null,
      depDelayed15Pct: delay?.depDel15Rate != null ? delay.depDel15Rate * 100 : null,
      cancelPct: delay?.cancelRate ?? null,
      history: history.map((h) => ({
        year: h.year,
        passengers: h.passengers,
        seats: h.seats,
        departures: h.departures,
        loadFactorPct: h.loadFactor,
        seatsPerDeparture: h.seatsPerDeparture,
      })),
    },
    envelope({
      metricDefinitions: [
        "Load factor = passengers divided by available seats, as a percentage.",
        "Seats per departure = average aircraft size on scheduled passenger service.",
        "NAS delay per arrival = minutes of delay attributed by carriers to air traffic control, traffic volume, airport operations and non-extreme weather, divided by arriving flights. It excludes the airline's own faults.",
        "Long-haul share = share of passengers on flights of at least " + HAUL_BANDS.longMinMiles + " miles.",
      ],
      assumptions: [
        ...BASE_ASSUMPTIONS,
        `Haul bands are our convention, not an industry standard: short under ${HAUL_BANDS.shortMaxMiles} miles, long at or above ${HAUL_BANDS.longMinMiles} miles.`,
      ],
      caveats,
      confidence: delay ? "high" : "medium",
    }),
  );
}

// --------------------------------------------------------------- 3. rankAirports

export interface RankAirportsParams {
  cohort?: Cohort;
  states?: string[];
  region?: "new_england";
  metro?: keyof typeof METRO_GROUPS;
  limit?: number;
  weights?: Partial<Weights>;
}

export interface RankedRow {
  rank: number;
  iata: string;
  city: string | null;
  state: string | null;
  cohort: Cohort;
  score: number;
  passengers: number;
  loadFactorPct: number | null;
  nasDelayMinPerArrival: number | null;
  topComponent: string;
}

export interface RankAirportsResult {
  rows: RankedRow[];
  weightsUsed: string;
  /** Plain-language stability statement. Always present on a ranking. */
  robustnessNote: string;
  populationSize: number;
  cohortsIncluded: Cohort[];
}

export function rankAirports(params: RankAirportsParams = {}): ToolResult<RankAirportsResult> {
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 25);

  const states =
    params.region === "new_england"
      ? [...NEW_ENGLAND_STATES]
      : params.states?.map((s) => s.toUpperCase());
  const metroAirports = params.metro ? METRO_GROUPS[params.metro]?.airports : undefined;

  if (params.metro && !metroAirports) {
    return fail(
      "invalid_parameters",
      `Unknown metro "${params.metro}".`,
      [`Valid metros: ${Object.keys(METRO_GROUPS).join(", ")}`],
    );
  }

  let ranked = scoreAirports(inputs(), { weights: params.weights });
  if (params.cohort) ranked = ranked.filter((r) => r.cohort === params.cohort);
  if (states?.length) {
    const set = new Set(states);
    ranked = ranked.filter((r) => r.state && set.has(r.state.toUpperCase()));
  }
  if (metroAirports) ranked = ranked.filter((r) => metroAirports.includes(r.iata));

  if (ranked.length === 0) {
    return fail(
      "empty_result",
      "No airports matched those filters.",
      [
        "Check the state codes are two-letter US codes.",
        `Valid cohorts: large_hub, medium_hub, small_hub, non_hub.`,
      ],
    );
  }

  const population = ranked.length;
  const top = ranked.slice(0, limit);
  const delayByIata = new Map(
    top.map((r) => [r.iata, loadDelayYear(r.iata)?.nasDelayMinPerArrival ?? null]),
  );

  const robustness = assessRobustness(inputs(), {
    cohort: params.cohort,
    states,
    iataFilter: metroAirports,
    topN: limit,
  });

  // A ranking mixing cohorts is not a single ordered list: percentiles came from different
  // populations. Say so rather than letting the numbers imply comparability.
  const cohortsIncluded = [...new Set(top.map((r) => r.cohort))];
  const caveats = [...BASE_CAVEATS];
  if (cohortsIncluded.length > 1) {
    caveats.push(
      `This list spans ${cohortsIncluded.length} size cohorts (${cohortsIncluded.join(", ")}). ` +
        `Scores are percentile-based within a cohort, so they are NOT directly comparable across cohorts — ` +
        `treat this as several small lists, not one ranking.`,
    );
  }

  return ok(
    {
      rows: top.map((r, i) => {
        const strongest = r.components.reduce((best, c) =>
          c.contribution > best.contribution ? c : best,
        );
        return {
          rank: i + 1,
          iata: r.iata,
          city: r.city,
          state: r.state,
          cohort: r.cohort,
          score: r.score,
          passengers:
            inputs().find((x) => x.iata === r.iata)?.current.passengers ?? 0,
          loadFactorPct:
            r.components.find((c) => c.key === "demandPressure")?.rawValue ?? null,
          nasDelayMinPerArrival: delayByIata.get(r.iata) ?? null,
          topComponent: strongest.key,
        };
      }),
      weightsUsed: describeWeights({
        demandPressure: 0.3,
        capacityStrain: 0.25,
        growthMomentum: 0.25,
        frequencyConstraint: 0.2,
        ...params.weights,
      } as Weights),
      robustnessNote: robustness.note,
      populationSize: population,
      cohortsIncluded,
    },
    envelope({
      metricDefinitions: [
        "Score is a 0-100 weighted sum of four components, each converted to a percentile rank within the airport's size cohort.",
        "It measures demand-side expansion opportunity, NOT profitability: no construction cost, financing or concession revenue data is public.",
      ],
      caveats,
      confidence: "medium",
    }),
  );
}

// --------------------------------------------------------------- 4. compareAirports

export interface ComparisonRow {
  iata: string;
  city: string | null;
  cohort: Cohort | null;
  score: number | null;
  passengers: number;
  loadFactorPct: number | null;
  nasDelayMinPerArrival: number | null;
  taxiOutMinMean: number | null;
  seatsPerDeparture: number | null;
  routes: number;
  departures: number;
}

export interface CompareResult {
  rows: ComparisonRow[];
  /** The differences that actually matter, stated rather than left for the reader to spot. */
  observations: string[];
  sameCohort: boolean;
}

export function compareAirports(codes: string[]): ToolResult<CompareResult> {
  const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()))].filter(Boolean);
  if (wanted.length < 2) {
    return fail("invalid_parameters", "Comparing needs at least two airport codes.");
  }
  if (wanted.length > 6) {
    return fail("invalid_parameters", "Comparing is limited to six airports at a time.");
  }

  const rows: ComparisonRow[] = [];
  const missing: string[] = [];

  for (const code of wanted) {
    const m = getAirportMetrics(code);
    if (!m.ok) {
      missing.push(code);
      continue;
    }
    rows.push({
      iata: m.data.iata,
      city: m.data.city,
      cohort: m.data.cohort,
      score: m.data.score,
      passengers: m.data.passengers,
      loadFactorPct: m.data.loadFactorPct,
      nasDelayMinPerArrival: m.data.nasDelayMinPerArrival,
      taxiOutMinMean: m.data.taxiOutMinMean,
      seatsPerDeparture: m.data.seatsPerDeparture,
      routes: m.data.routes,
      departures: m.data.departures,
    });
  }

  if (rows.length < 2) {
    return fail(
      "no_data_for_airport",
      `Could not find data for ${missing.join(", ")}.`,
      ["Check the IATA codes."],
    );
  }

  const observations: string[] = [];
  const cohorts = new Set(rows.map((r) => r.cohort).filter(Boolean));
  const sameCohort = cohorts.size <= 1;

  if (!sameCohort) {
    observations.push(
      `These airports are in different size cohorts (${[...cohorts].join(", ")}), so their scores ` +
        `are not directly comparable — each was ranked against different peers. The raw figures below are comparable.`,
    );
  }

  // Metro relationships: comparing a metro's main airport to its own satellite is a different
  // question from comparing two independent markets, and the user should know which they asked.
  // Reported once per metro, not once per airport, or a two-airport comparison says it twice.
  const reportedMetros = new Set<string>();
  for (const a of rows) {
    const metro = metroFor(a.iata);
    if (!metro || reportedMetros.has(metro.key)) continue;
    const together = rows.filter(
      (b) => b.iata === a.iata || metro.siblingAirports.includes(b.iata),
    );
    if (together.length > 1) {
      reportedMetros.add(metro.key);
      const codes = together.map((t) => t.iata);
      const joined =
        codes.length === 2
          ? `${codes[0]} and ${codes[1]} are both`
          : `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]} are all`;
      observations.push(
        `${joined} in ${metro.label} — they share a catchment area and partly compete for the ` +
          `same passengers, so this compares two airports within one market rather than two markets.`,
      );
    }
  }

  const withLf = rows.filter((r) => r.loadFactorPct !== null);
  if (withLf.length >= 2) {
    const hi = withLf.reduce((a, b) => (b.loadFactorPct! > a.loadFactorPct! ? b : a));
    const lo = withLf.reduce((a, b) => (b.loadFactorPct! < a.loadFactorPct! ? b : a));
    observations.push(
      `Fullest aircraft: ${hi.iata} at ${hi.loadFactorPct!.toFixed(1)}%; emptiest: ${lo.iata} at ${lo.loadFactorPct!.toFixed(1)}%.`,
    );
  }

  const withDelay = rows.filter((r) => r.nasDelayMinPerArrival !== null);
  if (withDelay.length >= 2) {
    const hi = withDelay.reduce((a, b) =>
      b.nasDelayMinPerArrival! > a.nasDelayMinPerArrival! ? b : a,
    );
    const lo = withDelay.reduce((a, b) =>
      b.nasDelayMinPerArrival! < a.nasDelayMinPerArrival! ? b : a,
    );
    const ratio = lo.nasDelayMinPerArrival! > 0
      ? hi.nasDelayMinPerArrival! / lo.nasDelayMinPerArrival!
      : null;
    observations.push(
      `Most airport-caused delay: ${hi.iata} at ${hi.nasDelayMinPerArrival!.toFixed(2)} minutes per arrival` +
        (ratio ? `, ${ratio.toFixed(1)}x ${lo.iata} at ${lo.nasDelayMinPerArrival!.toFixed(2)}` : "") + ".",
    );
  } else if (withDelay.length === 1) {
    observations.push(
      `Congestion can only be compared where delay data exists; only ${withDelay[0].iata} of these is covered.`,
    );
  }

  const caveats = [...BASE_CAVEATS];
  if (missing.length) {
    caveats.push(`No data found for: ${missing.join(", ")}. They are omitted from the comparison.`);
  }

  return ok({ rows, observations, sameCohort }, envelope({ caveats, confidence: "high" }));
}

// --------------------------------------------------------------- 5. explainScore

export interface ExplainComponent {
  component: string;
  plainLabel: string;
  rawValue: number | null;
  unit: string;
  percentileInCohort: number | null;
  weight: number;
  pointsContributed: number;
  unavailableReason?: string;
}

export interface ExplainScoreResult {
  iata: string;
  city: string | null;
  cohort: Cohort;
  cohortSize: number;
  score: number;
  components: ExplainComponent[];
  /** Seasonal delay detail, when covered — this is how a weather-driven constraint is shown. */
  seasonality: {
    worstMonth: number;
    worstNasDelay: number;
    bestMonth: number;
    bestNasDelay: number;
    swingRatio: number;
  } | null;
  interpretation: string[];
}

const PLAIN_LABELS: Record<string, string> = {
  demandPressure: "how full the planes are",
  capacityStrain: "airport-caused delays",
  growthMomentum: "passenger growth",
  frequencyConstraint: "bigger planes rather than more flights",
};

export function explainScore(iata: string): ToolResult<ExplainScoreResult> {
  const code = iata.trim().toUpperCase();
  const row = scoredDefault().find((s) => s.iata === code);
  if (!row) {
    return fail(
      "no_data_for_airport",
      `${code} has no comparative score — it is either not in the dataset or below the ranking threshold.`,
      ["Use getAirportMetrics for its own figures without a comparative score."],
    );
  }

  const months = loadDelayMonths(code);
  let seasonality: ExplainScoreResult["seasonality"] = null;
  const usable = months.filter((m) => m.nasDelayMinPerArrival !== null && m.arrFlights > 0);
  if (usable.length >= 6) {
    const worst = usable.reduce((a, b) =>
      b.nasDelayMinPerArrival! > a.nasDelayMinPerArrival! ? b : a,
    );
    const best = usable.reduce((a, b) =>
      b.nasDelayMinPerArrival! < a.nasDelayMinPerArrival! ? b : a,
    );
    seasonality = {
      worstMonth: worst.month,
      worstNasDelay: worst.nasDelayMinPerArrival!,
      bestMonth: best.month,
      bestNasDelay: best.nasDelayMinPerArrival!,
      swingRatio:
        best.nasDelayMinPerArrival! > 0
          ? worst.nasDelayMinPerArrival! / best.nasDelayMinPerArrival!
          : Number.POSITIVE_INFINITY,
    };
  }

  // Read the profile, not just the total: a high score built entirely on growth means something
  // quite different from one built on congestion, and the total hides that.
  const interpretation: string[] = [];
  const byKey = new Map(row.components.map((c) => [c.key, c]));
  const strain = byKey.get("capacityStrain");
  const growth = byKey.get("growthMomentum");
  const demand = byKey.get("demandPressure");

  if (strain?.percentile != null && growth?.percentile != null) {
    if (strain.percentile > 80 && growth.percentile < 30) {
      interpretation.push(
        `${code} is heavily congested but not growing. That points to capacity being suppressed ` +
          `rather than demand outrunning seats — the constraint is on what the airport can handle, ` +
          `not on how many people want to fly.`,
      );
    } else if (growth.percentile > 80 && strain.percentile < 30) {
      interpretation.push(
        `${code} is growing strongly without much congestion yet, which reads as headroom rather ` +
          `than an immediate constraint.`,
      );
    } else if (strain.percentile > 70 && growth.percentile > 70) {
      interpretation.push(
        `${code} is both congested and growing — the strongest combination for an expansion case.`,
      );
    }
  }
  if (demand?.percentile != null && demand.percentile > 85) {
    interpretation.push(
      `Load factor is in the top ${(100 - demand.percentile).toFixed(0)}% of its cohort, so aircraft ` +
        `are close to full and carriers cannot add passengers without adding seats.`,
    );
  }
  if (seasonality && seasonality.swingRatio > 3) {
    interpretation.push(
      `Congestion is strongly seasonal: ${seasonality.worstNasDelay.toFixed(2)} minutes per arrival ` +
        `in month ${seasonality.worstMonth} against ${seasonality.bestNasDelay.toFixed(2)} in month ` +
        `${seasonality.bestMonth}, a ${seasonality.swingRatio.toFixed(1)}x swing. A constraint that ` +
        `varies this much by season usually points to weather affecting throughput rather than a ` +
        `permanent shortage of capacity.`,
    );
  }

  return ok(
    {
      iata: row.iata,
      city: row.city,
      cohort: row.cohort,
      cohortSize: row.cohortSize,
      score: row.score,
      components: row.components.map((c) => ({
        component: c.key,
        plainLabel: PLAIN_LABELS[c.key] ?? c.key,
        rawValue: c.rawValue,
        unit: c.unit,
        percentileInCohort: c.percentile,
        weight: c.weight,
        pointsContributed: c.contribution,
        ...(c.unavailableReason ? { unavailableReason: c.unavailableReason } : {}),
      })),
      seasonality,
      interpretation,
    },
    envelope({
      metricDefinitions: [
        "Each component is converted to a percentile rank within the airport's size cohort, then multiplied by its weight. The points contributed sum to the score.",
        "Percentiles compare against cohort peers only, never against all airports.",
      ],
      confidence: "high",
    }),
  );
}

// --------------------------------------------------------------- 6. flightMix

export interface FlightMixResult {
  iata: string;
  city: string | null;
  year: number;
  totalPassengers: number;
  haul: {
    shortPassengers: number;
    mediumPassengers: number;
    longPassengers: number;
    shortPct: number;
    mediumPct: number;
    longPct: number;
  };
  domesticPassengers: number;
  internationalPassengers: number;
  internationalPct: number;
  freightLbs: number;
  freightNote: string | null;
  topRoutes: {
    dest: string;
    passengers: number;
    loadFactorPct: number | null;
    distanceMiles: number | null;
    haul: string;
    isInternational: boolean;
  }[];
  constrainedRoutes: {
    dest: string;
    loadFactorPct: number;
    passengers: number;
    departures: number;
  }[];
}

export function flightMix(iata: string): ToolResult<FlightMixResult> {
  const code = iata.trim().toUpperCase();
  const history = loadAirportHistory(code);
  const current = history.find((h) => h.year === YEARS.current);
  if (!current) {
    return fail("no_data_for_airport", `No ${YEARS.current} data for ${code}.`);
  }

  const hauls = current.paxShort + current.paxMedium + current.paxLong;
  const pct = (n: number) => (hauls > 0 ? (n / hauls) * 100 : 0);

  const routes = loadRoutes(code, YEARS.current, 400);
  const constrained = routes
    .filter((r) => r.loadFactor !== null && r.loadFactor >= 88 && r.passengers >= 20_000)
    .sort((a, b) => b.loadFactor! - a.loadFactor!)
    .slice(0, 8);

  // Cargo is worth flagging explicitly where it dwarfs the passenger business: a "share of
  // long-haul flights" answer means something quite different at a freight hub.
  let freightNote: string | null = null;
  if (current.freightLbs > 1_000_000_000) {
    freightNote =
      `${code} handled ${(current.freightLbs / 1e9).toFixed(2)} billion pounds of freight in ` +
      `${YEARS.current} on dedicated cargo services, alongside ` +
      `${Math.round(current.passengers).toLocaleString("en-US")} scheduled passengers. The figures ` +
      `above cover passenger service only; the cargo operation is a separate and in this case larger business.`;
  }

  return ok(
    {
      iata: code,
      city: current.city,
      year: current.year,
      totalPassengers: current.passengers,
      haul: {
        shortPassengers: current.paxShort,
        mediumPassengers: current.paxMedium,
        longPassengers: current.paxLong,
        shortPct: pct(current.paxShort),
        mediumPct: pct(current.paxMedium),
        longPct: pct(current.paxLong),
      },
      domesticPassengers: current.paxDomestic,
      internationalPassengers: current.paxInternational,
      internationalPct: current.intlShare ?? 0,
      freightLbs: current.freightLbs,
      freightNote,
      topRoutes: routes.slice(0, 10).map((r) => ({
        dest: r.dest,
        passengers: r.passengers,
        loadFactorPct: r.loadFactor,
        distanceMiles: r.distance,
        haul: r.haul,
        isInternational: r.isInternational,
      })),
      constrainedRoutes: constrained.map((r) => ({
        dest: r.dest,
        loadFactorPct: r.loadFactor!,
        passengers: r.passengers,
        departures: r.departures,
      })),
    },
    envelope({
      metricDefinitions: [
        `Haul bands by great-circle distance: short under ${HAUL_BANDS.shortMaxMiles} miles, medium ${HAUL_BANDS.shortMaxMiles}-${HAUL_BANDS.longMinMiles}, long at or above ${HAUL_BANDS.longMinMiles}.`,
        "Shares are of passengers, not of flights — a long-haul flight carries more people than a short one, so the two differ.",
        "A route is called constrained when its load factor is 88% or above with at least 20,000 annual passengers.",
      ],
      assumptions: [
        ...BASE_ASSUMPTIONS,
        "Haul thresholds are our convention, not an industry standard.",
      ],
      confidence: "high",
    }),
  );
}
