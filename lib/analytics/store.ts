import { createClient, type Client, type InArgs, type Row } from "@libsql/client";

import { HEAD_VERSION, MIGRATIONS } from "./migrations";
import { TAXONOMY_VERSION, TOPICS } from "./taxonomy";

/**
 * Read-write access to the analytics database.
 *
 * Deliberately the only file that knows we use libSQL — the same rule `lib/data/db.ts` states for
 * itself, restated here rather than widened to cover both. The two databases have opposite
 * lifecycles: `aviation.db` is an immutable artifact rebuilt by a Python pipeline and opened
 * read-only, while this one is an append-only operational log written on every request. Sharing a
 * module would mean one file with two connection modes and two reasons to change.
 *
 * One client, two deployments. `file:` locally, `libsql://` in production, selected by an
 * environment variable — so the code path under test is the code path that ships. libSQL speaks
 * SQLite's dialect, so the DDL in `migrations.ts` is identical in both.
 *
 * EVERY EXPORT HERE IS FAILURE-TOLERANT. If the database cannot be reached, calls resolve to empty
 * results and record a reason instead of throwing. Analytics is a passenger: it may not break the
 * product it measures.
 */

const DEFAULT_URL = "file:data/analytics.db";

/**
 * Turbopack re-evaluates modules on every edit, and each evaluation would otherwise open a fresh
 * connection that never closes. Pinning the client to the global object is the standard Next
 * workaround; it looks unusual precisely because module scope is normally enough.
 */
const globalForStore = globalThis as unknown as {
  __analyticsStore?: StoreState;
};

/** What the migration runner did on the one occasion it ran in this process. */
export interface MigrationOutcome {
  from: number;
  to: number;
  applied: readonly number[];
}

interface StoreState {
  client: Client | null;
  /** Set when the store is unusable. Surfaced by `analyticsStatus()` and shown in the dashboard. */
  disabledReason: string | null;
  /** Resolves once migrations and taxonomy seeding have run. Shared so they run exactly once. */
  ready: Promise<void> | null;
  /**
   * Recorded during `ensureReady`, because by the time anything can query the database the
   * migrations have already run — so "what version was this before?" is unanswerable afterwards.
   */
  migration: MigrationOutcome | null;
}

function state(): StoreState {
  if (!globalForStore.__analyticsStore) {
    globalForStore.__analyticsStore = {
      client: null,
      disabledReason: null,
      ready: null,
      migration: null,
    };
  }
  return globalForStore.__analyticsStore;
}

function client(): Client | null {
  const s = state();
  if (s.client || s.disabledReason) return s.client;

  const url = process.env.ANALYTICS_DB_URL ?? DEFAULT_URL;
  try {
    s.client = createClient({
      url,
      // Only sent for remote URLs; libSQL ignores it for `file:`.
      authToken: process.env.ANALYTICS_DB_TOKEN,
    });
  } catch (err) {
    // A bad URL or a missing token must not throw into a request. Record it and stay disabled.
    s.disabledReason = `could not open ${url}: ${err instanceof Error ? err.message : String(err)}`;
    s.client = null;
  }
  return s.client;
}

// ------------- 1. migrations and seeding

async function applyMigrations(db: Client): Promise<MigrationOutcome> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migration (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );

  const existing = await db.execute("SELECT version FROM schema_migration");
  const done = new Set(existing.rows.map((r) => Number(r.version)));
  const from = done.size === 0 ? 0 : Math.max(...done);
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    // One batch per migration, so a half-applied migration cannot be recorded as complete.
    await db.batch(
      [
        ...migration.up.map((sql) => ({ sql, args: [] as InArgs })),
        {
          sql: "INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)",
          args: [migration.version, migration.name, new Date().toISOString()],
        },
      ],
      "write",
    );
    applied.push(migration.version);
  }

  return { from, to: applied.length > 0 ? Math.max(...applied) : from, applied };
}

/**
 * Seed the taxonomy rows the `turn_topic` foreign key depends on.
 *
 * Idempotent: `INSERT OR REPLACE` refreshes labels and definitions when the config changes, which
 * is safe because a topic's *id* is the thing assignments point at, and ids are never reused across
 * versions.
 */
async function seedTaxonomy(db: Client): Promise<void> {
  await db.batch(
    TOPICS.map((topic, index) => ({
      sql: `INSERT OR REPLACE INTO taxonomy_topic
              (taxonomy_version, topic_id, label, definition, sort_order)
            VALUES (?, ?, ?, ?, ?)`,
      args: [TAXONOMY_VERSION, topic.id, topic.label, topic.definition, index] as InArgs,
    })),
    "write",
  );
}

/**
 * Bring the database to head and seed the taxonomy, exactly once per process.
 *
 * Every public function awaits this, so callers never have to remember to. On failure the store
 * disables itself rather than propagating — a migration problem should show up as an empty
 * dashboard with a stated reason, not as a 500 on a chat request.
 */
export async function ensureReady(): Promise<void> {
  const s = state();
  if (s.disabledReason) return;
  if (s.ready) return s.ready;

  s.ready = (async () => {
    const db = client();
    if (!db) return;
    try {
      // Foreign keys are off by default in SQLite and must be enabled per connection. Without
      // this the composite FK on turn_topic would be documentation rather than a constraint.
      await db.execute("PRAGMA foreign_keys = ON");
      s.migration = await applyMigrations(db);
      await seedTaxonomy(db);
    } catch (err) {
      s.disabledReason = err instanceof Error ? err.message : String(err);
    }
  })();

  return s.ready;
}

/**
 * Run migrations and report what happened.
 *
 * Returns the outcome captured *during* the migration rather than re-reading the version
 * afterwards, because any read goes through `ensureReady()` and would therefore observe the
 * post-migration state — making "0 -> 1" impossible to ever report.
 */
export async function migrate(): Promise<MigrationOutcome> {
  await ensureReady();
  return state().migration ?? { from: 0, to: 0, applied: [] };
}

// ------------- 2. query helpers

/** Rows come back with snake_case columns; each caller maps to camelCase, as `lib/data/db.ts` does. */
export async function query(sql: string, args: InArgs = []): Promise<Row[]> {
  await ensureReady();
  const db = client();
  if (!db || state().disabledReason) return [];
  try {
    const result = await db.execute({ sql, args });
    return result.rows;
  } catch (err) {
    console.error("[analytics] query failed", err);
    return [];
  }
}

/** A write batch. Returns false when the write did not happen, so callers can log it. */
export async function write(
  statements: readonly { sql: string; args: InArgs }[],
): Promise<boolean> {
  await ensureReady();
  const db = client();
  if (!db || state().disabledReason) return false;
  if (statements.length === 0) return true;
  await db.batch([...statements], "write");
  return true;
}

// ------------- 3. status

export interface AnalyticsStatus {
  enabled: boolean;
  /** Present only when disabled. Written for a human reading the dashboard's empty state. */
  reason?: string;
  turnCount: number;
  schemaVersion: number;
  headVersion: number;
}

/**
 * Whether analytics is usable, and why not when it isn't.
 *
 * The dashboard renders this rather than assuming an empty table means no traffic. "No data yet"
 * and "the database is unreachable" look identical in a chart and mean completely different things.
 */
export async function analyticsStatus(): Promise<AnalyticsStatus> {
  await ensureReady();
  const s = state();
  if (s.disabledReason) {
    return {
      enabled: false,
      reason: s.disabledReason,
      turnCount: 0,
      schemaVersion: 0,
      headVersion: HEAD_VERSION,
    };
  }

  const counted = await query("SELECT COUNT(*) AS n FROM turn");
  const versioned = await query("SELECT MAX(version) AS v FROM schema_migration");
  return {
    enabled: true,
    turnCount: Number(counted[0]?.n ?? 0),
    schemaVersion: Number(versioned[0]?.v ?? 0),
    headVersion: HEAD_VERSION,
  };
}

/**
 * Drop the cached client so a test can point at a different URL.
 *
 * Exported for tests only. Production code has exactly one database for the life of the process.
 */
export function resetStoreForTests(): void {
  globalForStore.__analyticsStore = {
    client: null,
    disabledReason: null,
    ready: null,
    migration: null,
  };
}
