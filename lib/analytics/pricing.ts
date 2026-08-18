/**
 * What a turn costs.
 *
 * Prices are a fact about the world, not about this code, so they live in one visible table with
 * the date they were last checked — the same reasoning that puts the scoring weights in
 * `lib/scoring/config.ts` rather than inline. A rate buried in an expression is a rate nobody
 * reviews.
 *
 * THE CENTRAL RULE: an unpriced model returns `null`, never an estimate. The product's own
 * invariant is that every number it states came from a known source; a dashboard that quietly
 * invented a dollar figure would break that rule in the one place a reader is least able to check
 * it. `groq/compound-mini` is a live example — Groq publishes no rate for it, so any turn on that
 * model reports "cost unavailable" rather than a plausible-looking guess.
 *
 * Costs here are ESTIMATES in one specific sense worth stating: they price the tokens the provider
 * reported, at the provider's list rate. They do not know about free-tier allowances, negotiated
 * pricing, or cached-token discounts. The dashboard labels them accordingly.
 */

export interface ModelPrice {
  readonly inputPerMTokenUsd: number;
  readonly outputPerMTokenUsd: number;
}

/**
 * Checked against https://console.groq.com/docs/models on this date.
 *
 * Re-check it when a model is added. Groq has already removed a whole model family once during
 * this project's lifetime (the Llama 3.x line, which is why `DEFAULT_MODEL` is overridable), so
 * treating this table as permanent would be a mistake.
 */
export const PRICES_CHECKED_ON = "2026-08-17";

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "openai/gpt-oss-120b": { inputPerMTokenUsd: 0.15, outputPerMTokenUsd: 0.6 },
  "openai/gpt-oss-20b": { inputPerMTokenUsd: 0.075, outputPerMTokenUsd: 0.3 },
  "openai/gpt-oss-safeguard-20b": { inputPerMTokenUsd: 0.075, outputPerMTokenUsd: 0.3 },
  "qwen/qwen3.6-27b": { inputPerMTokenUsd: 0.6, outputPerMTokenUsd: 3.0 },
  // Deliberately absent: groq/compound and groq/compound-mini, which Groq lists without a price.
  // Absent means "we do not know", which is a different and more useful claim than zero.
};

const PER_MILLION = 1_000_000;

/**
 * Cost of one model interaction, or null when it cannot be known.
 *
 * Null propagates rather than defaulting to zero: a turn with unknown token counts and a turn that
 * genuinely cost nothing are different facts, and averaging them together would understate spend
 * without anyone noticing.
 */
export function costUsd(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  // `MODEL_PRICES[model]` alone resolves inherited keys: "constructor" and "toString" are truthy
  // and have no rate fields, so the arithmetic below returns NaN for a model that was never priced.
  // NaN then propagates into SUM and AVG as a real-looking figure. `null` is the honest answer.
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price) return null;
  if (promptTokens === null && completionTokens === null) return null;

  const input = ((promptTokens ?? 0) / PER_MILLION) * price.inputPerMTokenUsd;
  const output = ((completionTokens ?? 0) / PER_MILLION) * price.outputPerMTokenUsd;
  return input + output;
}

export function isPriced(model: string): boolean {
  // `in` walks the prototype chain, so `isPriced("toString")` was true. Own keys only.
  return Object.hasOwn(MODEL_PRICES, model);
}

/**
 * Format a cost for display.
 *
 * Sub-cent figures are the normal case here, and `$0.00` reads as free rather than as small, so
 * anything under a cent keeps four decimals.
 */
export function formatUsd(cost: number | null): string {
  if (cost === null) return "cost unavailable";
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}
