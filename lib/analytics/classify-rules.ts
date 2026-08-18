import { RULES_VERSION } from "./classifier-version";
import { UNCLASSIFIED } from "./taxonomy";

/**
 * Stage one of the classifier: deterministic rules.
 *
 * This is the stage that earns the feature its cost story. It is a pure function over data already
 * in memory — no network, no model, no measurable time — and it decides the clear majority of
 * turns. The language model is reserved for the residual, which is the whole argument: if a lookup
 * table and a regex settle it, spending a model call is a choice to pay for nothing.
 *
 * PRECEDENCE IS A DESIGN DECISION, SO IT IS DATA. The rules are an ordered array and the first
 * match wins. That ordering encodes a hierarchy worth stating explicitly, because it is the part a
 * reviewer should argue with:
 *
 *   1. INTENT — what the user is trying to do, including asking for something out of scope or not
 *      about airports at all. "How much would it cost to expand ATL?" still makes the agent run
 *      `rankAirports`, so the tools would call it screening. The user asked about money.
 *   2. SUBJECT — cargo, congestion, growth, traffic mix. What the question is ABOUT.
 *   3. ANALYTICAL SHAPE — comparison and screening, for questions whose subject is general
 *      expansion opportunity rather than a specific metric.
 *   4. OBSERVED BEHAVIOUR — which tools the agent actually invoked. The most reliable signal when
 *      the prompt is terse ("why?", "what about SNA"), and free, but it describes what the system
 *      did rather than what was asked.
 *
 * SUBJECT ABOVE SHAPE IS A REVERSAL, made while labelling the gold set and worth recording. Shape
 * first looked right because it determines the format of a correct answer. But it collapsed
 * "which airports have the worst delays", "which airports are growing fastest" and "which airports
 * are cargo hubs" all into `screening_ranking`, which emptied the subject topics and made the
 * dashboard's headline read "users ask for lists" instead of "users ask about delays". For a view
 * whose entire job is grouping what gets discussed, the subject is the more useful axis — and the
 * shape topics still hold every question with no specific metric subject ("SFO vs OAK", "which
 * airports should we look at in California").
 *
 * The honest caveat: shape and subject are orthogonal, so a single label cannot carry both. That
 * is the known ceiling on this taxonomy, and the trigger for adding a second label is written down
 * in `taxonomy.ts` rather than left to be rediscovered.
 *
 * When the prompt says one thing and the tools say another, the prompt wins. The tools record how
 * the agent interpreted a question; the topic is meant to record the question.
 */

export interface ClassifierFeatures {
  /** Redacted prompt text — the same string that gets stored. */
  prompt: string;
  /** Tool names invoked for this turn, in order. */
  toolsInvoked: readonly string[];
}

export interface TopicRule {
  /** Stored in `turn_topic.rule_id`, so a surprising label traces back to one line. */
  readonly id: string;
  readonly topicId: string;
  /** Fixed per rule. The rule stage asserts; it does not estimate. */
  readonly confidence: number;
  /** One line, printed by the eval report next to the rule's hit count. */
  readonly why: string;
  matches(f: ClassifierFeatures): boolean;
}

const has = (re: RegExp) => (f: ClassifierFeatures) => re.test(f.prompt);
const used = (tool: string) => (f: ClassifierFeatures) => f.toolsInvoked.includes(tool);

/**
 * Does this prompt refer to the domain at all?
 *
 * Used only by the final off-domain rule, which has to tell "no rule matched because the prompt is
 * unusual" apart from "no rule matched because this is not about airports".
 *
 * The two halves are separate regexes for one reason worth recording: an IATA code is three
 * UPPERCASE letters, and folding that into the case-insensitive list as `\b[A-Z]{3}\b` makes it
 * match every three-letter word in English. "What is the weather" contains "the", so every prompt
 * looked on-domain and the off-domain rule could never fire.
 */
const DOMAIN_WORDS =
  /airport|airline|flight|passenger|terminal|runway|route|carrier|hub|iata|traffic|seat|freight|cargo|delay|expansion|haul|aviation/i;

/** Case-sensitive on purpose — see above. */
const IATA_CODE = /\b[A-Z]{3}\b/;

function mentionsDomain(prompt: string): boolean {
  return DOMAIN_WORDS.test(prompt) || IATA_CODE.test(prompt);
}

export const TOPIC_RULES: readonly TopicRule[] = [
  // ------------- 1. intent
  {
    id: "intent.injection",
    topicId: "off_domain",
    confidence: 0.9,
    why: "attempts to override instructions or interrogate the assistant itself",
    matches: has(
      /ignore (your|all|the|previous)|disregard (your|all|the)|system prompt|your instructions|what model are you|who are you|are you (an? )?(ai|bot|llm)|pretend (to be|you)/i,
    ),
  },
  {
    id: "intent.scope_money",
    topicId: "scope_boundary",
    confidence: 0.9,
    why: "asks about money, land or politics — the declared boundary of the product",
    matches: has(
      /profitab|\bROI\b|return on investment|capex|cap-ex|capital expenditure|financ|construction cost|payback|lease|rent\b|land (price|cost|value)|zoning|politic|budget|how much (would|does) it cost|worth the investment/i,
    ),
  },
  {
    id: "intent.methodology",
    topicId: "methodology_explainability",
    confidence: 0.85,
    why: "asks how the system works rather than about an airport",
    matches: has(
      /how (is|are|do|does|did) (it|you|the|this).{0,30}(score|comput|calculat|weigh|rank|work|decide)|methodolog|what (data|dataset|source|years)|which (data|years|weights|sources)|why should i (trust|believe)|how (confident|sure|reliable)|assumption|caveat|limitation|where (does|do) (the|this) (data|number)/i,
    ),
  },

  // ------------- 2. subject
  {
    id: "subject.cargo",
    topicId: "cargo_freight",
    confidence: 0.85,
    why: "freight is a distinct dataset with its own caveats, so it is worth separating",
    matches: has(/freight|cargo|belly|tonnage|air ?cargo|shipping/i),
  },
  {
    id: "subject.capacity",
    topicId: "capacity_congestion",
    confidence: 0.8,
    why: "about the ability to handle traffic rather than the traffic itself",
    matches: has(
      // `\bunmet\b` rather than the phrase "unmet demand": the brief's own question is "what is
      // the unmet FLIGHT demand in SFO", and a two-word literal missed it. Phrases that users
      // reliably split are a bad thing to match on.
      /delay|congest|taxi|slot|curfew|\bunmet\b|capacit|bottleneck|constrain|throughput|on-?time|saturat|overcrowd/i,
    ),
  },
  {
    id: "subject.growth",
    topicId: "growth_momentum",
    confidence: 0.8,
    why: "about change over time",
    matches: has(
      /growth|growing|grew|declin|shrink|recover|trend|trajector|year[- ]over[- ]year|\byoy\b|since 2019|momentum|expand(ing|ed)? (fast|quick)/i,
    ),
  },
  {
    id: "subject.mix",
    topicId: "traffic_mix",
    confidence: 0.75,
    why: "about the composition of traffic rather than its volume",
    matches: has(
      /long[- ]haul|short[- ]haul|medium[- ]haul|international (share|traffic|flights)|domestic|route mix|\bhaul\b|carrier mix|what routes|which routes|destinations/i,
    ),
  },

  // ------------- 3. analytical shape
  //
  // Reached only when no subject rule fired, i.e. the question is about expansion opportunity in
  // general rather than about a named metric.
  {
    id: "shape.comparison",
    topicId: "comparison",
    confidence: 0.8,
    why: "sets named candidates against each other with no more specific subject",
    matches: has(
      /\bcompare\b|\bvs\.?\b|\bversus\b|which of (these|them)|better than|against each other|stack up/i,
    ),
  },
  {
    id: "shape.screening",
    topicId: "screening_ranking",
    confidence: 0.8,
    why: "asks for candidates from an unnamed population",
    matches: has(
      /which airports|what airports|best (airports|candidates)|top \d|shortlist|candidates for|rank the|worth (expanding|looking at)|should we (look|invest|expand)|look at in/i,
    ),
  },

  // ------------- 4. observed behaviour
  {
    id: "tool.rank",
    topicId: "screening_ranking",
    confidence: 0.8,
    why: "rankAirports only runs when the agent read the question as a screen",
    matches: used("rankAirports"),
  },
  {
    id: "tool.compare",
    topicId: "comparison",
    confidence: 0.8,
    why: "compareAirports takes named candidates, so the question supplied them",
    matches: used("compareAirports"),
  },
  {
    id: "tool.mix",
    topicId: "traffic_mix",
    confidence: 0.8,
    why: "flightMix answers composition questions specifically",
    matches: used("flightMix"),
  },
  {
    id: "tool.explain",
    topicId: "airport_diagnostic",
    confidence: 0.7,
    why: "explainScore decomposes one named airport's score",
    matches: used("explainScore"),
  },
  {
    id: "tool.metrics",
    topicId: "airport_diagnostic",
    confidence: 0.75,
    why: "metrics for a single named airport",
    matches: used("getAirportMetrics"),
  },

  // ------------- 5. last resort
  {
    id: "fallback.off_domain",
    topicId: "off_domain",
    confidence: 0.6,
    why: "no tool ran and nothing in the prompt refers to the domain",
    matches: (f) => f.toolsInvoked.length === 0 && !mentionsDomain(f.prompt),
  },
];

export interface RuleOutcome {
  topicId: string;
  confidence: number;
  stage: "rule" | "abstain";
  ruleId: string | null;
  /** Every rule that matched, in declaration order. Lets the eval measure how often rules disagree. */
  allMatches: { ruleId: string; topicId: string }[];
}

/**
 * Apply the rules. First match wins; no match abstains.
 *
 * `allMatches` is returned rather than discarded so the eval can report the conflict rate — the
 * rate at which rules of different topics fire on the same prompt. A rising conflict rate is the
 * early warning that a newly added pattern is stealing another topic's traffic, which is otherwise
 * only visible as a mysterious drop in one class's recall.
 */
export function classifyByRules(f: ClassifierFeatures): RuleOutcome {
  const allMatches: { ruleId: string; topicId: string }[] = [];

  for (const rule of TOPIC_RULES) {
    if (rule.matches(f)) allMatches.push({ ruleId: rule.id, topicId: rule.topicId });
  }

  const winner = allMatches[0];
  if (!winner) {
    return {
      topicId: UNCLASSIFIED,
      confidence: 0,
      stage: "abstain",
      ruleId: null,
      allMatches,
    };
  }

  const rule = TOPIC_RULES.find((r) => r.id === winner.ruleId);
  return {
    topicId: winner.topicId,
    confidence: rule?.confidence ?? 0.5,
    stage: "rule",
    ruleId: winner.ruleId,
    allMatches,
  };
}

/** True when matched rules disagree about the topic — the signal worth watching over time. */
export function hasConflict(outcome: RuleOutcome): boolean {
  return new Set(outcome.allMatches.map((m) => m.topicId)).size > 1;
}

export { RULES_VERSION };
