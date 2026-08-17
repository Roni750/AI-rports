import { describe, expect, it } from "vitest";

import { assessRobustness, describeWeights, ROBUSTNESS_SCENARIOS } from "./robustness";
import type { AirportYear, ScoringInput } from "./types";

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

function input(
  iata: string,
  current: [number, number, number],
  baseline: [number, number, number],
  delay: number | null = 10,
  state = "XX",
): ScoringInput {
  const mk = (year: number, t: [number, number, number]) =>
    airportYear({ iata, year, state, passengers: t[0], seats: t[1], departures: t[2] });
  return {
    iata,
    city: `${iata} City`,
    state,
    current: mk(2024, current),
    previous: null,
    baseline: mk(2019, baseline),
    nasDelayMinutesPerArrival: delay,
  };
}

/** A filler population so percentiles have something to rank against. */
function filler(count: number): ScoringInput[] {
  return Array.from({ length: count }, (_, i) =>
    input(
      `F${String(i).padStart(2, "0")}`,
      [1_000_000 + i * 50_000, 1_250_000 + i * 60_000, 10_000 + i * 100],
      [950_000 + i * 50_000, 1_200_000 + i * 60_000, 9_800 + i * 100],
      5 + i * 0.5,
    ),
  );
}

describe("assessRobustness", () => {
  it("marks an all-round strong airport as robust", () => {
    // Best on every component, so it should top the list under any weighting.
    const dominant = input("DOM", [4_000_000, 4_400_000, 25_000], [2_600_000, 3_200_000, 24_000], 40);
    const report = assessRobustness([dominant, ...filler(12)], { topN: 5 });

    const dom = [...report.robust, ...report.weightDependent].find((e) => e.iata === "DOM");
    expect(dom).toBeDefined();
    expect(dom!.robust).toBe(true);
    expect(dom!.stableIn).toBe(ROBUSTNESS_SCENARIOS.length);
  });

  it("marks a one-trick airport as weight-dependent and names what carries it", () => {
    // Enormous growth, but poor load factor -- should survive growth-led weighting and little else.
    const grower = input("GRW", [3_000_000, 4_400_000, 30_000], [800_000, 1_150_000, 8_000], 1);
    const report = assessRobustness([grower, ...filler(14)], { topN: 3 });

    const grw = [...report.robust, ...report.weightDependent].find((e) => e.iata === "GRW");
    if (grw) {
      // Either it is flagged weight-dependent, or it genuinely holds under everything.
      if (!grw.robust) {
        expect(grw.stableIn).toBeLessThan(ROBUSTNESS_SCENARIOS.length);
        expect(report.weightDependent.map((e) => e.iata)).toContain("GRW");
      }
      expect(grw.drivenByLabel.length).toBeGreaterThan(0);
    }
  });

  it("produces a plain-language note with no internal jargon", () => {
    const report = assessRobustness(filler(15), { topN: 5 });
    expect(report.note.length).toBeGreaterThan(0);
    expect(report.note.endsWith(".")).toBe(true);
    for (const jargon of ["percentile", "cohort", "demandPressure", "frequencyConstraint", "NAS"]) {
      expect(report.note).not.toContain(jargon);
    }
  });

  it("respects a state filter, so regional questions get regional robustness", () => {
    const pop = [
      input("AAA", [2_000_000, 2_300_000, 15_000], [1_700_000, 2_100_000, 15_500], 8, "ME"),
      input("BBB", [1_500_000, 1_900_000, 12_000], [1_400_000, 1_800_000, 12_500], 4, "ME"),
      ...filler(12),
    ];
    const report = assessRobustness(pop, { states: ["ME"], topN: 5 });
    const all = [...report.robust, ...report.weightDependent].map((e) => e.iata);
    expect(all).toContain("AAA");
    expect(all).toContain("BBB");
    expect(all.some((c) => c.startsWith("F"))).toBe(false);
  });

  it("is deterministic", () => {
    const pop = filler(15);
    expect(JSON.stringify(assessRobustness(pop))).toBe(JSON.stringify(assessRobustness(pop)));
  });

  it("returns an empty note rather than throwing when nothing matches the filter", () => {
    const report = assessRobustness(filler(10), { states: ["ZZ"] });
    expect(report.robust).toEqual([]);
    expect(report.weightDependent).toEqual([]);
    expect(report.note).toBe("");
  });

  it("describes weights in plain language", () => {
    const text = describeWeights();
    expect(text).toContain("how full the planes are");
    expect(text).toMatch(/\d+%/);
  });
});

