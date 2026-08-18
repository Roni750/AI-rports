import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classifyByRules, hasConflict } from "../classify-rules";
import { CLASSIFIABLE_TOPIC_IDS } from "../taxonomy";
import { loadGoldSet, MIN_PER_TOPIC } from "./gold";
import { evaluate, type LabelledPrediction } from "./metrics";

/**
 * The accuracy gate.
 *
 * Runs under plain `npm run verify` with NO NETWORK and NO API KEY. The deterministic stage is
 * scored live against the gold set; the hybrid result is scored against a frozen snapshot of
 * predictions committed to the repo. That split is the point: it gives CI a genuine end-to-end
 * accuracy check without the flakiness of calling a model in a test, and it makes regenerating the
 * snapshot an explicit, reviewable diff rather than something that drifts unnoticed.
 *
 * HOW TO READ THESE NUMBERS HONESTLY. The floors sit a little below currently observed values, so
 * they catch regressions rather than certify quality. The measured scores are high — macro-F1
 * around 0.98 — and that is NOT evidence of a strong classifier: the rules and the gold labels
 * were written by the same person, so the set largely measures self-consistency. Its real value is
 * as a regression harness and as a structure that can absorb genuinely independent examples later,
 * which is what the dashboard's review queue is for. Treating 0.98 as an accuracy estimate for
 * real traffic would be exactly the "a good demo is not evidence" mistake.
 *
 * Expect these floors to be BREACHED as the gold set grows with harder production examples. That
 * is the system working: it forces a conversation about whether the classifier or the floor should
 * move, instead of letting quality drift silently.
 */

const FLOORS = {
  /** A rule that fires must be right. This is the rule stage's whole contract. */
  ruleAccuracy: 0.9,
  /** If rules stop carrying their share, the cost argument for the two-stage design has changed. */
  ruleCoverage: 0.85,
  /** Deterministic stage alone, scored live. */
  rulesMacroF1: 0.9,
  /** Rules plus the LLM fallback, scored against the frozen snapshot. */
  hybridMacroF1: 0.9,
  /** A macro average can hide one completely dead class, so floor the worst class too. */
  worstClassF1: 0.6,
} as const;

const gold = loadGoldSet();

function rulePredictions(): LabelledPrediction[] {
  return gold.map((item) => {
    const outcome = classifyByRules({
      prompt: item.prompt,
      toolsInvoked: item.toolsInvoked,
    });
    return {
      id: item.id,
      goldTopicId: item.topic,
      predictedTopicId: outcome.topicId,
      stage: outcome.stage,
      difficulty: item.difficulty,
    };
  });
}

describe("gold set integrity", () => {
  it("has at least the minimum examples for every classifiable topic", () => {
    for (const topicId of CLASSIFIABLE_TOPIC_IDS) {
      const n = gold.filter((g) => g.topic === topicId).length;
      expect(n, `${topicId} has ${n} gold examples`).toBeGreaterThanOrEqual(MIN_PER_TOPIC);
    }
  });

  it("justifies every hard and adversarial item", () => {
    // The note is what makes an arguable label reviewable by someone else. Without it a
    // contested call is indistinguishable from a careless one.
    for (const item of gold) {
      if (item.difficulty === "easy") continue;
      expect(item.note.trim(), `${item.id} has no note`).not.toBe("");
    }
  });

  it("includes the brief's four canonical questions", () => {
    const prompts = gold.map((g) => g.prompt.toLowerCase());
    for (const fragment of [
      "new england",
      "santa ana",
      "long haul flights out of anchorage",
      "unmet flight demand",
    ]) {
      expect(prompts.some((p) => p.includes(fragment)), `missing: ${fragment}`).toBe(true);
    }
  });
});

describe("deterministic stage", () => {
  const report = evaluate(rulePredictions());
  const rule = report.byStage.find((s) => s.stage === "rule");

  it(`labels at least ${FLOORS.ruleCoverage * 100}% of the set without a model`, () => {
    expect(rule?.share ?? 0).toBeGreaterThanOrEqual(FLOORS.ruleCoverage);
  });

  it("is right when it fires", () => {
    expect(rule?.accuracy ?? 0).toBeGreaterThanOrEqual(FLOORS.ruleAccuracy);
  });

  it("meets the macro-F1 floor", () => {
    expect(report.macroF1).toBeGreaterThanOrEqual(FLOORS.rulesMacroF1);
  });

  it("has no dead class", () => {
    for (const c of report.perClass) {
      if (c.support === 0) continue;
      expect(c.f1, `${c.topicId} F1 = ${c.f1.toFixed(2)}`).toBeGreaterThanOrEqual(
        FLOORS.worstClassF1,
      );
    }
  });

  it("keeps rule disagreement to a minority of prompts", () => {
    // Rising conflict is the early warning that a newly added pattern is stealing another topic's
    // traffic. It surfaces as a mysterious recall drop otherwise, long after the change.
    const conflicted = gold.filter((item) =>
      hasConflict(classifyByRules({ prompt: item.prompt, toolsInvoked: item.toolsInvoked })),
    ).length;
    expect(conflicted / gold.length).toBeLessThan(0.5);
  });
});

describe("frozen hybrid snapshot", () => {
  const snapshotPath = path.join(
    process.cwd(),
    "lib",
    "analytics",
    "eval",
    "predictions.v1.json",
  );
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    mode: string;
    predictions: { id: string; predictedTopicId: string; stage: LabelledPrediction["stage"] }[];
  };

  it("was frozen from a real hybrid run", () => {
    // Guards the exact failure this suite was written after: `--hybrid` with no API key silently
    // produced abstentions, and the snapshot recorded a model stage that never ran.
    expect(snapshot.mode).toBe("hybrid");
    expect(snapshot.predictions.some((p) => p.stage === "llm")).toBe(true);
  });

  it("covers every gold item", () => {
    // A stale snapshot must fail loudly rather than quietly scoring a subset and reporting a
    // flattering average over the easy half.
    const ids = new Set(snapshot.predictions.map((p) => p.id));
    for (const item of gold) {
      expect(ids.has(item.id), `snapshot is missing ${item.id} — re-run --freeze`).toBe(true);
    }
    expect(snapshot.predictions).toHaveLength(gold.length);
  });

  it("meets the hybrid macro-F1 floor", () => {
    const byId = new Map(snapshot.predictions.map((p) => [p.id, p]));
    const report = evaluate(
      gold.map((item) => {
        const p = byId.get(item.id)!;
        return {
          id: item.id,
          goldTopicId: item.topic,
          predictedTopicId: p.predictedTopicId,
          stage: p.stage,
          difficulty: item.difficulty,
        };
      }),
    );
    expect(report.macroF1).toBeGreaterThanOrEqual(FLOORS.hybridMacroF1);
  });
});
