// Scene templates: a shared header + one body per template, joined into a single TSX module
// that EverCut compiles (allowed imports there: react, zod, @evercut/motion).
import type { TemplateId } from "../shared/templates";
import common from "./common.mgx?raw";
import hook from "./hook.mgx?raw";
import title from "./title.mgx?raw";
import problem from "./problem.mgx?raw";
import solution from "./solution.mgx?raw";
import features from "./features.mgx?raw";
import steps from "./steps.mgx?raw";
import screenshot from "./screenshot.mgx?raw";
import stats from "./stats.mgx?raw";
import compare from "./compare.mgx?raw";
import cta from "./cta.mgx?raw";

const bodies: Record<TemplateId, string> = { hook, title, problem, solution, features, steps, screenshot, stats, compare, cta };

export function templateSource(id: TemplateId): string {
  return `${common}\n\n// ---- ${id} ----\n${bodies[id]}`;
}
