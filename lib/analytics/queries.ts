// `InValue`, not `InArgs`: the latter is `Array<InValue> | Record<string, InValue>`, and a union
// with an object type cannot be spread. Every query here binds positionally.
import type { InValue } from "@libsql/client";

import { DEFAULT_TENANT, MIN_SAMPLE_FOR_SHARE, MIN_SAMPLE_FOR_TREND } from "./config";
import { ACTIVE_CLASSIFIER_VERSION } from "./classifier-version";
import { formatUsd } from "./pricing";
import { query } from "./store";
import { topicById, TOPIC_IDS } from "./taxonomy";

/**
 * Aggregations for the analytics dashboard.
 *
 * Every function returns its data inside an envelope, deliberately mirroring `ResultEnvelope` in
 * `lib/tools/types.ts`. The argument that made the tool layer trustworthy applies with more force
 * here: a metrics layer is where "n=3 is not a trend" is the most common way a system misleads its
 * own operators. A bar chart showing a 100% failure rate looks identical whether it is built from
 * three requests or three thousand, and only one of those is worth acting on.
 *
 * So sample-size caveats are GENERATED, not remembered. Below a threshold the function emits the
 * caveat itself and lowers its stated confidence. A reader cannot receive the number without also
 * receiving the reason to doubt it — the same structural trick the tool layer uses for assumptions.
 */

export type Confidence = "high" | "medium" | "low";

export interface AnalyticsEnvelope {
  /** What one row of `data` means, in plain language. */
  grain: string;
  window: { fromIso: string; toIso: string };
  /** Rows behind the figures — the number that decides whether any of this means anything. */
  sampleSize: number;
  /** Share of the sample that came from replayed seed traffic rather than real users. */
  seededShare: number;
  caveats: string[];
  confidence: Confidence;
}

export interface Analytics<T> extends AnalyticsEnvelope {
  data: T;
}

export interface AnalyticsQuery {
  fromIso?: string;
  toIso?: string;
  /**
   * Window length in days, when the caller has no specific start.
   *
   * Exists so a UI can express "last 7 days" without computing a timestamp itself. Reading the
   * clock is impure, and doing it inside a React render is both a lint error and a real hazard —
   * two calls in one render could straddle a boundary. The clock belongs in the data layer.
   */
  days?: number;
  tenantId?: string;
  /** "all" includes seeded traffic; the dashboard always labels it when it does. */
  origin?: "live" | "replay" | "synthetic" | "all";
  classifierVersion?: string;
}

interface ResolvedQuery {
  fromIso: string;
  toIso: string;
  tenantId: string;
  origin: string;
  classifierVersion: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function resolve(q: AnalyticsQuery = {}): ResolvedQuery {
  const toIso = q.toIso ?? new Date().toISOString();
  const fromIso =
    q.fromIso ?? new Date(Date.parse(toIso) - (q.days ?? 30) * DAY_MS).toISOString();
  return {
    fromIso,
    toIso,
    tenantId: q.tenantId ?? DEFAULT_TENANT,
    origin: q.origin ?? "all",
    classifierVersion: q.classifierVersion ?? ACTIVE_CLASSIFIER_VERSION,
  };
}

/**
 * The shared turn filter.
 *
 * Every aggregate joins `turn` to `session` for the tenant and origin columns, so the join and its
 * predicates live in one place — a query that forgot the tenant predicate would silently report
 * across tenants, which is the single worst bug available in a multi-tenant analytics layer.
 */
function turnFilter(r: ResolvedQuery): { sql: string; args: InValue[] } {
  const clauses = [
    "s.tenant_id = ?",
    "t.created_at >= ?",
    "t.created_at <= ?",
  ];
  const args: InValue[] = [r.tenantId, r.fromIso, r.toIso];

  if (r.origin !== "all") {
    clauses.push("s.origin = ?");
    args.push(r.origin);
  }

  return { sql: clauses.join(" AND "), args };
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Build the envelope, applying the sample-size rules in one place.
 *
 * `extra` carries caveats a specific query knows about — unpriced models, missing coverage — that
 * a generic helper cannot infer.
 */
function envelope(
  grain: string,
  r: ResolvedQuery,
  sampleSize: number,
  seeded: number,
  opts: { trend?: boolean; extra?: string[] } = {},
): AnalyticsEnvelope {
  const caveats = [...(opts.extra ?? [])];
  let confidence: Confidence = "high";

  if (sampleSize === 0) {
    caveats.push("No turns in this window.");
    confidence = "low";
  } else if (sampleSize < MIN_SAMPLE_FOR_SHARE) {
    caveats.push(
      `n=${sampleSize}: shares here are illustrative, not a distribution. ` +
        `Below ${MIN_SAMPLE_FOR_SHARE} turns a single conversation moves every percentage.`,
    );
    confidence = "low";
  } else if (sampleSize < MIN_SAMPLE_FOR_TREND) {
    confidence = "medium";
  }

  if (opts.trend && sampleSize < MIN_SAMPLE_FOR_TREND) {
    caveats.push(
      `Fewer than ${MIN_SAMPLE_FOR_TREND} turns in this window — the line shows activity, not a trend.`,
    );
  }

  const seededShare = sampleSize === 0 ? 0 : seeded / sampleSize;
  if (seededShare > 0) {
    caveats.push(
      `${(seededShare * 100).toFixed(0)}% of these turns (${seeded} of ${sampleSize}) were replayed ` +
        `from a seed corpus rather than asked by a user. Tool calls, tokens and latencies are real; ` +
        `the questions were scripted.`,
    );
    if (seededShare > 0.5 && confidence === "high") confidence = "medium";
  }

  return {
    grain,
    window: { fromIso: r.fromIso, toIso: r.toIso },
    sampleSize,
    seededShare,
    caveats,
    confidence,
  };
}

/** Sample size and seeded count for a window. Every envelope on the page is built from one. */
export interface Sample {
  total: number;
  seeded: number;
}

/**
 * Compute the window's sample once, for a caller about to run several aggregates over it.
 *
 * Each function below computes its own when none is passed, which keeps them independently
 * callable. But the dashboard runs all eight against the SAME window in one `Promise.all`, and
 * eight identical full-window COUNT/SUM scans is eight round trips — against the libSQL HTTP
 * deployment this module is built for, eight separate HTTP requests — to learn one number.
 */
export async function windowSample(q: AnalyticsQuery = {}): Promise<Sample> {
  return sampleOf(resolve(q));
}

async function sampleOf(r: ResolvedQuery): Promise<Sample> {
  const f = turnFilter(r);
  const rows = await query(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN s.origin IN ('replay','synthetic') THEN 1 ELSE 0 END) AS seeded
     FROM turn t JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql}`,
    f.args,
  );
  return { total: num(rows[0]?.n), seeded: num(rows[0]?.seeded) };
}

// ------------- 1. headline

export interface Overview {
  turns: number;
  sessions: number;
  turnsPerSession: number;
  p50TotalMs: number;
  p95TotalMs: number;
  meanTokensPerTurn: number | null;
  meanCostUsd: number | null;
  totalCostUsd: number | null;
  unpricedTurns: number;
  truncationRate: number;
  errorRate: number;
}

export async function overview(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<Overview>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT COUNT(*) AS turns,
            COUNT(DISTINCT t.session_id) AS sessions,
            AVG(t.prompt_tokens + t.completion_tokens) AS mean_tokens,
            AVG(t.cost_usd) AS mean_cost,
            SUM(t.cost_usd) AS total_cost,
            SUM(CASE WHEN t.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
            SUM(CASE WHEN t.outcome = 'truncated' THEN 1 ELSE 0 END) AS truncated,
            SUM(CASE WHEN t.outcome = 'error' AND t.error_kind IS NOT 'cancelled' THEN 1 ELSE 0 END) AS errored,
            SUM(CASE WHEN t.error_kind = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
     FROM turn t JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql}`,
    f.args,
  );

  const row = rows[0] ?? {};
  const turns = num(row.turns);
  const unpriced = num(row.unpriced);
  // Cancellations leave neither numerator nor denominator. A user closing the tab says nothing
  // about whether the agent would have answered, so counting it either way misstates the rate.
  const rated = turns - num(row.cancelled);

  // SQLite has no percentile function, so the ordering is done in SQL and the row is picked by
  // OFFSET. Reading the whole `total_ms` column into JavaScript also works and is easier to read,
  // but it makes the cost of rendering this page grow with the retention window: at 90 days and
  // the "All time" chip, that is every turn ever recorded transferred to index two of them. Two
  // one-row queries are constant regardless of how much history exists.
  const [p50TotalMs, p95TotalMs] = await Promise.all([
    percentileFromDb(f, turns, 0.5),
    percentileFromDb(f, turns, 0.95),
  ]);

  const extra: string[] = [];
  if (unpriced > 0 && turns > 0) {
    extra.push(
      `${unpriced} of ${turns} turns ran on a model with no published price, so spend is a ` +
        `lower bound rather than a total.`,
    );
  }

  return {
    ...envelope("one chat turn", r, counted.total, counted.seeded, { extra }),
    data: {
      turns,
      sessions: num(row.sessions),
      turnsPerSession: num(row.sessions) === 0 ? 0 : turns / num(row.sessions),
      p50TotalMs,
      p95TotalMs,
      meanTokensPerTurn: nullableNum(row.mean_tokens),
      meanCostUsd: nullableNum(row.mean_cost),
      totalCostUsd: nullableNum(row.total_cost),
      unpricedTurns: unpriced,
      truncationRate: turns === 0 ? 0 : num(row.truncated) / turns,
      errorRate: rated <= 0 ? 0 : num(row.errored) / rated,
    },
  };
}

/**
 * Nearest-rank percentile over an in-memory array.
 *
 * Retained as the definition of record: `percentileFromDb` below must agree with it, and a test
 * can check this one without a database. The two are kept in step by `rankIndex`.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[rankIndex(sorted.length, p)];
}

/** Zero-based index of the nearest-rank percentile in an ascending run of `n` values. */
function rankIndex(n: number, p: number): number {
  return Math.min(Math.max(Math.ceil(p * n), 1), n) - 1;
}

/** The same percentile, chosen by the database so only the one row crosses the wire. */
async function percentileFromDb(
  f: { sql: string; args: InValue[] },
  n: number,
  p: number,
): Promise<number> {
  if (n === 0) return 0;
  const rows = await query(
    `SELECT t.total_ms FROM turn t JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql} ORDER BY t.total_ms LIMIT 1 OFFSET ?`,
    [...f.args, rankIndex(n, p)],
  );
  return num(rows[0]?.total_ms);
}

// ------------- 2. the umbrella view

export interface TopicRow {
  topicId: string;
  label: string;
  turns: number;
  share: number;
  meanConfidence: number;
  /** Share of this topic's labels that needed a model. The cost story, per topic. */
  llmShare: number;
  errorRate: number;
  meanCostUsd: number | null;
}

export async function topicDistribution(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<TopicRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT tt.topic_id,
            COUNT(*) AS turns,
            AVG(tt.confidence) AS mean_confidence,
            SUM(CASE WHEN tt.stage = 'llm' THEN 1 ELSE 0 END) AS llm_labels,
            SUM(CASE WHEN t.outcome = 'error' AND t.error_kind IS NOT 'cancelled' THEN 1 ELSE 0 END) AS errored,
            SUM(CASE WHEN t.error_kind = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            AVG(t.cost_usd) AS mean_cost
     FROM turn t
     JOIN session s ON s.session_id = t.session_id
     JOIN turn_topic tt ON tt.turn_id = t.turn_id AND tt.classifier_version = ?
     WHERE ${f.sql}
     GROUP BY tt.topic_id`,
    [r.classifierVersion, ...f.args],
  );

  const labelled = rows.reduce((sum, row) => sum + num(row.turns), 0);
  const byTopic = new Map(rows.map((row) => [String(row.topic_id), row]));

  // Every topic is emitted, including those with zero turns and including `unclassified`.
  // Dropping empty rows would quietly turn "nobody asked about cargo" into "cargo does not exist",
  // and hiding the abstention bucket would overstate coverage.
  const data: TopicRow[] = TOPIC_IDS.map((topicId) => {
    const row = byTopic.get(topicId);
    const turns = num(row?.turns);
    return {
      topicId,
      label: topicById(topicId)?.label ?? topicId,
      turns,
      share: labelled === 0 ? 0 : turns / labelled,
      meanConfidence: num(row?.mean_confidence),
      llmShare: turns === 0 ? 0 : num(row?.llm_labels) / turns,
      errorRate: turns - num(row?.cancelled) <= 0 ? 0 : num(row?.errored) / (turns - num(row?.cancelled)),
      meanCostUsd: nullableNum(row?.mean_cost),
    };
  }).sort((a, b) => b.turns - a.turns);

  const extra: string[] = [];
  if (counted.total > labelled) {
    const missing = counted.total - labelled;
    extra.push(
      `${missing} ${missing === 1 ? "turn has" : "turns have"} no label for classifier ` +
        `${r.classifierVersion} and ${missing === 1 ? "is" : "are"} excluded. ` +
        `Run \`npm run analytics:classify\` to fill ${missing === 1 ? "it" : "them"}.`,
    );
  }

  return {
    ...envelope("one topic", r, counted.total, counted.seeded, { extra }),
    data,
  };
}

// ------------- 3. volume

export interface DayRow {
  day: string;
  turns: number;
  sessions: number;
}

export async function volumeByDay(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<DayRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT substr(t.created_at, 1, 10) AS day,
            COUNT(*) AS turns,
            COUNT(DISTINCT t.session_id) AS sessions
     FROM turn t JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql}
     GROUP BY day ORDER BY day`,
    f.args,
  );

  return {
    ...envelope("one day", r, counted.total, counted.seeded, { trend: true }),
    data: rows.map((row) => ({
      day: String(row.day),
      turns: num(row.turns),
      sessions: num(row.sessions),
    })),
  };
}

// ------------- 4. reliability

export interface Reliability {
  turns: number;
  answeredRate: number;
  truncationRate: number;
  errorRate: number;
  toolCallSuccessRate: number;
  meanToolCallsPerTurn: number;
  /** Turns that produced an answer without consulting a single tool. */
  zeroToolAnswerRate: number;
  meanIterations: number;
  /**
   * The compounding-error sentence, generated from this window's own numbers.
   *
   * Null when there is nothing to say. Written out rather than left for the reader to compute,
   * because the gap between per-step reliability and end-to-end reliability is the thing people
   * consistently underestimate.
   */
  compounding: string | null;
}

export async function reliability(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<Reliability>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT COUNT(*) AS turns,
            SUM(CASE WHEN t.outcome = 'answered' THEN 1 ELSE 0 END) AS answered,
            SUM(CASE WHEN t.outcome = 'truncated' THEN 1 ELSE 0 END) AS truncated,
            SUM(CASE WHEN t.outcome = 'error' AND t.error_kind IS NOT 'cancelled' THEN 1 ELSE 0 END) AS errored,
            SUM(CASE WHEN t.error_kind = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(t.tool_calls) AS tool_calls,
            SUM(t.tool_failures) AS tool_failures,
            SUM(CASE WHEN t.tool_calls = 0 AND t.outcome != 'error' THEN 1 ELSE 0 END) AS zero_tool,
            AVG(t.iterations) AS mean_iterations
     FROM turn t JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql}`,
    f.args,
  );

  const row = rows[0] ?? {};
  const turns = num(row.turns);
  const toolCalls = num(row.tool_calls);
  const toolFailures = num(row.tool_failures);
  const successRate = toolCalls === 0 ? 1 : (toolCalls - toolFailures) / toolCalls;
  const meanCalls = turns === 0 ? 0 : toolCalls / turns;
  const observedClean = turns === 0 ? 0 : num(row.answered) / turns;

  let compounding: string | null = null;
  if (toolCalls > 0 && meanCalls > 0 && turns >= MIN_SAMPLE_FOR_SHARE) {
    const predicted = Math.pow(successRate, meanCalls);
    compounding =
      `Tool calls succeed at ${(successRate * 100).toFixed(1)}%. Over a mean of ` +
      `${meanCalls.toFixed(1)} calls per turn that predicts ${(predicted * 100).toFixed(1)}% ` +
      `of turns completing without a single tool failure, against ${(observedClean * 100).toFixed(1)}% ` +
      `observed answering cleanly.`;
  }

  return {
    ...envelope("the whole window", r, counted.total, counted.seeded),
    data: {
      turns,
      answeredRate: observedClean,
      truncationRate: turns === 0 ? 0 : num(row.truncated) / turns,
      errorRate: turns - num(row.cancelled) <= 0 ? 0 : num(row.errored) / (turns - num(row.cancelled)),
      toolCallSuccessRate: successRate,
      meanToolCallsPerTurn: meanCalls,
      zeroToolAnswerRate: turns === 0 ? 0 : num(row.zero_tool) / turns,
      meanIterations: num(row.mean_iterations),
      compounding,
    },
  };
}

// ------------- 5. tools

export interface ToolUsageRow {
  toolName: string;
  calls: number;
  failureRate: number;
  meanDurationMs: number;
  maxDurationMs: number;
}

export async function toolUsage(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<ToolUsageRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT c.tool_name,
            COUNT(*) AS calls,
            SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS failures,
            AVG(c.duration_ms) AS mean_ms,
            MAX(c.duration_ms) AS max_ms
     FROM turn_tool_call c
     JOIN turn t ON t.turn_id = c.turn_id
     JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql}
     GROUP BY c.tool_name ORDER BY calls DESC`,
    f.args,
  );

  return {
    ...envelope("one tool", r, counted.total, counted.seeded),
    data: rows.map((row) => ({
      toolName: String(row.tool_name),
      calls: num(row.calls),
      failureRate: num(row.calls) === 0 ? 0 : num(row.failures) / num(row.calls),
      meanDurationMs: num(row.mean_ms),
      maxDurationMs: num(row.max_ms),
    })),
  };
}

// ------------- 6. classifier health

export interface ClassifierHealth {
  activeVersion: string;
  byStage: { stage: string; turns: number; share: number; costUsd: number }[];
  labelledTurns: number;
  unlabelledTurns: number;
  classificationCostUsd: number;
}

export async function classifierHealth(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<ClassifierHealth>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT tt.stage, COUNT(*) AS turns, SUM(tt.cost_usd) AS cost
     FROM turn t
     JOIN session s ON s.session_id = t.session_id
     JOIN turn_topic tt ON tt.turn_id = t.turn_id AND tt.classifier_version = ?
     WHERE ${f.sql}
     GROUP BY tt.stage`,
    [r.classifierVersion, ...f.args],
  );

  const labelled = rows.reduce((sum, row) => sum + num(row.turns), 0);

  return {
    ...envelope("one classifier stage", r, counted.total, counted.seeded),
    data: {
      activeVersion: r.classifierVersion,
      byStage: rows.map((row) => ({
        stage: String(row.stage),
        turns: num(row.turns),
        share: labelled === 0 ? 0 : num(row.turns) / labelled,
        costUsd: num(row.cost),
      })),
      labelledTurns: labelled,
      unlabelledTurns: Math.max(counted.total - labelled, 0),
      classificationCostUsd: rows.reduce((sum, row) => sum + num(row.cost), 0),
    },
  };
}

// ------------- 7. the review queue

export interface ReviewRow {
  turnId: string;
  sessionId: string;
  createdAt: string;
  prompt: string;
  topicId: string;
  confidence: number;
  stage: string;
}

/**
 * Prompts the classifier was least sure about.
 *
 * This is the panel that closes the loop: today's abstentions are tomorrow's gold-set entries, so
 * the observability layer feeds the evaluation layer rather than the two sitting side by side.
 */
export async function needsReview(
  q: AnalyticsQuery = {},
  limit = 20,
  sample?: Sample,
): Promise<Analytics<ReviewRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT t.turn_id, t.session_id, t.created_at, t.prompt,
            tt.topic_id, tt.confidence, tt.stage
     FROM turn t
     JOIN session s ON s.session_id = t.session_id
     JOIN turn_topic tt ON tt.turn_id = t.turn_id AND tt.classifier_version = ?
     WHERE ${f.sql} AND (tt.stage = 'abstain' OR tt.confidence < 0.75)
     ORDER BY tt.confidence ASC, t.created_at DESC
     LIMIT ?`,
    [r.classifierVersion, ...f.args, limit],
  );

  return {
    ...envelope("one low-confidence turn", r, counted.total, counted.seeded),
    data: rows.map((row) => ({
      turnId: String(row.turn_id),
      sessionId: String(row.session_id),
      createdAt: String(row.created_at),
      prompt: String(row.prompt),
      topicId: String(row.topic_id),
      confidence: num(row.confidence),
      stage: String(row.stage),
    })),
  };
}

// ------------- 8. sessions

export interface SessionRow {
  sessionId: string;
  origin: string;
  startedAt: string;
  turns: number;
  topics: string[];
  totalCostUsd: number | null;
  totalMs: number;
}

export async function recentSessions(
  q: AnalyticsQuery = {},
  limit = 25,
  sample?: Sample,
): Promise<Analytics<SessionRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT s.session_id, s.origin, s.started_at,
            COUNT(t.turn_id) AS turns,
            SUM(t.cost_usd) AS cost,
            SUM(t.total_ms) AS total_ms,
            GROUP_CONCAT(DISTINCT tt.topic_id) AS topics
     FROM turn t
     JOIN session s ON s.session_id = t.session_id
     LEFT JOIN turn_topic tt ON tt.turn_id = t.turn_id AND tt.classifier_version = ?
     WHERE ${f.sql}
     GROUP BY s.session_id
     ORDER BY s.started_at DESC
     LIMIT ?`,
    [r.classifierVersion, ...f.args, limit],
  );

  return {
    ...envelope("one session", r, counted.total, counted.seeded),
    data: rows.map((row) => ({
      sessionId: String(row.session_id),
      origin: String(row.origin),
      startedAt: String(row.started_at),
      turns: num(row.turns),
      topics: row.topics ? String(row.topics).split(",").filter(Boolean) : [],
      totalCostUsd: nullableNum(row.cost),
      totalMs: num(row.total_ms),
    })),
  };
}

/** Re-exported so UI code formats money the same way the chat trace does. */
export { formatUsd };

// ------------- 9. entities: what the questions were about

export interface AirportRow {
  code: string;
  label: string | null;
  /** Distinct turns mentioning it, from either source. Not a row count. */
  turns: number;
  share: number;
  /** Turns where the USER named it. */
  promptTurns: number;
  /** Turns where the AGENT resolved to it. */
  toolTurns: number;
}

/**
 * Which airports people ask about.
 *
 * The second analytics dimension. The topic taxonomy says what KIND of question was asked; this
 * says what it was ABOUT, which no single-label topic classifier can carry without inventing a
 * class per airport.
 *
 * `turns` counts DISTINCT turns rather than rows. An airport named in the prompt AND passed to a
 * tool stores two rows on purpose — the split is informative — so counting rows would rank
 * airports by how thoroughly they were processed rather than by how often they were asked about.
 */
export async function airportDistribution(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<AirportRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT e.code,
            MAX(e.label) AS label,
            COUNT(DISTINCT e.turn_id) AS turns,
            COUNT(DISTINCT CASE WHEN e.source = 'prompt' THEN e.turn_id END) AS prompt_turns,
            COUNT(DISTINCT CASE WHEN e.source = 'tool_arg' THEN e.turn_id END) AS tool_turns
     FROM turn_entity e
     JOIN turn t ON t.turn_id = e.turn_id
     JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql} AND e.entity_type = 'airport'
     GROUP BY e.code
     ORDER BY turns DESC, e.code`,
    f.args,
  );

  // Share is of turns that named ANY airport, not of all turns: most turns name none, and dividing
  // by the whole window would make every airport look negligible.
  const withAirport = await query(
    `SELECT COUNT(DISTINCT e.turn_id) AS n
     FROM turn_entity e
     JOIN turn t ON t.turn_id = e.turn_id
     JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql} AND e.entity_type = 'airport'`,
    f.args,
  );
  const denominator = num(withAirport[0]?.n);

  return {
    ...envelope("one airport", r, counted.total, counted.seeded, {
      extra:
        denominator === 0
          ? []
          : [
              `Shares are of the ${denominator} turns that named an airport, not of all ` +
                `${counted.total} turns in the window — most questions name none.`,
            ],
    }),
    data: rows.map((row) => ({
      code: String(row.code),
      label: row.label === null ? null : String(row.label),
      turns: num(row.turns),
      share: denominator === 0 ? 0 : num(row.turns) / denominator,
      promptTurns: num(row.prompt_turns),
      toolTurns: num(row.tool_turns),
    })),
  };
}

export interface PhrasingRow {
  phrase: string;
  turns: number;
}

/**
 * What people type when they do not type a code.
 *
 * "LA" is the standing example: it is neither an IATA code nor a city in the dataset, and it is
 * what users actually write. Resolution is exactly what destroys this fact, so it is captured
 * before resolution — a resolved-code column can never answer "how do people refer to this place".
 */
export async function unresolvedPhrasings(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<PhrasingRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT e.code, COUNT(DISTINCT e.turn_id) AS turns
     FROM turn_entity e
     JOIN turn t ON t.turn_id = e.turn_id
     JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql} AND e.entity_type = 'unresolved'
     GROUP BY e.code ORDER BY turns DESC, e.code LIMIT 20`,
    f.args,
  );

  return {
    ...envelope("one phrasing", r, counted.total, counted.seeded),
    data: rows.map((row) => ({ phrase: String(row.code), turns: num(row.turns) })),
  };
}

/**
 * Airports asked about that the dataset does not cover.
 *
 * A demand signal rather than a bug list: the agent was given a code and had no data for it.
 * Recorded only when it arrived through a tool argument, because there the agent asserted it was
 * an airport — a three-letter token in free prose could be "ROI" or "CEO".
 */
export async function coverageGaps(
  q: AnalyticsQuery = {},
  sample?: Sample,
): Promise<Analytics<PhrasingRow[]>> {
  const r = resolve(q);
  const f = turnFilter(r);
  const counted = sample ?? (await sampleOf(r));

  const rows = await query(
    `SELECT e.code, COUNT(DISTINCT e.turn_id) AS turns
     FROM turn_entity e
     JOIN turn t ON t.turn_id = e.turn_id
     JOIN session s ON s.session_id = t.session_id
     WHERE ${f.sql} AND e.entity_type = 'unknown_code'
     GROUP BY e.code ORDER BY turns DESC, e.code LIMIT 20`,
    f.args,
  );

  return {
    ...envelope("one unrecognised code", r, counted.total, counted.seeded),
    data: rows.map((row) => ({ phrase: String(row.code), turns: num(row.turns) })),
  };
}
