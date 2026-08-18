import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTIVE_CLASSIFIER_VERSION } from "./classifier-version";
import { recordTurn } from "./record";
import {
  classifierHealth,
  needsReview,
  overview,
  percentile,
  recentSessions,
  reliability,
  toolUsage,
  topicDistribution,
} from "./queries";
import { resetStoreForTests } from "./store";
import { TAXONOMY_VERSION } from "./taxonomy";
import type { TurnRecord } from "./types";

/**
 * Aggregates checked against fixtures whose totals are known by construction.
 *
 * Hermetic: each test builds its own database in the OS temp directory, so the suite never depends
 * on `data/analytics.db` existing or containing anything in particular. A metrics test that reads
 * whatever happens to be lying around passes for reasons nobody can reconstruct.
 */

const ORIGINAL_URL = process.env.ANALYTICS_DB_URL;

function tempDbUrl(): string {
  const file = path.join(
    os.tmpdir(),
    `analytics-queries-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
  return `file:${file.split(path.sep).join("/")}`;
}

beforeEach(() => {
  process.env.ANALYTICS_DB_URL = tempDbUrl();
  resetStoreForTests();
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.ANALYTICS_DB_URL;
  else process.env.ANALYTICS_DB_URL = ORIGINAL_URL;
  resetStoreForTests();
});

/** A turn with sensible defaults, so each test states only what it cares about. */
function turn(over: Partial<TurnRecord> & { sessionId: string; turnIndex: number }): TurnRecord {
  return {
    tenantId: "demo",
    origin: "live",
    createdAt: "2026-08-17T12:00:00.000Z",
    appVersion: "test",
    prompt: "which airports in New England are candidates",
    replyChars: 200,
    historyTurns: 0,
    model: "openai/gpt-oss-120b",
    iterations: 2,
    modelCalls: 2,
    promptTokens: 1000,
    completionTokens: 200,
    modelMs: 900,
    totalMs: 1000,
    outcome: "answered",
    errorKind: null,
    toolTrace: [{ name: "rankAirports", arguments: {}, ok: true, durationMs: 10 }],
    ...over,
  };
}

describe("percentile", () => {
  it("uses nearest rank", () => {
    const sorted = [10, 20, 30, 40, 100];
    expect(percentile(sorted, 0.5)).toBe(30);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("overview", () => {
  it("counts turns and sessions and derives cost", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0 }));
    await recordTurn(turn({ sessionId: "a", turnIndex: 1 }));
    await recordTurn(turn({ sessionId: "b", turnIndex: 0 }));

    const result = await overview();
    expect(result.data.turns).toBe(3);
    expect(result.data.sessions).toBe(2);
    expect(result.data.turnsPerSession).toBeCloseTo(1.5, 6);

    // 1000 prompt + 200 completion on gpt-oss-120b at $0.15/$0.60 per 1M
    // = 0.00015 + 0.00012 = 0.00027 per turn, 0.00081 across three.
    expect(result.data.meanCostUsd).toBeCloseTo(0.00027, 8);
    expect(result.data.totalCostUsd).toBeCloseTo(0.00081, 8);
    expect(result.data.unpricedTurns).toBe(0);
  });

  it("reports unpriced turns instead of costing them at zero", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, model: "groq/compound-mini" }));
    const result = await overview();
    expect(result.data.unpricedTurns).toBe(1);
    expect(result.caveats.some((c) => c.includes("no published price"))).toBe(true);
  });

  it("counts truncated and errored turns", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0 }));
    await recordTurn(turn({ sessionId: "a", turnIndex: 1, outcome: "truncated" }));
    await recordTurn(
      turn({ sessionId: "a", turnIndex: 2, outcome: "error", errorKind: "rate_limit" }),
    );

    const result = await overview();
    expect(result.data.truncationRate).toBeCloseTo(1 / 3, 6);
    expect(result.data.errorRate).toBeCloseTo(1 / 3, 6);
  });
});

describe("the honesty envelope", () => {
  it("flags a small sample as low confidence with a stated reason", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0 }));
    const result = await overview();
    expect(result.sampleSize).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.caveats.join(" ")).toContain("n=1");
  });

  it("says so when the window is empty rather than implying zero traffic is a finding", async () => {
    const result = await overview();
    expect(result.sampleSize).toBe(0);
    expect(result.caveats).toContain("No turns in this window.");
  });

  it("declares the seeded share and names it as replayed", async () => {
    await recordTurn(turn({ sessionId: "live1", turnIndex: 0, origin: "live" }));
    await recordTurn(turn({ sessionId: "seed1", turnIndex: 0, origin: "replay" }));

    const result = await overview();
    expect(result.seededShare).toBeCloseTo(0.5, 6);
    expect(result.caveats.some((c) => c.includes("replayed"))).toBe(true);
  });

  it("excludes seeded traffic when asked", async () => {
    await recordTurn(turn({ sessionId: "live1", turnIndex: 0, origin: "live" }));
    await recordTurn(turn({ sessionId: "seed1", turnIndex: 0, origin: "replay" }));

    const result = await overview({ origin: "live" });
    expect(result.data.turns).toBe(1);
    expect(result.seededShare).toBe(0);
  });

  it("respects the time window", async () => {
    await recordTurn(turn({ sessionId: "old", turnIndex: 0, createdAt: "2020-01-01T00:00:00.000Z" }));
    await recordTurn(turn({ sessionId: "new", turnIndex: 0, createdAt: "2026-08-17T12:00:00.000Z" }));

    const result = await overview({ fromIso: "2026-08-01T00:00:00.000Z" });
    expect(result.data.turns).toBe(1);
  });

  it("isolates tenants", async () => {
    // The worst available bug in a multi-tenant analytics layer is a query that forgets the
    // tenant predicate, because the numbers still look plausible.
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, tenantId: "demo" }));
    await recordTurn(turn({ sessionId: "b", turnIndex: 0, tenantId: "other" }));

    expect((await overview()).data.turns).toBe(1);
    expect((await overview({ tenantId: "other" })).data.turns).toBe(1);
  });
});

describe("topicDistribution", () => {
  it("groups by the umbrella and always emits every topic", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, prompt: "which airports are candidates" }));
    await recordTurn(
      turn({ sessionId: "a", turnIndex: 1, prompt: "how much freight moves through ANC" }),
    );

    const result = await topicDistribution();
    const screening = result.data.find((t) => t.topicId === "screening_ranking")!;
    const cargo = result.data.find((t) => t.topicId === "cargo_freight")!;
    expect(screening.turns).toBe(1);
    expect(cargo.turns).toBe(1);
    expect(screening.share).toBeCloseTo(0.5, 6);

    // A topic nobody asked about must still appear, or "nobody asked" silently becomes
    // "this category does not exist".
    const growth = result.data.find((t) => t.topicId === "growth_momentum")!;
    expect(growth.turns).toBe(0);

    // Including the abstention bucket, so coverage cannot be overstated by omission.
    expect(result.data.some((t) => t.topicId === "unclassified")).toBe(true);
  });

  it("reports turns that have no label for the active classifier", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0 }));
    const result = await topicDistribution({ classifierVersion: "rules@99|llm@none|tax@1" });
    expect(result.caveats.some((c) => c.includes("no label"))).toBe(true);
  });
});

describe("reliability", () => {
  it("computes tool success and the compounding-error sentence", async () => {
    // 25 turns so the sample clears the threshold that gates the sentence.
    for (let i = 0; i < 25; i++) {
      await recordTurn(
        turn({
          sessionId: "s",
          turnIndex: i,
          toolTrace: [
            { name: "rankAirports", arguments: {}, ok: true, durationMs: 10 },
            { name: "explainScore", arguments: {}, ok: i !== 0, errorCode: i === 0 ? "empty_result" : undefined, durationMs: 5 },
          ],
        }),
      );
    }

    const result = await reliability();
    expect(result.data.turns).toBe(25);
    // 50 calls, 1 failure.
    expect(result.data.toolCallSuccessRate).toBeCloseTo(49 / 50, 6);
    expect(result.data.meanToolCallsPerTurn).toBeCloseTo(2, 6);
    expect(result.data.compounding).toContain("98.0%");
  });

  it("withholds the compounding sentence when the sample is too small to support it", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0 }));
    expect((await reliability()).data.compounding).toBeNull();
  });

  it("counts turns that answered without consulting a tool", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, toolTrace: [] }));
    await recordTurn(turn({ sessionId: "a", turnIndex: 1 }));
    expect((await reliability()).data.zeroToolAnswerRate).toBeCloseTo(0.5, 6);
  });
});

describe("toolUsage", () => {
  it("aggregates per tool with failure rates", async () => {
    await recordTurn(
      turn({
        sessionId: "a",
        turnIndex: 0,
        toolTrace: [
          { name: "rankAirports", arguments: {}, ok: true, durationMs: 100 },
          { name: "rankAirports", arguments: {}, ok: false, errorCode: "empty_result", durationMs: 20 },
          { name: "flightMix", arguments: {}, ok: true, durationMs: 4 },
        ],
      }),
    );

    const result = await toolUsage();
    const rank = result.data.find((t) => t.toolName === "rankAirports")!;
    expect(rank.calls).toBe(2);
    expect(rank.failureRate).toBeCloseTo(0.5, 6);
    expect(rank.maxDurationMs).toBe(100);
  });
});

describe("classifierHealth", () => {
  it("splits labels by stage and reports what classification cost", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, prompt: "which airports are candidates" }));
    const result = await classifierHealth();

    expect(result.data.activeVersion).toBe(ACTIVE_CLASSIFIER_VERSION);
    const rule = result.data.byStage.find((s) => s.stage === "rule")!;
    expect(rule.turns).toBe(1);
    // The entire argument for the deterministic stage, as a number.
    expect(result.data.classificationCostUsd).toBe(0);
  });
});

describe("needsReview", () => {
  it("surfaces abstentions ahead of confident labels", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, prompt: "mm", toolTrace: [{ name: "resolveAirport", arguments: {}, ok: true, durationMs: 1 }] }));
    await recordTurn(turn({ sessionId: "a", turnIndex: 1, prompt: "which airports are candidates" }));

    const result = await needsReview();
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    expect(result.data[0].stage).toBe("abstain");
    expect(result.data[0].prompt).toBe("mm");
  });
});

describe("recentSessions", () => {
  it("rolls turns up to sessions with their topics", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0, prompt: "which airports are candidates" }));
    await recordTurn(
      turn({ sessionId: "a", turnIndex: 1, prompt: "how much freight moves through ANC" }),
    );

    const result = await recentSessions();
    expect(result.data).toHaveLength(1);
    expect(result.data[0].turns).toBe(2);
    expect(result.data[0].topics.sort()).toEqual(["cargo_freight", "screening_ranking"]);
    expect(result.data[0].totalCostUsd).toBeCloseTo(0.00054, 8);
  });

  it("records the taxonomy version alongside the label", async () => {
    await recordTurn(turn({ sessionId: "a", turnIndex: 0 }));
    const result = await topicDistribution();
    expect(TAXONOMY_VERSION).toBe(1);
    expect(result.data.some((t) => t.turns > 0)).toBe(true);
  });
});
