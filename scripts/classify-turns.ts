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
 *      npm run analytics:classify -- --retry-abstained   ask again about turns the model declined
 */

// First: CLASSIFIER_MODEL and the ACTIVE_CLASSIFIER_VERSION built from it are module-scope
// constants. Loading `.env.local` inside main() would run after both were already fixed, so a
// configured model would be ignored AND every row would be stamped with the default model's
// version string — quietly destroying the only thing that makes two classifiers comparable.
import "./boot-env";

import { numericFlag, hasFlag } from "./args";
import { classifyByRules } from "../lib/analytics/classify-rules";
import { classifyWithModel } from "../lib/analytics/classify-llm";
import { ACTIVE_CLASSIFIER_VERSION, CLASSIFIER_MODEL } from "../lib/analytics/classifier-version";
import { formatUsd } from "../lib/analytics/pricing";
import { query, write } from "../lib/analytics/store";
import { TAXONOMY_VERSION } from "../lib/analytics/taxonomy";

const args = process.argv.slice(2);
const backfill = hasFlag(args, "--backfill");
const dryRun = hasFlag(args, "--dry-run");
const retryAbstained = hasFlag(args, "--retry-abstained");
const limit = numericFlag(args, "--limit", 200);

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
  //
  // Abstentions are NOT re-selected by default, and that is a cost decision. An abstention means
  // this model, on this prompt, declined; asking again spends another call to reach the same
  // place, on every run, forever. `--retry-abstained` exists for the case that actually changed —
  // a new prompt or a raised threshold — where re-asking is the point.
  const unlabelled = retryAbstained
    ? "tt.turn_id IS NULL OR tt.stage = 'abstain'"
    : "tt.turn_id IS NULL";

  const rows = await query(
    `SELECT t.turn_id, t.prompt,
            (SELECT GROUP_CONCAT(c.tool_name)
               FROM turn_tool_call c WHERE c.turn_id = t.turn_id) AS tools,
            tt.stage AS existing_stage
     FROM turn t
     LEFT JOIN turn_topic tt
       ON tt.turn_id = t.turn_id AND tt.classifier_version = ?
     WHERE ${backfill ? "1 = 1" : unlabelled}
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

/**
 * Persist one label, and never let a rejected statement end the run.
 *
 * `write` deliberately lets a constraint violation through — see `store.ts` — which is right for a
 * request path and wrong here. This job has already spent real money by the time it reaches the
 * later rows: one bad label (a taxonomy version bumped without re-seeding, say) must cost that one
 * label, not every call still queued behind it. Reported at the end rather than swallowed.
 */
let writeFailures = 0;

async function writeLabel(
  turnId: string,
  statements: { sql: string; args: (string | number | null)[] }[],
): Promise<void> {
  try {
    await write(statements);
  } catch (err) {
    writeFailures++;
    console.error(`  ! could not label ${turnId}: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
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
        await writeLabel(turn.turnId, [
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

  if (needModel.length > 0 && !process.env.ANTHROPIC_API_KEY) {
    // Same guard as the eval runner. Without it the job "succeeds" while writing abstentions that
    // look like the model having declined, which is a lie the dashboard would then repeat.
    console.error("ANTHROPIC_API_KEY is not set — the model stage would abstain on everything.");
    process.exit(1);
  }

  let spent = 0;
  let labelled = 0;
  let abstained = 0;
  let unreached = 0;

  for (const [i, turn] of needModel.entries()) {
    const result = await classifyWithModel(turn.prompt, turn.tools);
    spent += result.costUsd ?? 0;

    if (result.retryable) {
      // The request never produced a judgement — no key, a 429 that outlasted its retries, a
      // timeout. Writing it would record an abstention for a prompt the model never saw, and the
      // turn would then look permanently unclassifiable. Leave it unlabelled; the next run finds
      // it again precisely because nothing was written.
      unreached++;
      console.log(
        `  ${String(i + 1).padStart(3)}/${needModel.length} ${"skipped".padEnd(8)}` +
          `${"not recorded".padEnd(28)}${result.reason ?? "request failed"}`,
      );
      if (i < needModel.length - 1) await sleep(DELAY_MS);
      continue;
    }

    if (result.stage === "llm") labelled++;
    else abstained++;

    await writeLabel(turn.turnId, [
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
  if (unreached > 0) {
    console.log(`not reached:       ${unreached}  (nothing recorded — re-run to retry these)`);
  }
  if (writeFailures > 0) {
    console.log(`write failures:    ${writeFailures}  (labels rejected by the database)`);
  }
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
