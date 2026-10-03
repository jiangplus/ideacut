// Story directions in two stages. Stage 1 drafts one compact concept (title, hook, logline) per
// narrative archetype, 20 in all, in parallel batches; a judge scores them. Stage 2 expands only
// the winner — or whichever one the user picks — into beats the storyboard follows.

import { z } from "zod";
import { ConceptExpansion, ConceptSeed, type Concept, type IdeaProject } from "../shared/project";
import { ARCHETYPES, RUBRIC, type Archetype } from "../shared/archetypes";
import { fallbackConcepts, fallbackExpansion } from "./fallbacks";
import { gather } from "./gather";
import { askJson } from "./llm-json";
import type { Provider } from "./minimax";
import { conceptsPrompt, expandPrompt, judgeConceptsPrompt } from "./prompts";

/** Small batches bound what one stuck call can lose. */
const BATCH_SIZE = 4;
/** After this many good batches, stragglers get GRACE_MS more. */
const QUORUM = 3;
const GRACE_MS = 20_000;

export interface ConceptsResult {
  concepts: Concept[];
  /** Batches that failed, or were still running after the grace period. */
  fallbackBatches: number;
  judged: boolean;
}

/** Drafts compact concepts for every archetype, judges and ranks them, and expands the best. */
export async function generateConcepts(provider: Provider, p: IdeaProject, archetypes: Archetype[] = ARCHETYPES): Promise<ConceptsResult> {
  if (!p.plan) throw new Error("Create the plan first");
  // Interleave so every batch mixes different kinds of story.
  const n = Math.ceil(archetypes.length / BATCH_SIZE);
  const batches = Array.from({ length: n }, (_, b) => archetypes.filter((_, i) => i % n === b));
  const schema = z.object({ concepts: z.array(ConceptSeed).min(1) });
  const settled = await gather(
    batches.map(async (batch) => {
      const r = await askJson(provider, conceptsPrompt(p, batch), schema, {
        task: "concepts",
        check: (v) => (v.concepts.length < batch.length ? [`write exactly ${batch.length} concepts, one per archetype (${batch.map((a) => a.id).join(", ")})`] : []),
        fallback: () => ({ concepts: fallbackConcepts(p, batch) }),
        temperature: 0.95,
      });
      // Trust the order over the model's archetype labels.
      return { fallback: r.usedFallback, concepts: r.value.concepts.slice(0, batch.length).map((c, i) => ({ ...c, archetype: batch[i]!.id })) };
    }),
    { ok: (d) => !d.fallback, quorum: Math.min(QUORUM, batches.length), graceMs: GRACE_MS },
  );
  const drafted = settled.filter((d): d is NonNullable<typeof d> => !!d);
  // Rule-based concepts only fill in when the model produced none at all.
  const real = drafted.filter((d) => !d.fallback);
  const concepts: Concept[] = (real.length ? real : drafted)
    .flatMap((d) => d.concepts)
    .map((c, i) => ({ protagonist: "", beats: [], ending: "", ...c, id: `c${i + 1}`, verdict: "" }));
  const ranked = await judgeConcepts(provider, p, concepts);
  if (ranked.concepts[0]) ranked.concepts[0] = await expandConcept(provider, p, ranked.concepts[0]);
  return { concepts: ranked.concepts, fallbackBatches: batches.length - real.length, judged: ranked.judged };
}

/** Stage 2: the concept's protagonist, beats and ending. No-op when already expanded. */
export async function expandConcept(provider: Provider, p: IdeaProject, c: Concept): Promise<Concept> {
  if (c.beats.length) return c;
  const r = await askJson(provider, expandPrompt(p, c), ConceptExpansion, { task: "expand", fallback: () => fallbackExpansion(p, c), temperature: 0.8 });
  return { ...c, ...r.value, hook: r.value.hook || c.hook };
}

const score = z.coerce.number().min(1).max(10);
const JudgeReply = z.object({
  scores: z.array(z.object({ id: z.string(), hook: score, clarity: score, specificity: score, emotion: score, credibility: score, fit: score, reason: z.string().default("") })),
});
type JudgeRow = z.infer<typeof JudgeReply>["scores"][number];

/**
 * Scores every concept with two independent judge passes over different orderings (to cancel
 * position bias), averages them, and returns the concepts best first.
 */
export async function judgeConcepts(provider: Provider, p: IdeaProject, concepts: Concept[]): Promise<{ concepts: Concept[]; judged: boolean }> {
  if (provider.demo) return { concepts, judged: false };
  const passes = await gather(
    [0, 1].map(async (seed) => {
      const order = shuffle(concepts, seed + concepts.length);
      const r = await askJson(provider, judgeConceptsPrompt(p, order), JudgeReply, {
        task: "judge",
        check: (v) => {
          const missing = concepts.filter((c) => !v.scores.some((s) => s.id === c.id)).map((c) => c.id);
          return missing.length ? [`score every concept; missing: ${missing.join(", ")}`] : [];
        },
        fallback: () => ({ scores: [] }),
        temperature: 0.2,
      });
      return r.usedFallback ? undefined : r.value.scores;
    }),
    { ok: (v) => !!v, quorum: 1, graceMs: GRACE_MS },
  );
  const valid = passes.filter((x): x is JudgeRow[] => !!x);
  if (!valid.length) return { concepts, judged: false };
  const scored = concepts.map((c) => {
    const rows = valid.map((pass) => pass.find((s) => s.id === c.id)).filter((x): x is JudgeRow => !!x);
    const scores = Object.fromEntries(RUBRIC.map((r) => [r.key, round1(avg(rows.map((row) => row[r.key])))]));
    const total = Math.round(RUBRIC.reduce((n, r) => n + scores[r.key]! * r.weight, 0) * 10);
    return { ...c, scores, score: total, verdict: rows.map((r) => r.reason).find(Boolean) ?? "" };
  });
  scored.sort((a, b) => b.score - a.score);
  return { concepts: scored, judged: true };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Deterministic shuffle (so tests and reruns are stable). */
export function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed * 9301 + 49297;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
