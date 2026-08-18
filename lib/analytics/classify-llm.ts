import Anthropic from "@anthropic-ai/sdk";

import { CLASSIFIER_MODEL, MIN_CONFIDENCE } from "./classifier-version";
import { costUsd } from "./pricing";
import { CLASSIFIABLE_TOPIC_IDS, isTopicId, TOPICS, UNCLASSIFIED } from "./taxonomy";

/**
 * Stage two of the classifier: the language model, for prompts the rules declined.
 *
 * Runs OFFLINE, from `scripts/classify-turns.ts`, never in the request path. Groq's free tier binds
 * on tokens per minute, and the chat loop already spends that budget on the answer a user is
 * waiting for. A 200-token label must never be the reason a real reply gets a 429. Re-classifying
 * history under a new taxonomy needs a batch path regardless, so building batch-first means one
 * code path instead of two.
 *
 * Called over plain fetch against Groq's OpenAI-compatible endpoint, matching `lib/agent/agent.ts`
 * rather than introducing an SDK for one request shape.
 *
 * ONE PROMPT PER CALL, deliberately. Batching ten prompts into a single request would cut token
 * use roughly tenfold, and was rejected: one malformed response loses ten labels instead of one,
 * and a model that returns nine array entries for ten inputs misaligns every label after the gap —
 * a silent corruption that looks like a working classifier. Single calls are individually
 * retryable and idempotent. The cost is real and priced: see the eval's `costUsdPer1000`.
 */


export interface LlmClassification {
  topicId: string;
  confidence: number;
  stage: "llm" | "abstain";
  reason: string | null;
  costUsd: number | null;
  /**
   * True when the call never produced a judgement — no key, a 429, a transport error.
   *
   * An abstention and a failed request are both `stage: "abstain"`, and conflating them was
   * expensive in both directions. Persisted, a rate-limited batch writes permanent abstentions for
   * turns the model never actually saw; and because the batch selector re-reads abstentions, every
   * later run pays for them again. A retryable result is meant to be dropped rather than stored:
   * the turn stays unlabelled and the next run picks it up.
   */
  retryable: boolean;
}

/** Built once. The definitions are the contract the gold set is also labelled against. */
function taxonomyBlock(): string {
  return TOPICS.filter((t) => t.id !== UNCLASSIFIED)
    .map((t) => `- ${t.id}: ${t.definition}`)
    .join("\n");
}

const SYSTEM_PROMPT = `You classify user questions to an airport investment analysis assistant into exactly one topic.

Topics:
${taxonomyBlock()}

Reply with JSON only: {"topic_id": "<one id from the list>", "confidence": <0 to 1>, "reason": "<at most 12 words>"}

Rules:
- Classify what the USER ASKED, not what the assistant did in response.
- If the question is about money, financing, land, zoning or politics, it is scope_boundary.
- If it is not about airports at all, it is off_domain.
- Prefer the specific subject (cargo, congestion, growth, traffic mix) over the general shape of the request.
- If genuinely unsure, give a low confidence rather than inventing certainty.`;

/**
 * Classify one prompt.
 *
 * Never throws: a classifier failure must not abort a batch that has already spent real tokens on
 * earlier items. Failures come back as abstentions, which is the same state a low-confidence
 * answer produces, and which the review queue already surfaces.
 *
 * They are marked `retryable`, though, and the distinction matters to the caller. A model that
 * looked at a prompt and declined it is a finding worth storing; a request that never reached the
 * model is not, and storing it as an abstention makes the turn look permanently unclassifiable.
 */
export async function classifyWithModel(
  prompt: string,
  toolsInvoked: readonly string[],
  apiKey = process.env.ANTHROPIC_API_KEY ?? "",
): Promise<LlmClassification> {
  if (!apiKey) {
    return failed("no ANTHROPIC_API_KEY configured");
  }

  const user =
    `Question: ${prompt}\n` +
    `Tools the assistant ran: ${toolsInvoked.length > 0 ? toolsInvoked.join(", ") : "none"}`;

  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptOnce(user, apiKey);
    // A 429 is the one failure worth waiting out in place: the token window resets in tens of
    // seconds, and giving up leaves the turn to be re-selected and re-paid for on a later run.
    if (outcome.rateLimited && attempt < MAX_RETRIES) {
      await sleep(backoffMs(outcome.retryAfterSeconds, attempt));
      continue;
    }
    return outcome.classification;
  }
}

/** Bounded: a batch that stalls forever against a throttled key is worse than a short run. */
const MAX_RETRIES = 3;

/**
 * How long one classification may take before it is abandoned.
 *
 * Node's `fetch` has no default timeout. A connection that opens and never responds would hang the
 * whole batch with no diagnostic — the run just stops printing, having already spent tokens on
 * every item before it.
 */
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Honour the provider's own reset hint when it sends one, but never wait less than the backoff. */
function backoffMs(retryAfterSeconds: number | null, attempt: number): number {
  const backoff = Math.min(2 ** attempt * 1000, 8000);
  const hinted = retryAfterSeconds === null ? 0 : retryAfterSeconds * 1000;
  return Math.min(Math.max(hinted, backoff), 30_000);
}

interface Attempt {
  classification: LlmClassification;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
}

/** One request. Separated from the retry loop so the loop has nothing to do but decide to wait. */
async function attemptOnce(user: string, apiKey: string): Promise<Attempt> {
  const settled = (classification: LlmClassification): Attempt => ({
    classification,
    rateLimited: false,
    retryAfterSeconds: null,
  });

  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(
        {
          model: CLASSIFIER_MODEL,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: user }],
          /*
           * No `temperature` — sampling parameters are rejected on current models. Determinism was
           * never guaranteed by temperature 0 anyway, which is exactly why labels are versioned and
           * predictions are frozen for CI rather than recomputed.
           *
           * Thinking is off and effort is low: this is a single-label classification with no tools,
           * so the failure mode that makes disabling thinking risky for the agent (a tool call
           * emitted as plain text) cannot arise here, and the batch stays fast and cheap.
           */
          max_tokens: 1000,
          thinking: { type: "disabled" },
          output_config: { effort: "low" },
        },
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
    } catch (err) {
      // The provider decided nothing here, so this is not an abstention to record. Surface a 429
      // separately: it is the one status the retry loop above can actually do something about.
      const status = err instanceof Anthropic.APIError ? (err.status ?? 0) : 0;
      const hint = Number(
        err instanceof Anthropic.APIError ? (err.headers?.get?.("retry-after") ?? NaN) : NaN,
      );
      return {
        classification: failed(`provider returned ${status || "a transport error"}`),
        rateLimited: status === 429,
        retryAfterSeconds: Number.isFinite(hint) ? hint : null,
      };
    }

    const cost = costUsd(
      CLASSIFIER_MODEL,
      message.usage.input_tokens ?? null,
      message.usage.output_tokens ?? null,
    );

    const content = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // A 200 with no content is a provider defect, not a judgement about the prompt.
    if (!content) return settled(failed("empty response"));

    let parsed: { topic_id?: unknown; confidence?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return settled(abstain("response was not valid JSON", cost));
    }

    const topicId = typeof parsed.topic_id === "string" ? parsed.topic_id : "";
    // A model is perfectly capable of inventing a plausible-looking topic id. Anything outside the
    // declared taxonomy is discarded rather than stored, or the foreign key would reject it later
    // and take the whole batch with it.
    if (!isTopicId(topicId) || !CLASSIFIABLE_TOPIC_IDS.includes(topicId)) {
      return settled(abstain(`returned unknown topic "${String(parsed.topic_id).slice(0, 40)}"`, cost));
    }

    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : null;

    if (confidence < MIN_CONFIDENCE) {
      // A real abstention: the model answered and was not sure enough. Worth storing, and worth
      // NOT asking again — the same prompt and the same model will reach the same place.
      return settled({
        topicId: UNCLASSIFIED,
        confidence,
        stage: "abstain",
        reason: reason ?? "below confidence threshold",
        costUsd: cost,
        retryable: false,
      });
    }

    return settled({ topicId, confidence, stage: "llm", reason, costUsd: cost, retryable: false });
  } catch (err) {
    // Includes the timeout above, which arrives as an AbortError. Nothing was learned, so nothing
    // is recorded.
    return settled(failed(err instanceof Error ? err.message.slice(0, 80) : "request failed"));
  }
}

/** The model looked and declined. A result, and one the review queue is built to surface. */
function abstain(reason: string, cost: number | null = null): LlmClassification {
  return {
    topicId: UNCLASSIFIED,
    confidence: 0,
    stage: "abstain",
    reason,
    costUsd: cost,
    retryable: false,
  };
}

/** The call did not happen. Shaped like an abstention so nothing downstream has to branch on it. */
function failed(reason: string): LlmClassification {
  return {
    topicId: UNCLASSIFIED,
    confidence: 0,
    stage: "abstain",
    reason,
    costUsd: null,
    retryable: true,
  };
}
