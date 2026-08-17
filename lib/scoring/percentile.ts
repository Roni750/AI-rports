/**
 * Percentile ranking.
 *
 * Why percentiles rather than raw values or z-scores:
 *
 *  1. The components are measured in incompatible units -- percent load factor, percent growth,
 *     minutes of delay. They cannot be summed directly.
 *  2. Raw values reward the wrong airports. The highest US load factors belong to small fields
 *     (Harrisburg 86.8%, Chattanooga 86.5%) where a carrier right-sized a handful of routes,
 *     ahead of Atlanta at 84.7% across 274 routes.
 *  3. Z-scores are unbounded, so a single outlier dominates a weighted sum. New Haven grew
 *     passengers 1,110% between 2019 and 2024 because one carrier opened a base there; under
 *     z-scoring it would swamp every other airport in any growth-weighted composite.
 *
 * Percentiles bound every input to 0-100, so an extreme value becomes "highest in its cohort"
 * rather than "an order of magnitude more important than second place".
 */

/**
 * Mid-rank ("mean rank") percentile of `value` within `population`, on a 0-100 scale.
 *
 * Ties receive the same percentile, positioned at the midpoint of the tied block, so no airport
 * is arbitrarily ranked above an identically-performing one.
 *
 * A single-member population returns 50 -- the neutral midpoint -- because with nothing to
 * compare against, any other answer would assert a ranking that does not exist.
 */
export function percentileRank(population: number[], value: number): number {
  const finite = population.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return 50;
  if (finite.length === 1) return 50;

  let below = 0;
  let equal = 0;
  for (const v of finite) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return ((below + 0.5 * equal) / finite.length) * 100;
}

/**
 * Percentile-rank every member of a population in one pass.
 * Returns a Map keyed by the caller's identifier.
 *
 * Entries whose value is null or non-finite are given a null percentile rather than being
 * coerced to zero: "we could not measure this" and "this measured lowest" are different claims,
 * and conflating them would silently penalise airports with missing data.
 */
export function percentileRankAll<K>(
  entries: { key: K; value: number | null }[],
): Map<K, number | null> {
  const population = entries
    .map((e) => e.value)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  const out = new Map<K, number | null>();
  for (const e of entries) {
    if (e.value === null || !Number.isFinite(e.value)) {
      out.set(e.key, null);
    } else {
      out.set(e.key, percentileRank(population, e.value));
    }
  }
  return out;
}

/** Arithmetic mean of the finite values, or null if there are none. */
export function mean(values: (number | null)[]): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/** Median of the finite values, or null if there are none. */
export function median(values: (number | null)[]): number | null {
  const finite = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];
}
