import { AgentError, runAgent, type ChatMessage } from "../../../lib/agent/agent";

/**
 * Chat endpoint.
 *
 * Node runtime, not Edge: the data layer uses node:sqlite, which is unavailable on Edge.
 * POST handlers are never cached, so no cache configuration is needed.
 */
export const runtime = "nodejs";

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;

interface ChatRequestBody {
  messages?: unknown;
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

  try {
    const result = await runAgent(parsed, {
      apiKey: process.env.GROQ_API_KEY ?? "",
      signal: request.signal,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof AgentError) {
      return Response.json(
        { error: err.message, hint: err.hint },
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 },
      );
    }
    // Never leak an internal stack trace to the client.
    console.error("[chat] unexpected failure", err);
    return Response.json({ error: "The agent failed unexpectedly." }, { status: 500 });
  }
}
