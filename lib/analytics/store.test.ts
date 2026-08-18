import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEAD_VERSION, MIGRATIONS } from "./migrations";
import { analyticsStatus, migrate, query, resetStoreForTests, write } from "./store";
import { TAXONOMY_VERSION, TOPICS, UNCLASSIFIED } from "./taxonomy";

/**
 * These run against `:memory:`, not `data/analytics.db`.
 *
 * A test suite that needs a real database file to exist is a test suite that fails on a fresh
 * clone. Every case below builds its own empty database, so `npm run verify` is hermetic and the
 * order the tests run in cannot matter.
 */

const ORIGINAL_URL = process.env.ANALYTICS_DB_URL;

/**
 * A throwaway file database.
 *
 * `:memory:` is gone the moment the client is replaced, so it cannot express "reconnect to the same
 * database" — which is exactly what a genuine second-migration test needs. The file is left behind
 * for the OS to reap: libSQL keeps a Windows lock on it briefly after close, so deleting it here
 * would trade a real assertion for a flaky one.
 */
function tempDbUrl(): string {
  const file = path.join(os.tmpdir(), `analytics-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  return `file:${file.split(path.sep).join("/")}`;
}

beforeEach(() => {
  process.env.ANALYTICS_DB_URL = ":memory:";
  delete process.env.ANALYTICS_DB_TOKEN;
  resetStoreForTests();
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.ANALYTICS_DB_URL;
  else process.env.ANALYTICS_DB_URL = ORIGINAL_URL;
  resetStoreForTests();
});

describe("migration list", () => {
  it("is contiguous and ascending from 1", () => {
    // Catches the merge conflict where two branches both add version 3 — which would otherwise
    // surface as one migration silently never being applied.
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  it("agrees with HEAD_VERSION", () => {
    expect(HEAD_VERSION).toBe(MIGRATIONS.length);
  });

  it("gives every migration a name", () => {
    for (const m of MIGRATIONS) expect(m.name.trim()).not.toBe("");
  });
});

describe("migrate", () => {
  it("takes a fresh database to head", async () => {
    const outcome = await migrate();
    expect(outcome.from).toBe(0);
    expect(outcome.to).toBe(HEAD_VERSION);
    expect(outcome.applied).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it("creates every table the write path needs", async () => {
    await migrate();
    const rows = await query("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = rows.map((r) => String(r.name));
    for (const expected of ["session", "turn", "turn_tool_call", "taxonomy_topic", "turn_topic"]) {
      expect(tables).toContain(expected);
    }
  });

  it("is idempotent — reconnecting to a migrated database applies nothing", async () => {
    // A file database, so dropping the client and reconnecting reaches the same data. This is the
    // property `npm run analytics:migrate` promises when it is run twice against a real deploy.
    process.env.ANALYTICS_DB_URL = tempDbUrl();
    resetStoreForTests();

    const first = await migrate();
    expect(first.from).toBe(0);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));

    resetStoreForTests();
    const second = await migrate();
    expect(second.from).toBe(HEAD_VERSION);
    expect(second.to).toBe(HEAD_VERSION);
    expect(second.applied).toEqual([]);

    const applied = await query("SELECT COUNT(*) AS n FROM schema_migration");
    expect(Number(applied[0].n)).toBe(MIGRATIONS.length);
  });
});

describe("taxonomy seeding", () => {
  it("seeds every topic, including the abstention state", async () => {
    await migrate();
    const rows = await query(
      "SELECT topic_id FROM taxonomy_topic WHERE taxonomy_version = ?",
      [TAXONOMY_VERSION],
    );
    const ids = rows.map((r) => String(r.topic_id));
    expect(ids).toHaveLength(TOPICS.length);
    expect(ids).toContain(UNCLASSIFIED);
  });

  it("re-seeding the same database does not duplicate rows", async () => {
    // Seeding runs on every boot, so it has to be safe on every boot. A file database is required
    // here for the same reason as above: the second seed must meet the first one's rows.
    process.env.ANALYTICS_DB_URL = tempDbUrl();
    resetStoreForTests();

    await migrate();
    const before = await query("SELECT COUNT(*) AS n FROM taxonomy_topic");
    expect(Number(before[0].n)).toBe(TOPICS.length);

    resetStoreForTests();
    await migrate();
    const after = await query("SELECT COUNT(*) AS n FROM taxonomy_topic");
    expect(Number(after[0].n)).toBe(TOPICS.length);
  });
});

describe("constraints", () => {
  it("enforces the topic foreign key on turn_topic", async () => {
    await migrate();
    await seedOneTurn();

    const label = (topicId: string, classifierVersion: string) => [
      {
        sql: `INSERT INTO turn_topic (turn_id, classifier_version, taxonomy_version, topic_id,
                confidence, stage, classified_at, cost_usd)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["s1:0", classifierVersion, TAXONOMY_VERSION, topicId, 1, "rule", "2026-08-17", 0],
      },
    ];

    // The valid case first, so the rejection below is pinned to the foreign key rather than to
    // any old failure in the same statement — a `rejects.toThrow()` with nothing to contrast
    // against passes just as happily when the SQL is simply malformed.
    await expect(write(label(UNCLASSIFIED, "valid"))).resolves.toBe(true);

    // A label pointing at a topic that does not exist is exactly the bug the composite foreign
    // key is there to catch: a taxonomy rename that leaves assignments dangling.
    await expect(write(label("no_such_topic", "invalid"))).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("enforces one row per (session, turn_index)", async () => {
    await migrate();
    await seedOneTurn();
    await expect(seedOneTurn("s1:0-duplicate")).rejects.toThrow();
  });
});

describe("failure tolerance", () => {
  it("disables itself rather than throwing when the database is unreachable", async () => {
    process.env.ANALYTICS_DB_URL = "libsql://definitely-not-a-real-host.invalid";
    resetStoreForTests();

    // The contract that matters: a broken analytics database degrades to an empty result and a
    // stated reason. If this ever throws, a chat request could 500 because telemetry was down.
    const status = await analyticsStatus();
    expect(status.enabled).toBe(false);
    expect(status.reason).toBeTruthy();

    await expect(query("SELECT 1")).resolves.toEqual([]);
  });
});

/** Minimal session + turn so constraint tests have something to hang a label on. */
async function seedOneTurn(turnId = "s1:0"): Promise<void> {
  await write([
    {
      sql: `INSERT OR IGNORE INTO session (session_id, tenant_id, origin, started_at, app_version)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["s1", "demo", "live", "2026-08-17T00:00:00.000Z", "test"],
    },
    {
      sql: `INSERT INTO turn (turn_id, session_id, turn_index, created_at, prompt, prompt_chars,
              reply_chars, history_turns, model, iterations, model_calls, tool_calls,
              tool_failures, model_ms, tool_ms, total_ms, outcome, redaction_version)
            VALUES (?, ?, 0, ?, ?, 1, 1, 0, 'test-model', 1, 1, 0, 0, 1, 0, 1, 'answered', 1)`,
      args: [turnId, "s1", "2026-08-17T00:00:00.000Z", "hi"],
    },
  ]);
}
