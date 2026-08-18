/**
 * Score the topic classifier against the labelled gold set.
 *
 * "How do you know it works?" is the question this script exists to answer with numbers rather
 * than an opinion. It reports precision, recall and F1 per class, the confusion matrix, and — the
 * figure the whole two-stage design rests on — how much of the traffic the free deterministic
 * stage handles and how accurate it is when it fires.
 *
 * Read-only by default. `--freeze` is the only mode that writes.
 *
 * Run: npm run eval:topics                 rules only, no network, runs anywhere
 *      npm run eval:topics -- --hybrid     adds the LLM fallback for rule misses (needs a key)
 *      npm run eval:topics -- --hybrid --freeze   records predictions.v1.json for the CI gate
 */

// First: CLASSIFIER_MODEL and ACTIVE_CLASSIFIER_VERSION are module-scope constants, so a
// `loadEnvLocal()` inside main() would run after they were already fixed — and this script PRINTS
// the model it is about to use. Reporting one model while calling another is the specific way a
// measurement tool lies.
import "./boot-env";

import { writeFileSync } from "node:fs";
import path from "node:path";

import { classifyByRules, hasConflict, TOPIC_RULES } from "../lib/analytics/classify-rules";
import { ACTIVE_CLASSIFIER_VERSION, CLASSIFIER_MODEL } from "../lib/analytics/classifier-version";
import { loadGoldSet } from "../lib/analytics/eval/gold";
import { evaluate, type LabelledPrediction } from "../lib/analytics/eval/metrics";
import { topicById } from "../lib/analytics/taxonomy";

const args = process.argv.slice(2);
const useHybrid = args.includes("--hybrid");
const freeze = args.includes("--freeze");

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s.padEnd(width);
}

async function main(): Promise<void> {
  // Refuse to run the hybrid mode without a key rather than degrading to abstentions. Without
  // this guard the run still completes and still prints a report — one that looks like a model
  // declining to classify, when in fact no request was ever made. A measurement tool that fails
  // quietly is worse than one that fails.
  if (useHybrid && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "--hybrid needs ANTHROPIC_API_KEY (checked the environment and .env.local).\n" +
        "Without it the LLM stage abstains on everything and the report is misleading.\n" +
        "Run without --hybrid to score the deterministic stage alone.",
    );
    process.exit(1);
  }

  const gold = loadGoldSet();
  console.log(`gold set: ${gold.length} items`);
  console.log(`classifier: ${ACTIVE_CLASSIFIER_VERSION}`);
  console.log(`mode: ${useHybrid ? `rules + LLM fallback (${CLASSIFIER_MODEL})` : "rules only"}\n`);

  const predictions: LabelledPrediction[] = [];
  const ruleHits = new Map<string, number>();
  let conflicts = 0;

  for (const item of gold) {
    const outcome = classifyByRules({
      prompt: item.prompt,
      toolsInvoked: item.toolsInvoked,
    });
    if (outcome.ruleId) ruleHits.set(outcome.ruleId, (ruleHits.get(outcome.ruleId) ?? 0) + 1);
    if (hasConflict(outcome)) conflicts++;

    predictions.push({
      id: item.id,
      goldTopicId: item.topic,
      predictedTopicId: outcome.topicId,
      stage: outcome.stage,
      difficulty: item.difficulty,
    });
  }

  if (useHybrid) {
    // Imported lazily so the default rules-only run needs neither a network nor an API key.
    const { classifyWithModel } = await import("../lib/analytics/classify-llm");
    const pending = predictions.filter((p) => p.stage === "abstain");
    console.log(`LLM stage: ${pending.length} rule misses to resolve\n`);

    for (const p of pending) {
      const item = gold.find((g) => g.id === p.id)!;
      const result = await classifyWithModel(item.prompt, item.toolsInvoked);
      p.predictedTopicId = result.topicId;
      p.stage = result.stage;
    }
  }

  const report = evaluate(predictions);

  // ------------- headline
  console.log("─".repeat(78));
  console.log(`n                    ${report.n}`);
  console.log(`coverage             ${pct(report.coverage)}   (share the classifier would label)`);
  console.log(`accuracy (overall)   ${pct(report.accuracyOverall)}   (abstentions counted wrong)`);
  console.log(`accuracy (covered)   ${pct(report.accuracyOnCovered)}   (abstentions excluded)`);
  console.log(`macro-F1             ${report.macroF1.toFixed(3)}`);
  console.log("─".repeat(78));

  // ------------- per class
  console.log("\nper class");
  console.log(`  ${pad("topic", 28)}${pad("supp", 6)}${pad("pred", 6)}${pad("prec", 8)}${pad("rec", 8)}${pad("f1", 8)}`);
  for (const c of report.perClass) {
    if (c.support === 0 && c.predicted === 0) continue;
    console.log(
      `  ${pad(c.topicId, 28)}${pad(String(c.support), 6)}${pad(String(c.predicted), 6)}` +
        `${pad(c.precision.toFixed(2), 8)}${pad(c.recall.toFixed(2), 8)}${pad(c.f1.toFixed(2), 8)}`,
    );
  }

  // ------------- stage split: the cost argument, quantified
  console.log("\nby stage");
  for (const s of report.byStage) {
    console.log(
      `  ${pad(s.stage, 12)}${pad(String(s.n), 6)}${pad(pct(s.share), 10)}accuracy ${pct(s.accuracy)}`,
    );
  }

  console.log("\nby difficulty");
  for (const d of report.byDifficulty) {
    console.log(`  ${pad(d.difficulty, 14)}${pad(String(d.n), 6)}accuracy ${pct(d.accuracy)}`);
  }

  // ------------- where it goes wrong
  if (report.topConfusions.length > 0) {
    console.log("\nbiggest confusions (gold -> predicted)");
    for (const c of report.topConfusions) {
      console.log(`  ${pad(c.gold, 28)} -> ${pad(c.predicted, 28)} ${c.count}`);
      const example = predictions.find(
        (p) => p.goldTopicId === c.gold && p.predictedTopicId === c.predicted,
      );
      const item = example ? gold.find((g) => g.id === example.id) : undefined;
      if (item) console.log(`      e.g. "${item.prompt.slice(0, 62)}"`);
    }
  }

  const misses = predictions.filter((p) => p.goldTopicId !== p.predictedTopicId);
  if (misses.length > 0) {
    console.log(`\nall ${misses.length} misses`);
    for (const m of misses) {
      const item = gold.find((g) => g.id === m.id)!;
      console.log(
        `  ${pad(m.id, 7)}${pad(m.difficulty ?? "", 13)}${pad(m.goldTopicId, 28)} -> ${m.predictedTopicId}`,
      );
      console.log(`      "${item.prompt.slice(0, 68)}"`);
    }
  }

  // ------------- rule usage
  console.log("\nrule hits");
  for (const rule of TOPIC_RULES) {
    const hits = ruleHits.get(rule.id) ?? 0;
    if (hits === 0) continue;
    console.log(`  ${pad(rule.id, 24)}${pad(String(hits), 5)}${rule.why}`);
  }
  const unused = TOPIC_RULES.filter((r) => !ruleHits.has(r.id));
  if (unused.length > 0) {
    // Not an error: a rule can exist for traffic the gold set does not represent. Worth surfacing
    // so it is a deliberate gap rather than an unnoticed one.
    console.log(`  (${unused.length} rules never fired: ${unused.map((r) => r.id).join(", ")})`);
  }
  console.log(`\nprompts where rules of different topics disagreed: ${conflicts}`);

  const unrepresented = report.perClass.filter((c) => c.support === 0);
  if (unrepresented.length > 0) {
    console.log(`topics with no gold examples: ${unrepresented.map((c) => c.topicId).join(", ")}`);
  }

  if (freeze) {
    const out = path.join(process.cwd(), "lib", "analytics", "eval", "predictions.v1.json");
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          classifierVersion: ACTIVE_CLASSIFIER_VERSION,
          model: useHybrid ? CLASSIFIER_MODEL : null,
          mode: useHybrid ? "hybrid" : "rules-only",
          generatedAt: new Date().toISOString(),
          predictions: predictions.map((p) => ({
            id: p.id,
            predictedTopicId: p.predictedTopicId,
            stage: p.stage,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\nfroze ${predictions.length} predictions to ${path.relative(process.cwd(), out)}`);
    console.log("this is what the CI gate scores — regenerating it should be a reviewed diff");
  }

  // A label for every topic id, so the reader does not have to hold the taxonomy in their head.
  console.log("\ntopics");
  for (const c of report.perClass) {
    if (c.support === 0) continue;
    console.log(`  ${pad(c.topicId, 28)}${topicById(c.topicId)?.label ?? ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
