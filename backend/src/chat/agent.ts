// ============================================================
// The brain: one tool-calling loop over an OpenAI-compatible chat endpoint,
// with a model-fallback chain.
//
// Structure ported from the qubits-dealflow assistant's graph.py and the
// SIH_147 port of it (chat_agent.py): a small set of read-only tools, one
// system prompt, and a loop that moves to the next candidate model on a
// capacity error rather than failing the request. Those two both reach for
// LangGraph's create_react_agent; this backend is Express, and the ReAct loop
// it would give us is the twenty lines below — so the port is the loop itself
// rather than a Python sidecar beside a Node server, and the dependency list
// stays where it is. Groq's API is OpenAI-shaped, so plain fetch is enough.
//
// Why fallback at all: Groq's free tier returns 429 for the rest of the minute
// once a model's token budget is spent, and a demo that dies on the second
// question is worse than one that answers slightly slower on a smaller model.
// Non-capacity failures (a 400, a malformed tool schema) are re-raised, since
// retrying those on another model just repeats the same mistake.
// ============================================================

import { systemPrompt } from "./prompt";
import { TOOL_DEFINITIONS, toolRunner } from "./tools";

const BASE_URL = process.env.CHAT_BASE_URL || "https://api.groq.com/openai/v1";
// Groq's free tier meters tokens per minute *per model* (8,000 each), so a
// longer chain is more headroom, not just more redundancy: four models is four
// separate pools. All four support tool calling.
const CANDIDATE_MODELS = (
  process.env.CHAT_MODELS || "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b,openai/gpt-oss-safeguard-20b"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/** Tool rounds allowed per question before we make the model answer with what
 *  it has. Six is enough for "look up the case, read its logs, explain a term"
 *  and short enough that a loop cannot run up a bill. */
const MAX_TOOL_ROUNDS = 6;
const REQUEST_TIMEOUT_MS = 30_000;
/** Cap on one completion. Groq counts prompt + max_tokens against the per-minute
 *  budget up front, so an unbounded request is billed as if it were enormous. */
const MAX_COMPLETION_TOKENS = 1200;
/** Earlier turns sent with a question. Older ones cost tokens and rarely matter. */
const MAX_HISTORY_MESSAGES = 10;
/** How long a request may sleep waiting for a rate limit to clear, in total. */
const MAX_WAIT_MS = 15_000;
const DEFAULT_COOLDOWN_MS = 20_000;

export class AllModelsBusy extends Error {
  constructor(
    message: string,
    /** Seconds until the soonest model is usable again. */
    public retryAfterSec: number,
  ) {
    super(message);
  }
}
export class ChatNotConfigured extends Error {}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface InboundMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Reply {
  answer: string;
  model: string;
  /** Which lookups produced the answer — shown in the widget so a claim can be traced. */
  toolsUsed: string[];
}

class CapacityError extends Error {
  constructor(
    message: string,
    public retryMs?: number,
  ) {
    super(message);
  }
}

/** Models that are rate-limited right now, and until when. Shared across
 *  requests so the next question skips a model we know will refuse instead of
 *  spending a round trip (and an examiner's patience) finding out again. */
const cooldownUntil = new Map<string, number>();

/** Groq says "Please try again in 8.51s" (or "1m2.3s") in the 429 body. */
function retryDelayMs(body: string, header: string | null): number | undefined {
  const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(body);
  if (m) return Math.ceil((Number(m[1] || 0) * 60 + Number(m[2])) * 1000);
  const h = Number(header);
  return Number.isFinite(h) && h > 0 ? h * 1000 : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** gpt-oss emits narrow no-break spaces and non-breaking hyphens, which the
 *  chat font renders as cramped runs ("12 Henit") and which stop words
 *  wrapping. Fold them to ordinary characters, and drop stray ** markers. */
function tidy(text: string): string {
  return text
    .replace(/[\u00a0\u2007\u2009\u200a\u202f]/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/<think>[\s\S]*?<\/think>/gi, "") // qwen reasons inline
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
}

async function complete(model: string, apiKey: string, messages: ChatCompletionMessage[]) {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: MAX_COMPLETION_TOKENS,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout or a dropped connection is the same situation as a 503 from
    // the caller's point of view: this model is not answering, try the next.
    throw new CapacityError(`${model} did not respond (${(err as Error).message})`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = `${res.status} ${body.slice(0, 300)}`;
    if (res.status === 429 || res.status >= 500) {
      throw new CapacityError(`${model}: ${detail}`, retryDelayMs(body, res.headers.get("retry-after")));
    }
    throw new Error(`Assistant model request failed: ${detail}`);
  }

  const data = (await res.json()) as { choices?: { message?: ChatCompletionMessage }[] };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Assistant model returned no message.");
  return message;
}

/** One model's full ReAct loop: answer, or call tools and go round again. */
async function runLoop(
  model: string,
  apiKey: string,
  seed: ChatCompletionMessage[],
  run: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<Reply> {
  const messages = [...seed];
  const toolsUsed: string[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const message = await complete(model, apiKey, messages);
    const calls = message.tool_calls ?? [];

    if (!calls.length || round === MAX_TOOL_ROUNDS) {
      return { answer: tidy(message.content || ""), model, toolsUsed };
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        // Hand the parse failure back as the tool result; the model corrects
        // itself far more reliably than it does from a thrown request.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `{"error":"arguments were not valid JSON"}`,
        });
        continue;
      }
      toolsUsed.push(call.function.name);
      const result = await run(call.function.name, args).catch(
        (err: Error) => `{"error":${JSON.stringify(err.message)}}`,
      );
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Unreachable: the loop returns at round === MAX_TOOL_ROUNDS.
  return { answer: "", model, toolsUsed };
}

export async function answer(opts: {
  messages: InboundMessage[];
  liveContext: unknown;
  userId: number;
  apiKey: string;
}): Promise<Reply> {
  if (!CANDIDATE_MODELS.length) throw new ChatNotConfigured("No assistant models are configured (CHAT_MODELS).");

  const seed: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt(opts.liveContext) },
    ...opts.messages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content })),
  ];
  const run = toolRunner(opts.userId);

  let last: Error | null = null;
  let waited = 0;
  // Two passes: try every model that is not cooling down; if all refused and
  // the soonest one frees up within the wait budget, sleep that long and go
  // round once more. Eight seconds of waiting beats telling the examiner to
  // come back later.
  for (let pass = 0; pass < 2; pass++) {
    const now = Date.now();
    for (const model of CANDIDATE_MODELS) {
      if ((cooldownUntil.get(model) ?? 0) > now) continue;
      try {
        return await runLoop(model, opts.apiKey, seed, run);
      } catch (err) {
        if (!(err instanceof CapacityError)) throw err;
        console.warn(`[chat] ${err.message} - trying the next model`);
        cooldownUntil.set(model, Date.now() + (err.retryMs ?? DEFAULT_COOLDOWN_MS));
        last = err;
      }
    }

    const soonest = Math.min(...CANDIDATE_MODELS.map((m) => cooldownUntil.get(m) ?? 0));
    const wait = Math.max(0, soonest - Date.now()) + 250;
    if (pass === 1 || waited + wait > MAX_WAIT_MS) break;
    console.warn(`[chat] every model is rate-limited; waiting ${Math.round(wait / 1000)}s`);
    waited += wait;
    await sleep(wait);
  }

  const soonest = Math.min(...CANDIDATE_MODELS.map((m) => cooldownUntil.get(m) ?? 0));
  throw new AllModelsBusy(last?.message ?? "every model refused", Math.max(1, Math.ceil((soonest - Date.now()) / 1000)));
}
