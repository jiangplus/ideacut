// Structured output from a chat model: ask for JSON, extract it, validate with zod, and on
// failure send the validation errors back for a repair — then fall back if it still fails.

import type { z } from "zod";
import { isFatal, type ChatMessage, type Provider } from "./minimax";

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

export async function askJson<S extends z.ZodType>(
  provider: Provider,
  messages: ChatMessage[],
  schema: S,
  opts: { attempts?: number; fallback: () => z.infer<S>; check?: (v: z.infer<S>) => string[]; temperature?: number },
): Promise<AskResult<z.infer<S>>> {
  const attempts = opts.attempts ?? 3;
  const convo = [...messages];
  const errors: string[] = [];
  for (let i = 1; i <= attempts; i++) {
    let reply: string;
    try {
      reply = await provider.chat(convo, { temperature: i === 1 ? opts.temperature : 0.3 });
    } catch (err) {
      // Balance / key / model problems must reach the user, not turn into fallback content.
      if (isFatal(err)) throw err;
      errors.push((err as Error).message);
      continue;
    }
    let problems: string[];
    try {
      const parsed = schema.safeParse(extractJson(reply));
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
    convo.push({ role: "assistant", content: reply });
    convo.push({ role: "user", content: `That JSON is not valid:\n- ${problems.join("\n- ")}\nReply with the corrected JSON only.` });
  }
  return { value: opts.fallback(), attempts, usedFallback: true, errors };
}
