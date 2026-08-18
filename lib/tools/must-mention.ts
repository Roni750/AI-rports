/**
 * Required context: the facts an answer is wrong without.
 *
 * The original design was a bare `string[]` that the system prompt asked the model to include.
 * That was an improvement over burying the same text among optional caveats — but it was still
 * persuasion, just better labelled. Nothing checked that the model complied, so a dropped fact
 * looked exactly like a relayed one.
 *
 * This module closes that gap and adds the two things a flat list could not express:
 *
 *   dedup     the same fact emitted by two different tools is relayed once, not twice
 *   priority  a cross-cohort warning outranks a metro relationship when several accumulate
 *   checking  after the answer exists, did each fact actually reach it?
 *
 * Everything here is pure and unit-tested. The checker is a heuristic and says so — the prompt
 * deliberately asks the model to reword, so an exact-substring test would fail on correct answers.
 * What it detects reliably is a fact being dropped altogether, which is the failure that matters.
 */

/** Ordered most to least important. A result carrying several is relayed in this order. */
export const MUST_MENTION_PRIORITIES = ["critical", "important", "useful"] as const;
export type MustMentionPriority = (typeof MUST_MENTION_PRIORITIES)[number];

export interface MustMention {
	/**
	 * Stable identity for deduplication.
	 *
	 * Two tools legitimately notice the same thing — resolveAirport and compareAirports both spot
	 * that SNA sits inside greater Los Angeles — and hearing it twice makes an answer read like a
	 * machine. Keyed on the fact, not the tool that found it.
	 */
	key: string;
	/** The fact, as a sentence. The model conveys it in its own words. */
	text: string;
	priority: MustMentionPriority;
}

/** One required fact, plus whether the finished answer actually carried it. */
export interface RequiredContextCheck extends MustMention {
	relayed: boolean;
	/** Distinctive terms the check looked for. Exposed so a false negative is diagnosable. */
	signals: string[];
	/** How many of those appeared. */
	signalsFound: number;
}

/** At least this share of a fact's distinctive terms must appear before it counts as relayed. */
const RELAY_THRESHOLD = 0.5;

/**
 * Strip formatting that differs between the fact and a reworded answer.
 *
 * "2,660,772" and "2660772" are the same number; "5.75 billion" may be written either way. Commas
 * inside digits go, case is flattened, and everything else is left alone.
 */
function normalise(text: string): string {
	return text.replace(/(\d),(?=\d)/g, "$1").toLowerCase();
}

/**
 * The terms whose presence indicates a fact was conveyed.
 *
 * Numbers and airport codes carry the substance of every fact this system emits, and neither
 * survives paraphrase as anything else — a model rewording the freight note still has to say
 * "5.75" and "ANC". Single digits are excluded: "6" appears in almost any text and would make the
 * check pass on answers that dropped the fact entirely.
 */
export function extractSignals(text: string): string[] {
	const signals = new Set<string>();

	for (const m of text.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
		const n = m[0].replace(/,/g, "");
		if (n.replace(".", "").length >= 2) signals.add(n.toLowerCase());
	}
	for (const m of text.matchAll(/\b[A-Z]{3}\b/g)) signals.add(m[0].toLowerCase());

	// Nothing numeric or coded — fall back to the longest distinctive words, which is weaker but
	// better than declaring every such fact relayed by default.
	if (signals.size === 0) {
		for (const w of text.toLowerCase().match(/\b[a-z]{7,}\b/g) ?? []) signals.add(w);
	}
	return [...signals];
}

/**
 * Deduplicate by key and order by priority.
 *
 * First occurrence of a key wins: tools run in the order the model chose them, so the earliest
 * mention is the one whose phrasing fits the flow of the answer.
 */
export function resolveRequiredContext(collected: readonly MustMention[]): MustMention[] {
	const byKey = new Map<string, MustMention>();
	for (const m of collected) if (!byKey.has(m.key)) byKey.set(m.key, m);

	return [...byKey.values()].sort(
		(a, b) =>
			MUST_MENTION_PRIORITIES.indexOf(a.priority) - MUST_MENTION_PRIORITIES.indexOf(b.priority),
	);
}

/** Did the finished answer carry each required fact? */
export function checkRelayed(
	required: readonly MustMention[],
	reply: string,
): RequiredContextCheck[] {
	const haystack = normalise(reply);

	return required.map((m) => {
		const signals = extractSignals(m.text);
		const found = signals.filter((s) => haystack.includes(s));
		return {
			...m,
			signals,
			signalsFound: found.length,
			// No signals means nothing to test against; treat as relayed rather than reporting a
			// failure the checker cannot actually observe.
			relayed: signals.length === 0 || found.length / signals.length >= RELAY_THRESHOLD,
		};
	});
}

/** Compliance across one turn, for logging. Null when the turn required nothing. */
export function relayRate(checks: readonly RequiredContextCheck[]): number | null {
	if (checks.length === 0) return null;
	return checks.filter((c) => c.relayed).length / checks.length;
}
