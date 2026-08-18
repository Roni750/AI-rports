/**
 * Bring the analytics database to head and report where it landed.
 *
 * Migrations also run lazily on first use, so this script is not required for the app to work. It
 * exists because "did the schema apply?" should be answerable without starting a web server and
 * asking a question, and because a deploy wants a place to run migrations deliberately rather than
 * hoping the first request does it.
 *
 * Safe to run repeatedly: the second run applies nothing. That is the property worth demonstrating,
 * so the script prints the version before and after.
 *
 * Run: npm run analytics:migrate      (from the project root — the default DB path is relative)
 */

// First: `migrate()` opens whichever database ANALYTICS_DB_URL names, and without this the
// variable from `.env.local` is invisible here. The script would then migrate the local file and
// report success while the configured deployment database stayed at version 0 — so the first real
// request hits tables that do not exist.
import "./boot-env";

import { analyticsStatus, migrate, query } from "../lib/analytics/store";
import { HEAD_VERSION } from "../lib/analytics/migrations";

async function main(): Promise<void> {
  const url = process.env.ANALYTICS_DB_URL ?? "file:data/analytics.db";
  console.log(`analytics database: ${url}`);

  const outcome = await migrate();

  const status = await analyticsStatus();
  if (!status.enabled) {
    console.error(`\nFAILED: ${status.reason}`);
    process.exit(1);
  }

  console.log(`schema version: ${outcome.from} -> ${outcome.to} (head ${HEAD_VERSION})`);
  console.log(
    outcome.applied.length === 0
      ? "no migrations applied — already at head"
      : `applied migration(s): ${outcome.applied.join(", ")}`,
  );

  const tables = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  console.log(`\ntables: ${tables.map((t) => String(t.name)).join(", ")}`);

  const topics = await query("SELECT COUNT(*) AS n FROM taxonomy_topic");
  console.log(`taxonomy topics seeded: ${Number(topics[0]?.n ?? 0)}`);
  console.log(`turns recorded: ${status.turnCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
