/**
 * What produced a label.
 *
 * Every assignment in `turn_topic` stores this string, and assignments are never updated in place —
 * a new version writes new rows. That makes two things possible that are otherwise guesswork:
 * comparing two classifiers over identical traffic, and answering "did the label distribution move
 * because users changed or because we did?"
 *
 * The version encodes all three things that can change an answer. Bump the relevant part when you
 * change it, or the comparison above silently stops meaning anything.
 */

import { TAXONOMY_VERSION } from "./taxonomy";

/** Bump when the rule set in `classify-rules.ts` changes in any way that could move a label. */
export const RULES_VERSION = 1;

/**
 * The model used for the fallback stage.
 *
 * Deliberately NOT the model that answers questions. Two reasons: it is a fraction of the price for
 * a task that needs no domain reasoning, and it decouples label stability from the answer path, so
 * swapping the chat model cannot silently move six months of topic history.
 *
 * Verify availability with `npm run models` before changing it. Groq removed the entire Llama 3.x
 * family during this project's lifetime — `llama-3.1-8b-instant`, the obvious choice for this job,
 * no longer resolves — so a model id is an assumption with a shelf life, not a constant.
 */
export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5";

/**
 * Below this, the LLM stage records an abstention instead of a label.
 *
 * An abstention is a useful output: it feeds the dashboard's review queue, which is where the next
 * gold-set examples come from. A low-confidence guess is not useful — it is a wrong label that
 * looks like a right one.
 */
export const MIN_CONFIDENCE = 0.55;

export const ACTIVE_CLASSIFIER_VERSION =
  `rules@${RULES_VERSION}|llm@${CLASSIFIER_MODEL}|tax@${TAXONOMY_VERSION}`;
