/**
 * Schema migrations for the analytics database.
 *
 * Migrations are TypeScript constants, not `.sql` files read from disk. Two reasons:
 *
 * - Next traces imported modules automatically. Files read at runtime have to be declared in
 *   `outputFileTracingIncludes`, which is already the sharpest trap in this repo (the aviation
 *   dataset is only bundled because of an explicit entry there). A constant cannot be forgotten.
 * - The migration list is then type-checked and testable — `migrations.test.ts` asserts the
 *   versions are contiguous, which catches the merge conflict where two people both add "3".
 *
 * Version tracking uses a `schema_migration` table rather than `PRAGMA user_version`. The same code
 * runs against a local file and a remote HTTP-backed Turso database, and PRAGMA support over
 * libSQL's HTTP protocol is not guaranteed. A table is portable, and it is readable by anyone who
 * opens the database wondering what state it is in.
 */

export interface Migration {
  /** Contiguous from 1, ascending. Asserted by a test. */
  readonly version: number;
  /** Why this migration exists, in a few words. */
  readonly name: string;
  /** Statements applied in order, inside one batch. */
  readonly up: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "conversation analytics baseline",
    up: [
      // grain: one chat session — one browser tab, one conversation
      `CREATE TABLE IF NOT EXISTS session (
         session_id   TEXT PRIMARY KEY,
         tenant_id    TEXT NOT NULL DEFAULT 'demo',
         origin       TEXT NOT NULL CHECK (origin IN ('live','replay','synthetic')),
         started_at   TEXT NOT NULL,
         app_version  TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS session_tenant_started_idx
         ON session (tenant_id, started_at)`,

      // grain: one user prompt and its answer, asserted by UNIQUE (session_id, turn_index)
      `CREATE TABLE IF NOT EXISTS turn (
         turn_id           TEXT PRIMARY KEY,
         session_id        TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
         turn_index        INTEGER NOT NULL,
         created_at        TEXT NOT NULL,
         prompt            TEXT NOT NULL,
         prompt_chars      INTEGER NOT NULL,
         reply_chars       INTEGER NOT NULL,
         history_turns     INTEGER NOT NULL,
         model             TEXT NOT NULL,
         iterations        INTEGER NOT NULL,
         model_calls       INTEGER NOT NULL,
         tool_calls        INTEGER NOT NULL,
         tool_failures     INTEGER NOT NULL,
         prompt_tokens     INTEGER,
         completion_tokens INTEGER,
         cost_usd          REAL,
         model_ms          INTEGER NOT NULL,
         tool_ms           INTEGER NOT NULL,
         total_ms          INTEGER NOT NULL,
         outcome           TEXT NOT NULL CHECK (outcome IN ('answered','truncated','error')),
         error_kind        TEXT,
         redaction_version INTEGER NOT NULL,
         UNIQUE (session_id, turn_index)
       )`,
      `CREATE INDEX IF NOT EXISTS turn_created_idx ON turn (created_at)`,
      `CREATE INDEX IF NOT EXISTS turn_outcome_idx ON turn (outcome)`,

      // grain: one tool execution within a turn
      `CREATE TABLE IF NOT EXISTS turn_tool_call (
         turn_id        TEXT NOT NULL REFERENCES turn(turn_id) ON DELETE CASCADE,
         call_index     INTEGER NOT NULL,
         tool_name      TEXT NOT NULL,
         ok             INTEGER NOT NULL CHECK (ok IN (0,1)),
         error_code     TEXT,
         duration_ms    INTEGER NOT NULL,
         arguments_json TEXT NOT NULL,
         PRIMARY KEY (turn_id, call_index)
       )`,
      `CREATE INDEX IF NOT EXISTS turn_tool_call_name_idx ON turn_tool_call (tool_name, ok)`,

      // grain: one topic in one taxonomy version. Seeded from taxonomy.ts, never hand-edited.
      `CREATE TABLE IF NOT EXISTS taxonomy_topic (
         taxonomy_version INTEGER NOT NULL,
         topic_id         TEXT NOT NULL,
         label            TEXT NOT NULL,
         definition       TEXT NOT NULL,
         sort_order       INTEGER NOT NULL,
         PRIMARY KEY (taxonomy_version, topic_id)
       )`,

      // grain: one label per turn per classifier version. Never updated in place, so two
      // classifiers can be diffed over identical traffic and drift becomes observable.
      `CREATE TABLE IF NOT EXISTS turn_topic (
         turn_id            TEXT NOT NULL REFERENCES turn(turn_id) ON DELETE CASCADE,
         classifier_version TEXT NOT NULL,
         taxonomy_version   INTEGER NOT NULL,
         topic_id           TEXT NOT NULL,
         confidence         REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
         stage              TEXT NOT NULL CHECK (stage IN ('rule','llm','abstain')),
         rule_id            TEXT,
         reason             TEXT,
         classified_at      TEXT NOT NULL,
         cost_usd           REAL NOT NULL DEFAULT 0,
         PRIMARY KEY (turn_id, classifier_version),
         FOREIGN KEY (taxonomy_version, topic_id)
           REFERENCES taxonomy_topic(taxonomy_version, topic_id)
       )`,
      `CREATE INDEX IF NOT EXISTS turn_topic_lookup_idx
         ON turn_topic (classifier_version, topic_id)`,
    ],
  },
  {
    version: 2,
    name: "airport entities per turn",
    up: [
      // grain: one entity, mentioned in one turn, from one source
      //
      // A second dimension alongside the topic label. Topics say what KIND of question was asked;
      // this says what it was ABOUT, which is orthogonal and cannot be folded into the taxonomy
      // without inventing a class per airport.
      //
      // `source` is part of the grain rather than a mere attribute: an airport the user typed and
      // an airport the agent resolved to are different facts, and keeping them apart is what lets
      // the dashboard show how often the agent reached somewhere nobody named.
      `CREATE TABLE IF NOT EXISTS turn_entity (
         turn_id     TEXT NOT NULL REFERENCES turn(turn_id) ON DELETE CASCADE,
         entity_type TEXT NOT NULL CHECK (entity_type IN ('airport','unresolved','unknown_code')),
         code        TEXT NOT NULL,
         source      TEXT NOT NULL CHECK (source IN ('tool_arg','prompt')),
         label       TEXT,
         PRIMARY KEY (turn_id, entity_type, code, source)
       )`,
      `CREATE INDEX IF NOT EXISTS turn_entity_code_idx
         ON turn_entity (entity_type, code)`,
    ],
  },
];

/** The version a fully-migrated database sits at. */
export const HEAD_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
