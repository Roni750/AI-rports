/**
 * The contract between the deterministic core and the language model.
 *
 * Two design rules make this layer worth having:
 *
 * 1. EVERY NUMBER THE AGENT STATES ORIGINATES HERE. The model selects a tool, passes parameters,
 *    and narrates what comes back. It never calculates, estimates, or fills a gap. For an
 *    investment decision a fabricated figure is worse than no figure, so this is enforced by
 *    structure rather than by asking the prompt nicely.
 *
 * 2. ASSUMPTIONS ARE DATA, NOT PROSE. Each result carries its own metric definitions, assumptions,
 *    data vintage and caveats as fields. The prompt's job is to relay them. You cannot forget to
 *    state an assumption if the data layer emits it — which is what the brief's "clearly
 *    communicate assumption, uncertainty and scoping" requirement actually needs.
 *
 * Errors are returned, never thrown. A tool that throws gives the model nothing to recover with;
 * a structured failure with suggestions lets it ask a better question.
 */

import type { MustMention } from "./must-mention";

export type Confidence = "high" | "medium" | "low";

export interface ResultEnvelope {
  /** How each figure in `data` is defined, in plain language. */
  metricDefinitions: string[];
  /** Choices made that a reader could reasonably have made differently. */
  assumptions: string[];
  /** Which data, which years. */
  dataVintage: string;
  /** Known limitations affecting how far this answer can be trusted. */
  caveats: string[];
  confidence: Confidence;
  /**
   * Context the answer is REQUIRED to convey, not merely offered.
   *
   * This field exists because an advisory list gets filtered. Told that caveats were "worth
   * including where they matter", the model dropped Anchorage's freight note — 5.75 billion pounds
   * of cargo against 2.66 million passengers — which is the single most important thing about
   * interpreting that airport's passenger figures.
   *
   * Anything placed here is something the answer is wrong without. The system prompt treats it as
   * mandatory rather than as a suggestion. Structure beats persuasion.
   *
   * Each entry carries a `key` so the same fact spotted by two tools is relayed once, and a
   * `priority` so a cross-cohort warning outranks a metro relationship when several accumulate.
   * The agent checks after the fact whether each one actually reached the answer — see
   * `must-mention.ts`, because asking without checking is still only persuasion.
   */
  mustMention?: MustMention[];
}

export interface ToolSuccess<T> extends ResultEnvelope {
  ok: true;
  data: T;
}

export type ToolErrorCode =
  | "airport_not_found"
  | "ambiguous_query"
  | "no_data_for_airport"
  | "invalid_parameters"
  | "empty_result";

export interface ToolFailure {
  ok: false;
  code: ToolErrorCode;
  /** Written for the model to relay to a user, so it must be plain and specific. */
  message: string;
  /** Concrete next steps — candidate airports, valid parameter values, a narrower filter. */
  suggestions?: string[];
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export function ok<T>(data: T, envelope: ResultEnvelope): ToolSuccess<T> {
  return { ok: true, data, ...envelope };
}

export function fail(
  code: ToolErrorCode,
  message: string,
  suggestions?: string[],
): ToolFailure {
  return { ok: false, code, message, ...(suggestions ? { suggestions } : {}) };
}
