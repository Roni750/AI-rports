import type { AirportLookup } from "../data/db";

/**
 * Which airports a turn was about.
 *
 * The topic taxonomy answers *what kind of question* was asked. This answers *what it was about* —
 * an orthogonal dimension, and arguably the more actionable one. Topics describe the shape of
 * demand; entities describe where it is pointed. The cross-tab produces sentences neither can
 * produce alone: "capacity questions are dominated by SFO and EWR".
 *
 * NO MODEL IS INVOLVED, and that is not a shortcut. Deciding whether "ANC" is an airport is
 * membership in a closed set of ~700 codes shipped with the product. A lookup answers it exactly,
 * instantly and for nothing; a language model would answer it slower, dearer, and occasionally
 * wrongly. Reaching for one here would be the junior move.
 *
 * THE RULE THAT SHAPES EVERYTHING: entities come from the PROMPT and the TOOL ARGUMENTS, never
 * from tool results. An airport sitting in row 9 of a ranking table was *returned*, not *asked
 * about*. Counting it would quietly convert "how often was LAX asked about" into "how often did LAX
 * rank highly" — a different question, and one whose answer is decided by the scoring engine rather
 * than by users. Tool arguments are the agent's resolution of what the user meant; the prompt is
 * the user's own words. Those two are the question. Everything else is the answer.
 */

export type EntityType = "airport" | "unresolved" | "unknown_code";
export type EntitySource = "tool_arg" | "prompt";

export interface Entity {
  entityType: EntityType;
  /** IATA code, or the raw lowercased query for `unresolved`, or the unrecognised code. */
  code: string;
  source: EntitySource;
  /** Display city for an airport; null otherwise. */
  label: string | null;
}

export interface EntityInput {
  /** The REDACTED prompt — the same text that gets stored. */
  prompt: string;
  toolCalls: readonly { name: string; arguments: Record<string, unknown> }[];
}

/**
 * Argument keys that carry an airport code.
 *
 * Verified against `lib/agent/tool-schemas.ts` and against the arguments actually recorded:
 * `iata` (single), `iataCodes` (array), `query` (free text, resolveAirport only).
 */
const CODE_KEYS = ["iata"] as const;
const CODE_ARRAY_KEYS = ["iataCodes"] as const;
const QUERY_KEYS = ["query"] as const;

/**
 * A bare three-letter uppercase token in free text.
 *
 * Case-SENSITIVE on purpose. The same pattern under an `/i` flag matches every three-letter English
 * word, which is how the off-domain classifier rule once decided that "the" made a prompt on-topic.
 * Even case-sensitive it only produces a *candidate*: "ROI" in "expand ATL and what is the ROI?"
 * has the exact shape of a code and is not one, so every match is checked against the real set.
 */
const BARE_CODE = /\b[A-Z]{3}\b/g;

/** Exactly three letters and nothing else — a whole query that looks like a code. */
const CODE_SHAPE = /^[A-Za-z]{3}$/;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function extractEntities(input: EntityInput, lookup: AirportLookup): Entity[] {
  // Keyed by the storage grain, so the same airport reached twice by the same route collapses to
  // one row while a prompt mention and a tool mention stay distinct — that split is informative.
  const found = new Map<string, Entity>();

  const add = (entityType: EntityType, code: string, source: EntitySource) => {
    const key = `${entityType}|${code}|${source}`;
    if (found.has(key)) return;
    found.set(key, {
      entityType,
      code,
      source,
      label: entityType === "airport" ? (lookup.iataToCity.get(code) ?? null) : null,
    });
  };

  /** A code from a tool argument: valid ones are airports, invalid ones are coverage gaps. */
  const addToolCode = (raw: string) => {
    const code = raw.toUpperCase();
    if (code.length !== 3) return;
    // An unrecognised code IS worth recording here, because the agent passed it to a tool as an
    // airport. Someone asked about a place this dataset does not cover — a demand signal about
    // coverage rather than a bug. `ZZZ` in the seed corpus is the deliberate example.
    add(lookup.codes.has(code) ? "airport" : "unknown_code", code, "tool_arg");
  };

  // ------------- 1. tool arguments (authoritative: the agent asserted these are airports)

  for (const call of input.toolCalls) {
    for (const key of CODE_KEYS) {
      const raw = asString(call.arguments[key]);
      if (raw) addToolCode(raw);
    }

    for (const key of CODE_ARRAY_KEYS) {
      const value = call.arguments[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const raw = asString(item);
        if (raw) addToolCode(raw);
      }
    }

    for (const key of QUERY_KEYS) {
      const raw = asString(call.arguments[key]);
      if (!raw) continue;

      const upper = raw.toUpperCase();
      if (upper.length === 3 && lookup.codes.has(upper)) {
        add("airport", upper, "tool_arg");
        continue;
      }

      const city = lookup.cityToIata.get(raw.toLowerCase());
      if (city) {
        add("airport", city, "tool_arg");
        continue;
      }

      // A query shaped exactly like a code that resolves to nothing is a coverage gap, not a
      // phrasing. Someone typed "ZZZ airport" and meant an airport; recording it as vocabulary
      // would file it beside "LA" and hide the more useful reading — that we were asked about a
      // place this dataset does not cover.
      if (CODE_SHAPE.test(raw)) {
        add("unknown_code", upper, "tool_arg");
        continue;
      }

      // Neither a code nor a city we know: the user's own phrasing, preserved. This is what
      // records that people say "LA" rather than "LAX" — a fact about vocabulary that no
      // resolved-code column can express, because resolution is exactly what destroys it.
      add("unresolved", raw.toLowerCase(), "tool_arg");
    }
  }

  // ------------- 2. prompt text (best-effort, so deliberately stricter)

  for (const match of input.prompt.match(BARE_CODE) ?? []) {
    // Validated only. Unlike a tool argument, a bare token in free text carries no assertion that
    // it is an airport, so an unrecognised one is dropped rather than recorded as a coverage gap.
    // Recording it would make "ROI", "USA" and "CEO" look like airports we are missing data for.
    if (lookup.codes.has(match)) add("airport", match, "prompt");
  }

  for (const iata of citiesMentioned(input.prompt, lookup)) {
    add("airport", iata, "prompt");
  }

  return [...found.values()];
}

/**
 * City names appearing in the prompt, as IATA codes.
 *
 * Scans word n-grams rather than testing one RegExp per city. With ~700 cities the per-city
 * approach compiles 700 patterns for every turn and needs each name escaped for regex syntax —
 * "Dallas/Fort Worth" and "Martha's Vineyard" both carry characters that would otherwise be
 * interpreted. Tokenising once and looking up is linear in the prompt, needs no escaping, and
 * matches multi-word names ("New York", "San Francisco") by construction.
 */
function citiesMentioned(prompt: string, lookup: AirportLookup): string[] {
  const index = phraseIndex(lookup);
  const words = tokenise(prompt);
  const hits: string[] = [];

  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(index.maxWords, words.length - i); n >= 1; n--) {
      const iata = index.byPhrase.get(words.slice(i, i + n).join(" "));
      if (iata) {
        hits.push(iata);
        // Longest match wins, and the matched span is consumed: "new york" must not also match
        // "york" on the next pass.
        i += n - 1;
        break;
      }
    }
  }

  return hits;
}

/** Words, lowercased, with punctuation dropped entirely rather than treated as a separator. */
function tokenise(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

interface PhraseIndex {
  byPhrase: Map<string, string>;
  maxWords: number;
}

/**
 * City names re-keyed through the SAME tokeniser the prompt goes through.
 *
 * Without this the two sides normalise differently and the mismatch is silent: the lookup key is
 * "martha's vineyard" while the prompt tokenises to "martha s vineyard", so that airport could
 * never be recognised and nothing would ever report a problem. Any normalisation applied to one
 * side of a comparison has to be applied to the other.
 *
 * Cached per lookup object — the lookup itself is a process-lifetime singleton, so this is built
 * once rather than on every turn.
 */
const phraseIndexCache = new WeakMap<AirportLookup, PhraseIndex>();

function phraseIndex(lookup: AirportLookup): PhraseIndex {
  const cached = phraseIndexCache.get(lookup);
  if (cached) return cached;

  const byPhrase = new Map<string, string>();
  let maxWords = 1;

  for (const [city, iata] of lookup.cityToIata) {
    const words = tokenise(city);
    if (words.length === 0) continue;
    const phrase = words.join(" ");
    // First writer wins, matching the lookup's own passenger-ordered precedence.
    if (!byPhrase.has(phrase)) byPhrase.set(phrase, iata);
    if (words.length > maxWords) maxWords = words.length;
  }

  const index = { byPhrase, maxWords };
  phraseIndexCache.set(lookup, index);
  return index;
}
