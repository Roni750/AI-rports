import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { YEARS } from "../scoring/config";
import type { AirportYear, ScoringInput } from "../scoring/types";

/**
 * Read-only access to the precomputed dataset.
 *
 * Deliberately the only file that knows we use SQLite. Everything above this layer works with
 * plain typed objects, so the storage choice can change without touching the scoring engine,
 * the tools, or the agent.
 *
 * `node:sqlite` is built into Node 22, so there is no native module to compile and nothing extra
 * to install. It emits an experimental warning; the trade is deliberate, since the alternative
 * (better-sqlite3) is a compiled dependency that complicates serverless deployment.
 */

let db: DatabaseSync | null = null;

function connect(): DatabaseSync {
  if (!db) {
    const file = path.join(process.cwd(), "data", "aviation.db");
    db = new DatabaseSync(file, { readOnly: true });
  }
  return db;
}

/** Raw DB rows come back with snake_case columns and null-prototype objects. */
interface AirportYearRow {
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
  freight_lbs: number;
  cargo_departures: number;
  pax_short: number;
  pax_medium: number;
  pax_long: number;
  pax_domestic: number;
  pax_international: number;
  load_factor: number | null;
  seats_per_departure: number | null;
  pax_per_departure: number | null;
  long_haul_share: number | null;
  intl_share: number | null;
  avg_distance: number | null;
}

function toAirportYear(r: AirportYearRow): AirportYear {
  return {
    iata: r.iata,
    year: r.year,
    city: r.city,
    state: r.state,
    country: r.country,
    passengers: r.passengers ?? 0,
    seats: r.seats ?? 0,
    departures: r.departures ?? 0,
    routes: r.routes ?? 0,
    carriers: r.carriers ?? 0,
    freightLbs: r.freight_lbs ?? 0,
    cargoDepartures: r.cargo_departures ?? 0,
    paxShort: r.pax_short ?? 0,
    paxMedium: r.pax_medium ?? 0,
    paxLong: r.pax_long ?? 0,
    paxDomestic: r.pax_domestic ?? 0,
    paxInternational: r.pax_international ?? 0,
    loadFactor: r.load_factor,
    seatsPerDeparture: r.seats_per_departure,
    paxPerDeparture: r.pax_per_departure,
    longHaulShare: r.long_haul_share,
    intlShare: r.intl_share,
    avgDistance: r.avg_distance,
  };
}

/**
 * Assemble scoring inputs for all US airports.
 *
 * Restricted to US airports because the dataset includes international segments, which bring
 * foreign airports in as origins — 993 origins in 2024 versus the ~350 US airports with
 * meaningful scheduled service. Ranking foreign airports for US investment would be nonsense.
 */
export function loadScoringInputs(): ScoringInput[] {
  const con = connect();

  const rows = con
    .prepare(
      `SELECT * FROM airport_year
       WHERE country = 'US' AND year IN (?, ?, ?)`,
    )
    .all(YEARS.current, YEARS.previous, YEARS.baseline) as unknown as AirportYearRow[];

  // Delay data covers only larger reporting carriers: ~348 airports, not all 993.
  const delayRows = con
    .prepare(
      `SELECT iata, nas_delay_min_per_arrival, arr_flights
       FROM airport_delay_year WHERE year = ?`,
    )
    .all(YEARS.current) as unknown as {
    iata: string;
    nas_delay_min_per_arrival: number | null;
    arr_flights: number;
  }[];

  const delayByIata = new Map<string, number | null>();
  for (const d of delayRows) {
    // Below a few thousand arrivals the mean is dominated by a handful of bad days, so treat it
    // as unmeasured rather than reporting a number we don't believe.
    const usable = d.arr_flights >= 2_000 && d.nas_delay_min_per_arrival !== null;
    delayByIata.set(d.iata, usable ? d.nas_delay_min_per_arrival : null);
  }

  const byIata = new Map<string, Map<number, AirportYear>>();
  for (const r of rows) {
    const ay = toAirportYear(r);
    const years = byIata.get(ay.iata) ?? new Map<number, AirportYear>();
    years.set(ay.year, ay);
    byIata.set(ay.iata, years);
  }

  const inputs: ScoringInput[] = [];
  for (const [iata, years] of byIata) {
    const current = years.get(YEARS.current);
    if (!current) continue; // no current-year service means nothing to score
    inputs.push({
      iata,
      city: current.city,
      state: current.state,
      current,
      previous: years.get(YEARS.previous) ?? null,
      baseline: years.get(YEARS.baseline) ?? null,
      nasDelayMinutesPerArrival: delayByIata.get(iata) ?? null,
    });
  }
  return inputs;
}

/** Every year on record for one airport, oldest first. */
export function loadAirportHistory(iata: string): AirportYear[] {
  const rows = connect()
    .prepare(`SELECT * FROM airport_year WHERE iata = ? ORDER BY year`)
    .all(iata.toUpperCase()) as unknown as AirportYearRow[];
  return rows.map(toAirportYear);
}

export interface DelayMonth {
  iata: string;
  year: number;
  month: number;
  arrFlights: number;
  nasDelayMinPerArrival: number | null;
  weatherDelayMinPerArrival: number | null;
  taxiOutMinMean: number | null;
  arrDel15Rate: number | null;
  depDel15Rate: number | null;
  cancelRate: number | null;
}

/** Monthly delay detail — how seasonality is demonstrated rather than asserted. */
export function loadDelayMonths(iata: string, year = YEARS.current): DelayMonth[] {
  const rows = connect()
    .prepare(
      `SELECT iata, year, month, arr_flights, nas_delay_min_per_arrival,
              weather_delay_min_per_arrival, taxi_out_min_mean, arr_del15_rate, dep_del15_rate
       FROM airport_delay_month WHERE iata = ? AND year = ? ORDER BY month`,
    )
    .all(iata.toUpperCase(), year) as unknown as Record<string, number | string | null>[];

  return rows.map((r) => ({
    iata: String(r.iata),
    year: Number(r.year),
    month: Number(r.month),
    arrFlights: Number(r.arr_flights ?? 0),
    nasDelayMinPerArrival: r.nas_delay_min_per_arrival as number | null,
    weatherDelayMinPerArrival: r.weather_delay_min_per_arrival as number | null,
    taxiOutMinMean: r.taxi_out_min_mean as number | null,
    arrDel15Rate: r.arr_del15_rate as number | null,
    depDel15Rate: r.dep_del15_rate as number | null,
    cancelRate: null,
  }));
}

export interface DelayYear {
  iata: string;
  year: number;
  arrFlights: number;
  depFlights: number;
  nasDelayMinPerArrival: number | null;
  weatherDelayMinPerArrival: number | null;
  taxiOutMinMean: number | null;
  taxiInMinMean: number | null;
  depDel15Rate: number | null;
  arrDel15Rate: number | null;
  cancelRate: number | null;
  carrierDelayMinTotal: number | null;
  lateAircraftDelayMinTotal: number | null;
  nasDelayMinTotal: number | null;
  weatherDelayMinTotal: number | null;
}

/** Annual delay detail for one airport, or null when it isn't covered by the dataset. */
export function loadDelayYear(iata: string, year = YEARS.current): DelayYear | null {
  const r = connect()
    .prepare(`SELECT * FROM airport_delay_year WHERE iata = ? AND year = ?`)
    .get(iata.toUpperCase(), year) as unknown as Record<string, number | string | null> | undefined;
  if (!r) return null;
  return {
    iata: String(r.iata),
    year: Number(r.year),
    arrFlights: Number(r.arr_flights ?? 0),
    depFlights: Number(r.dep_flights ?? 0),
    nasDelayMinPerArrival: r.nas_delay_min_per_arrival as number | null,
    weatherDelayMinPerArrival: r.weather_delay_min_per_arrival as number | null,
    taxiOutMinMean: r.taxi_out_min_mean as number | null,
    taxiInMinMean: r.taxi_in_min_mean as number | null,
    depDel15Rate: r.dep_del15_rate as number | null,
    arrDel15Rate: r.arr_del15_rate as number | null,
    cancelRate: r.cancel_rate as number | null,
    carrierDelayMinTotal: r.carrierdelay_min_total as number | null,
    lateAircraftDelayMinTotal: r.lateaircraftdelay_min_total as number | null,
    nasDelayMinTotal: r.nasdelay_min_total as number | null,
    weatherDelayMinTotal: r.weatherdelay_min_total as number | null,
  };
}

export interface RouteYear {
  origin: string;
  dest: string;
  year: number;
  passengers: number;
  seats: number;
  departures: number;
  distance: number | null;
  carriers: number;
  loadFactor: number | null;
  seatsPerDeparture: number | null;
  isInternational: boolean;
  haul: string;
  destCountry: string | null;
}

/** Routes out of an airport, busiest first. Powers route-level constraint questions. */
export function loadRoutes(
  origin: string,
  year = YEARS.current,
  limit = 500,
): RouteYear[] {
  const rows = connect()
    .prepare(
      `SELECT * FROM route_year WHERE origin = ? AND year = ?
       ORDER BY passengers DESC LIMIT ?`,
    )
    .all(origin.toUpperCase(), year, limit) as unknown as Record<
    string,
    number | string | null
  >[];

  return rows.map((r) => ({
    origin: String(r.origin),
    dest: String(r.dest),
    year: Number(r.year),
    passengers: Number(r.passengers ?? 0),
    seats: Number(r.seats ?? 0),
    departures: Number(r.departures ?? 0),
    distance: r.distance as number | null,
    carriers: Number(r.carriers ?? 0),
    loadFactor: r.load_factor as number | null,
    seatsPerDeparture: r.seats_per_departure as number | null,
    isInternational: Number(r.is_international ?? 0) === 1,
    haul: String(r.haul ?? "unknown"),
    destCountry: (r.dest_country as string | null) ?? null,
  }));
}

/** Look up airports by IATA code, city name fragment, or state. */
export function findAirports(query: string, limit = 25): AirportYear[] {
  const q = query.trim();
  const rows = connect()
    .prepare(
      `SELECT * FROM airport_year
       WHERE year = ? AND country = 'US'
         AND (iata = ? OR city LIKE ? OR state = ?)
       ORDER BY passengers DESC LIMIT ?`,
    )
    .all(YEARS.current, q.toUpperCase(), `%${q}%`, q.toUpperCase(), limit) as unknown as
    AirportYearRow[];
  return rows.map(toAirportYear);
}

/** Every US airport in a set of states, for regional questions. */
export function findAirportsByStates(states: readonly string[]): AirportYear[] {
  if (states.length === 0) return [];
  const placeholders = states.map(() => "?").join(",");
  const rows = connect()
    .prepare(
      `SELECT * FROM airport_year
       WHERE year = ? AND country = 'US' AND state IN (${placeholders})
       ORDER BY passengers DESC`,
    )
    .all(YEARS.current, ...states.map((s) => s.toUpperCase())) as unknown as AirportYearRow[];
  return rows.map(toAirportYear);
}

/**
 * The reference data an entity extractor needs: which IATA codes are real, and what each
 * airport's city is called.
 *
 * Exists so the analytics layer can recognise "Anchorage" and "ANC" in a prompt without shipping
 * a second copy of the airport list. Recognition is a lookup, not a judgement — there is no reason
 * for a language model to be involved in deciding whether ANC is an airport.
 *
 * Loaded once and cached: the map is a few hundred entries and never changes within a process.
 */
export interface AirportLookup {
  /** Every valid US IATA code in the current year, uppercase. */
  codes: ReadonlySet<string>;
  /** Lowercased city name -> the busiest IATA serving it. */
  cityToIata: ReadonlyMap<string, string>;
  /** IATA -> display city, for labelling a code in the UI. */
  iataToCity: ReadonlyMap<string, string>;
}

let cachedLookup: AirportLookup | null = null;

export function loadAirportLookup(): AirportLookup {
  if (cachedLookup) return cachedLookup;

  const rows = connect()
    .prepare(
      `SELECT iata, city, passengers FROM airport_year
       WHERE year = ? AND country = 'US' AND iata IS NOT NULL
       ORDER BY passengers DESC`,
    )
    .all(YEARS.current) as unknown as { iata: string; city: string | null; passengers: number }[];

  const codes = new Set<string>();
  const cityToIata = new Map<string, string>();
  const iataToCity = new Map<string, string>();

  for (const row of rows) {
    const iata = row.iata?.toUpperCase();
    if (!iata || iata.length !== 3) continue;
    codes.add(iata);

    if (!row.city) continue;
    if (!iataToCity.has(iata)) iataToCity.set(iata, row.city);

    // BTS writes the city WITH its state — "Anchorage, AK", "Dallas/Fort Worth, TX". Keying on the
    // raw string is the obvious mistake and a silent one: nobody types "anchorage, ak", so every
    // city lookup misses and the whole feature reports zero without erroring.
    //
    // Two keys per airport, so both phrasings resolve:
    //   "anchorage"     — the bare name, what people actually type
    //   "anchorage ak"  — name plus state, which disambiguates Portland OR from Portland ME
    const [namePart, statePart] = row.city.split(",");
    // "Dallas/Fort Worth" — take the first alternative as the primary name.
    const name = namePart.split("/")[0].trim().toLowerCase();
    const state = statePart?.trim().toLowerCase() ?? "";

    // Rows are ordered by passengers, so the first writer wins: bare "Chicago" maps to ORD rather
    // than MDW, and bare "Portland" to whichever is busier. Genuine ambiguity between them belongs
    // to the agent's own resolver, not to a recognition table — this only has to recognise that a
    // city was named at all.
    if (name.length >= 4 && !cityToIata.has(name)) cityToIata.set(name, iata);
    if (name.length >= 4 && state) {
      const qualified = `${name} ${state}`;
      if (!cityToIata.has(qualified)) cityToIata.set(qualified, iata);
    }
  }

  cachedLookup = { codes, cityToIata, iataToCity };
  return cachedLookup;
}
