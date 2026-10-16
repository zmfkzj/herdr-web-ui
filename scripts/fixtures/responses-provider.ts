/**
 * A model for tests: a loopback server speaking the OpenAI Responses streaming API, the part of it
 * pi-ai's `openai-responses` client reads. It answers a scripted user prompt with its tool calls,
 * one per request, and then with a final text. Each call carries its own `call_id` and item `id`,
 * so pi itself builds the tool call id it stores (`${call_id}|${id}`, pi-ai's
 * openai-responses-shared), as it does for OpenAI, Codex or Copilot. Only `key` is accepted, and
 * nothing leaves the PC: no real model, account or credential is involved.
 */

export interface ScriptedCall {
  /** the Responses `call_id` */
  callId: string;
  /** the Responses function-call item `id` */
  itemId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedTurn {
  calls: ScriptedCall[];
  /** the text answered once every call has its output */
  done: string;
}

export interface ProviderRequest {
  path: string;
  authorized: boolean;
  /** the scripted prompt the request answers, or null */
  prompt: string | null;
  /** the outputs of that prompt's calls the request carried */
  outputs: number;
}

type Item = { type?: unknown; role?: unknown; content?: unknown };

/** The text of a Responses input item (a user message's `input_text` parts, or its plain content). */
function itemText(item: Item): string {
  if (typeof item.content === "string") return item.content;
  return Array.isArray(item.content) ? item.content.map((part) => typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "").join("") : "";
}

const sse = (events: Record<string, unknown>[]) => new Response(
  events.map((event, index) => `event: ${String(event["type"])}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
);

function answer(id: string, turn: ScriptedTurn, outputs: number): Response {
  const response = { id, object: "response", status: "in_progress", output: [] as unknown[] };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const call = turn.calls[outputs];
  if (call) {
    const args = JSON.stringify(call.arguments);
    const item = { type: "function_call", id: call.itemId, call_id: call.callId, name: call.name, arguments: args, status: "completed" };
    return sse([
      { type: "response.created", response },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.itemId, delta: args },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: call.itemId, arguments: args },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { ...response, status: "completed", output: [item], usage } },
    ]);
  }
  const message = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: turn.done, annotations: [] }] };
  return sse([
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: message.id, content_index: 0, delta: turn.done },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { ...response, status: "completed", output: [message], usage } },
  ]);
}

/** Starts the model on a loopback port; `url` is the provider's `baseUrl` for pi's models.json. */
export function responsesProvider(script: Record<string, ScriptedTurn>, key: string) {
  const requests: ProviderRequest[] = [];
  let served = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const authorized = request.headers.get("authorization") === `Bearer ${key}`;
      if (request.method !== "POST" || !path.endsWith("/responses")) {
        requests.push({ path, authorized, prompt: null, outputs: 0 });
        return Response.json({ error: { message: "not served" } }, { status: 404 });
      }
      const body = await request.json() as { input?: Item[] };
      const input = Array.isArray(body.input) ? body.input : [];
      // the newest user message naming a scripted prompt (pi may add user messages of its own, an
      // image a tool read, after it), then the call outputs that came since
      let at = -1, prompt: string | null = null;
      for (let i = input.length - 1; i >= 0 && prompt === null; i--) {
        const item = input[i]!;
        if (item.role !== "user") continue;
        const text = itemText(item);
        prompt = Object.keys(script).find((name) => text.includes(name)) ?? null;
        at = i;
      }
      const outputs = prompt === null ? 0 : input.slice(at + 1).filter((item) => item.type === "function_call_output").length;
      requests.push({ path, authorized, prompt, outputs });
      if (!authorized) return Response.json({ error: { message: "unknown key" } }, { status: 401 });
      if (prompt === null) return Response.json({ error: { message: "no scripted prompt in this request" } }, { status: 400 });
      return answer(`resp_fixture_${++served}`, script[prompt]!, outputs);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
