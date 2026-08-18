/**
 * The umbrella taxonomy: what users ask this agent about.
 *
 * Versioned and declared as configuration, for the same reason the scoring weights are
 * (`lib/scoring/config.ts`): a taxonomy encodes a judgment about what distinctions matter, and
 * making that judgment visible and adjustable is the honest engineering choice. Bury it in the
 * classifier's control flow and nobody can review it.
 *
 * Code is the source of truth. The `taxonomy_topic` table exists so that a label assigned under
 * version 1 still resolves to its definition after the code has moved on to version 2 — old
 * assignments are never rewritten, so old definitions must remain resolvable.
 *
 * This module is deliberately free of imports. It is pure data, which lets `store.ts` seed from it
 * without a circular dependency and lets the eval load it without touching a database.
 */

export const TAXONOMY_VERSION = 1;

/**
 * The abstention id.
 *
 * It has a row in `taxonomy_topic` because `turn_topic` carries a foreign key to it, and an
 * abstention still has to be storable. It is excluded from `CLASSIFIABLE_TOPIC_IDS` because no
 * classifier may ever *predict* it as a category — reaching it means declining to predict.
 */
export const UNCLASSIFIED = "unclassified";

export interface Topic {
  readonly id: string;
  readonly label: string;
  /**
   * The definition is load-bearing, not decoration: it is pasted verbatim into the LLM
   * classifier's prompt and is the reference a human labels the gold set against. Two people
   * labelling from the same definition should agree; if they don't, the definition is the bug.
   */
  readonly definition: string;
}

export const TOPICS: readonly Topic[] = [
  {
    id: "screening_ranking",
    label: "Screening & ranking",
    definition:
      "Find or shortlist airports matching criteria — a region, a state, a cohort, 'which airports " +
      "should we look at'. The subjects are plural and unnamed; the user wants candidates, not facts " +
      "about one place.",
  },
  {
    id: "airport_diagnostic",
    label: "Single-airport diagnostic",
    definition:
      "One named airport: its metrics, its score, or why it scores the way it does. The subject is " +
      "singular and named.",
  },
  {
    id: "comparison",
    label: "Head-to-head comparison",
    definition:
      "Two or more named airports or metro areas set against each other. The user supplies the " +
      "candidates; the question is which one wins on some dimension.",
  },
  {
    id: "capacity_congestion",
    label: "Capacity & congestion",
    definition:
      "Delays, taxi time, throughput, slot limits, curfews, 'unmet demand', or physical constraint. " +
      "About the airport's ability to handle traffic rather than the traffic itself.",
  },
  {
    id: "growth_momentum",
    label: "Growth & momentum",
    definition:
      "Change over time — year-on-year movement, recovery against 2019, trajectory, whether somewhere " +
      "is growing or shrinking.",
  },
  {
    id: "traffic_mix",
    label: "Traffic mix & routes",
    definition:
      "The composition of traffic: haul bands, international versus domestic share, route-level or " +
      "carrier-level breakdowns.",
  },
  {
    id: "cargo_freight",
    label: "Cargo & freight",
    definition:
      "Freight tonnage, belly cargo on passenger aircraft, all-cargo operators, or freight hubs.",
  },
  {
    id: "methodology_explainability",
    label: "Methodology & trust",
    definition:
      "How the score is computed, which weights or components are used, which data and which years, " +
      "how confident the system is, or why the user should believe an answer. About the system " +
      "rather than about airports.",
  },
  {
    id: "scope_boundary",
    label: "Out-of-scope asks",
    definition:
      "Questions the system deliberately cannot answer: profitability, capex, ROI, financing, " +
      "construction cost, land, zoning, or politics. On-domain but outside the declared boundary.",
  },
  {
    id: "off_domain",
    label: "Off-domain",
    definition:
      "Not about airports at all — chit-chat, questions about the assistant itself, or attempts to " +
      "override its instructions.",
  },
  {
    id: UNCLASSIFIED,
    label: "Unclassified",
    definition:
      "No confident label. This is an abstention state, not a bucket: it means the classifier " +
      "declined rather than that the prompt belongs to a residual category. Always displayed " +
      "explicitly, because hiding it would overstate coverage.",
  },
];

/** Topic ids in display order — the order panels and confusion matrices use. */
export const TOPIC_IDS: readonly string[] = TOPICS.map((t) => t.id);

/** Every topic except the abstention state: the classes a classifier may actually predict. */
export const CLASSIFIABLE_TOPIC_IDS: readonly string[] = TOPIC_IDS.filter(
  (id) => id !== UNCLASSIFIED,
);

const BY_ID = new Map(TOPICS.map((t) => [t.id, t]));

export function topicById(id: string): Topic | undefined {
  return BY_ID.get(id);
}

export function isTopicId(id: string): boolean {
  return BY_ID.has(id);
}
