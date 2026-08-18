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

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface LlmClassification {
  topicId: string;
  confidence: number;
  stage: "llm" | "abstain";
  reason: string | null;
  costUsd: number | null;
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
 */
export async function classifyWithModel(
  prompt: string,
  toolsInvoked: readonly string[],
  apiKey = process.env.GROQ_API_KEY ?? "",
): Promise<LlmClassification> {
  if (!apiKey) {
    return abstain("no GROQ_API_KEY configured");
  }

  const user =
    `Question: ${prompt}\n` +
    `Tools the assistant ran: ${toolsInvoked.length > 0 ? toolsInvoked.join(", ") : "none"}`;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        // Classification should be as close to deterministic as the provider allows. Note that
        // temperature 0 reduces variance without guaranteeing identical outputs, which is exactly
        // why labels are versioned and predictions are frozen for CI rather than recomputed.
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      return abstain(`provider returned ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) return abstain("empty response");

    const cost = costUsd(
      CLASSIFIER_MODEL,
      json.usage?.prompt_tokens ?? null,
      json.usage?.completion_tokens ?? null,
    );

    let parsed: { topic_id?: unknown; confidence?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return abstain("response was not valid JSON", cost);
    }

    const topicId = typeof parsed.topic_id === "string" ? parsed.topic_id : "";
    // A model is perfectly capable of inventing a plausible-looking topic id. Anything outside the
    // declared taxonomy is discarded rather than stored, or the foreign key would reject it later
    // and take the whole batch with it.
    if (!isTopicId(topicId) || !CLASSIFIABLE_TOPIC_IDS.includes(topicId)) {
      return abstain(`returned unknown topic "${String(parsed.topic_id).slice(0, 40)}"`, cost);
    }

    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : null;

    if (confidence < MIN_CONFIDENCE) {
      return {
        topicId: UNCLASSIFIED,
        confidence,
        stage: "abstain",
        reason: reason ?? "below confidence threshold",
        costUsd: cost,
      };
    }

    return { topicId, confidence, stage: "llm", reason, costUsd: cost };
  } catch (err) {
    return abstain(err instanceof Error ? err.message.slice(0, 80) : "request failed");
  }
}

function abstain(reason: string, cost: number | null = null): LlmClassification {
  return { topicId: UNCLASSIFIED, confidence: 0, stage: "abstain", reason, costUsd: cost };
}
