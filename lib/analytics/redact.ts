/**
 * Strip personal data from text before it is stored.
 *
 * This is a regex, not a model, and that is the point. Detecting an email address is a solved
 * problem with a deterministic answer; spending a language model call on it would add latency, cost
 * and non-determinism to buy nothing. If a lookup table or a pattern solves it, the pattern wins.
 *
 * THE RAW TEXT IS NEVER WRITTEN. Redaction happens inside the analytics layer rather than at the
 * call site, so no caller can forget it. The trade this makes is real and worth stating: because
 * only redacted text is persisted, improving this redactor cannot retroactively clean old rows —
 * but equally, no raw personal data was ever at rest to clean. For a system aimed at regulated
 * industries that is the right side of the trade.
 *
 * A redactor that eats the data is worse than no redactor, so the patterns below are deliberately
 * narrow and `redact.test.ts` asserts the negative cases: an IATA code is not a phone number, a
 * year is not an SSN, and a load factor is not a credit card.
 */

/**
 * Bumped whenever the patterns change, and stored on every row.
 *
 * Without it, a row redacted by an old version is indistinguishable from one redacted by the
 * current version — so "which rows need re-examining after we fixed the phone pattern?" would have
 * no answer.
 */
export const REDACTION_VERSION = 1;

export interface Redaction {
  text: string;
  /** Which categories fired, for a redaction-rate metric. Never the values themselves. */
  hits: string[];
  version: number;
}

interface Pattern {
  readonly label: string;
  readonly re: RegExp;
  readonly placeholder: string;
}

/**
 * Order matters. Emails run before phone numbers, or the digits inside an address like
 * `bob2024@example.com` get mangled first and leave a fragment the email pattern no longer matches.
 */
const PATTERNS: readonly Pattern[] = [
  {
    label: "email",
    re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    placeholder: "[redacted:email]",
  },
  {
    label: "card",
    // 13–19 digits, optionally separated by spaces or hyphens. Requires at least 13 to avoid
    // catching a year, a passenger count, or an airport's annual seat total.
    //
    // Written to END on a digit rather than as `(?:\d[ -]?){13,19}`: that form lets the final
    // digit's optional separator consume the space after the number, so redacting "1111 please"
    // produced "[redacted:card]please".
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    placeholder: "[redacted:card]",
  },
  {
    label: "ssn",
    // Strictly 3-2-4 with separators. Bare nine-digit runs are NOT matched: freight poundage and
    // seat counts reach nine digits routinely in this dataset, and eating those would be worse
    // than missing an SSN nobody was likely to type.
    re: /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g,
    placeholder: "[redacted:ssn]",
  },
  {
    label: "phone",
    // Requires either a leading + country code or explicit separators/parentheses. A bare run of
    // digits is not treated as a phone number, because in this domain it is almost always a metric.
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\b\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}\b/g,
    placeholder: "[redacted:phone]",
  },
  {
    label: "handle",
    // A social handle: @ followed by word characters, where the @ is not part of an email (those
    // are already gone by this point).
    re: /(^|\s)@\w{2,}/g,
    placeholder: "$1[redacted:handle]",
  },
];

/**
 * Redact a string, reporting which categories fired.
 *
 * Returns the input unchanged when nothing matches, which is the overwhelmingly common case for
 * this product — people ask about airports, not about themselves.
 */
export function redact(input: string): Redaction {
  let text = input;
  const hits: string[] = [];

  for (const pattern of PATTERNS) {
    // Rebuilt per call: a /g regex carries lastIndex between uses, and a shared instance would
    // start matching from wherever the previous string left off.
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    if (!re.test(text)) continue;
    hits.push(pattern.label);
    text = text.replace(new RegExp(pattern.re.source, pattern.re.flags), pattern.placeholder);
  }

  return { text, hits, version: REDACTION_VERSION };
}

/**
 * Redact the values inside a tool-argument object.
 *
 * Tool arguments echo user text — `resolveAirport({ query: "..." })` carries whatever the user
 * typed — so storing them raw would defeat the redaction applied to the prompt itself.
 */
export function redactArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "string" ? redact(value).text : value;
  }
  return out;
}
