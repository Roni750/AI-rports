/**
 * List the models the configured Groq key can actually use.
 *
 * Exists because provider model names change and get deprecated. When the chat route reports that a
 * model was rejected, this says what to put in GROQ_MODEL instead.
 *
 * Run: npm run models
 */

import fs from "node:fs";
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

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.error("No GROQ_API_KEY found.");
    console.error("Create airport-agent/.env.local containing:  GROQ_API_KEY=gsk_...");
    return 1;
  }

  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    console.error(`Groq returned ${res.status}: ${await res.text()}`);
    if (res.status === 401) console.error("The key was rejected — check it was copied in full.");
    return 1;
  }

  const json = (await res.json()) as {
    data?: { id: string; owned_by?: string; context_window?: number; active?: boolean }[];
  };

  const models = (json.data ?? []).filter((m) => m.active !== false);
  models.sort((a, b) => a.id.localeCompare(b.id));

  console.log(`${models.length} models available:\n`);
  for (const m of models) {
    const ctx = m.context_window ? `${(m.context_window / 1000).toFixed(0)}k ctx` : "";
    console.log(`  ${m.id.padEnd(42)} ${(m.owned_by ?? "").padEnd(16)} ${ctx}`);
  }

  // Tool calling is required, so flag the families known to support it well.
  const preferred = models.filter((m) =>
    /llama-3\.[13]|llama-4|gpt-oss|qwen|kimi|maverick|scout/i.test(m.id),
  );
  if (preferred.length) {
    console.log("\nLikely tool-calling candidates for GROQ_MODEL:");
    for (const m of preferred) console.log(`  ${m.id}`);
  }
  console.log(
    `\nCurrently configured: GROQ_MODEL=${process.env.GROQ_MODEL ?? "(unset, using code default)"}`,
  );
  return 0;
}

main().then((code) => process.exit(code));
