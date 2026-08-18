import { describe, expect, it } from "vitest";

import { REDACTION_VERSION, redact, redactArguments } from "./redact";

/**
 * The negative cases matter more than the positive ones.
 *
 * A redactor is easy to make aggressive and hard to make correct. Over-redaction is the failure
 * that actually costs something here: it destroys the prompt text the whole analytics feature
 * exists to analyse, and it does so silently. Every domain string below is one this product sees
 * constantly, so any of them being eaten is a bug that would reach the dashboard.
 */

describe("redacts what it should", () => {
  it("removes email addresses", () => {
    const { text, hits } = redact("mail me at roni.test+tag@example.co.uk about SFO");
    expect(text).toBe("mail me at [redacted:email] about SFO");
    expect(hits).toContain("email");
  });

  it("removes card-shaped digit runs", () => {
    const { text, hits } = redact("card 4111 1111 1111 1111 please");
    expect(text).toBe("card [redacted:card] please");
    expect(hits).toContain("card");
  });

  it("removes SSN-shaped numbers", () => {
    const { text } = redact("ssn 123-45-6789");
    expect(text).toBe("ssn [redacted:ssn]");
  });

  it("removes phone numbers", () => {
    expect(redact("call +1 415-555-0134 now").text).toBe("call [redacted:phone] now");
    expect(redact("call (415) 555-0134 now").text).toBe("call [redacted:phone] now");
  });

  it("removes social handles", () => {
    expect(redact("ask @roni_dev about it").text).toBe("ask [redacted:handle] about it");
  });

  it("reports the version it used", () => {
    expect(redact("nothing here").version).toBe(REDACTION_VERSION);
  });
});

describe("leaves the domain's own vocabulary alone", () => {
  // Each of these is a real string this agent receives or produces. If the redactor touches one,
  // the analytics layer starts storing corrupted prompts and nobody finds out until the dashboard
  // shows nonsense.
  const untouched = [
    "Which airports in New England are strong candidates for terminal expansion?",
    "Compare LA and Santa Ana airport congestion levels.",
    "What is the percentage of long haul flights out of Anchorage airport?",
    "What is the unmet flight demand in SFO airport and why?",
    "SFO vs OAK in 2024",
    "load factor 0.847 at ATL",
    "ANC handled 5750000000 lbs of freight",
    "compare 2019 and 2023 and 2024",
    "JFK taxi-out was 26.4 minutes",
    "show me airports with over 1000000 passengers",
    "what about LAX, SNA and LGB",
  ];

  for (const prompt of untouched) {
    it(`leaves "${prompt.slice(0, 42)}…" unchanged`, () => {
      const { text, hits } = redact(prompt);
      expect(text).toBe(prompt);
      expect(hits).toEqual([]);
    });
  }

  it("does not treat a four-digit year as anything", () => {
    expect(redact("2024").text).toBe("2024");
  });

  it("does not treat a nine-digit freight figure as an SSN", () => {
    // Bare nine-digit runs are common in this dataset. The SSN pattern requires separators
    // precisely so this passes.
    expect(redact("freight was 938000000 lbs").text).toBe("freight was 938000000 lbs");
  });

  it("does not treat a twelve-digit metric as a card number", () => {
    expect(redact("seats 123456789012").text).toBe("seats 123456789012");
  });
});

describe("redactArguments", () => {
  it("redacts string values and leaves other types alone", () => {
    const out = redactArguments({
      query: "email me at a@b.com",
      year: 2024,
      limit: 10,
      states: ["MA", "CT"],
    });
    expect(out.query).toBe("email me at [redacted:email]");
    expect(out.year).toBe(2024);
    expect(out.limit).toBe(10);
    expect(out.states).toEqual(["MA", "CT"]);
  });

  it("leaves ordinary tool arguments untouched", () => {
    const args = { iata: "SFO", year: 2024, weights: { demandPressure: 0.3 } };
    expect(redactArguments(args)).toEqual(args);
  });
});
