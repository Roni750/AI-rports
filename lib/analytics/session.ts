import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Session ids the server can recognise as its own.
 *
 * `turn_id` is `${sessionId}:${turnIndex}`, and the turn write is an upsert — deliberately, so a
 * retried request updates its row instead of duplicating it. Both halves used to come from the
 * client: the session id was sent in the body, and the turn index was counted from the history the
 * client also sent. That made any recorded turn addressable by anyone who could name its session,
 * and `ON CONFLICT DO UPDATE` then let them rewrite its prompt, cost, outcome and tool trace.
 *
 * The fix keeps the property that made the design attractive. A cookie is still not used — the
 * comment in `app/page.tsx` rejects it to avoid making the endpoint stateful and raising a consent
 * question — so instead the id travels as before and carries an HMAC the server checks. The
 * endpoint stays stateless, `sessionStorage` still scopes a conversation to a tab, and an id the
 * server did not mint is no longer accepted.
 *
 * Verification DEGRADES rather than rejects, matching the rule this file's callers already follow:
 * an unrecognised token earns a fresh session, it does not fail the request. Telemetry that can
 * refuse to answer a question has the priorities backwards.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The signing key.
 *
 * Falls back to a per-process random value when ANALYTICS_SESSION_SECRET is unset, which is the
 * safe direction to fail: sessions minted before a restart stop verifying and are replaced, so
 * conversations started before a deploy are recorded under a new session id. That costs a split
 * conversation in the analytics table. The alternative — a fixed default secret — would mean
 * every deployment shares a forgeable key, which is not a fallback but a backdoor.
 */
const SECRET = process.env.ANALYTICS_SESSION_SECRET ?? randomBytes(32).toString("hex");

function sign(id: string): string {
  return createHmac("sha256", SECRET).update(id).digest("base64url");
}

/** A fresh session id and its signature, in the single string the client stores and echoes back. */
export function mintSessionToken(): string {
  const id = randomUUID();
  return `${id}.${sign(id)}`;
}

/** The session id inside a token this server signed, or null for anything else. */
export function verifySessionToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const dot = raw.indexOf(".");
  if (dot < 0) return null;

  const id = raw.slice(0, dot);
  const supplied = raw.slice(dot + 1);
  if (!UUID_V4.test(id)) return null;

  // Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch.
  const expected = Buffer.from(sign(id));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? id : null;
}
