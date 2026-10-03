// The three writing steps: clarifying questions → plan → storyboard.

import { z } from "zod";
import { narrationBudget, narrationLength, Plan, Question, sceneIssues, type IdeaProject, type Scene } from "../shared/project";
import { TEMPLATE_IDS, type TemplateId } from "../shared/templates";
import { fallbackPlan, fallbackQuestions, fallbackStoryboard } from "./fallbacks";
import { askJson } from "./llm-json";
import type { Provider } from "./minimax";
import { planPrompt, questionsPrompt, storyboardPrompt } from "./prompts";

export interface StepResult<T> {
  value: T;
  usedFallback: boolean;
  attempts: number;
  errors: string[];
}

export async function generateQuestions(provider: Provider, p: IdeaProject): Promise<StepResult<Question[]>> {
  if (!p.idea.text.trim()) throw new Error("Describe the idea first");
  const schema = z.object({ questions: z.array(Question.omit({ id: true }).extend({ id: z.string().optional() })).min(3).max(6) });
  const r = await askJson(provider, questionsPrompt(p), schema, {
    fallback: () => ({ questions: fallbackQuestions(p) }),
    temperature: 0.7,
  });
  const value = r.value.questions.map((q, i) => Question.parse({ ...q, id: `q${i + 1}` }));
  return { value, usedFallback: r.usedFallback, attempts: r.attempts, errors: r.errors };
}

export async function generatePlan(provider: Provider, p: IdeaProject): Promise<StepResult<Plan>> {
  const r = await askJson(provider, planPrompt(p), Plan, { fallback: () => fallbackPlan(p), temperature: 0.6 });
  return { value: r.value, usedFallback: r.usedFallback, attempts: r.attempts, errors: r.errors };
}

const RawScene = z.object({ template: z.enum(TEMPLATE_IDS as [TemplateId, ...TemplateId[]]), narration: z.string().min(2), fields: z.record(z.string(), z.unknown()) });

/** Problems that make a storyboard unusable; sent back to the model for repair. */
export function storyboardIssues(p: IdeaProject, scenes: Scene[]): string[] {
  const issues = scenes.flatMap((s) => sceneIssues(s, p.idea.materials));
  const budget = narrationBudget(p.spec);
  const total = scenes.reduce((n, s) => n + narrationLength(s.narration, p.spec.language), 0);
  if (total > budget.chars * 1.3) issues.push(`narration totals ${total} ${budget.unit}; shorten it to about ${budget.chars}`);
  if (total < budget.chars * 0.55) issues.push(`narration totals only ${total} ${budget.unit}; lengthen it to about ${budget.chars}`);
  if (scenes.length < 3) issues.push("use at least 3 scenes");
  if (scenes.at(-1)?.template !== "cta") issues.push('the last scene must use the "cta" template');
  if (!scenes.some((s) => s.template === "title")) issues.push('include a "title" scene that reveals the product name');
  return issues;
}

export async function generateStoryboard(provider: Provider, p: IdeaProject): Promise<StepResult<Scene[]>> {
  if (!p.plan) throw new Error("Create the plan first");
  const schema = z.object({ scenes: z.array(RawScene).min(3).max(12) });
  const withIds = (raw: z.infer<typeof schema>) => raw.scenes.map((s, i) => ({ ...s, id: `s${i + 1}` }));
  const r = await askJson(provider, storyboardPrompt(p), schema, {
    check: (v) => storyboardIssues(p, withIds(v)),
    fallback: () => ({ scenes: fallbackStoryboard(p) }),
    temperature: 0.8,
  });
  return { value: withIds(r.value), usedFallback: r.usedFallback, attempts: r.attempts, errors: r.errors };
}
