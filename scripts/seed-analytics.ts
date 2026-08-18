/**
 * Populate the analytics database by replaying a written corpus through the real agent.
 *
 * The measurements this produces are genuine: real tool calls against the real dataset, real token
 * counts from the provider, real latencies, real failures. The only fiction is that a person typed
 * the questions, and every seeded row is marked `origin = 'replay'` so the dashboard can say so.
 * An unlabelled seeded dashboard presented as user traffic would be precisely the credibility
 * failure that decision D1 exists to prevent.
 *
 * Timestamps are spread across the preceding fortnight so the volume chart has a shape. That is
 * synthetic and is disclosed in the banner alongside the seeded share.
 *
 * Budget roughly 12–15 minutes: the free tier is metered per minute, so the run is throttled.
 *
 * Run: npm run analytics:seed
 *      npm run analytics:seed -- --days 14      window to spread timestamps over
 *      npm run analytics:seed -- --dry-run      list what would be asked, call nothing
 */

import { randomUUID } from "node:crypto";

import { loadEnvLocal } from "./load-env";
import { runAgent, AgentError, type ChatMessage } from "../lib/agent/agent";
import { APP_VERSION, DEFAULT_TENANT } from "../lib/analytics/config";
import { recordTurn } from "../lib/analytics/record";
import { SEED_CORPUS, SEED_TURN_COUNT } from "../lib/analytics/seed/corpus";
import type { ErrorKind } from "../lib/analytics/types";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysArg = args.indexOf("--days");
const spreadDays = daysArg >= 0 ? Number(args[daysArg + 1]) : 14;

/** Between turns. The chat model's per-minute token budget is the binding constraint. */
const DELAY_MS = 9000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorKindOf(err: unknown): ErrorKind {
  if (!(err instanceof AgentError)) return "unexpected";
  if (err.status === 429) return "rate_limit";
  if (err.status === 401) return "auth";
  return "upstream";
}

async function main(): Promise<void> {
  loadEnvLocal();

  console.log(`corpus: ${SEED_CORPUS.length} conversations, ${SEED_TURN_COUNT} turns`);
  console.log(`timestamps spread across the last ${spreadDays} days`);

  if (dryRun) {
    for (const [i, convo] of SEED_CORPUS.entries()) {
      console.log(`\n${i + 1}. ${convo.exercises}`);
      for (const t of convo.turns) console.log(`   - ${t}`);
    }
    console.log(`\n--dry-run: nothing was asked and nothing was written`);
    return;
  }

  const apiKey = process.env.GROQ_API_KEY ?? "";
  if (!apiKey) {
    console.error("GROQ_API_KEY is not set (checked the environment and .env.local).");
    process.exit(1);
  }

  const estimate = Math.round((SEED_TURN_COUNT * (DELAY_MS + 2500)) / 60000);
  console.log(`estimated run time: ~${estimate} minutes\n`);

  let done = 0;
  let failed = 0;

  for (const [convoIndex, convo] of SEED_CORPUS.entries()) {
    const sessionId = randomUUID();

    // Each conversation lands at its own point in the window, oldest first, so the volume chart
    // is not a single spike. Within a conversation the turns stay minutes apart.
    const offsetDays = spreadDays * (1 - convoIndex / Math.max(SEED_CORPUS.length, 1));
    const sessionStart = Date.now() - offsetDays * 24 * 60 * 60 * 1000;

    const history: ChatMessage[] = [];
    console.log(`${convoIndex + 1}/${SEED_CORPUS.length}  ${convo.exercises}`);

    for (const [turnIndex, prompt] of convo.turns.entries()) {
      history.push({ role: "user", content: prompt });
      const createdAt = new Date(sessionStart + turnIndex * 3 * 60 * 1000).toISOString();
      const startedAt = Date.now();

      const base = {
        sessionId,
        tenantId: DEFAULT_TENANT,
        origin: "replay" as const,
        turnIndex,
        createdAt,
        appVersion: APP_VERSION,
        prompt,
        historyTurns: turnIndex,
      };

      try {
        const result = await runAgent(history, { apiKey });
        history.push({ role: "assistant", content: result.reply });

        await recordTurn({
          ...base,
          replyChars: result.reply.length,
          model: result.model,
          iterations: result.iterations,
          modelCalls: result.timing.modelMs.length,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          modelMs: result.timing.totalModelMs,
          totalMs: Date.now() - startedAt,
          outcome: result.truncated ? "truncated" : "answered",
          errorKind: null,
          toolTrace: result.trace,
        });

        done++;
        console.log(
          `   ok    ${String(result.timing.totalMs).padStart(5)}ms  ` +
            `${result.trace.length} tools  "${prompt.slice(0, 46)}"`,
        );
      } catch (err) {
        // Recorded, not skipped. A corpus that only keeps successes would produce a reliability
        // panel showing a system that never fails, which is the opposite of useful.
        await recordTurn({
          ...base,
          replyChars: 0,
          model: process.env.GROQ_MODEL ?? "unknown",
          iterations: 0,
          modelCalls: 0,
          promptTokens: null,
          completionTokens: null,
          modelMs: 0,
          totalMs: Date.now() - startedAt,
          outcome: "error",
          errorKind: errorKindOf(err),
          toolTrace: [],
        });

        // The conversation continues without the failed reply in history, which is what the UI
        // does too when a request errors.
        history.pop();
        failed++;
        console.log(`   ERROR ${errorKindOf(err)}  "${prompt.slice(0, 46)}"`);
      }

      await sleep(DELAY_MS);
    }
  }

  console.log(`\nseeded ${done} turns (${failed} recorded as errors) across ${SEED_CORPUS.length} sessions`);
  console.log("every row is marked origin='replay'; the dashboard labels it as seeded");
  console.log("next: npm run analytics:classify");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
