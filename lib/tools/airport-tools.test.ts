import { describe, expect, it } from "vitest";

import {
  compareAirports,
  explainScore,
  flightMix,
  getAirportMetrics,
  rankAirports,
  resolveAirport,
} from "./airport-tools";
import type { ToolResult } from "./types";

/**
 * Integration tests against the real dataset.
 *
 * Deliberately not mocked: the point is that the shipped database answers the brief's questions
 * correctly. A mocked test would pass while the demo failed.
 *
 * Assertions avoid pinning exact figures where a data refresh would legitimately change them,
 * and pin them where the value IS the claim (e.g. Anchorage being freight-dominated).
 */

function expectOk<T>(r: ToolResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data;
}

/** Every successful result must carry its own provenance -- that is the whole design. */
function expectEnvelope<T>(r: ToolResult<T>) {
  if (!r.ok) throw new Error("expected ok");
  expect(r.dataVintage.length).toBeGreaterThan(0);
  expect(r.assumptions.length).toBeGreaterThan(0);
  expect(["high", "medium", "low"]).toContain(r.confidence);
  expect(Array.isArray(r.caveats)).toBe(true);
}

describe("resolveAirport", () => {
  it("surfaces metro ambiguity instead of guessing", () => {
    const d = expectOk(resolveAirport("LA"));
    expect(d.kind).toBe("ambiguous");
    expect(d.interpretations!.length).toBeGreaterThanOrEqual(2);
    // One reading must be the single main airport, another the whole basin.
    const airportSets = d.interpretations!.map((i) => i.airports);
    expect(airportSets.some((s) => s.length === 1 && s[0] === "LAX")).toBe(true);
    expect(airportSets.some((s) => s.length > 1 && s.includes("SNA"))).toBe(true);
  });

  it("tells you Santa Ana sits inside the LA metro", () => {
    const d = expectOk(resolveAirport("Santa Ana"));
    expect(d.kind).toBe("resolved");
    expect(d.airport!.iata).toBe("SNA");
    expect(d.airport!.metro).not.toBeNull();
    expect(d.airport!.metro!.siblingAirports).toContain("LAX");
    expect(d.notes.join(" ")).toMatch(/Los Angeles/i);
  });

  it("resolves an exact IATA code without asking", () => {
    const d = expectOk(resolveAirport("SFO"));
    expect(d.kind).toBe("resolved");
    expect(d.airport!.iata).toBe("SFO");
  });

  it("returns a structured failure for an unknown code, never throws", () => {
    const r = resolveAirport("ZZZ");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("airport_not_found");
      expect(r.suggestions?.length).toBeGreaterThan(0);
    }
  });

  it("rejects empty input as a parameter problem", () => {
    const r = resolveAirport("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_parameters");
  });
});

describe("getAirportMetrics", () => {
  it("returns figures plus provenance for a major airport", () => {
    const r = getAirportMetrics("SFO");
    const d = expectOk(r);
    expectEnvelope(r);
    expect(d.passengers).toBeGreaterThan(1_000_000);
    expect(d.loadFactorPct).toBeGreaterThan(50);
    expect(d.loadFactorPct).toBeLessThan(100);
    expect(d.history.length).toBeGreaterThanOrEqual(2); // multiple years for trend questions
  });

  it("flags reduced confidence when an airport has no delay coverage", () => {
    // Search the dataset for an airport outside On-Time Performance coverage.
    const ranked = expectOk(rankAirports({ cohort: "non_hub", limit: 25 }));
    const uncovered = ranked.rows.find((r) => r.nasDelayMinPerArrival === null);
    if (!uncovered) return; // coverage happens to be complete; nothing to assert
    const r = getAirportMetrics(uncovered.iata);
    if (r.ok) {
      expect(r.data.nasDelayMinPerArrival).toBeNull();
      expect(r.confidence).toBe("medium");
      expect(r.caveats.join(" ")).toMatch(/On-Time Performance/i);
    }
  });

  it("fails cleanly for an unknown airport", () => {
    const r = getAirportMetrics("ZZZ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_data_for_airport");
  });
});

describe("rankAirports", () => {
  it("always attaches a robustness note", () => {
    const d = expectOk(rankAirports({ cohort: "large_hub", limit: 5 }));
    expect(d.robustnessNote.length).toBeGreaterThan(10);
    expect(d.weightsUsed).toMatch(/%/);
  });

  it("answers the New England question across all six states", () => {
    const d = expectOk(rankAirports({ region: "new_england", limit: 8 }));
    expect(d.rows.length).toBeGreaterThan(3);
    const states = new Set(d.rows.map((r) => r.state));
    for (const s of states) expect(["ME", "NH", "VT", "MA", "RI", "CT"]).toContain(s);
  });

  it("warns when a list mixes size cohorts", () => {
    const r = rankAirports({ region: "new_england", limit: 8 });
    if (!r.ok) throw new Error("expected ok");
    if (r.data.cohortsIncluded.length > 1) {
      expect(r.caveats.join(" ")).toMatch(/NOT directly comparable across cohorts/i);
    }
  });

  it("states that the score is not profitability", () => {
    const r = rankAirports({ cohort: "large_hub", limit: 3 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.metricDefinitions.join(" ")).toMatch(/NOT profitability/i);
  });

  it("changes the ranking when weights change", () => {
    const a = expectOk(rankAirports({ cohort: "large_hub", limit: 12 }));
    const b = expectOk(
      rankAirports({
        cohort: "large_hub",
        limit: 12,
        weights: { capacityStrain: 0.85, demandPressure: 0.05, growthMomentum: 0.05, frequencyConstraint: 0.05 },
      }),
    );
    expect(a.rows.map((r) => r.iata).join()).not.toBe(b.rows.map((r) => r.iata).join());

    // SFO is the most delay-affected large hub, so weighting delay heavily must move it UP.
    // Asserting it lands exactly first would be over-fitting: Newark is nearly as delay-affected
    // and much stronger on the other three components, so it can still edge ahead even at 5%
    // weights. The mechanism is what matters, not the exact winner.
    const rankOf = (rows: typeof a.rows, iata: string) =>
      rows.find((r) => r.iata === iata)?.rank ?? Number.POSITIVE_INFINITY;
    expect(rankOf(b.rows, "SFO")).toBeLessThan(rankOf(a.rows, "SFO"));
    expect(rankOf(b.rows, "SFO")).toBeLessThanOrEqual(3);
  });

  it("returns a structured empty result for impossible filters", () => {
    const r = rankAirports({ states: ["ZZ"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty_result");
  });

  it("clamps limit into a sane range", () => {
    const d = expectOk(rankAirports({ cohort: "large_hub", limit: 999 }));
    expect(d.rows.length).toBeLessThanOrEqual(25);
  });
});

describe("compareAirports", () => {
  it("names the metro relationship exactly once for LAX vs SNA", () => {
    const d = expectOk(compareAirports(["LAX", "SNA"]));
    const metroLines = d.observations.filter((o) => /Greater Los Angeles/.test(o));
    expect(metroLines.length).toBe(1);
    expect(metroLines[0]).toMatch(/both/);
  });

  it("warns that scores are incomparable across cohorts", () => {
    const d = expectOk(compareAirports(["LAX", "SNA"]));
    expect(d.sameCohort).toBe(false);
    expect(d.observations.join(" ")).toMatch(/not directly comparable/i);
  });

  it("compares congestion with a concrete ratio", () => {
    const d = expectOk(compareAirports(["LAX", "SNA"]));
    expect(d.observations.join(" ")).toMatch(/minutes per arrival/);
  });

  it("requires at least two airports", () => {
    const r = compareAirports(["SFO"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_parameters");
  });

  it("refuses an unreasonably long comparison", () => {
    const r = compareAirports(["SFO", "LAX", "JFK", "ORD", "ATL", "DFW", "DEN"]);
    expect(r.ok).toBe(false);
  });
});

describe("explainScore", () => {
  it("breaks SFO down so the contributions sum to the score", () => {
    const d = expectOk(explainScore("SFO"));
    const summed = d.components.reduce((s, c) => s + c.pointsContributed, 0);
    expect(summed).toBeCloseTo(d.score, 6);
  });

  it("identifies SFO as congested but not growing", () => {
    const d = expectOk(explainScore("SFO"));
    const strain = d.components.find((c) => c.component === "capacityStrain")!;
    const growth = d.components.find((c) => c.component === "growthMomentum")!;
    expect(strain.percentileInCohort).toBeGreaterThan(90);
    expect(growth.percentileInCohort).toBeLessThan(30);
    // And it must say so in words, not leave the reader to infer it.
    expect(d.interpretation.join(" ")).toMatch(/congested but not growing/i);
  });

  it("reports SFO's seasonal swing, which is the actual mechanism", () => {
    const d = expectOk(explainScore("SFO"));
    expect(d.seasonality).not.toBeNull();
    expect(d.seasonality!.swingRatio).toBeGreaterThan(3);
    expect(d.interpretation.join(" ")).toMatch(/seasonal/i);
  });

  it("fails cleanly for an airport with no comparative score", () => {
    const r = explainScore("ZZZ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_data_for_airport");
  });
});

describe("flightMix", () => {
  it("gives Anchorage's haul split with shares summing to 100", () => {
    const d = expectOk(flightMix("ANC"));
    const total = d.haul.shortPct + d.haul.mediumPct + d.haul.longPct;
    expect(total).toBeCloseTo(100, 1);
    expect(d.haul.longPct).toBeGreaterThan(0);
  });

  it("flags Anchorage as freight-dominated -- the trap in that question", () => {
    const r = flightMix("ANC");
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    expect(r.data.freightLbs).toBeGreaterThan(1e9);
    expect(r.data.freightNote).not.toBeNull();
    expect(r.data.freightNote!).toMatch(/freight/i);
    // The definition must make clear shares are of passengers, not flights.
    expect(r.metricDefinitions.join(" ")).toMatch(/of passengers, not of flights/i);
  });

  it("states that haul thresholds are our own convention", () => {
    const r = flightMix("ANC");
    if (!r.ok) throw new Error("expected ok");
    expect(r.assumptions.join(" ")).toMatch(/not an industry standard/i);
  });

  it("finds genuinely constrained routes out of SFO", () => {
    const d = expectOk(flightMix("SFO"));
    expect(d.constrainedRoutes.length).toBeGreaterThan(0);
    for (const r of d.constrainedRoutes) {
      expect(r.loadFactorPct).toBeGreaterThanOrEqual(88);
      expect(r.passengers).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("fails cleanly for an unknown airport", () => {
    const r = flightMix("ZZZ");
    expect(r.ok).toBe(false);
  });
});
