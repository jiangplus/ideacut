// Prompts for the three writing steps. Each asks for JSON in a fixed shape; the task marker
// on the first line lets the demo provider recognise the request.

import { TEMPLATES } from "../shared/templates";
import { narrationBudget, type IdeaProject } from "../shared/project";
import type { ChatMessage } from "./minimax";

const lang = (p: IdeaProject) => (p.spec.language === "zh" ? "Simplified Chinese" : "English");

function ideaBlock(p: IdeaProject): string {
  const mats = p.idea.materials.map((m) => `- ${m.id}: ${m.name}${m.note ? ` — ${m.note}` : ""}`).join("\n");
  return [
    `IDEA:\n${p.idea.text.trim()}`,
    p.idea.details.trim() ? `DETAILS FROM THE FOUNDER:\n${p.idea.details.trim()}` : "",
    mats ? `UPLOADED IMAGES (product screenshots etc.):\n${mats}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function answersBlock(p: IdeaProject): string {
  const lines = (p.questions ?? []).flatMap((q) => {
    const a = p.answers.find((x) => x.questionId === q.id);
    const ans = [...(a?.choices ?? []), a?.note].filter(Boolean).join("; ");
    return ans ? [`Q: ${q.question}\nA: ${ans}`] : [];
  });
  return lines.length ? `FOUNDER'S ANSWERS:\n${lines.join("\n")}` : "";
}

export function questionsPrompt(p: IdeaProject): ChatMessage[] {
  return [
    {
      role: "system",
      content: `TASK: questions
You are a sharp startup advisor helping a founder prepare a ${p.spec.duration}-second project intro video.
Ask the 4–5 most useful clarifying questions about their idea: who exactly it is for, the painful problem, why existing options fail, what makes it different, how it makes money or what result it proves. Skip anything the founder already answered.
Each question gets 3–4 short, concrete answer options written for THIS idea (not generic), so the founder can just click. Write in ${lang(p)}.
Reply with JSON only:
{"questions":[{"id":"q1","question":"...","why":"one short reason this matters","options":["...","...","..."],"multi":false}]}`,
    },
    { role: "user", content: ideaBlock(p) },
  ];
}

export function planPrompt(p: IdeaProject): ChatMessage[] {
  return [
    {
      role: "system",
      content: `TASK: plan
You turn a founder's idea and answers into a crisp project plan that a ${p.spec.duration}-second intro video will be built from.
Rules: be specific and concrete; use the founder's own facts; never invent numbers, customers or awards — if traction is unknown leave "traction" empty. Keep every field short (a sentence or two). Write in ${lang(p)}.
Reply with JSON only, exactly these fields:
{"name":"product name (keep the founder's if given)","oneLiner":"one-line promise","problem":"...","audience":"...","solution":"...","features":["3–5 items"],"howItWorks":["step 1","step 2","step 3"],"differentiation":"...","businessModel":"...","traction":"","cta":"what viewers should do","contact":"link/email if given, else empty"}`,
    },
    { role: "user", content: [ideaBlock(p), answersBlock(p)].filter(Boolean).join("\n\n") },
  ];
}

export function storyboardPrompt(p: IdeaProject): ChatMessage[] {
  const budget = narrationBudget(p.spec);
  const templates = Object.entries(TEMPLATES)
    .map(([id, t]) => `- ${id}: ${t.purpose} fields: ${describeFields(id as keyof typeof TEMPLATES)}`)
    .join("\n");
  const scenes = p.spec.duration <= 30 ? "4–5" : p.spec.duration <= 60 ? "6–8" : "8–10";
  const images = p.idea.materials.map((m) => m.id);
  return [
    {
      role: "system",
      content: `TASK: storyboard
You are a video scriptwriter. Write a ${p.spec.duration}-second project intro video as ${scenes} scenes.
Narrative: hook → problem → product reveal → how it works / features → (proof or difference) → call to action.
Each scene uses one template and has the voice-over narration for that scene. On-screen text in fields must be SHORT (they are headlines, not sentences) and must not just repeat the narration.
Total narration must be about ${budget.chars} ${budget.unit} in ${lang(p)} (spoken at a natural pace), split across scenes.
${images.length ? `Use the uploaded images (${images.join(", ")}) in "solution" or "screenshot" scenes via the "image" field.` : `There are no uploaded images: do not use the "screenshot" template and leave "image" out.`}
Use emoji for feature icons. Do not invent statistics; only use "stats" if the plan has real numbers.
Templates:
${templates}
Reply with JSON only:
{"scenes":[{"template":"hook","narration":"...","fields":{...}}]}`,
    },
    { role: "user", content: `PLAN:\n${JSON.stringify(p.plan, null, 2)}\n\n${ideaBlock(p)}` },
  ];
}

function describeFields(id: keyof typeof TEMPLATES): string {
  const shape = TEMPLATES[id].fields.shape as Record<string, unknown>;
  const examples: Record<string, string> = {
    hook: `{"line":"..."}`,
    title: `{"name":"...","tagline":"..."}`,
    problem: `{"heading":"...","points":["...","..."]}`,
    solution: `{"heading":"...","body":"...","image":"(optional image id)"}`,
    features: `{"heading":"...","items":[{"icon":"⚡","text":"..."}]}`,
    steps: `{"heading":"...","steps":["...","...","..."]}`,
    screenshot: `{"caption":"...","image":"image id"}`,
    stats: `{"heading":"...","stats":[{"value":"3×","label":"..."}]}`,
    compare: `{"heading":"...","them":["..."],"us":["..."]}`,
    cta: `{"name":"...","action":"...","contact":"(optional)"}`,
  };
  return examples[id] ?? JSON.stringify(Object.keys(shape));
}
