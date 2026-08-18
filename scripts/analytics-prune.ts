/**
 * Delete recorded conversations older than the retention window.
 *
 * Retention is enforced by running this, not by a background job on a schedule nobody remembers.
 * That is deliberate: silent automatic deletion is how data disappears in the middle of an
 * investigation, and a screening demo has no operational need for a cron.
 *
 * The delete is a single statement because the schema does the work — `ON DELETE CASCADE` from
 * `session` through `turn` to `turn_tool_call` and `turn_topic` means erasing a conversation is one
 * row. That is also the answer to a right-to-erasure request for a single session, which is worth
 * knowing: the schema shape IS the compliance story.
 *
 * Run: npm run analytics:prune                 delete beyond RETENTION_DAYS
 *      npm run analytics:prune -- --dry-run    report what would go, delete nothing
 *      npm run analytics:prune -- --days 30    override the window
 *      npm run analytics:prune -- --session <id>   erase one conversation
 */

// First, and before any import that reads configuration at module scope: this script talks to
// whichever database ANALYTICS_DB_URL names, and reading that from `.env.local` too late means
// pruning the local file while the configured database keeps every row it was asked to drop.
import "./boot-env";

import { flagValue, hasFlag, numericFlag } from "./args";
import { RETENTION_DAYS } from "../lib/analytics/config";
import { query, write } from "../lib/analytics/store";

const args = process.argv.slice(2);
const dryRun = hasFlag(args, "--dry-run");
// Both values go through the strict parser. `--session` with no value used to yield `undefined`,
// which the `if (sessionId)` branch below reads as "no session was asked for" — turning a
// single-conversation erasure into the 90-day bulk delete. See `args.ts`.
const days = numericFlag(args, "--days", RETENTION_DAYS);
const sessionId = flagValue(args, "--session");

async function main(): Promise<void> {
  if (sessionId) {
    const rows = await query("SELECT COUNT(*) AS n FROM turn WHERE session_id = ?", [sessionId]);
    const turns = Number(rows[0]?.n ?? 0);
    if (turns === 0) {
      console.log(`no session ${sessionId}`);
      return;
    }
    console.log(`session ${sessionId}: ${turns} turns`);
    if (dryRun) {
      console.log("--dry-run: nothing deleted");
      return;
    }
    if (!(await write([{ sql: "DELETE FROM session WHERE session_id = ?", args: [sessionId] }]))) {
      console.error("delete failed — the database rejected the write, nothing was erased");
      process.exit(1);
    }
    console.log("erased — cascades removed its turns, tool calls and labels");
    return;
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(`retention window: ${days} days (cutoff ${cutoff.slice(0, 10)})`);

  const rows = await query(
    `SELECT COUNT(DISTINCT s.session_id) AS sessions, COUNT(t.turn_id) AS turns
     FROM session s LEFT JOIN turn t ON t.session_id = s.session_id
     WHERE s.started_at < ?`,
    [cutoff],
  );

  const sessions = Number(rows[0]?.sessions ?? 0);
  const turns = Number(rows[0]?.turns ?? 0);
  console.log(`beyond the window: ${sessions} sessions, ${turns} turns`);

  if (sessions === 0) {
    console.log("nothing to prune");
    return;
  }
  if (dryRun) {
    console.log("--dry-run: nothing deleted");
    return;
  }

  if (!(await write([{ sql: "DELETE FROM session WHERE started_at < ?", args: [cutoff] }]))) {
    console.error("prune failed — the database rejected the write, nothing was deleted");
    process.exit(1);
  }

  const after = await query("SELECT COUNT(*) AS n FROM turn");
  console.log(`pruned. ${Number(after[0]?.n ?? 0)} turns remain`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
