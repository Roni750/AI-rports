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
	COMPONENT_LABELS,
	DATA_PROVENANCE,
	DEFAULT_WEIGHTS,
	HAUL_BANDS,
	METRO_GROUPS,
	NEW_ENGLAND_STATES,
	YEARS,
} from "../scoring/config";
import {assessRobustness, describeWeights} from "../scoring/robustness";
import {scoreAirports} from "../scoring/score";
import type {Cohort, ScoredAirport, Weights} from "../scoring/types";
import type {MustMention} from "./must-mention";
import {fail, ok, type ResultEnvelope, type ToolResult} from "./types";

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

// --------------------------------------------------------------- tool-layer tunables
//
// Every judgement call the tool surface makes lives here, for the same reason the scoring model
// keeps its own in `lib/scoring/config.ts`: a reviewer should be able to read the whole value
// system at once and challenge it, rather than meeting a bare `88` inside a filter and having to
// work out what it decided.
//
// Nothing here changes a score. These govern how much of a result is returned, when a query is
// too ambiguous to answer, and when a pattern is pronounced enough to be worth writing a sentence
// about. Scoring parameters — weights, cohorts, shrinkage, haul bands — are imported above and
// are never redefined in this file.

/** Search breadth and the point at which a query stops being genuinely ambiguous. */
const SEARCH = {
	/** Candidates fetched before disambiguating: wide enough to see every airport in a metro. */
	maxCandidates: 12,
	/** Readings offered back when the candidates really are comparable. */
	maxInterpretations: 6,
	/** Runner-up airports named in the note when one match dominates outright. */
	maxAlternativesNamed: 3,
	/** Nearby codes suggested when an airport has no data for the current year. */
	maxSuggestions: 5,
	/**
	 * Resolve outright when the busiest match carries at least this many times the passengers of
	 * the runner-up.
	 *
	 * "Anchorage" matches ANC (2.66m passengers) and Merrill Field (1,416). Asking the user to
	 * choose between those is not careful, it is obtuse — nobody asking about Anchorage means the
	 * general-aviation field. Genuinely ambiguous cases fall below the factor and are asked about.
	 */
	dominanceFactor: 10,
} as const;

/** Bounds on a ranking request. The cap exists so one call cannot swamp the model's context. */
const RANKING = {
	defaultLimit: 5,
	minLimit: 1,
	maxLimit: 25,
} as const;

const COMPARISON = {
	/** Fewer than two airports is not a comparison. */
	minAirports: 2,
	/** More than this stops being a comparison and becomes a ranking — use rankAirports instead. */
	maxAirports: 6,
	/** A highest-versus-lowest observation needs two sides before it says anything. */
	minRowsForContrast: 2,
} as const;

/**
 * Percentile thresholds that decide when a component profile is worth remarking on.
 *
 * Editorial rather than statistical: they choose when a pattern is pronounced enough that an
 * analyst would mention it unprompted. Named so that editorial line is visible and arguable in one
 * place instead of being scattered through a chain of conditionals.
 */
const PROFILE_THRESHOLDS = {
	/** One component clearly high while the other is clearly low — a divergent profile. */
	high: 80,
	low: 30,
	/** Both components elevated. A lower bar, because both have to clear it. */
	bothElevated: 70,
	/** Load factor high enough to be worth calling out on its own. */
	loadFactorNotable: 85,
} as const;

const SEASONALITY = {
	/** Months of usable delay data before a seasonal swing is a pattern rather than an accident. */
	minMonths: 6,
	/** Worst-to-best ratio above which the swing is the story, not noise. */
	notableSwingRatio: 3,
} as const;

const FLIGHT_MIX = {
	/** Routes pulled before filtering — comfortably above the busiest US airport's route count. */
	routeSampleSize: 400,
	topRoutesShown: 10,
	constrainedRoutesShown: 8,
} as const;

/**
 * What makes a route "constrained": nearly full, on enough traffic that the figure is not noise.
 *
 * Both halves matter. A 100% load factor over 300 annual passengers is one well-timed aircraft,
 * not evidence of demand pressing against capacity.
 */
const CONSTRAINED_ROUTE = {
	minLoadFactorPct: 88,
	minPassengers: 20_000,
} as const;

/** The unit the freight note is written in, so the threshold and the display agree by construction. */
const LBS_PER_BILLION = 1_000_000_000;

/**
 * Freight above this dwarfs the passenger business, which changes how a passenger-only percentage
 * should be read. Anchorage moved 5.75 billion pounds against 2.66 million passengers.
 */
const FREIGHT_HUB_MIN_LBS = 1 * LBS_PER_BILLION;

/**
 * Delay coverage, stated as a caveat on every result.
 *
 * A property of the committed dataset rather than of any request, so it is a constant — but it is
 * a constant that silently goes stale if the data is rebuilt, which is exactly why it is named
 * here rather than typed into a sentence. Derive it from the data when the pipeline can report it.
 */
const DELAY_COVERAGE = {
	airportsCovered: 195,
	airportsTotal: 728,
} as const;

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

/**
 * Envelope text is kept terse on purpose.
 *
 * The standing facts — full source description, excluded years, self-reporting, delay coverage —
 * live in the system prompt, stated once. Repeating them verbatim on every tool result burned a
 * significant share of a token-per-minute budget for no added information. What stays here is the
 * short reminder plus anything genuinely specific to the individual result.
 */
const VINTAGE = `BTS T-100 + On-Time Performance; ${DATA_PROVENANCE.years.join("/")}`;

const BASE_ASSUMPTIONS = ["Scheduled passenger service only; cargo counted separately."];

const BASE_CAVEATS = [
	`Delay figures cover larger reporting carriers only (${DELAY_COVERAGE.airportsCovered} of ${DELAY_COVERAGE.airportsTotal} airports).`,
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

/**
 * The metro relationship as a required fact, keyed on the metro rather than on the tool.
 *
 * Attaching this to one tool was a design error: a comparison the model assembles from two
 * getAirportMetrics calls instead of compareAirports never touched the emitting tool, so an answer
 * could put LAX beside SNA without ever saying they serve one market. The fact belongs to the
 * airport, so every tool that returns an airport emits it — and the key makes saying it twice
 * impossible rather than merely unlikely.
 */
function metroMustMention(iata: string): MustMention[] {
	const metro = metroFor(iata);
	if (!metro) return [];
	return [
		{
			key: `metro:${metro.key}`,
			priority: "important",
			text:
				`${iata} is part of ${metro.label}, alongside ${metro.siblingAirports.join(", ")}. ` +
				`Airports in one metro share a catchment area and partly compete for the same passengers.`,
		},
	];
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
			envelope({confidence: "high", metricDefinitions: []}),
		);
	}

	const matches = findAirports(raw, SEARCH.maxCandidates);
	if (matches.length === 0) {
		return fail(
			"airport_not_found",
			`No US airport matched "${raw}".`,
			["Try a 3-letter IATA code (e.g. SFO), a city name, or a 2-letter state code."],
		);
	}

	// Exact IATA match wins outright.
	const exact = matches.find((m) => m.iata.toUpperCase() === raw.toUpperCase());
	// findAirports already orders by passengers descending.
	const chosen = exact ?? matches[0];

	// Only treat multiple matches as a real ambiguity when the candidates are actually comparable —
	// see SEARCH.dominanceFactor. "compare LA and Santa Ana" IS genuinely ambiguous, and metro
	// aliases are handled above precisely because they always are.
	const notes: string[] = [];

	if (!exact && matches.length > 1) {
		const [first, second] = matches;
		const dominates =
			second.passengers <= 0 ||
			first.passengers / Math.max(second.passengers, 1) >= SEARCH.dominanceFactor;

		if (!dominates) {
			return ok(
				{
					kind: "ambiguous",
					interpretations: matches.slice(0, SEARCH.maxInterpretations).map((m) => ({
						label: `${m.iata} — ${m.city ?? "unknown city"}`,
						airports: [m.iata],
						description: `${Math.round(m.passengers).toLocaleString("en-US")} scheduled passengers in ${YEARS.current}.`,
					})),
					notes: [
						`"${raw}" matched ${matches.length} US airports of comparable size, so the intended one is unclear.`,
					],
				},
				envelope(),
			);
		}

		const alternatives = matches
			.slice(1, 1 + SEARCH.maxAlternativesNamed)
			.map((m) => `${m.iata} (${Math.round(m.passengers).toLocaleString("en-US")} passengers)`);
		notes.push(
			`Interpreted "${raw}" as ${first.iata}, by far the busiest match with ` +
			`${Math.round(first.passengers).toLocaleString("en-US")} scheduled passengers. ` +
			`Smaller airports also matched: ${alternatives.join(", ")}.`,
		);
	}

	const metro = metroFor(chosen.iata);
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
	history: {
		year: number;
		passengers: number;
		seats: number;
		departures: number;
		loadFactorPct: number | null;
		seatsPerDeparture: number | null
	}[];
}

export function getAirportMetrics(iata: string): ToolResult<AirportMetricsResult> {
	const code = iata.trim().toUpperCase();
	const history = loadAirportHistory(code);
	const current = history.find((h) => h.year === YEARS.current);

	if (!current) {
		const alt = findAirports(code, SEARCH.maxSuggestions);
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
			// Emitted here as well as by compareAirports: the model often assembles a comparison from
			// two of these calls, and the relationship matters just as much in that shape.
			...(metroMustMention(code).length > 0 ? {mustMention: metroMustMention(code)} : {}),
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
	const limit = Math.min(
		Math.max(params.limit ?? RANKING.defaultLimit, RANKING.minLimit),
		RANKING.maxLimit,
	);

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

	let ranked = scoreAirports(inputs(), {weights: params.weights});
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
			// Spread the real defaults rather than restating them: a second copy of the weights would
			// keep type-checking after DEFAULT_WEIGHTS changed, and this string is the label telling
			// the reader which weighting produced the ranking. It has to be the weighting.
			weightsUsed: describeWeights({...DEFAULT_WEIGHTS, ...params.weights}),
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
			// A ranking without its stability is an overstatement of what the model knows, so the note
			// is mandatory. Same for the cross-cohort warning, which changes what the numbers mean.
			mustMention: [
				// Cross-cohort first: it changes what the numbers mean, where robustness only says how
				// far to trust the order.
				...(cohortsIncluded.length > 1
					? [
						{
							key: "cross-cohort",
							priority: "critical" as const,
							text: `This list spans several size cohorts (${cohortsIncluded.join(", ")}); scores are only comparable within a cohort.`,
						},
					]
					: []),
				...(robustness.note
					? [{key: "robustness", priority: "important" as const, text: robustness.note}]
					: []),
			],
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
	if (wanted.length < COMPARISON.minAirports) {
		return fail(
			"invalid_parameters",
			`Comparing needs at least ${COMPARISON.minAirports} airport codes.`,
		);
	}
	if (wanted.length > COMPARISON.maxAirports) {
		return fail(
			"invalid_parameters",
			`Comparing is limited to ${COMPARISON.maxAirports} airports at a time.`,
		);
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

	if (rows.length < COMPARISON.minAirports) {
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
	/** Metro keys seen here, so the required fact is keyed on the metro rather than on its wording. */
	const metroKeys: string[] = [];
	for (const a of rows) {
		const metro = metroFor(a.iata);
		if (!metro || reportedMetros.has(metro.key)) continue;
		const together = rows.filter(
			(b) => b.iata === a.iata || metro.siblingAirports.includes(b.iata),
		);
		if (together.length > 1) {
			reportedMetros.add(metro.key);
			metroKeys.push(metro.key);
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
	if (withLf.length >= COMPARISON.minRowsForContrast) {
		const hi = withLf.reduce((a, b) => (b.loadFactorPct! > a.loadFactorPct! ? b : a));
		const lo = withLf.reduce((a, b) => (b.loadFactorPct! < a.loadFactorPct! ? b : a));
		observations.push(
			`Fullest aircraft: ${hi.iata} at ${hi.loadFactorPct!.toFixed(1)}%; emptiest: ${lo.iata} at ${lo.loadFactorPct!.toFixed(1)}%.`,
		);
	}

	const withDelay = rows.filter((r) => r.nasDelayMinPerArrival !== null);
	if (withDelay.length >= COMPARISON.minRowsForContrast) {
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

	// Whether the airports share a market, and whether their scores are comparable, both change what
	// the comparison means. Required rather than offered.
	//
	// Keyed by the fact rather than by this tool, so a metro relationship another tool reported in
	// the same turn is not said twice.
	//
	// The metro key comes from METRO_GROUPS via metroKeys, NOT from parsing the sentence back out.
	// An earlier version recovered it with a regex over its own prose and produced
	// "metro:greater los angeles" where getAirportMetrics produced "metro:los_angeles" — two keys
	// for one fact, which defeats the deduplication entirely.
	let metroIndex = 0;
	const required: MustMention[] = observations.flatMap((o): MustMention[] => {
		if (/not directly comparable/.test(o)) {
			return [{key: "cross-cohort", priority: "critical", text: o}];
		}
		if (/share a catchment area/.test(o)) {
			const key = metroKeys[metroIndex++] ?? "unknown";
			return [{key: `metro:${key}`, priority: "important", text: o}];
		}
		return [];
	});

	return ok(
		{rows, observations, sameCohort},
		envelope({
			caveats,
			...(required.length > 0 ? {mustMention: required} : {}),
			confidence: "high",
		}),
	);
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

/** A percentile read as a share from the top: the 92nd percentile is the top 8%. */
function topSharePct(percentile: number): number {
	return 100 - percentile;
}

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
	if (usable.length >= SEASONALITY.minMonths) {
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
		if (
			strain.percentile > PROFILE_THRESHOLDS.high &&
			growth.percentile < PROFILE_THRESHOLDS.low
		) {
			interpretation.push(
				`${code} is heavily congested but not growing. That points to capacity being suppressed ` +
				`rather than demand outrunning seats — the constraint is on what the airport can handle, ` +
				`not on how many people want to fly.`,
			);
		} else if (
			growth.percentile > PROFILE_THRESHOLDS.high &&
			strain.percentile < PROFILE_THRESHOLDS.low
		) {
			interpretation.push(
				`${code} is growing strongly without much congestion yet, which reads as headroom rather ` +
				`than an immediate constraint.`,
			);
		} else if (
			strain.percentile > PROFILE_THRESHOLDS.bothElevated &&
			growth.percentile > PROFILE_THRESHOLDS.bothElevated
		) {
			interpretation.push(
				`${code} is both congested and growing — the strongest combination for an expansion case.`,
			);
		}
	}
	if (demand?.percentile != null && demand.percentile > PROFILE_THRESHOLDS.loadFactorNotable) {
		interpretation.push(
			`Load factor is in the top ${topSharePct(demand.percentile).toFixed(0)}% of its cohort, so aircraft ` +
			`are close to full and carriers cannot add passengers without adding seats.`,
		);
	}
	if (seasonality && seasonality.swingRatio > SEASONALITY.notableSwingRatio) {
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
				plainLabel: COMPONENT_LABELS[c.key] ?? c.key,
				rawValue: c.rawValue,
				unit: c.unit,
				percentileInCohort: c.percentile,
				weight: c.weight,
				pointsContributed: c.contribution,
				...(c.unavailableReason ? {unavailableReason: c.unavailableReason} : {}),
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

	const routes = loadRoutes(code, YEARS.current, FLIGHT_MIX.routeSampleSize);
	const constrained = routes
		.filter(
			(r) =>
				r.loadFactor !== null &&
				r.loadFactor >= CONSTRAINED_ROUTE.minLoadFactorPct &&
				r.passengers >= CONSTRAINED_ROUTE.minPassengers,
		)
		.sort((a, b) => b.loadFactor! - a.loadFactor!)
		.slice(0, FLIGHT_MIX.constrainedRoutesShown);

	// Cargo is worth flagging explicitly where it dwarfs the passenger business: a "share of
	// long-haul flights" answer means something quite different at a freight hub.
	let freightNote: string | null = null;
	if (current.freightLbs > FREIGHT_HUB_MIN_LBS) {
		freightNote =
			`${code} handled ${(current.freightLbs / LBS_PER_BILLION).toFixed(2)} billion pounds of freight in ` +
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
			topRoutes: routes.slice(0, FLIGHT_MIX.topRoutesShown).map((r) => ({
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
				`A route is called constrained when its load factor is ${CONSTRAINED_ROUTE.minLoadFactorPct}% or above with at least ${CONSTRAINED_ROUTE.minPassengers.toLocaleString("en-US")} annual passengers.`,
			],
			assumptions: [
				...BASE_ASSUMPTIONS,
				"Haul thresholds are our convention, not an industry standard.",
			],
			// At a freight hub the cargo business is the bigger story, and a passenger-only percentage
			// read without it is misleading. Required rather than offered — see ResultEnvelope.mustMention.
			...(freightNote
				? {
					mustMention: [
						{key: `freight:${code}`, priority: "critical" as const, text: freightNote},
					],
				}
				: {}),
			confidence: "high",
		}),
	);
}
