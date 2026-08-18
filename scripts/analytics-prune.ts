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

import { RETENTION_DAYS } from "../lib/analytics/config";
import { query, write } from "../lib/analytics/store";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysArg = args.indexOf("--days");
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : RETENTION_DAYS;
const sessionArg = args.indexOf("--session");
const sessionId = sessionArg >= 0 ? args[sessionArg + 1] : null;

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
    await write([{ sql: "DELETE FROM session WHERE session_id = ?", args: [sessionId] }]);
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

  await write([{ sql: "DELETE FROM session WHERE started_at < ?", args: [cutoff] }]);

  const after = await query("SELECT COUNT(*) AS n FROM turn");
  console.log(`pruned. ${Number(after[0]?.n ?? 0)} turns remain`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
