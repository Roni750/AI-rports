/**
 * Measures the fixed prefix re-sent on every model call: system prompt + tool schemas.
 *
 * Kept as a script rather than a one-off because the prefix is a budget, not a constant. On a
 * tokens-per-minute-limited provider it is paid once per iteration, so a prompt edit that looks
 * harmless can quietly push a four-iteration question over the ceiling.
 *
 * Run: npx tsx scripts/measure-prefix.ts
 */
import { systemPrompt } from "../lib/agent/system-prompt";
import { TOOL_SCHEMAS } from "../lib/agent/tool-schemas";

/** Measured 2026-08-17, before the trimming pass. */
const BASELINE = { system: 5495, tools: 4155, prefix: 9811 };

const system = systemPrompt().length;
const tools = JSON.stringify(TOOL_SCHEMAS).length;
const prefix = JSON.stringify({
  messages: [{ role: "system", content: systemPrompt() }],
  tools: TOOL_SCHEMAS,
}).length;

const delta = (now: number, was: number) =>
  now === was ? "unchanged" : `${(((was - now) / was) * 100).toFixed(0)}% smaller`;

console.log(`system prompt : ${String(was(BASELINE.system)).padStart(5)} -> ${String(system).padStart(5)} chars   ${delta(system, BASELINE.system)}`);
console.log(`tool schemas  : ${String(was(BASELINE.tools)).padStart(5)} -> ${String(tools).padStart(5)} chars   ${delta(tools, BASELINE.tools)}`);
console.log(`FIXED PREFIX  : ${String(was(BASELINE.prefix)).padStart(5)} -> ${String(prefix).padStart(5)} chars   ${delta(prefix, BASELINE.prefix)}`);
console.log(`                ~${Math.round(BASELINE.prefix / 4)} -> ~${Math.round(prefix / 4)} tokens, paid on every call`);

console.log("\nper-tool schema size:");
for (const t of TOOL_SCHEMAS) {
  console.log(`  ${t.function.name.padEnd(20)} ${String(JSON.stringify(t).length).padStart(5)} chars`);
}

function was(n: number) {
  return n;
}
