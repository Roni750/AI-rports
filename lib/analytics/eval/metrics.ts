import { TOPIC_IDS, UNCLASSIFIED } from "../taxonomy";

/**
 * Classification metrics.
 *
 * Pure functions with no I/O, unit-tested against a hand-computed example before anything trusts
 * them. Testing the measuring instrument first is not ceremony: every accuracy claim this feature
 * makes is only as good as the arithmetic here, and a quietly wrong F1 would make the CI floor
 * meaningless while looking perfectly healthy.
 *
 * The one judgment encoded below is how abstentions are counted, and it is deliberately reported
 * twice. `accuracyOverall` treats an abstention as wrong; `accuracyOnCovered` ignores abstained
 * items entirely. Publishing only the second is how a classifier with a coverage problem looks
 * excellent — it abstains on everything hard and scores 100% on the rest. Publishing only the
 * first hides whether the abstentions were well-targeted. Both, always.
 */

export interface LabelledPrediction {
  id: string;
  goldTopicId: string;
  predictedTopicId: string;
  stage: "rule" | "llm" | "abstain";
  difficulty?: string;
}

export interface ClassMetrics {
  topicId: string;
  /** Gold items with this label — the denominator for recall. */
  support: number;
  /** Times this label was predicted — the denominator for precision. */
  predicted: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface EvalReport {
  n: number;
  /** Share of items the classifier was willing to label at all. */
  coverage: number;
  /** Abstentions counted as wrong. The honest headline. */
  accuracyOverall: number;
  /** Abstentions excluded. The diagnostic, meaningless on its own. */
  accuracyOnCovered: number;
  /** Unweighted mean F1 across classes with support, so a rare class cannot be ignored. */
  macroF1: number;
  perClass: ClassMetrics[];
  /** rows = gold, cols = predicted, both ordered by `labels`. */
  confusion: number[][];
  labels: string[];
  byStage: { stage: string; n: number; share: number; accuracy: number }[];
  byDifficulty: { difficulty: string; n: number; accuracy: number }[];
  /** The pairs that account for the most errors, worst first. */
  topConfusions: { gold: string; predicted: string; count: number }[];
}

function divide(numerator: number, denominator: number): number {
  // A class that was never predicted has undefined precision. Zero is the useful convention here:
  // it drags macro-F1 down, which is the correct signal for "this class does not work".
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluate(predictions: readonly LabelledPrediction[]): EvalReport {
  const n = predictions.length;

  // Every taxonomy label plus the abstention state, so the confusion matrix has a column for
  // "declined to answer" rather than silently dropping those rows.
  const labels = [...TOPIC_IDS];
  const index = new Map(labels.map((l, i) => [l, i]));

  const confusion: number[][] = labels.map(() => labels.map(() => 0));
  for (const p of predictions) {
    const row = index.get(p.goldTopicId);
    const col = index.get(p.predictedTopicId);
    if (row === undefined || col === undefined) continue;
    confusion[row][col]++;
  }

  const covered = predictions.filter((p) => p.stage !== "abstain");
  const correct = (p: LabelledPrediction) => p.goldTopicId === p.predictedTopicId;

  const perClass: ClassMetrics[] = labels
    .filter((label) => label !== UNCLASSIFIED)
    .map((topicId) => {
      const support = predictions.filter((p) => p.goldTopicId === topicId).length;
      const predicted = predictions.filter((p) => p.predictedTopicId === topicId).length;
      const truePositives = predictions.filter(
        (p) => p.goldTopicId === topicId && p.predictedTopicId === topicId,
      ).length;

      const precision = divide(truePositives, predicted);
      const recall = divide(truePositives, support);
      const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
      return { topicId, support, predicted, precision, recall, f1 };
    });

  // Macro-F1 over classes that actually appear in the gold set. Including a class with zero
  // support would average in a meaningless zero and understate the classifier.
  const scored = perClass.filter((c) => c.support > 0);

  const stages = ["rule", "llm", "abstain"] as const;
  const byStage = stages
    .map((stage) => {
      const items = predictions.filter((p) => p.stage === stage);
      return {
        stage,
        n: items.length,
        share: divide(items.length, n),
        accuracy: divide(items.filter(correct).length, items.length),
      };
    })
    .filter((s) => s.n > 0);

  const difficulties = [...new Set(predictions.map((p) => p.difficulty ?? "unspecified"))].sort();
  const byDifficulty = difficulties.map((difficulty) => {
    const items = predictions.filter((p) => (p.difficulty ?? "unspecified") === difficulty);
    return {
      difficulty,
      n: items.length,
      accuracy: divide(items.filter(correct).length, items.length),
    };
  });

  const topConfusions = labels
    .flatMap((gold, i) =>
      labels.map((predicted, j) => ({ gold, predicted, count: confusion[i][j] })),
    )
    .filter((c) => c.gold !== c.predicted && c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    n,
    coverage: divide(covered.length, n),
    accuracyOverall: divide(predictions.filter(correct).length, n),
    accuracyOnCovered: divide(covered.filter(correct).length, covered.length),
    macroF1: divide(
      scored.reduce((sum, c) => sum + c.f1, 0),
      scored.length,
    ),
    perClass,
    confusion,
    labels,
    byStage,
    byDifficulty,
    topConfusions,
  };
}
