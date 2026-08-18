import { describe, expect, it } from "vitest";

import { loadAirportLookup } from "./db";

/**
 * The airport lookup, against the real dataset.
 *
 * Integration-style on purpose, matching `lib/tools/airport-tools.test.ts`. The bug this file
 * exists to prevent was invisible to any fixture: BTS writes the city column as "Anchorage, AK",
 * so keying on the raw string produced "anchorage, ak" — a key nobody would ever type. Every city
 * lookup missed, the feature reported zero, and nothing errored. A test with its own hand-written
 * city names would have passed happily.
 *
 * The rule worth taking from it: when a lookup is built from real data, assert against the real
 * data's shape, not against what you assume the shape is.
 */

const lookup = loadAirportLookup();

describe("codes", () => {
  it("contains the major hubs", () => {
    for (const code of ["SFO", "LAX", "ATL", "ANC", "JFK", "ORD"]) {
      expect(lookup.codes.has(code), code).toBe(true);
    }
  });

  it("holds only three-letter uppercase codes", () => {
    for (const code of lookup.codes) {
      expect(code).toMatch(/^[A-Z0-9]{3}$/);
    }
  });

  it("does not contain three-letter words that merely look like codes", () => {
    // Not a guarantee about the alphabet — just a check that the set is airports rather than
    // anything three characters long. "ROI" being absent is what stops the prompt scanner
    // treating it as an airport.
    expect(lookup.codes.has("ROI")).toBe(false);
  });
});

describe("city names", () => {
  it("resolves a bare city name", () => {
    // The regression. "Anchorage" is what a person types; "Anchorage, AK" is what BTS stores.
    expect(lookup.cityToIata.get("anchorage")).toBe("ANC");
    expect(lookup.cityToIata.get("santa ana")).toBe("SNA");
    expect(lookup.cityToIata.get("san francisco")).toBe("SFO");
  });

  it("also resolves a city qualified by its state", () => {
    expect(lookup.cityToIata.get("anchorage ak")).toBe("ANC");
    expect(lookup.cityToIata.get("san francisco ca")).toBe("SFO");
  });

  it("never keeps the raw comma-and-state form as a key", () => {
    // The exact shape of the original bug.
    for (const key of lookup.cityToIata.keys()) {
      expect(key, `"${key}" still carries punctuation`).not.toContain(",");
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("takes the first alternative of a slashed name", () => {
    // "Dallas/Fort Worth, TX"
    expect(lookup.cityToIata.get("dallas")).toBe("DFW");
  });

  it("gives a shared city name to the busiest airport", () => {
    // Chicago has both ORD and MDW. Recognition only has to know a city was named; deciding
    // between two airports serving it is the agent's resolver's job, not this table's.
    expect(lookup.cityToIata.get("chicago")).toBe("ORD");
  });

  it("maps every city key to a real code", () => {
    for (const [city, iata] of lookup.cityToIata) {
      expect(lookup.codes.has(iata), `${city} -> ${iata}`).toBe(true);
    }
  });
});

describe("display labels", () => {
  it("keeps the full city string for display", () => {
    // The key is normalised; the label is not, because a reader wants the state back.
    expect(lookup.iataToCity.get("ANC")).toContain("Anchorage");
    expect(lookup.iataToCity.get("ANC")).toContain("AK");
  });
});
