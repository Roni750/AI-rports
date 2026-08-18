import { classifyByRules } from "./classify-rules";
import { ACTIVE_CLASSIFIER_VERSION } from "./classifier-version";
import { loadAirportLookup } from "../data/db";
import { extractEntities } from "./entities";
import { costUsd } from "./pricing";
import { redact, redactArguments } from "./redact";
import { write } from "./store";
import { TAXONOMY_VERSION } from "./taxonomy";
import type { TurnRecord } from "./types";

/**
 * The write path: one conversation turn becomes rows.
 *
 * THIS FUNCTION CANNOT THROW. It is called from a request handler after the response has already
 * been flushed, and a telemetry failure must never surface as a failed answer. Everything is
 * wrapped, and the worst case is a log line and a missing row.
 *
 * Writes are idempotent. `turn_id` is derived from the session and the turn's position rather than
 * generated, so a retry, a double-invoked effect, or a replayed seed overwrites its own row instead
 * of creating a second one — the "loads are idempotent" rule from `docs/data-architecture.md`
 * applied to an operational log rather than to a batch pipeline.
 */

/** `session:index` — deterministic, which is what makes the write idempotent. */
export function turnId(sessionId: string, turnIndex: number): string {
  return `${sessionId}:${turnIndex}`;
}

export async function recordTurn(input: TurnRecord): Promise<void> {
  try {
    await writeTurn(input);
  } catch (err) {
    // Deliberately swallowed. Analytics is a passenger: it may not break the product it measures.
    console.error("[analytics] write failed; chat is unaffected", err);
  }
}

async function writeTurn(input: TurnRecord): Promise<void> {
  const id = turnId(input.sessionId, input.turnIndex);
  const redacted = redact(input.prompt);
  const cost = costUsd(input.model, input.promptTokens, input.completionTokens);

  const toolMs = input.toolTrace.reduce((sum, t) => sum + t.durationMs, 0);
  const toolFailures = input.toolTrace.filter((t) => !t.ok).length;

  // The rule stage runs here, inline, because it is a pure function over values already in hand.
  // It costs nothing measurable and means the dashboard has labels the instant a turn lands. Turns
  // it declines to label are written as abstentions for the batch LLM pass to pick up, so an
  // unlabelled turn is a queue entry rather than a gap.
  // Which airports the turn was about. Also pure, also inline, and reading the REDACTED prompt —
  // the same text that gets stored, so nothing can be recognised here that was scrubbed there.
  const entities = extractEntities(
    {
      prompt: redacted.text,
      toolCalls: input.toolTrace.map((t) => ({ name: t.name, arguments: t.arguments })),
    },
    loadAirportLookup(),
  );

  const labelled = classifyByRules({
    prompt: redacted.text,
    toolsInvoked: input.toolTrace.map((t) => t.name),
  });

  await write([
    {
      // The session may already exist — every turn after the first arrives with one. OR IGNORE
      // keeps the original `started_at` rather than resetting it on each turn.
      sql: `INSERT OR IGNORE INTO session
              (session_id, tenant_id, origin, started_at, app_version)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        input.sessionId,
        input.tenantId,
        input.origin,
        input.createdAt,
        input.appVersion,
      ],
    },
    {
      sql: `INSERT INTO turn (
              turn_id, session_id, turn_index, created_at, prompt, prompt_chars, reply_chars,
              history_turns, model, iterations, model_calls, tool_calls, tool_failures,
              prompt_tokens, completion_tokens, cost_usd, model_ms, tool_ms, total_ms,
              outcome, error_kind, redaction_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(turn_id) DO UPDATE SET
              prompt            = excluded.prompt,
              reply_chars       = excluded.reply_chars,
              iterations        = excluded.iterations,
              model_calls       = excluded.model_calls,
              tool_calls        = excluded.tool_calls,
              tool_failures     = excluded.tool_failures,
              prompt_tokens     = excluded.prompt_tokens,
              completion_tokens = excluded.completion_tokens,
              cost_usd          = excluded.cost_usd,
              model_ms          = excluded.model_ms,
              tool_ms           = excluded.tool_ms,
              total_ms          = excluded.total_ms,
              outcome           = excluded.outcome,
              error_kind        = excluded.error_kind`,
      args: [
        id,
        input.sessionId,
        input.turnIndex,
        input.createdAt,
        redacted.text,
        redacted.text.length,
        input.replyChars,
        input.historyTurns,
        input.model,
        input.iterations,
        input.modelCalls,
        input.toolTrace.length,
        toolFailures,
        input.promptTokens,
        input.completionTokens,
        cost,
        input.modelMs,
        toolMs,
        input.totalMs,
        input.outcome,
        input.errorKind,
        redacted.version,
      ],
    },
    // After the turn insert: the foreign key needs its parent row, and `PRAGMA foreign_keys = ON`
    // is active.
    //
    // Delete-then-insert rather than OR REPLACE, so this turn's entities are exactly what the
    // current extractor produces. OR REPLACE refreshes rows the extractor still emits but cannot
    // retract ones it no longer does, which leaves a re-recorded turn carrying labels from an
    // older version of the rules. The whole batch is atomic, so there is no window where a turn
    // has no entities.
    {
      sql: "DELETE FROM turn_entity WHERE turn_id = ?",
      args: [id],
    },
    ...entities.map((entity) => ({
      sql: `INSERT INTO turn_entity
              (turn_id, entity_type, code, source, label)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, entity.entityType, entity.code, entity.source, entity.label],
    })),
    ...input.toolTrace.map((call, index) => ({
      // OR REPLACE against the (turn_id, call_index) primary key, so re-recording a turn rewrites
      // its tool calls rather than appending a second copy of them.
      sql: `INSERT OR REPLACE INTO turn_tool_call
              (turn_id, call_index, tool_name, ok, error_code, duration_ms, arguments_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        index,
        call.name,
        call.ok ? 1 : 0,
        call.errorCode ?? null,
        call.durationMs,
        JSON.stringify(redactArguments(call.arguments)),
      ],
    })),
    {
      // OR REPLACE keyed on (turn_id, classifier_version): re-recording a turn refreshes this
      // version's label without touching labels written by any other version, which is what keeps
      // classifier history comparable.
      sql: `INSERT OR REPLACE INTO turn_topic
              (turn_id, classifier_version, taxonomy_version, topic_id, confidence, stage,
               rule_id, reason, classified_at, cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      args: [
        id,
        ACTIVE_CLASSIFIER_VERSION,
        TAXONOMY_VERSION,
        labelled.topicId,
        labelled.confidence,
        labelled.stage,
        labelled.ruleId,
        labelled.ruleId ? `matched ${labelled.ruleId}` : null,
        input.createdAt,
      ],
    },
  ]);
}
