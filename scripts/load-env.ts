import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env.local reader for scripts that run outside Next.
 *
 * Next loads `.env.local` automatically; `tsx` does not. Without this, a script that needs
 * GROQ_API_KEY does not fail loudly — it takes the "no key configured" branch and produces
 * plausible but empty results. That is exactly how the topic eval was briefly reporting a working
 * LLM stage that had never made a request, so this is not a convenience wrapper.
 *
 * Extracted from `scripts/list-models.ts`, which established the pattern.
 */
export function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    // Real environment variables win, so CI and one-off overrides are not silently replaced.
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}
