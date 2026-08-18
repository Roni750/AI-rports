/**
 * Command-line flag parsing that refuses to guess.
 *
 * `args[args.indexOf("--session") + 1]` is the obvious way to read a flag's value and it has a
 * dangerous failure mode: when the value is missing — omitted, or swallowed by a shell — it yields
 * `undefined` rather than an error. A caller that then writes `if (sessionId) { … }` silently takes
 * the *other* branch, which in `analytics-prune` meant a request to erase one conversation fell
 * through to the bulk retention delete.
 *
 * So a flag that is present without a value is a hard error, not a default. These scripts delete
 * data and spend money; "I could not tell what you meant" must stop the run.
 */

/** True when a bare flag is present. */
export function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

/**
 * The value following `name`, or `fallback` when the flag is absent entirely.
 *
 * Exits when the flag is present but its value is missing or is itself another flag — the two
 * shapes that would otherwise become `undefined`.
 */
export function flagValue(
  args: readonly string[],
  name: string,
  fallback: string | null = null,
): string | null {
  const at = args.indexOf(name);
  if (at < 0) return fallback;

  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    die(`${name} needs a value (got ${value === undefined ? "nothing" : `"${value}"`}).`);
  }
  return value;
}

/** As `flagValue`, but the value must parse as a positive, finite number. */
export function numericFlag(args: readonly string[], name: string, fallback: number): number {
  const raw = flagValue(args, name);
  if (raw === null) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    die(`${name} must be a positive number (got "${raw}").`);
  }
  return parsed;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
