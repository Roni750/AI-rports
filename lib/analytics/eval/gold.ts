import { readFileSync } from "node:fs";
import path from "node:path";

import { isTopicId, UNCLASSIFIED } from "../taxonomy";

/**
 * The labelled evaluation set.
 *
 * JSONL rather than a TypeScript array or a single JSON document, for one practical reason: the
 * set is meant to GROW, and its main source of new entries is the dashboard's review queue. One
 * object per line means appending an example touches one line in a diff, so adding twenty
 * examples stays reviewable.
 *
 * LABELLING PROTOCOL — the part that decides whether the numbers mean anything:
 *
 * - Items are labelled against the DEFINITIONS in `taxonomy.ts`, not against intuition and not
 *   against what the classifier happens to output. Labelling to match the code would make the
 *   eval a tautology that reports 100% and detects nothing.
 * - Every `hard` item carries a `note` justifying the call. Where a label is genuinely arguable,
 *   the note says so — g-022 is the clearest case. That residual ambiguity is the ceiling on
 *   achievable F1, and naming the ceiling is more useful than pretending it is 1.0.
 * - The `adversarial` slice was written before the rules that handle it, so those rules could not
 *   be fitted to the examples.
 *
 * KNOWN LIMITATION, stated rather than buried: these items were labelled by the same person who
 * wrote the rules, so the set measures self-consistency more than it measures ground truth. The
 * mitigations are the ones available at this scale — write the adversarial cases first, source new
 * items from production abstentions rather than imagination, and report accuracy by difficulty so
 * a strong easy slice cannot mask a weak hard one.
 */

export interface GoldItem {
  id: string;
  prompt: string;
  toolsInvoked: string[];
  topic: string;
  difficulty: "easy" | "hard" | "adversarial";
  note: string;
}

/** Minimum examples per classifiable topic, asserted by a test so the set cannot rot unevenly. */
export const MIN_PER_TOPIC = 6;

const GOLD_PATH = path.join(process.cwd(), "lib", "analytics", "eval", "gold-topics.jsonl");

/**
 * Read and validate the gold set.
 *
 * Throws with a line number on any malformed row. A silently skipped line would shrink the
 * denominator of every metric without changing anything visible, which is the kind of error that
 * survives for months.
 */
export function loadGoldSet(file = GOLD_PATH): GoldItem[] {
  const raw = readFileSync(file, "utf8");
  const items: GoldItem[] = [];
  const seen = new Set<string>();

  raw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`gold-topics.jsonl:${i + 1} is not valid JSON`);
    }

    const item = parsed as Partial<GoldItem>;
    if (typeof item.id !== "string" || item.id === "") {
      throw new Error(`gold-topics.jsonl:${i + 1} has no id`);
    }
    if (seen.has(item.id)) {
      throw new Error(`gold-topics.jsonl:${i + 1} repeats id ${item.id}`);
    }
    seen.add(item.id);

    if (typeof item.prompt !== "string" || item.prompt.trim() === "") {
      throw new Error(`gold-topics.jsonl:${i + 1} (${item.id}) has no prompt`);
    }
    if (typeof item.topic !== "string" || !isTopicId(item.topic)) {
      throw new Error(`gold-topics.jsonl:${i + 1} (${item.id}) has unknown topic ${item.topic}`);
    }
    if (item.topic === UNCLASSIFIED) {
      // `unclassified` is what the classifier outputs when it declines. As a gold label it would
      // be asserting that the correct answer is "no answer", which is not a thing to be right about.
      throw new Error(`gold-topics.jsonl:${i + 1} (${item.id}) uses the abstention state as a label`);
    }
    if (!Array.isArray(item.toolsInvoked)) {
      throw new Error(`gold-topics.jsonl:${i + 1} (${item.id}) has no toolsInvoked array`);
    }
    if (item.difficulty !== "easy" && item.difficulty !== "hard" && item.difficulty !== "adversarial") {
      throw new Error(`gold-topics.jsonl:${i + 1} (${item.id}) has bad difficulty ${item.difficulty}`);
    }

    items.push({
      id: item.id,
      prompt: item.prompt,
      toolsInvoked: item.toolsInvoked as string[],
      topic: item.topic,
      difficulty: item.difficulty,
      note: typeof item.note === "string" ? item.note : "",
    });
  });

  return items;
}
