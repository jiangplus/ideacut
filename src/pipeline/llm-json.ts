// Structured output from a chat model: ask for JSON, extract it, validate with zod, and on
// failure send the validation errors back for a repair — then fall back if it still fails.

import type { z } from "zod";
import { isFatal, isSlow, withRetry, type ChatMessage, type ChatOptions, type Provider } from "./minimax";

/**
 * Model settings per writing task (thinking, output cap, deadline). Drafting runs with thinking
 * off: variety comes from archetypes and sampling, and M3's thinking is slow and unpredictable.
 * Judging keeps low thinking, where comparing options benefits from it and the output is small.
 */
export const CALLS = {
  questions: { think: "off", maxTokens: 3_000, timeoutMs: 45_000 },
  plan: { think: "off", maxTokens: 3_000, timeoutMs: 45_000 },
  concepts: { think: "off", maxTokens: 4_000, timeoutMs: 60_000 },
  expand: { think: "off", maxTokens: 3_000, timeoutMs: 45_000 },
  judge: { think: "low", maxTokens: 6_000, timeoutMs: 60_000 },
  storyboard: { think: "off", maxTokens: 8_000, timeoutMs: 90_000 },
  "judge-storyboard": { think: "low", maxTokens: 6_000, timeoutMs: 60_000 },
} as const satisfies Record<string, ChatOptions>;
export type CallTask = keyof typeof CALLS;

/** Finds the first complete JSON object or array in model output (handles ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter((x): x is string => !!x);
  for (const c of candidates) {
    const start = c.search(/[{[]/);
    if (start < 0) continue;
    // Walk to the matching bracket, respecting strings.
    const open = c[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("no JSON found in the model's reply");
}

export interface AskResult<T> {
  value: T;
  attempts: number;
  /** True when every attempt failed and `fallback` was used. */
  usedFallback: boolean;
  errors: string[];
}

/**
 * Asks for JSON and validates it. At most one follow-up: a runaway or timed-out call gets a fresh
 * attempt with thinking off; an invalid answer gets one repair turn that carries only the extracted
 * JSON and the specific problems (never the model's reasoning). Then `fallback`.
 * `fix` runs before validation to correct mechanical problems in code (lengths, ordering), so the
 * model is only asked to repair what code can't.
 */
export async function askJson<S extends z.ZodType>(
  provider: Provider,
  messages: ChatMessage[],
  schema: S,
  opts: { task: CallTask; fallback: () => z.infer<S>; check?: (v: z.infer<S>) => string[]; fix?: (raw: unknown) => unknown; temperature?: number; attempts?: number },
): Promise<AskResult<z.infer<S>>> {
  const attempts = opts.attempts ?? 2;
  const call: ChatOptions = { ...CALLS[opts.task], task: opts.task };
  let convo = messages;
  const errors: string[] = [];
  for (let i = 1; i <= attempts; i++) {
    let reply: string;
    try {
      // Rate limits are likely when several calls run in parallel; withRetry backs off on those.
      reply = await withRetry(() => provider.chat(convo, { ...call, temperature: i === 1 ? opts.temperature : 0.3 }), 2);
    } catch (err) {
      // Balance / key / model problems must reach the user, not turn into fallback content.
      if (isFatal(err)) throw err;
      errors.push((err as Error).message);
      if (isSlow(err)) Object.assign(call, { think: "off" });
      convo = messages;
      continue;
    }
    let problems: string[];
    let json: unknown;
    try {
      json = extractJson(reply);
      if (opts.fix) json = opts.fix(json);
      const parsed = schema.safeParse(json);
      if (parsed.success) {
        problems = opts.check?.(parsed.data) ?? [];
        if (problems.length === 0) return { value: parsed.data, attempts: i, usedFallback: false, errors };
      } else {
        problems = parsed.error.issues.slice(0, 12).map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`);
      }
    } catch (err) {
      problems = [(err as Error).message];
    }
    errors.push(problems.join("; "));
    convo = [
      ...messages,
      { role: "assistant", content: json === undefined ? reply.slice(0, 4_000) : JSON.stringify(json) },
      { role: "user", content: `Fix only these problems and reply with the corrected JSON, nothing else:\n- ${problems.join("\n- ")}` },
    ];
  }
  return { value: opts.fallback(), attempts, usedFallback: true, errors };
}
