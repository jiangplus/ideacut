// The writing steps: clarifying questions → plan → (story concepts, see story.ts) → storyboard.

import { z } from "zod";
import { chosenConcept, narrationBudget, narrationLength, PlanDraft, Question, QuestionDraft, sceneIssues, type IdeaProject, type Plan, type Scene } from "../shared/project";
import { TEMPLATE_IDS, TEMPLATES, type TemplateId } from "../shared/templates";
import { fallbackPlan, fallbackQuestions, fallbackStoryboard } from "./fallbacks";
import { gather } from "./gather";
import { askJson } from "./llm-json";
import type { Provider } from "./minimax";
import { judgeStoryboardsPrompt, planPrompt, questionsPrompt, storyboardPrompt } from "./prompts";

export interface StepResult<T> {
  value: T;
  usedFallback: boolean;
  attempts: number;
  errors: string[];
}

export async function generateQuestions(provider: Provider, p: IdeaProject): Promise<StepResult<Question[]>> {
  if (!p.idea.text.trim()) throw new Error("Describe the idea first");
  const schema = z.object({ questions: z.array(QuestionDraft.omit({ id: true }).extend({ id: z.string().optional() })).min(3).max(6) });
  const r = await askJson(provider, questionsPrompt(p), schema, {
    task: "questions",
    fallback: () => ({ questions: fallbackQuestions(p) }),
    temperature: 0.7,
  });
  const value = r.value.questions.map((q, i) => Question.parse({ ...q, id: `q${i + 1}` }));
  return { value, usedFallback: r.usedFallback, attempts: r.attempts, errors: r.errors };
}

export async function generatePlan(provider: Provider, p: IdeaProject): Promise<StepResult<Plan>> {
  const r = await askJson(provider, planPrompt(p), PlanDraft, { task: "plan", fallback: () => fallbackPlan(p), temperature: 0.6 });
  return { value: r.value, usedFallback: r.usedFallback, attempts: r.attempts, errors: r.errors };
}

const RawScene = z.object({ template: z.enum(TEMPLATE_IDS as [TemplateId, ...TemplateId[]]), narration: z.string().min(2), fields: z.record(z.string(), z.unknown()) });

/**
 * Fixes mechanical problems in a drafted storyboard in code, so the model is only asked to repair
 * what code can't (story, facts, narration length): over-long on-screen text is cut at punctuation,
 * over-long lists are shortened, unknown images dropped, the CTA moved last (or added) and a title
 * scene inserted at the turn if missing.
 */
export function fixStoryboard(p: IdeaProject, raw: unknown): unknown {
  const scenes = (raw as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return raw;
  const plan = p.plan!;
  const images = new Set(p.idea.materials.map((m) => m.id));
  let out = scenes.map((s) => {
    const scene = s as { template?: string; narration?: unknown; fields?: Record<string, unknown> };
    const t = TEMPLATES[scene.template as TemplateId];
    if (!t || typeof scene.fields !== "object" || !scene.fields) return scene;
    const fields = structuredClone(scene.fields);
    if (typeof fields.image === "string" && !images.has(fields.image)) delete fields.image;
    for (let pass = 0; pass < 3; pass++) {
      const r = t.fields.safeParse(fields);
      if (r.success) break;
      for (const issue of r.error.issues) {
        if (issue.code !== "too_big") continue;
        const parent = issue.path.slice(0, -1).reduce<any>((o, k) => o?.[k as never], fields);
        const key = issue.path.at(-1) as never;
        const v = parent?.[key];
        const max = Number((issue as { maximum?: number | bigint }).maximum);
        if (typeof v === "string") parent[key] = cutText(v, max);
        else if (Array.isArray(v)) parent[key] = v.slice(0, max);
      }
    }
    return { ...scene, fields };
  });
  const isCta = (s: { template?: string }) => s.template === "cta";
  const cta = out.find(isCta) ?? { template: "cta", narration: `${plan.name}，${plan.cta}`, fields: { name: cutText(plan.name, 24), action: cutText(plan.cta, 40) } };
  out = [...out.filter((s) => !isCta(s)), cta];
  if (!out.some((s) => s.template === "title")) {
    const title = { template: "title", narration: p.spec.language === "zh" ? `${plan.name}，${plan.oneLiner}` : `${plan.name}: ${plan.oneLiner}`, fields: { name: cutText(plan.name, 24), tagline: cutText(plan.oneLiner, 40) } };
    // At the turn: before the first scene that shows the product, else about a third in.
    const turn = out.findIndex((s, i) => i > 0 && ["solution", "screenshot", "features", "steps"].includes(String(s.template)));
    out.splice(turn > 0 ? turn : Math.max(1, Math.floor(out.length / 3)), 0, title);
  }
  return { ...(raw as object), scenes: out };
}

/** Shortens text to `max` UTF-16 units, at punctuation when there is a good cut. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = [...text];
  let head = "";
  for (const c of chars) {
    if (head.length + c.length > max) break;
    head += c;
  }
  const cut = Math.max(...["，", "。", "！", "？", "、", "；", "·", ",", ".", "!", "?", ";", " "].map((x) => head.lastIndexOf(x)));
  // No dangling separators ("10:47 ·", "首先，").
  return (cut >= max * 0.5 ? head.slice(0, cut) : head).replace(/[\s·、，,;；:：—-]+$/u, "");
}

/** Text fields that should add to the voice-over rather than echo it (hook, title and quotes may echo). */
const ECHO_FIELDS = ["line", "caption", "body", "heading"];

/** On-screen text that just repeats the narration. */
export function echoIssues(scene: Scene, language: "zh" | "en"): string[] {
  if (["hook", "title", "cta", "quote"].includes(scene.template)) return [];
  const norm = (t: string) => t.toLowerCase().replace(/[\s\p{P}]/gu, "");
  const voice = norm(scene.narration);
  const max = language === "zh" ? 14 : 8;
  return ECHO_FIELDS.flatMap((k) => {
    const v = (scene.fields as Record<string, unknown>)[k];
    if (typeof v !== "string") return [];
    const text = norm(v);
    const echoes = text.length >= 6 && (voice.includes(text) || text.includes(voice) || overlap(text, voice) > 0.7);
    return echoes ? [`scene ${scene.id} ${k}: "${v}" repeats the narration; replace it with a short line (under ${max} ${language === "zh" ? "characters" : "words"}) that adds what the voice does not say`] : [];
  });
}

/** Share of `a`'s character bigrams that also appear in `b`. */
function overlap(a: string, b: string): number {
  const grams = (t: string) => new Set([...t].slice(0, -1).map((c, i) => c + [...t][i + 1]));
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

/** Problems that make a storyboard unusable; sent back to the model for repair. */
export function storyboardIssues(p: IdeaProject, scenes: Scene[]): string[] {
  const issues = scenes.flatMap((s) => sceneIssues(s, p.idea.materials));
  const budget = narrationBudget(p.spec);
  const total = scenes.reduce((n, s) => n + narrationLength(s.narration, p.spec.language), 0);
  if (total > budget.chars * 1.3) issues.push(`narration totals ${total} ${budget.unit}; shorten it to about ${budget.chars}`);
  if (total < budget.chars * 0.55) issues.push(`narration totals only ${total} ${budget.unit}; lengthen it to about ${budget.chars}`);
  if (scenes.length < 3) issues.push("use at least 3 scenes");
  if (scenes.at(-1)?.template !== "cta") issues.push('the last scene must use the "cta" template');
  issues.push(...scenes.flatMap((s) => echoIssues(s, p.spec.language)));
  if (!scenes.some((s) => s.template === "title")) issues.push('include a "title" scene that reveals the product name');
  return issues;
}

const DRAFTS = 3;

export interface StoryboardResult extends StepResult<Scene[]> {
  /** How many valid drafts were compared, and why the winner won. */
  drafts: number;
  reason: string;
}

/** Writes several drafts of the chosen story in parallel and keeps the one the judge prefers. */
export async function generateStoryboard(provider: Provider, p: IdeaProject): Promise<StoryboardResult> {
  if (!p.plan) throw new Error("Create the plan first");
  const schema = z.object({ scenes: z.array(RawScene).min(3).max(12) });
  const withIds = (raw: z.infer<typeof schema>) => raw.scenes.map((s, i) => ({ ...s, id: `s${i + 1}` }));
  const messages = storyboardPrompt(p, chosenConcept(p));
  // The first good draft starts a short grace period for the others.
  const results = (
    await gather(
      Array.from({ length: provider.demo ? 1 : DRAFTS }, () =>
        askJson(provider, messages, schema, {
          task: "storyboard",
          fix: (raw) => fixStoryboard(p, raw),
          check: (v) => storyboardIssues(p, withIds(v)),
          fallback: () => ({ scenes: fallbackStoryboard(p) }),
          temperature: 0.9,
        }),
      ),
      { ok: (r) => !r.usedFallback, quorum: 1, graceMs: 30_000 },
    )
  ).filter((r): r is NonNullable<typeof r> => !!r);
  const good = results.filter((r) => !r.usedFallback);
  const attempts = results.reduce((n, r) => n + r.attempts, 0);
  const errors = results.flatMap((r) => r.errors);
  if (!good.length) return { value: withIds(results[0]!.value), usedFallback: true, attempts, errors, drafts: 0, reason: "" };
  const drafts = good.map((r) => withIds(r.value));
  const pick = drafts.length > 1 ? await pickStoryboard(provider, p, drafts) : { index: 0, reason: "" };
  return { value: drafts[pick.index]!, usedFallback: false, attempts, errors, drafts: drafts.length, reason: pick.reason };
}

const StoryboardScores = z.object({
  scores: z.array(z.object({ draft: z.coerce.number().int(), story: z.coerce.number(), hook: z.coerce.number(), clarity: z.coerce.number(), show: z.coerce.number(), ending: z.coerce.number(), voice: z.coerce.number(), reason: z.string().default("") })),
});

/** The judge's favourite draft; story counts double. Falls back to the first draft. */
async function pickStoryboard(provider: Provider, p: IdeaProject, drafts: Scene[][]): Promise<{ index: number; reason: string }> {
  const r = await askJson(provider, judgeStoryboardsPrompt(p, drafts), StoryboardScores, {
    task: "judge-storyboard",
    check: (v) => (v.scores.length < drafts.length ? [`score all ${drafts.length} drafts`] : []),
    fallback: () => ({ scores: [] }),
    temperature: 0.2,
  });
  let best = { index: 0, total: -1, reason: "" };
  for (const s of r.value.scores) {
    const total = s.story * 2 + s.hook + s.clarity + s.show + s.ending + s.voice;
    const index = s.draft - 1;
    if (index >= 0 && index < drafts.length && total > best.total) best = { index, total, reason: s.reason };
  }
  return { index: best.index, reason: best.reason };
}
