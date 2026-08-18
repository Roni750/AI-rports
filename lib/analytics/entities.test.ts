import { describe, expect, it } from "vitest";

import type { AirportLookup } from "../data/db";
import { extractEntities, type Entity } from "./entities";

/**
 * The extractor, tested against a fixture lookup rather than the real dataset.
 *
 * A fixture makes the negative cases statable: to assert that "ROI" is not treated as an airport,
 * the test has to control what counts as an airport. Running against `aviation.db` would also make
 * these tests fail if BTS ever publishes an airport called ROI, which is a dependency no unit test
 * should have.
 */

const LOOKUP: AirportLookup = {
  codes: new Set(["LAX", "SNA", "ANC", "SFO", "ATL", "ORD", "MDW", "JFK", "MVY"]),
  cityToIata: new Map([
    ["los angeles", "LAX"],
    ["santa ana", "SNA"],
    ["anchorage", "ANC"],
    ["san francisco", "SFO"],
    ["atlanta", "ATL"],
    ["chicago", "ORD"],
    ["new york", "JFK"],
    ["martha's vineyard", "MVY"],
  ]),
  iataToCity: new Map([
    ["LAX", "Los Angeles"],
    ["SNA", "Santa Ana"],
    ["ANC", "Anchorage"],
    ["SFO", "San Francisco"],
    ["ATL", "Atlanta"],
    ["ORD", "Chicago"],
    ["JFK", "New York"],
    ["MVY", "Martha's Vineyard"],
  ]),
};

const extract = (
  prompt: string,
  toolCalls: { name: string; arguments: Record<string, unknown> }[] = [],
) => extractEntities({ prompt, toolCalls }, LOOKUP);

const codes = (entities: Entity[], type: Entity["entityType"] = "airport") =>
  entities
    .filter((e) => e.entityType === type)
    .map((e) => e.code)
    .sort();

describe("tool arguments", () => {
  it("takes a single iata argument", () => {
    const found = extract("tell me about it", [{ name: "flightMix", arguments: { iata: "ANC" } }]);
    expect(found).toEqual([
      { entityType: "airport", code: "ANC", source: "tool_arg", label: "Anchorage" },
    ]);
  });

  it("takes every code from an iataCodes array", () => {
    const found = extract("compare them", [
      { name: "compareAirports", arguments: { iataCodes: ["LAX", "SNA"] } },
    ]);
    expect(codes(found)).toEqual(["LAX", "SNA"]);
  });

  it("uppercases a lowercase code", () => {
    const found = extract("x", [{ name: "flightMix", arguments: { iata: "sfo" } }]);
    expect(codes(found)).toEqual(["SFO"]);
  });

  it("ignores arguments that are not airports", () => {
    const found = extract("x", [
      { name: "rankAirports", arguments: { limit: 10, region: "new_england", cohort: "large_hub" } },
    ]);
    expect(found).toEqual([]);
  });
});

describe("unknown codes are coverage gaps, not bugs", () => {
  it("records a code the agent used that the dataset does not have", () => {
    // The seed corpus asks about "ZZZ airport" on purpose. Someone asking about a place we have no
    // data for is a demand signal about coverage, and it is only trustworthy because the agent
    // asserted it was an airport by passing it to a tool.
    const found = extract("what about ZZZ airport?", [
      { name: "getAirportMetrics", arguments: { iata: "ZZZ" } },
    ]);
    expect(codes(found, "unknown_code")).toEqual(["ZZZ"]);
    expect(codes(found, "airport")).toEqual([]);
  });
});

describe("unresolved queries preserve the user's vocabulary", () => {
  it("keeps a resolveAirport query that is neither a code nor a known city", () => {
    // The finding this exists for: people type "LA", not "LAX". Resolution is exactly what
    // destroys that fact, so it is captured before resolution happens.
    const found = extract("how is LA doing?", [
      { name: "resolveAirport", arguments: { query: "LA" } },
    ]);
    expect(found.filter((e) => e.entityType === "unresolved")).toEqual([
      { entityType: "unresolved", code: "la", source: "tool_arg", label: null },
    ]);
  });

  it("resolves a query that IS a known city", () => {
    const found = extract("x", [{ name: "resolveAirport", arguments: { query: "Anchorage" } }]);
    expect(codes(found)).toEqual(["ANC"]);
    expect(codes(found, "unresolved")).toEqual([]);
  });

  it("resolves a query that IS a code", () => {
    const found = extract("x", [{ name: "resolveAirport", arguments: { query: "sfo" } }]);
    expect(codes(found)).toEqual(["SFO"]);
  });

  it("treats a code-shaped query that resolves to nothing as a coverage gap", () => {
    // Found in the real backfill: "ZZZ" reached the resolver as free text and was filed as
    // vocabulary, sitting beside "la" as though someone had invented a nickname. Someone typing
    // "ZZZ airport" meant an airport, and "asked about, no data" is the useful reading.
    const found = extract("what about ZZZ airport?", [
      { name: "resolveAirport", arguments: { query: "ZZZ" } },
    ]);
    expect(codes(found, "unknown_code")).toEqual(["ZZZ"]);
    expect(codes(found, "unresolved")).toEqual([]);
  });

  it("still treats a non-code phrase as vocabulary", () => {
    const found = extract("x", [{ name: "resolveAirport", arguments: { query: "the bay area" } }]);
    expect(codes(found, "unresolved")).toEqual(["the bay area"]);
  });
});

describe("prompt text", () => {
  it("finds a validated bare code", () => {
    const found = extract("how congested is SFO these days");
    expect(found).toEqual([
      { entityType: "airport", code: "SFO", source: "prompt", label: "San Francisco" },
    ]);
  });

  it("does NOT treat a three-letter word as an airport", () => {
    // The bug this pins. "ROI" has the exact shape of an IATA code. So do "USA", "CEO" and "FAA".
    // Shape is a candidate, not an answer — membership in the real code set is the answer. The
    // same mistake under an /i flag once made every three-letter English word look on-domain.
    const found = extract("how much would it cost to expand ATL and what is the ROI?");
    expect(codes(found)).toEqual(["ATL"]);
    expect(found.some((e) => e.code === "ROI")).toBe(false);
  });

  it("never records an unknown code from free text", () => {
    // Unlike a tool argument, a bare token in prose carries no assertion that it is an airport,
    // so an unrecognised one is dropped rather than logged as a coverage gap.
    const found = extract("the CEO of the FAA said XYZ");
    expect(found).toEqual([]);
  });

  it("finds a city by name", () => {
    const found = extract("how is Anchorage doing?");
    expect(codes(found)).toEqual(["ANC"]);
    expect(found[0].source).toBe("prompt");
  });

  it("matches multi-word city names", () => {
    expect(codes(extract("what about San Francisco?"))).toEqual(["SFO"]);
    expect(codes(extract("traffic through New York"))).toEqual(["JFK"]);
  });

  it("matches a city name containing punctuation", () => {
    // The prompt tokeniser drops the apostrophe, so the lookup key must be normalised the same
    // way. If the two sides normalise differently the airport is simply never recognised, and
    // nothing reports a problem.
    expect(codes(extract("flights to Martha's Vineyard"))).toEqual(["MVY"]);
  });

  it("prefers the longest city match", () => {
    // "New York" must not also register as "York" — the matched span is consumed.
    const found = extract("New York traffic");
    expect(codes(found)).toEqual(["JFK"]);
  });

  it("requires a word boundary", () => {
    // "Anchorage" inside a longer word is not a mention. Tokenising rather than substring-matching
    // is what gives this for free.
    expect(extract("reanchorages are not airports")).toEqual([]);
  });

  it("is case-insensitive for city names but not for codes", () => {
    expect(codes(extract("how is anchorage doing"))).toEqual(["ANC"]);
    // Lowercase "sfo" in prose is far more likely to be a typo or a fragment than a code, and
    // accepting it would widen the door that "ROI" is being kept out of.
    expect(extract("how is sfo doing")).toEqual([]);
  });
});

describe("sources are kept distinct", () => {
  it("records the same airport twice when it appears in both the prompt and a tool call", () => {
    // Deliberate: a prompt mention is the user's own words, a tool argument is the agent's
    // resolution of them. Collapsing the two would lose the ability to ask how often the agent
    // reached an airport the user never named.
    const found = extract("how is Anchorage doing?", [
      { name: "flightMix", arguments: { iata: "ANC" } },
    ]);
    expect(found).toHaveLength(2);
    expect(found.map((e) => e.source).sort()).toEqual(["prompt", "tool_arg"]);
  });

  it("deduplicates repeated mentions from the same source", () => {
    const found = extract("SFO vs SFO", [
      { name: "explainScore", arguments: { iata: "SFO" } },
      { name: "getAirportMetrics", arguments: { iata: "SFO" } },
    ]);
    expect(found).toHaveLength(2); // one prompt row, one tool row
  });
});

describe("intent, not output", () => {
  it("ignores airports that appear only in a tool result", () => {
    // The rule the whole module is built around. A tool RESULT is the answer, not the question —
    // counting it would turn "how often was LAX asked about" into "how often did LAX rank highly",
    // which is decided by the scoring engine rather than by users. The extractor is never given
    // results, and this test pins that by passing one and expecting it to be ignored.
    const found = extract("which airports in New England are candidates?", [
      {
        name: "rankAirports",
        arguments: { region: "new_england", limit: 10 },
        // Shape mirrors a real ToolResult; entirely absent from the extractor's contract.
        ...({ result: { data: { rows: [{ iata: "LAX" }, { iata: "SFO" }] } } } as object),
      },
    ]);
    expect(found).toEqual([]);
  });
});
