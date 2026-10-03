// IdeaCut project state: everything the workflow produces, saved as ideacut.json after
// every step so a project can be resumed or any step redone.

import { z } from "zod";
import { TEMPLATE_IDS, TEMPLATES, type TemplateId } from "./templates";

export const THEMES = {
  midnight: { label: "午夜蓝", bg: "#0d0d0d", fg: "#f2f2f2", accent: "#17a9f3", accent2: "#7c5cff", gradient: ["#0b1e3a", "#0d0d0d", "#2a1240"] },
  aurora: { label: "极光", bg: "#f4f1f3", fg: "#111111", accent: "#0f8bd6", accent2: "#ff5fa2", gradient: ["#bff4ff", "#f7e690", "#ffbddd"] },
  ember: { label: "暖橙", bg: "#160d08", fg: "#fff4ea", accent: "#ff7a1a", accent2: "#ffc53d", gradient: ["#2a1206", "#160d08", "#3a1d0a"] },
} as const;
export type ThemeId = keyof typeof THEMES;

export const Spec = z.object({
  duration: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(60),
  aspect: z.enum(["16:9", "9:16"]).default("16:9"),
  language: z.enum(["zh", "en"]).default("zh"),
  theme: z.enum(Object.keys(THEMES) as [ThemeId, ...ThemeId[]]).default("midnight"),
  voiceId: z.string().default(""),
  music: z.boolean().default(true),
  captions: z.boolean().default(true),
});
export type Spec = z.infer<typeof Spec>;

export const Material = z.object({
  id: z.string(),
  /** Path inside the project folder, e.g. "materials/shot1.png". */
  path: z.string(),
  name: z.string(),
  note: z.string().default(""),
});
export type Material = z.infer<typeof Material>;

export const Idea = z.object({
  text: z.string().default(""),
  details: z.string().default(""),
  materials: z.array(Material).default([]),
});
export type Idea = z.infer<typeof Idea>;

export const Question = z.object({
  id: z.string(),
  question: z.string().min(4),
  why: z.string().default(""),
  options: z.array(z.string().min(1)).min(2).max(5),
  multi: z.boolean().default(false),
});
export type Question = z.infer<typeof Question>;

export const Answer = z.object({ questionId: z.string(), choices: z.array(z.string()).default([]), note: z.string().default("") });
export type Answer = z.infer<typeof Answer>;

export const Plan = z.object({
  name: z.string().min(1).max(30),
  oneLiner: z.string().min(4).max(60),
  problem: z.string().min(4),
  audience: z.string().min(2),
  solution: z.string().min(4),
  features: z.array(z.string().min(2)).min(3).max(5),
  howItWorks: z.array(z.string().min(2)).length(3),
  differentiation: z.string().min(4),
  businessModel: z.string().min(2),
  traction: z.string().default(""),
  cta: z.string().min(2),
  contact: z.string().default(""),
});
export type Plan = z.infer<typeof Plan>;

export const Scene = z.object({
  id: z.string(),
  template: z.enum(TEMPLATE_IDS as [TemplateId, ...TemplateId[]]),
  narration: z.string().min(2),
  fields: z.record(z.string(), z.unknown()),
});
export type Scene = z.infer<typeof Scene>;

/** Checks a scene's fields against its template; returns readable problems. */
export function sceneIssues(scene: Scene, materials: Material[]): string[] {
  const t = TEMPLATES[scene.template];
  const r = t.fields.safeParse(scene.fields);
  const issues = r.success ? [] : r.error.issues.map((i) => `scene ${scene.id} (${scene.template}) ${i.path.join(".")}: ${i.message}`);
  const image = (scene.fields as { image?: string }).image;
  if (image && !materials.some((m) => m.id === image)) issues.push(`scene ${scene.id}: image "${image}" is not one of the uploaded materials (${materials.map((m) => m.id).join(", ") || "none"})`);
  if (scene.template === "screenshot" && !image) issues.push(`scene ${scene.id}: screenshot needs an image`);
  return issues;
}

export const StepKey = z.enum(["idea", "questions", "plan", "storyboard", "video"]);
export type StepKey = z.infer<typeof StepKey>;

export const ProduceStep = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(["pending", "running", "done", "skipped", "error"]),
  detail: z.string().default(""),
});
export type ProduceStep = z.infer<typeof ProduceStep>;

export const Run = z.object({
  status: z.enum(["idle", "running", "done", "error"]),
  steps: z.array(ProduceStep),
  error: z.string().optional(),
  output: z.string().optional(),
  evercutProject: z.string().optional(),
  previews: z.array(z.string()).default([]),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Hash of the inputs the output was made from (to detect a stale video). */
  inputHash: z.string().optional(),
});
export type Run = z.infer<typeof Run>;

export const IdeaProject = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string(),
  spec: Spec,
  idea: Idea,
  questions: z.array(Question).optional(),
  answers: z.array(Answer).default([]),
  plan: Plan.optional(),
  scenes: z.array(Scene).optional(),
  run: Run.optional(),
  /** Which upstream steps changed after a downstream step was produced. */
  stale: z.array(StepKey).default([]),
  /** Generated without an API key (demo content, placeholder voice). */
  demo: z.boolean().default(false),
});
export type IdeaProject = z.infer<typeof IdeaProject>;

/** Narration budget: roughly how much text fits a duration when spoken. */
export function narrationBudget(spec: Spec): { chars: number; unit: "chars" | "words" } {
  // ~4.2 Chinese characters/s or ~2.4 English words/s, leaving ~10% for pauses.
  return spec.language === "zh" ? { chars: Math.round(spec.duration * 4.2 * 0.9), unit: "chars" } : { chars: Math.round(spec.duration * 2.4 * 0.9), unit: "words" };
}

export function narrationLength(text: string, language: Spec["language"]): number {
  return language === "zh" ? text.replace(/\s+/g, "").length : text.trim().split(/\s+/).filter(Boolean).length;
}
