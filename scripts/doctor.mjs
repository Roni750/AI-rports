/**
 * Preflight check for a fresh clone.
 *
 * Every item here is something that produces a confusing failure rather than a clear one. The
 * Node version is the sharpest: `node:sqlite` is a Node 22 built-in, and on an older runtime the
 * app fails at import time with a module-not-found error that says nothing about versions.
 *
 * Deliberately dependency-free and plain .mjs, so it runs before anything is installed or built.
 *
 * Run: npm run doctor
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let failed = 0;
let warned = 0;

const pass = (what, detail = "") => console.log(`  ok    ${what}${detail ? `  — ${detail}` : ""}`);
const warn = (what, fix) => {
  warned++;
  console.log(`  warn  ${what}\n        ${fix}`);
};
const fail = (what, fix) => {
  failed++;
  console.log(`  FAIL  ${what}\n        ${fix}`);
};

console.log("\nAirport Investment Intelligence Agent — preflight\n");

// ---- Node ----------------------------------------------------------------
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 5)) {
  pass(`Node ${process.versions.node}`);
} else {
  fail(
    `Node ${process.versions.node} is too old`,
    "Node 22.5+ is required: the data layer uses the built-in node:sqlite module, which does not " +
      "exist on earlier versions. Install Node 22 LTS from https://nodejs.org",
  );
}

try {
  require("node:sqlite");
  pass("node:sqlite available");
} catch {
  fail(
    "node:sqlite is not available on this runtime",
    "Upgrade to Node 22.5 or newer. Nothing needs to be installed — it is a built-in module.",
  );
}

// ---- Dependencies --------------------------------------------------------
if (existsSync("node_modules/next")) pass("dependencies installed");
else fail("dependencies are not installed", "Run: npm install");

// ---- Data ----------------------------------------------------------------
// Committed on purpose so the app runs straight from a clone with no ingestion step.
for (const [file, what] of [
  ["data/aviation.db", "aviation dataset"],
  ["data/analytics.db", "analytics database"],
]) {
  if (existsSync(file)) {
    const mb = (readFileSync(file).length / 1024 / 1024).toFixed(1);
    pass(`${what} present`, `${file}, ${mb} MB`);
  } else if (file.includes("aviation")) {
    fail(
      `${what} is missing (${file})`,
      "It is committed to the repository, so this usually means a partial clone. " +
        "Re-clone, or rebuild it with: npm run data:download && npm run data:build",
    );
  } else {
    warn(`${what} is missing (${file})`, "Run: npm run analytics:migrate");
  }
}

// ---- Environment ---------------------------------------------------------
// Read directly rather than via a loader: this runs outside Next, which would normally load it.
const env = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
if (!env) {
  fail(
    ".env.local is missing",
    "Copy the template and add a free Groq key from https://console.groq.com\n" +
      "        cp .env.local.example .env.local",
  );
} else if (/^\s*GROQ_API_KEY\s*=\s*gsk_\S+/m.test(env)) {
  pass("GROQ_API_KEY set");
} else if (/^\s*GROQ_API_KEY\s*=\s*\S+/m.test(env)) {
  warn(
    "GROQ_API_KEY does not look like a Groq key",
    "Groq keys begin with 'gsk_'. Get one free at https://console.groq.com",
  );
} else {
  fail(
    "GROQ_API_KEY is not set in .env.local",
    "The chat cannot call a model without it. Free key: https://console.groq.com",
  );
}

// ---- Generated types -----------------------------------------------------
// Next 16 generates PageProps/LayoutProps. Before the first typegen, `tsc` fails on a clean clone
// with errors that look like broken source. `npm run typecheck` now generates them itself.
if (existsSync(".next/types") || existsSync("next-env.d.ts")) pass("Next types generated");
else warn("Next route types not generated yet", "Run: npm run typecheck (it generates them)");

// ---- Verdict -------------------------------------------------------------
console.log();
if (failed) {
  console.log(`${failed} problem(s) to fix before the app will run.\n`);
  process.exit(1);
}
console.log(warned ? `Ready, with ${warned} warning(s).\n` : "Ready. Run: npm run dev\n");
console.log("Then open http://localhost:3000\n");
