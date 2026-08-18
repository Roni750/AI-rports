import { after } from "next/server";

import {
  AgentError,
  DEFAULT_MODEL,
  runAgent,
  type ChatMessage,
} from "../../../lib/agent/agent";
import { recordTurn } from "../../../lib/analytics/record";
import { mintSessionToken, verifySessionToken } from "../../../lib/analytics/session";
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
 * Validation therefore DEGRADES rather than rejects: an unrecognised token earns a fresh session,
 * it does not fail the request. Refusing to answer a question because its telemetry label was
 * malformed would invert the priority between the product and the measurement of it.
 *
 * It is a SIGNED token rather than a bare UUID because `turn_id` is derived from it and the turn
 * write is an upsert — accepting any well-formed id let a caller name, and therefore rewrite,
 * another conversation's recorded turn. See `lib/analytics/session.ts`.
 */
function sessionFrom(raw: unknown): { id: string; token: string } {
  const verified = verifySessionToken(raw);
  if (verified !== null) return { id: verified, token: raw as string };

  const token = mintSessionToken();
  return { id: verifySessionToken(token)!, token };
}

/**
 * Coarse failure category from the error, not its message.
 *
 * A message is prose that changes when someone rewords it; a category is a dimension that still
 * groups correctly six months later.
 */
function errorKindOf(err: unknown, signal: AbortSignal): ErrorKind {
  // Checked first, and before the AgentError branch. A client that closes the tab mid-answer
  // aborts `request.signal`, the in-flight fetch rejects with an AbortError, and every one of
  // those used to be recorded as "unexpected" — so the reliability panel counted abandoned
  // requests as failures of the agent. A cancellation is a fact about the user, not the system.
  if (signal.aborted || (err instanceof Error && err.name === "AbortError")) return "cancelled";
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

  const session = sessionFrom(body.sessionId);
  const sessionId = session.id;
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

  /*
   * Streamed as newline-delimited JSON rather than returned whole.
   *
   * NDJSON rather than SSE: the client is a `fetch` reader, not an EventSource, so the extra
   * framing would buy nothing. One JSON object per line, parsed as lines arrive.
   *
   * The trade this makes: the HTTP status is committed the moment the first byte goes out, so a
   * failure partway through a turn can no longer be a 500. It arrives as an `error` event instead,
   * and the client renders it in place of the answer.
   */
  const encoder = new TextEncoder();
  let settled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const result = await runAgent(parsed, {
          apiKey: process.env.ANTHROPIC_API_KEY ?? "",
          signal: request.signal,
          onEvent: (event) => {
            // `done` is sent below with the session token attached, so it is not forwarded here.
            if (event.type !== "done") send(event);
          },
        });

        send({ type: "done", result, sessionId: session.token });
        settled = true;

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
            // An explicit projection, not a spread minus one key. Chart payloads are orders of
            // magnitude larger than the rest of a trace row and nothing queries them, and stating
            // the columns here means a field added to the trace later cannot leak into analytics
            // silently.
            toolTrace: result.trace.map((t) => ({
              name: t.name,
              arguments: t.arguments,
              ok: t.ok,
              ...(t.errorCode ? { errorCode: t.errorCode } : {}),
              durationMs: t.durationMs,
            })),
          }),
        );
      } catch (err) {
        const kind = errorKindOf(err, request.signal);
        send({
          type: "error",
          error: err instanceof AgentError ? err.message : "Something went wrong.",
          hint: err instanceof AgentError ? err.hint : undefined,
          kind,
        });
        settled = true;

        // Failures are recorded too. An analytics table containing only successes would report a
        // perfect system and hide the exact turns worth investigating.
        after(() =>
          recordTurn({
            ...baseRecord,
            replyChars: 0,
            model: DEFAULT_MODEL,
            iterations: 0,
            modelCalls: 0,
            promptTokens: null,
            completionTokens: null,
            modelMs: 0,
            totalMs: Date.now() - startedAt,
            outcome: "error",
            errorKind: kind,
            toolTrace: [],
          }),
        );
      } finally {
        if (!settled) send({ type: "error", error: "The turn ended unexpectedly.", kind: "unexpected" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Proxies that buffer a response would defeat the point of streaming it.
      "X-Accel-Buffering": "no",
    },
  });
}
