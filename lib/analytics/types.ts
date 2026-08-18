/**
 * Shared shapes for the conversation analytics layer.
 *
 * Two ideas run through this file and the modules that use it:
 *
 * 1. ANALYTICS IS A PASSENGER, NEVER A DRIVER. Nothing here is on the path of a user's answer. The
 *    write happens after the response is flushed, and every failure is swallowed and logged. A
 *    telemetry layer that can break the product it measures is worse than no telemetry.
 *
 * 2. A ROW MEANS ONE THING. Every table has a declared grain and asserts it with a uniqueness
 *    constraint, per `docs/data-architecture.md` — "an unenforced grain is a bug waiting for a
 *    demo." The TypeScript shapes below mirror those grains exactly, so a row that would violate
 *    one is usually not expressible.
 *
 * Timestamps are ISO-8601 UTC strings throughout. SQLite has no date type, and storing a scalar the
 * database can sort lexicographically is simpler than a numeric epoch nobody can read in a query.
 */

/** How a session's traffic was produced. Seeded data is labelled everywhere it is displayed. */
export type SessionOrigin = "live" | "replay" | "synthetic";

/** What became of one turn. `error` rows are the interesting ones, so they are recorded too. */
export type TurnOutcome = "answered" | "truncated" | "error";

/**
 * Coarse failure category, derived from `AgentError.status` rather than its message.
 *
 * A message is prose that changes when someone rewords it; a category is a dimension you can group
 * by six months later and still get the same buckets.
 *
 * `cancelled` is the odd one out: the user closed the tab or navigated away, which is not a failure
 * of the agent at all. It is carried here rather than as a fourth `TurnOutcome` because `outcome`
 * has a CHECK constraint and widening it means rebuilding a table with two cascading children —
 * more risk than the distinction is worth today. The reliability aggregates exclude it explicitly.
 */
export type ErrorKind = "rate_limit" | "auth" | "upstream" | "unexpected" | "cancelled";

/** Which stage of the classifier decided a label. `abstain` is a real outcome, not a failure. */
export type ClassifierStage = "rule" | "llm" | "abstain";

// ------------- 1. rows as stored

export interface SessionRow {
  sessionId: string;
  tenantId: string;
  origin: SessionOrigin;
  startedAt: string;
  appVersion: string;
}

export interface TurnRow {
  turnId: string;
  sessionId: string;
  turnIndex: number;
  createdAt: string;
  /** Redacted prompt text. The raw text is never written — see `redact.ts`. */
  prompt: string;
  promptChars: number;
  replyChars: number;
  /** Conversation depth at the time of asking. Explains token growth across a session. */
  historyTurns: number;
  model: string;
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  /** Null when the provider omitted usage. Never inferred from character counts. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** Null for a model with no entry in `pricing.ts`. Never guessed. */
  costUsd: number | null;
  modelMs: number;
  toolMs: number;
  totalMs: number;
  outcome: TurnOutcome;
  errorKind: ErrorKind | null;
  redactionVersion: number;
}

export interface ToolCallRow {
  turnId: string;
  callIndex: number;
  toolName: string;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
  /** JSON, redacted with the same redactor as the prompt: tool arguments echo user text. */
  argumentsJson: string;
}

export interface TurnTopicRow {
  turnId: string;
  classifierVersion: string;
  taxonomyVersion: number;
  topicId: string;
  confidence: number;
  stage: ClassifierStage;
  /** Which rule fired, so a surprising label can be traced to a line of code. */
  ruleId: string | null;
  /** One line of justification. The model's own words when the LLM stage decided. */
  reason: string | null;
  classifiedAt: string;
  /** Zero for the rule stage — which is the entire point of having a rule stage. */
  costUsd: number;
}

// ------------- 2. the write path's input

/**
 * Everything `recordTurn` needs, assembled by the route from data it already holds.
 *
 * Deliberately a plain object rather than the `AgentResult` itself: the analytics layer should not
 * depend on the agent's return shape, or a change there becomes a schema change here.
 */
export interface TurnRecord {
  sessionId: string;
  tenantId: string;
  origin: SessionOrigin;
  turnIndex: number;
  createdAt: string;
  appVersion: string;
  /** Raw prompt. Redaction happens inside the analytics layer so no caller can forget to do it. */
  prompt: string;
  replyChars: number;
  historyTurns: number;
  model: string;
  iterations: number;
  modelCalls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  // No `costUsd`: the caller reports tokens, and `record.ts` prices them via `pricing.ts`. Letting
  // a caller pass a cost in would mean two places could disagree about what a turn cost.
  modelMs: number;
  totalMs: number;
  outcome: TurnOutcome;
  errorKind: ErrorKind | null;
  toolTrace: readonly TurnToolTrace[];
}

/** One tool execution as the agent reports it, before it becomes a row. */
export interface TurnToolTrace {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}
