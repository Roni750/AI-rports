import { describe, expect, it } from "vitest";

import {
	checkRelayed,
	extractSignals,
	relayRate,
	resolveRequiredContext,
	type MustMention,
} from "./must-mention";

const FREIGHT: MustMention = {
	key: "freight:ANC",
	priority: "critical",
	text:
		"ANC handled 5.75 billion pounds of freight in 2024 on dedicated cargo services, alongside " +
		"2,660,772 scheduled passengers.",
};

const METRO: MustMention = {
	key: "metro:los_angeles",
	priority: "important",
	text: "LAX and SNA are both in Greater Los Angeles and share a catchment area.",
};

describe("extractSignals", () => {
	it("picks up numbers and airport codes, which survive paraphrase", () => {
		const s = extractSignals(FREIGHT.text);
		expect(s).toContain("5.75");
		expect(s).toContain("anc");
		expect(s).toContain("2660772"); // commas normalised away
	});

	it("ignores single digits, which would match almost any text", () => {
		expect(extractSignals("one of 6 weightings")).not.toContain("6");
	});

	it("falls back to distinctive words when there is nothing numeric", () => {
		const s = extractSignals("Scores are comparable only within a cohort.");
		expect(s.length).toBeGreaterThan(0);
		expect(s).toContain("comparable");
	});
});

describe("resolveRequiredContext", () => {
	it("relays a fact once even when two tools noticed it", () => {
		const out = resolveRequiredContext([METRO, {...METRO, text: "worded differently"}]);
		expect(out).toHaveLength(1);
		expect(out[0].text).toBe(METRO.text); // first occurrence wins
	});

	it("orders critical before important before useful", () => {
		const out = resolveRequiredContext([
			{key: "c", priority: "useful", text: "u"},
			{key: "a", priority: "critical", text: "c"},
			{key: "b", priority: "important", text: "i"},
		]);
		expect(out.map((m) => m.priority)).toEqual(["critical", "important", "useful"]);
	});

	it("is stable for equal priorities", () => {
		const items: MustMention[] = [
			{key: "x", priority: "critical", text: "first"},
			{key: "y", priority: "critical", text: "second"},
		];
		expect(resolveRequiredContext(items).map((m) => m.key)).toEqual(["x", "y"]);
	});
});

describe("checkRelayed", () => {
	it("passes when the answer rewords the fact but keeps the figures", () => {
		const reply =
			"Anchorage moved 5.75 billion pounds of cargo in 2024, against 2,660,772 passengers " +
			"— ANC is a freight hub first.";
		const [check] = checkRelayed([FREIGHT], reply);
		expect(check.relayed).toBe(true);
	});

	it("fails when the fact is dropped — the failure that matters", () => {
		const reply = "22.3% of Anchorage passengers were on long-haul routes.";
		const [check] = checkRelayed([FREIGHT], reply);
		expect(check.relayed).toBe(false);
		expect(check.signalsFound).toBeLessThan(check.signals.length);
	});

	it("reports the signals it looked for, so a false negative is diagnosable", () => {
		const [check] = checkRelayed([FREIGHT], "unrelated");
		expect(check.signals.length).toBeGreaterThan(0);
		expect(check.signalsFound).toBe(0);
	});

	it("does not report a failure it cannot observe", () => {
		// No numbers, no codes, no long words — nothing to test against.
		const [check] = checkRelayed([{key: "k", priority: "useful", text: "a b c"}], "");
		expect(check.relayed).toBe(true);
	});

	it("is case-insensitive about airport codes", () => {
		const [check] = checkRelayed([METRO], "lax and sna both serve greater los angeles");
		expect(check.relayed).toBe(true);
	});
});

describe("relayRate", () => {
	it("is null when nothing was required", () => {
		expect(relayRate([])).toBeNull();
	});

	it("reports the share relayed", () => {
		const checks = checkRelayed([FREIGHT, METRO], "LAX and SNA share Greater Los Angeles.");
		expect(relayRate(checks)).toBeCloseTo(0.5, 5);
	});
});
