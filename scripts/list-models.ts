/**
 * List the models the configured Groq key can actually use.
 *
 * Exists because provider model names change and get deprecated. When the chat route reports that a
 * model was rejected, this says what to put in ANTHROPIC_MODEL instead.
 *
 * Run: npm run models
 */

import Anthropic from "@anthropic-ai/sdk";
import  fs from "node:fs";
import path from "node:path";

/** Minimal .env.local reader — this script runs outside Next, which would otherwise load it. */
function loadEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

// Wrapped in a function rather than using top-level await: tsx compiles .ts as CommonJS unless
// the package declares "type": "module", and top-level await is ESM-only.
async function main() {
  loadEnvLocal();

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("No ANTHROPIC_API_KEY found.");
    console.error("Create airport-agent/.env.local containing:  ANTHROPIC_API_KEY=sk-ant-...");
    return 1;
  }

  const client = new Anthropic({ apiKey: key });

  const models: { id: string; name: string; ctx: number }[] = [];
  try {
    for await (const m of client.models.list()) {
      models.push({ id: m.id, name: m.display_name, ctx: m.max_input_tokens ?? 0 });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("The key was rejected — check it was copied in full.");
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  console.log(`${models.length} models available to this key:
`);
  for (const m of models) {
    const ctx = m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : "";
    console.log(`  ${m.id.padEnd(24)} ${m.name.padEnd(26)} ${ctx}`);
  }


  console.log(
    `\nCurrently configured: ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL ?? "(unset, using code default)"}`,
  );
  return 0;
}

main().then((code) => process.exit(code));
