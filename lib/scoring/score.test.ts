import { describe, expect, it } from "vitest";

import { MIN_PASSENGERS_FOR_INCLUSION } from "./config";
import { mean, median, percentileRank, percentileRankAll } from "./percentile";
import { cohortForShare, scoreAirports } from "./score";
import type { AirportYear, ScoringInput } from "./types";

// ---------------------------------------------------------------- fixtures

function airportYear(over: Partial<AirportYear> & { iata: string; year: number }): AirportYear {
  const passengers = over.passengers ?? 1_000_000;
  const seats = over.seats ?? 1_200_000;
  const departures = over.departures ?? 10_000;
  return {
    city: "Testville, XX",
    state: "XX",
    country: "US",
    routes: 20,
    carriers: 5,
    freightLbs: 0,
    cargoDepartures: 0,
    paxShort: 0,
    paxMedium: 0,
    paxLong: 0,
    paxDomestic: passengers,
    paxInternational: 0,
    loadFactor: seats > 0 ? (passengers / seats) * 100 : null,
    seatsPerDeparture: departures > 0 ? seats / departures : null,
    paxPerDeparture: departures > 0 ? passengers / departures : null,
    longHaulShare: 0,
    intlShare: 0,
    avgDistance: 900,
    ...over,
    passengers,
    seats,
    departures,
  };
}

/** Build a scoring input from compact per-year tuples: [passengers, seats, departures]. */
function input(
  iata: string,
  current: [number, number, number],
  baseline?: [number, number, number],
  previous?: [number, number, number],
  nasDelayMinutesPerArrival: number | null = 10,
): ScoringInput {
  const mk = (year: number, t: [number, number, number]) =>
    airportYear({ iata, year, passengers: t[0], seats: t[1], departures: t[2] });
  return {
    iata,
    city: `${iata} City`,
    state: "XX",
    current: mk(2024, current),
    previous: previous ? mk(2023, previous) : null,
    baseline: baseline ? mk(2019, baseline) : null,
    nasDelayMinutesPerArrival,
  };
}

/** A population large enough that percentiles are meaningful. */
function population(count: number): ScoringInput[] {
  return Array.from({ length: count }, (_, i) =>
    input(
      `A${String(i).padStart(2, "0")}`,
      [1_000_000 + i * 100_000, 1_300_000 + i * 100_000, 10_000 + i * 100],
      [900_000 + i * 100_000, 1_200_000 + i * 100_000, 9_500 + i * 100],
      [950_000 + i * 100_000, 1_250_000 + i * 100_000, 9_800 + i * 100],
      5 + i,
    ),
  );
}

// ---------------------------------------------------------------- percentile

describe("percentileRank", () => {
  it("places the lowest and highest values near the ends", () => {
    const pop = [1, 2, 3, 4, 5];
    expect(percentileRank(pop, 1)).toBeLessThan(20);
    expect(percentileRank(pop, 5)).toBeGreaterThan(80);
  });

  it("gives tied values an identical mid-block percentile", () => {
    const pop = [10, 10, 10, 20];
    const a = percentileRank(pop, 10);
    expect(a).toBeCloseTo(37.5, 5); // (0 + 0.5*3) / 4
    expect(percentileRank(pop, 10)).toBe(a);
  });

  it("returns the neutral midpoint when there is nothing to compare against", () => {
    expect(percentileRank([], 5)).toBe(50);
    expect(percentileRank([42], 42)).toBe(50);
  });

  it("distinguishes 'not measured' from 'measured lowest'", () => {
    const out = percentileRankAll([
      { key: "a", value: 1 },
      { key: "b", value: 100 },
      { key: "c", value: null },
    ]);
    expect(out.get("c")).toBeNull(); // not coerced to 0
    expect(out.get("a")).not.toBeNull();
  });

  it("ignores non-finite values rather than propagating NaN", () => {
    expect(mean([1, null, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(mean([null])).toBeNull();
  });
});

// ------------------------------------------------------------------- cohorts

describe("cohortForShare", () => {
  it("maps national share onto FAA-style hub classes", () => {
    expect(cohortForShare(2.5)).toBe("large_hub");
    expect(cohortForShare(1.0)).toBe("large_hub"); // boundary is inclusive
    expect(cohortForShare(0.5)).toBe("medium_hub");
    expect(cohortForShare(0.25)).toBe("medium_hub");
    expect(cohortForShare(0.1)).toBe("small_hub");
    expect(cohortForShare(0.01)).toBe("non_hub");
    expect(cohortForShare(0)).toBe("non_hub");
  });
});

// -------------------------------------------------------------- score engine

describe("scoreAirports", () => {
  it("is deterministic: identical input yields byte-identical output", () => {
    const pop = population(12);
    expect(JSON.stringify(scoreAirports(pop))).toBe(JSON.stringify(scoreAirports(pop)));
  });

  it("orders ties by IATA code so results never reshuffle between runs", () => {
    const pop = [
      input("ZZZ", [2_000_000, 2_400_000, 20_000], [1_800_000, 2_200_000, 19_000]),
      input("AAA", [2_000_000, 2_400_000, 20_000], [1_800_000, 2_200_000, 19_000]),
    ];
    const scored = scoreAirports(pop);
    expect(scored[0].score).toBeCloseTo(scored[1].score, 10);
    expect(scored[0].iata).toBe("AAA");
  });

  it("keeps every score within 0-100", () => {
    for (const r of scoreAirports(population(30))) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("ranks genuinely small airports rather than excluding them", () => {
    // 60k passengers is a small airport, not a broken one. It must be ranked: small airports are
    // legitimate expansion candidates, often cheaper to expand than major hubs.
    const smallButReal = input("SML", [60_000, 75_000, 900], [45_000, 58_000, 800]);
    const scored = scoreAirports([smallButReal, ...population(6)]);
    expect(scored.map((r) => r.iata)).toContain("SML");
  });

  it("applies only a data-quality floor, and lifts it on request", () => {
    // 800 passengers a year is a handful of flights; every metric is noise.
    const noise = input("NOI", [800, 2_000, 40], [200, 900, 10]);
    const pop = [...population(6), noise];
    expect(scoreAirports(pop).map((r) => r.iata)).not.toContain("NOI");
    expect(scoreAirports(pop, { includeAllAirports: true }).map((r) => r.iata)).toContain("NOI");
    expect(MIN_PASSENGERS_FOR_INCLUSION).toBeLessThan(50_000); // deliberately permissive
  });

  it("regularises growth so a small base cannot manufacture a huge rate", () => {
    // Same absolute gain, wildly different bases.
    const tiny = input("TNY", [160_000, 200_000, 1_600], [60_000, 80_000, 700]);
    const big = input("BIG", [20_100_000, 24_000_000, 150_000], [20_000_000, 23_900_000, 149_000]);
    const scored = scoreAirports([tiny, big, ...population(8)], { includeAllAirports: true });

    const tinyGrowth = scored.find((r) => r.iata === "TNY")!.components
      .find((c) => c.key === "growthMomentum")!.rawValue!;

    // Raw growth would be ~167%. Shrinkage must pull it well below that.
    expect(tinyGrowth).toBeLessThan(100);
    expect(tinyGrowth).toBeGreaterThan(0); // still positive -- it did grow

    // A large airport's rate is essentially unaffected by the shrinkage term.
    const bigGrowth = scored.find((r) => r.iata === "BIG")!.components
      .find((c) => c.key === "growthMomentum")!.rawValue!;
    expect(Math.abs(bigGrowth)).toBeLessThan(3);
  });

  it("does not let an extreme outlier dominate the composite", () => {
    // "HVN": +1,100% growth from a tiny base, mirroring the real New Haven case.
    const pop = [
      ...population(10),
      input("HVN", [1_200_000, 1_600_000, 9_000], [100_000, 150_000, 2_000], [1_000_000, 1_400_000, 8_000]),
    ];
    const scored = scoreAirports(pop);
    const hvn = scored.find((r) => r.iata === "HVN")!;
    const growth = hvn.components.find((c) => c.key === "growthMomentum")!;

    // Its growth is by far the highest, so it ranks top on that component...
    expect(growth.percentile).toBeGreaterThan(90);
    // ...but a percentile is capped, so the contribution cannot exceed weight * 100.
    expect(growth.contribution).toBeLessThanOrEqual(growth.weight * 100 + 1e-9);
    // And it cannot run away with the overall score on one component alone.
    expect(hvn.score).toBeLessThan(100);
  });

  it("ranks within cohort, so a small airport does not outrank a hub on raw load factor", () => {
    // Small airport with a very high load factor; large hub with a merely good one.
    const hub = input("HUB", [50_000_000, 59_000_000, 350_000], [48_000_000, 57_000_000, 360_000]);
    const small = input("SML", [600_000, 660_000, 6_000], [580_000, 650_000, 6_100]);
    const scored = scoreAirports([hub, small, ...population(8)]);

    const hubRow = scored.find((r) => r.iata === "HUB")!;
    const smallRow = scored.find((r) => r.iata === "SML")!;
    expect(hubRow.cohort).not.toBe(smallRow.cohort);
    // Each is ranked against its own cohort, so neither percentile is a cross-cohort claim.
    expect(hubRow.cohortSize).toBeGreaterThanOrEqual(1);
    expect(smallRow.cohortSize).toBeGreaterThanOrEqual(1);
  });

  it("redistributes weight when a component is unavailable, rather than penalising the airport", () => {
    const withDelay = population(8);
    const withoutDelay = withDelay.map((i) => ({ ...i, nasDelayMinutesPerArrival: null }));

    const a = scoreAirports(withoutDelay);
    for (const r of a) {
      const strain = r.components.find((c) => c.key === "capacityStrain")!;
      expect(strain.percentile).toBeNull();
      expect(strain.weight).toBe(0);
      expect(strain.unavailableReason).toBeTruthy();
      // Remaining weights must still sum to 1, so scores stay comparable.
      const total = r.components.reduce((s, c) => s + c.weight, 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it("records the weights used on every result", () => {
    const scored = scoreAirports(population(5), { weights: { growthMomentum: 0.9 } });
    expect(scored[0].weights.growthMomentum).toBeGreaterThan(0);
    // Weights are renormalised, so they always describe the actual calculation performed.
    const total = Object.values(scored[0].weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("changes the ranking when weights change", () => {
    // Two airports: one all growth, one all load factor.
    const grower = input("GRW", [3_000_000, 4_200_000, 30_000], [1_500_000, 2_100_000, 15_000]);
    const full = input("FUL", [3_000_000, 3_150_000, 30_000], [2_950_000, 3_100_000, 29_800]);
    const pop = [grower, full];

    const byGrowth = scoreAirports(pop, {
      weights: { growthMomentum: 1, demandPressure: 0, capacityStrain: 0, frequencyConstraint: 0 },
    });
    const byPressure = scoreAirports(pop, {
      weights: { demandPressure: 1, growthMomentum: 0, capacityStrain: 0, frequencyConstraint: 0 },
    });

    expect(byGrowth[0].iata).toBe("GRW");
    expect(byPressure[0].iata).toBe("FUL");
  });

  it("makes the arithmetic auditable: contributions sum to the score", () => {
    for (const r of scoreAirports(population(15))) {
      const summed = r.components.reduce((s, c) => s + c.contribution, 0);
      expect(summed).toBeCloseTo(r.score, 10);
    }
  });

  it("returns an empty result rather than throwing on an empty population", () => {
    expect(scoreAirports([])).toEqual([]);
    expect(scoreAirports([input("TNY", [1, 2, 1])])).toEqual([]);
  });

  it("handles zero seats without producing NaN", () => {
    const broken = input("BRK", [0, 0, 0], [0, 0, 0]);
    broken.current.passengers = MIN_PASSENGERS_FOR_INCLUSION;
    const scored = scoreAirports([broken, ...population(5)]);
    for (const r of scored) expect(Number.isFinite(r.score)).toBe(true);
  });
});

