import { describe, expect, it } from "vitest";

import { evaluate, type LabelledPrediction } from "./metrics";

/**
 * The measuring instrument, checked against arithmetic done by hand.
 *
 * Every accuracy claim in this feature — the CI floor, the dashboard's classifier-health panel,
 * the "rules handle N% for free" argument — is downstream of this file. A subtly wrong F1 would
 * keep the build green and the dashboard confident while being nonsense, which is the worst
 * available failure mode. So the expected values below are worked out longhand in the comments
 * rather than captured from a run.
 */

const p = (
  goldTopicId: string,
  predictedTopicId: string,
  stage: LabelledPrediction["stage"] = "rule",
  difficulty = "easy",
): LabelledPrediction => ({
  id: `${goldTopicId}->${predictedTopicId}-${Math.random()}`,
  goldTopicId,
  predictedTopicId,
  stage,
  difficulty,
});

describe("evaluate", () => {
  /**
   * Six items over two classes, one of them abstained:
   *
   *   1. comparison          -> comparison           correct
   *   2. comparison          -> comparison           correct
   *   3. comparison          -> cargo_freight        wrong
   *   4. cargo_freight       -> cargo_freight        correct
   *   5. cargo_freight       -> comparison           wrong
   *   6. cargo_freight       -> unclassified         abstained
   *
   * comparison:    support 3, predicted 3 (items 1,2,5), TP 2 -> P 2/3, R 2/3, F1 2/3
   * cargo_freight: support 3, predicted 2 (items 3,4),   TP 1 -> P 1/2, R 1/3, F1 0.4
   *
   * macro-F1 = (0.6667 + 0.4) / 2 = 0.5333
   * accuracyOverall   = 3/6 = 0.5
   * accuracyOnCovered = 3/5 = 0.6
   * coverage          = 5/6 = 0.8333
   */
  const sample: LabelledPrediction[] = [
    p("comparison", "comparison"),
    p("comparison", "comparison"),
    p("comparison", "cargo_freight"),
    p("cargo_freight", "cargo_freight"),
    p("cargo_freight", "comparison"),
    p("cargo_freight", "unclassified", "abstain"),
  ];

  const report = evaluate(sample);

  it("counts the sample", () => {
    expect(report.n).toBe(6);
  });

  it("computes coverage as the share not abstained", () => {
    expect(report.coverage).toBeCloseTo(5 / 6, 6);
  });

  it("reports both accuracy denominators, and they differ", () => {
    expect(report.accuracyOverall).toBeCloseTo(0.5, 6);
    expect(report.accuracyOnCovered).toBeCloseTo(0.6, 6);
    // The whole reason both are published: reporting only the flattering one is a way to hide an
    // abstention problem behind a good-looking score.
    expect(report.accuracyOnCovered).toBeGreaterThan(report.accuracyOverall);
  });

  it("computes per-class precision, recall and F1", () => {
    const comparison = report.perClass.find((c) => c.topicId === "comparison")!;
    expect(comparison.support).toBe(3);
    expect(comparison.predicted).toBe(3);
    expect(comparison.precision).toBeCloseTo(2 / 3, 6);
    expect(comparison.recall).toBeCloseTo(2 / 3, 6);
    expect(comparison.f1).toBeCloseTo(2 / 3, 6);

    const cargo = report.perClass.find((c) => c.topicId === "cargo_freight")!;
    expect(cargo.support).toBe(3);
    expect(cargo.predicted).toBe(2);
    expect(cargo.precision).toBeCloseTo(0.5, 6);
    expect(cargo.recall).toBeCloseTo(1 / 3, 6);
    expect(cargo.f1).toBeCloseTo(0.4, 6);
  });

  it("averages macro-F1 only over classes with support", () => {
    // Nine other topics exist and have zero support here. Averaging their zeros in would give
    // 0.53 * 2/11 = 0.097 and make the metric useless for a partial gold set.
    expect(report.macroF1).toBeCloseTo((2 / 3 + 0.4) / 2, 6);
  });

  it("builds a confusion matrix indexed by gold row and predicted column", () => {
    const row = report.labels.indexOf("comparison");
    const col = report.labels.indexOf("cargo_freight");
    expect(report.confusion[row][col]).toBe(1);
    expect(report.confusion[row][row]).toBe(2);
  });

  it("ranks the biggest confusion pairs first", () => {
    expect(report.topConfusions.length).toBeGreaterThan(0);
    for (let i = 1; i < report.topConfusions.length; i++) {
      expect(report.topConfusions[i - 1].count).toBeGreaterThanOrEqual(
        report.topConfusions[i].count,
      );
    }
  });

  it("breaks results down by stage", () => {
    const abstain = report.byStage.find((s) => s.stage === "abstain")!;
    expect(abstain.n).toBe(1);
    expect(abstain.accuracy).toBe(0);

    const rule = report.byStage.find((s) => s.stage === "rule")!;
    expect(rule.n).toBe(5);
    expect(rule.accuracy).toBeCloseTo(0.6, 6);
  });
});

describe("edge cases", () => {
  it("returns zeros rather than NaN for an empty set", () => {
    const report = evaluate([]);
    expect(report.n).toBe(0);
    expect(report.macroF1).toBe(0);
    expect(report.accuracyOverall).toBe(0);
    expect(report.coverage).toBe(0);
  });

  it("scores a class that was never predicted as zero, not as undefined", () => {
    // Division by zero here is the difference between "this class is broken" and a NaN that
    // propagates silently into macro-F1 and makes the CI floor unenforceable.
    const report = evaluate([p("cargo_freight", "comparison")]);
    const cargo = report.perClass.find((c) => c.topicId === "cargo_freight")!;
    expect(cargo.precision).toBe(0);
    expect(cargo.recall).toBe(0);
    expect(cargo.f1).toBe(0);
    expect(Number.isNaN(report.macroF1)).toBe(false);
  });

  it("gives a perfect classifier a macro-F1 of 1", () => {
    const report = evaluate([p("comparison", "comparison"), p("cargo_freight", "cargo_freight")]);
    expect(report.macroF1).toBeCloseTo(1, 6);
    expect(report.accuracyOverall).toBeCloseTo(1, 6);
  });
});
