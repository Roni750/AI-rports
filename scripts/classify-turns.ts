/**
 * Label the turns the deterministic stage declined, using the model.
 *
 * Runs offline, never in the request path. Groq's free tier binds on tokens per minute and the
 * chat loop already spends that budget on answers people are waiting for; a 200-token label must
 * never be the reason a real reply gets rate-limited. Being a batch job also means a 429 costs a
 * retry rather than a user's question.
 *
 * Two jobs, and the second is the reason this is batch-first:
 *   - fill in turns with no label for the active classifier version
 *   - `--backfill`, which relabels everything under a new classifier version so two versions can
 *     be compared over identical traffic
 *
 * Writes are additive. A turn's existing label for a DIFFERENT version is never touched.
 *
 * Run: npm run analytics:classify
 *      npm run analytics:classify -- --limit 50
 *      npm run analytics:classify -- --backfill      relabel turns already labelled by this version
 *      npm run analytics:classify -- --dry-run       report what would be classified, spend nothing
 */

import { loadEnvLocal } from "./load-env";
import { classifyByRules } from "../lib/analytics/classify-rules";
import { classifyWithModel } from "../lib/analytics/classify-llm";
import { ACTIVE_CLASSIFIER_VERSION, CLASSIFIER_MODEL } from "../lib/analytics/classifier-version";
import { formatUsd } from "../lib/analytics/pricing";
import { query, write } from "../lib/analytics/store";
import { TAXONOMY_VERSION } from "../lib/analytics/taxonomy";

const args = process.argv.slice(2);
const backfill = args.includes("--backfill");
const dryRun = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 200;

/**
 * Pause between calls.
 *
 * The free tier is metered per minute, so a tight loop trades a fast start for a wall of 429s.
 * Deliberately slower than necessary — this job has no deadline.
 */
const DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pending {
  turnId: string;
  prompt: string;
  tools: string[];
}

async function findPending(): Promise<Pending[]> {
  // Turns with no row for this classifier version, or — in backfill mode — every turn regardless.
  // The LEFT JOIN is on both keys so a label written by a different version does not count as
  // this version having seen the turn.
  const rows = await query(
    `SELECT t.turn_id, t.prompt,
            (SELECT GROUP_CONCAT(c.tool_name)
               FROM turn_tool_call c WHERE c.turn_id = t.turn_id) AS tools,
            tt.stage AS existing_stage
     FROM turn t
     LEFT JOIN turn_topic tt
       ON tt.turn_id = t.turn_id AND tt.classifier_version = ?
     WHERE ${backfill ? "1 = 1" : "tt.turn_id IS NULL OR tt.stage = 'abstain'"}
     ORDER BY t.created_at DESC
     LIMIT ?`,
    [ACTIVE_CLASSIFIER_VERSION, limit],
  );

  return rows.map((row) => ({
    turnId: String(row.turn_id),
    prompt: String(row.prompt),
    tools: row.tools ? String(row.tools).split(",").filter(Boolean) : [],
  }));
}

async function main(): Promise<void> {
  loadEnvLocal();

  const pending = await findPending();
  console.log(`classifier: ${ACTIVE_CLASSIFIER_VERSION}`);
  console.log(`turns to resolve: ${pending.length}${backfill ? " (backfill)" : ""}\n`);

  if (pending.length === 0) {
    console.log("nothing to do — every turn already has a label for this version");
    return;
  }

  // The rule stage runs first even here. In normal operation it already ran inline at write time,
  // but a backfill under a new rule set has to re-apply it, and a rule that now matches must not
  // be paid for with a model call.
  const needModel: Pending[] = [];
  let ruleResolved = 0;

  for (const turn of pending) {
    const outcome = classifyByRules({ prompt: turn.prompt, toolsInvoked: turn.tools });
    if (outcome.stage === "rule") {
      ruleResolved++;
      if (!dryRun) {
        await write([
          {
            sql: `INSERT OR REPLACE INTO turn_topic
                    (turn_id, classifier_version, taxonomy_version, topic_id, confidence,
                     stage, rule_id, reason, classified_at, cost_usd)
                  VALUES (?, ?, ?, ?, ?, 'rule', ?, ?, ?, 0)`,
            args: [
              turn.turnId,
              ACTIVE_CLASSIFIER_VERSION,
              TAXONOMY_VERSION,
              outcome.topicId,
              outcome.confidence,
              outcome.ruleId,
              `matched ${outcome.ruleId}`,
              new Date().toISOString(),
            ],
          },
        ]);
      }
    } else {
      needModel.push(turn);
    }
  }

  console.log(`resolved by rules: ${ruleResolved} (no model call, $0)`);
  console.log(`needing the model:  ${needModel.length} on ${CLASSIFIER_MODEL}\n`);

  if (dryRun) {
    console.log("--dry-run: stopping before any model call");
    for (const t of needModel.slice(0, 20)) console.log(`  would classify: "${t.prompt.slice(0, 66)}"`);
    return;
  }

  if (needModel.length > 0 && !process.env.GROQ_API_KEY) {
    // Same guard as the eval runner. Without it the job "succeeds" while writing abstentions that
    // look like the model having declined, which is a lie the dashboard would then repeat.
    console.error("GROQ_API_KEY is not set — the model stage would abstain on everything.");
    process.exit(1);
  }

  let spent = 0;
  let labelled = 0;
  let abstained = 0;

  for (const [i, turn] of needModel.entries()) {
    const result = await classifyWithModel(turn.prompt, turn.tools);
    spent += result.costUsd ?? 0;
    if (result.stage === "llm") labelled++;
    else abstained++;

    await write([
      {
        sql: `INSERT OR REPLACE INTO turn_topic
                (turn_id, classifier_version, taxonomy_version, topic_id, confidence,
                 stage, rule_id, reason, classified_at, cost_usd)
              VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        args: [
          turn.turnId,
          ACTIVE_CLASSIFIER_VERSION,
          TAXONOMY_VERSION,
          result.topicId,
          result.confidence,
          result.stage,
          result.reason,
          new Date().toISOString(),
          result.costUsd ?? 0,
        ],
      },
    ]);

    console.log(
      `  ${String(i + 1).padStart(3)}/${needModel.length} ${result.stage.padEnd(8)}` +
        `${result.topicId.padEnd(28)}"${turn.prompt.slice(0, 44)}"`,
    );

    if (i < needModel.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nlabelled by model: ${labelled}`);
  console.log(`still abstained:   ${abstained}  (these populate the dashboard's review queue)`);
  console.log(`classification spend: ${formatUsd(spent)}`);

  // Reported over the WHOLE corpus, not over this batch. This job only ever sees turns the rules
  // already declined, so a ratio computed from its own counters reads ~0% and understates the
  // deterministic stage's share by construction — the exact opposite of the point being made.
  const stages = await query(
    `SELECT stage, COUNT(*) AS n FROM turn_topic WHERE classifier_version = ? GROUP BY stage`,
    [ACTIVE_CLASSIFIER_VERSION],
  );
  const total = stages.reduce((sum, row) => sum + Number(row.n), 0);
  const byRule = Number(stages.find((row) => String(row.stage) === "rule")?.n ?? 0);
  if (total > 0) {
    console.log(
      `\nacross all ${total} labelled turns: ${byRule} resolved by rules ` +
        `(${((byRule / total) * 100).toFixed(1)}%, $0), the rest by model`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
