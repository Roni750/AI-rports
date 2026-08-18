import { randomUUID } from "node:crypto";
import { after } from "next/server";

import {
  AgentError,
  DEFAULT_MODEL,
  runAgent,
  type ChatMessage,
} from "../../../lib/agent/agent";
import { recordTurn } from "../../../lib/analytics/record";
import { APP_VERSION, DEFAULT_TENANT } from "../../../lib/analytics/config";
import type { ErrorKind } from "../../../lib/analytics/types";

/**
 * Chat endpoint.
 *
 * Node runtime, not Edge: the data layer uses node:sqlite, which is unavailable on Edge.
 * POST handlers are never cached, so no cache configuration is needed.
 *
 * Analytics is recorded through `after()`, which Next runs once the response has been flushed. The
 * write therefore costs the user nothing, and — per Next's own documentation — still runs when the
 * request errored, which matters because failed turns are the most interesting rows in the table.
 */
export const runtime = "nodejs";

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;

/**
 * A session id identifies a conversation for analytics and nothing else.
 *
 * Validation therefore DEGRADES rather than rejects: a malformed id earns a fresh one, it does not
 * fail the request. Refusing to answer a question because its telemetry label was malformed would
 * invert the priority between the product and the measurement of it.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionIdFrom(raw: unknown): string {
  return typeof raw === "string" && UUID_V4.test(raw) ? raw : randomUUID();
}

/**
 * Coarse failure category from the error, not its message.
 *
 * A message is prose that changes when someone rewords it; a category is a dimension that still
 * groups correctly six months later.
 */
function errorKindOf(err: unknown): ErrorKind {
  if (!(err instanceof AgentError)) return "unexpected";
  if (err.status === 429) return "rate_limit";
  if (err.status === 401) return "auth";
  return "upstream";
}

interface ChatRequestBody {
  messages?: unknown;
  sessionId?: unknown;
}

function parseMessages(raw: unknown): ChatMessage[] | string {
  if (!Array.isArray(raw)) return "Body must contain a 'messages' array.";
  if (raw.length === 0) return "'messages' cannot be empty.";
  if (raw.length > MAX_MESSAGES) return `Conversation is limited to ${MAX_MESSAGES} messages.`;

  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return "Each message must be an object.";
    const { role, content } = m as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") {
      return "Each message role must be 'user' or 'assistant'.";
    }
    if (typeof content !== "string" || content.trim() === "") {
      return "Each message needs non-empty string content.";
    }
    if (content.length > MAX_CHARS) {
      return `Messages are limited to ${MAX_CHARS} characters.`;
    }
    out.push({ role, content });
  }
  if (out[out.length - 1].role !== "user") {
    return "The last message must be from the user.";
  }
  return out;
}

export async function POST(request: Request) {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Request body was not valid JSON." }, { status: 400 });
  }

  const parsed = parseMessages(body.messages);
  if (typeof parsed === "string") {
    return Response.json({ error: parsed }, { status: 400 });
  }

  const sessionId = sessionIdFrom(body.sessionId);
  // Derived, not sent. The client already posts the whole history, so the server can count the
  // turn itself — one less value a client could lie about, and it is what makes `turn_id`
  // deterministic and therefore the write idempotent.
  const turnIndex = parsed.filter((m) => m.role === "user").length - 1;
  const prompt = parsed[parsed.length - 1].content;
  const startedAt = Date.now();
  const createdAt = new Date().toISOString();

  /** Everything the two paths below share, so neither can drift from the other. */
  const baseRecord = {
    sessionId,
    tenantId: DEFAULT_TENANT,
    origin: "live" as const,
    turnIndex,
    createdAt,
    appVersion: APP_VERSION,
    prompt,
    historyTurns: turnIndex,
  };

  try {
    const result = await runAgent(parsed, {
      apiKey: process.env.GROQ_API_KEY ?? "",
      signal: request.signal,
    });

    const response = Response.json({ ...result, sessionId });

    after(() =>
      recordTurn({
        ...baseRecord,
        replyChars: result.reply.length,
        model: result.model,
        iterations: result.iterations,
        modelCalls: result.timing.modelMs.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        modelMs: result.timing.totalModelMs,
        totalMs: Date.now() - startedAt,
        outcome: result.truncated ? "truncated" : "answered",
        errorKind: null,
        toolTrace: result.trace,
      }),
    );

    return response;
  } catch (err) {
    // Failures are recorded too. An analytics table containing only successes would report a
    // perfect system and hide the exact turns worth investigating.
    after(() =>
      recordTurn({
        ...baseRecord,
        replyChars: 0,
        // DEFAULT_MODEL, not the env var: GROQ_MODEL is an optional override and is normally
        // unset, so reading it directly recorded every failed turn as "unknown" — losing the
        // attribution on exactly the rows where "which model failed?" is the question.
        model: DEFAULT_MODEL,
        iterations: 0,
        modelCalls: 0,
        promptTokens: null,
        completionTokens: null,
        modelMs: 0,
        totalMs: Date.now() - startedAt,
        outcome: "error",
        errorKind: errorKindOf(err),
        toolTrace: [],
      }),
    );

    if (err instanceof AgentError) {
      return Response.json(
        { error: err.message, hint: err.hint, sessionId },
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 },
      );
    }
    // Never leak an internal stack trace to the client.
    console.error("[chat] unexpected failure", err);
    return Response.json(
      { error: "The agent failed unexpectedly.", sessionId },
      { status: 500 },
    );
  }
}
