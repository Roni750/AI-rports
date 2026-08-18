/**
 * Extract airport entities from turns that were recorded before the extractor existed.
 *
 * This is the payoff for having stored tool arguments rather than only tool names. Every turn ever
 * recorded already contains the resolved codes the agent used and the prompt the user typed, so a
 * dimension added today can be populated over the entire history without re-running a single agent
 * call and without spending a token.
 *
 * Deterministic and idempotent: re-running rewrites the same rows via the four-column primary key.
 * Safe to run after every deploy that changes the extractor.
 *
 * Run: npm run analytics:entities
 *      npm run analytics:entities -- --dry-run    report what would be written, write nothing
 *      npm run analytics:entities -- --limit 100
 */

// The store reads ANALYTICS_DB_URL at module scope, so `.env.local` has to be loaded before any
// import that touches it — otherwise this backfills the local file while the configured database
// keeps none of it.
import "./boot-env";

import { hasFlag, numericFlag } from "./args";
import { loadAirportLookup } from "../lib/data/db";
import { extractEntities, type Entity } from "../lib/analytics/entities";
import { query, write } from "../lib/analytics/store";

const args = process.argv.slice(2);
const dryRun = hasFlag(args, "--dry-run");
const limit = numericFlag(args, "--limit", 10_000);

interface StoredTurn {
  turnId: string;
  prompt: string;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
}

async function loadTurns(): Promise<StoredTurn[]> {
  const turns = await query(
    "SELECT turn_id, prompt FROM turn ORDER BY created_at DESC LIMIT ?",
    [limit],
  );

  const calls = await query(
    "SELECT turn_id, tool_name, arguments_json FROM turn_tool_call ORDER BY turn_id, call_index",
  );

  const byTurn = new Map<string, { name: string; arguments: Record<string, unknown> }[]>();
  for (const row of calls) {
    const id = String(row.turn_id);
    let parsed: Record<string, unknown> = {};
    try {
      const decoded = JSON.parse(String(row.arguments_json ?? "{}")) as unknown;
      // A tool argument payload is always an object; anything else is corrupt and is skipped
      // rather than allowed to throw halfway through a backfill.
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        parsed = decoded as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
    const list = byTurn.get(id) ?? [];
    list.push({ name: String(row.tool_name), arguments: parsed });
    byTurn.set(id, list);
  }

  return turns.map((row) => ({
    turnId: String(row.turn_id),
    prompt: String(row.prompt ?? ""),
    toolCalls: byTurn.get(String(row.turn_id)) ?? [],
  }));
}

async function main(): Promise<void> {
  const lookup = loadAirportLookup();
  console.log(`airport lookup: ${lookup.codes.size} codes, ${lookup.cityToIata.size} city names`);

  const turns = await loadTurns();
  console.log(`turns to scan: ${turns.length}\n`);

  const extracted = new Map<string, Entity[]>();
  let rows = 0;
  for (const turn of turns) {
    const entities = extractEntities(
      { prompt: turn.prompt, toolCalls: turn.toolCalls },
      lookup,
    );
    if (entities.length === 0) continue;
    extracted.set(turn.turnId, entities);
    rows += entities.length;
  }

  console.log(`turns with at least one entity: ${extracted.size}`);
  console.log(`entity rows: ${rows}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written. Sample:");
    for (const [turnId, entities] of [...extracted].slice(0, 10)) {
      const summary = entities.map((e) => `${e.code}(${e.entityType[0]}/${e.source[0]})`).join(" ");
      console.log(`  ${turnId.slice(0, 20)}…  ${summary}`);
    }
    return;
  }

  let written = 0;
  let failures = 0;

  for (const [turnId, entities] of extracted) {
    const statements = [
      {
        // Delete first, so the backfill is AUTHORITATIVE for a turn rather than merely additive.
        // `INSERT OR REPLACE` refreshes the rows the extractor still produces but cannot remove
        // ones it no longer does — after fixing the city lookup, "santa ana" survived as a stale
        // unresolved phrasing beside the correct SNA row, and the counts silently disagreed with
        // the code that produced them. A re-extraction has to be able to retract.
        sql: "DELETE FROM turn_entity WHERE turn_id = ?",
        args: [turnId],
      },
      ...entities.map((entity) => ({
        sql: `INSERT INTO turn_entity
                (turn_id, entity_type, code, source, label)
              VALUES (?, ?, ?, ?, ?)`,
        args: [turnId, entity.entityType, entity.code, entity.source, entity.label],
      })),
    ];

    try {
      // `write` reports an unreachable store by returning false, but THROWS when the database
      // actively rejects a statement. A backfill has to survive one bad turn rather than abandon
      // every turn queued behind it, so both halves are handled and counted.
      // Count the rows written, not the statements sent — the batch also carries a DELETE, and
      // reporting 124 writes for 83 rows is the kind of number that quietly erodes trust in a
      // report nobody can reconcile against the table.
      if (await write(statements)) written += entities.length;
      else failures += entities.length;
    } catch (err) {
      failures += entities.length;
      console.error(`  ! ${turnId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nwritten: ${written}`);
  if (failures > 0) console.log(`FAILED:  ${failures} (see errors above)`);

  const top = await query(
    `SELECT code, label, COUNT(DISTINCT turn_id) AS turns
     FROM turn_entity WHERE entity_type = 'airport'
     GROUP BY code ORDER BY turns DESC, code LIMIT 12`,
  );
  console.log("\nmost-asked airports");
  for (const row of top) {
    console.log(`  ${String(row.code).padEnd(5)}${String(row.turns).padStart(3)}  ${row.label ?? ""}`);
  }

  const unresolved = await query(
    `SELECT code, COUNT(DISTINCT turn_id) AS turns
     FROM turn_entity WHERE entity_type = 'unresolved'
     GROUP BY code ORDER BY turns DESC LIMIT 8`,
  );
  if (unresolved.length > 0) {
    console.log("\nunresolved phrasings (what users actually type)");
    for (const row of unresolved) console.log(`  "${row.code}"  ${row.turns}`);
  }

  const gaps = await query(
    `SELECT code, COUNT(DISTINCT turn_id) AS turns
     FROM turn_entity WHERE entity_type = 'unknown_code'
     GROUP BY code ORDER BY turns DESC LIMIT 8`,
  );
  if (gaps.length > 0) {
    console.log("\ncoverage gaps (asked about, no data)");
    for (const row of gaps) console.log(`  ${row.code}  ${row.turns}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
