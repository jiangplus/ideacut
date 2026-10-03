// Prompts for the writing steps. Each asks for JSON in a fixed shape; the task marker on the
// first line lets the demo provider recognise the request.

import { TEMPLATES } from "../shared/templates";
import { narrationBudget, type Concept, type IdeaProject, type Scene } from "../shared/project";
import type { ChatMessage } from "./minimax";
import { RUBRIC, type Archetype } from "../shared/archetypes";

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

const CLICHES = {
  zh: "赋能、一站式、颠覆、革命性、全方位、智能化、助力、打造、极致、新时代、痛点、解决方案、降本增效、让……变得简单",
  en: "revolutionary, seamless, game-changer, cutting-edge, empower, leverage, unlock, next-generation, all-in-one, solution, pain point",
};

function planBlock(p: IdeaProject): string {
  return `PLAN (the only facts you may use):\n${JSON.stringify(p.plan, null, 2)}`;
}

function conceptBlock(c: Concept): string {
  return [
    `TITLE: ${c.title}`,
    `HOOK: ${c.hook}`,
    `LOGLINE: ${c.logline}`,
    c.protagonist && `PROTAGONIST: ${c.protagonist}`,
    c.beats.length ? `BEATS:\n${c.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}` : "",
    c.ending && `ENDING: ${c.ending}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One concept that shows the bar: specific person, moment and stakes; hook with tension. */
const EXAMPLE_CONCEPT = {
  zh: { archetype: "deadline", title: "最后一个车位", hook: "还有三分钟开会。", logline: "要见大客户的销售在写字楼下绕到第四圈，停车 App 把他直接导进刚空出来的车位。" },
  en: { archetype: "deadline", title: "The Last Spot", hook: "Three minutes to the meeting.", logline: "A sales rep circles the block a fourth time before a big pitch; the parking app routes him straight into a spot that just opened." },
};

const IMMEDIATE = "Reply with the JSON immediately. Do not deliberate at length or explain.";

export function conceptsPrompt(p: IdeaProject, archetypes: Archetype[]): ChatMessage[] {
  const hookMax = p.spec.language === "zh" ? "20 characters" : "12 words";
  const example = EXAMPLE_CONCEPT[p.spec.language];
  return [
    {
      role: "system",
      content: `TASK: concepts
ARCHETYPES: ${archetypes.map((a) => a.id).join(",")}
${IMMEDIATE} Shape (one entry per archetype, in this order):
{"concepts":[{"archetype":"id","title":"...","hook":"...","logline":"..."}]}
Example of the bar (for a different product): ${JSON.stringify(example)}

You are the creative director of a studio known for short product films that make people feel something. Pitch ${archetypes.length} story concepts for a ${p.spec.duration}-second intro video of the product below (motion graphics and voice-over, no live footage), one per archetype:
${archetypes.map((a, i) => `${i + 1}. ${a.id}: ${a.how}`).join("\n")}
- title: 2–8 words.
- hook: the first spoken line, at most ${hookMax}. It creates tension or curiosity on its own; no greeting, no product name, no "have you ever".
- logline: one sentence with a specific person, a specific moment, what is at stake, and how the product turns it.
- Only the founder's facts; never invent numbers, customers or awards. Avoid: ${p.spec.language === "zh" ? CLICHES.zh : CLICHES.en}.
- Make the concepts genuinely different from each other. Write in ${lang(p)}.`,
    },
    { role: "user", content: [planBlock(p), ideaBlock(p), answersBlock(p)].filter(Boolean).join("\n\n") },
  ];
}

export function expandPrompt(p: IdeaProject, c: Concept): ChatMessage[] {
  const budget = narrationBudget(p.spec);
  return [
    {
      role: "system",
      content: `TASK: expand
${IMMEDIATE} Shape:
{"protagonist":"...","hook":"(the opening line, tightened if it helps)","beats":["...","...","...","..."],"ending":"..."}

Develop this story concept into the spine of a ${p.spec.duration}-second product film (about ${budget.chars} ${budget.unit} of voice-over):
- protagonist: a specific role in a specific situation, or "you".
- beats: 4–6, in order: setup → tension → turn (the product arrives) → payoff → close. Each beat is one concrete thing the viewer sees or hears (time, place, object, action), not a topic heading.
- ending: pays off the opening (same moment, person or question, now resolved) and leads into the call to action.
- Only the founder's facts; never invent numbers, customers or quotes from real people. Write in ${lang(p)}.`,
    },
    { role: "user", content: `CONCEPT:\n${conceptBlock(c)}\n\n${planBlock(p)}\n\n${ideaBlock(p)}` },
  ];
}

export function judgeConceptsPrompt(p: IdeaProject, concepts: Concept[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: `TASK: judge
${IMMEDIATE}
You are the jury for a startup pitch-video competition: a seasoned film editor, a VC and a skeptical engineer. Score every story concept for a ${p.spec.duration}-second video about the product below. Score each criterion 1–10:
${RUBRIC.map((r) => `- ${r.key}: ${r.ask}`).join("\n")}
Be harsh and use the whole range: 9–10 only for concepts you would bet on; a concept that could be pasted onto any other product gets ≤ 4 for specificity; any invented number or claim gets ≤ 3 for credibility. Judge each concept on its own merits, not its position in the list.
"reason" is one short sentence in ${lang(p)} saying what makes it strong or weak.
Reply with JSON only, one entry per concept:
{"scores":[{"id":"c1","hook":7,"clarity":6,"specificity":8,"emotion":5,"credibility":9,"fit":7,"reason":"..."}]}`,
    },
    { role: "user", content: `${planBlock(p)}\n\nCONCEPTS:\n${concepts.map((c) => `[${c.id}]\n${conceptBlock(c)}`).join("\n\n")}` },
  ];
}

export function storyboardPrompt(p: IdeaProject, concept?: Concept): ChatMessage[] {
  const budget = narrationBudget(p.spec);
  const templates = Object.entries(TEMPLATES)
    .map(([id, t]) => `- ${id}: ${t.purpose} fields: ${describeFields(id as keyof typeof TEMPLATES)}`)
    .join("\n");
  const scenes = p.spec.duration <= 30 ? "4–6" : p.spec.duration <= 60 ? "6–9" : "8–11";
  const images = p.idea.materials.map((m) => m.id);
  const sentence = p.spec.language === "zh" ? "about 20 characters" : "about 14 words";
  return [
    {
      role: "system",
      content: `TASK: storyboard
${IMMEDIATE} Shape: {"scenes":[{"template":"moment","narration":"...","fields":{...}}]}
You write the script for a ${p.spec.duration}-second product film: ${scenes} motion-graphics scenes, each with a template and the voice-over for that scene.
${concept ? "Tell the STORY DIRECTION below. Keep its hook, protagonist, beats and ending; tighten wording where it helps." : "Narrative: hook → tension → product as the turning point → payoff → close that echoes the opening."}
How to make it a story, not a slide deck:
- The voice-over is ONE continuous piece that reads like a short story. Each scene's narration follows from the previous one (cause and effect: so, until, then, but). Read in sequence, it must never sound like a list of headings.
- Show a person and a moment: times, places, objects, actions. Show, don't tell.
- The first line is the hook. The product name appears only after the tension is set up, never in the first scene.
- Exactly one "title" scene, at the turn of the story, reveals the product name and its promise. The last scene is a "cta".
- One idea per scene. Spoken sentences are short (${sentence}), conversational and easy for text-to-speech; no bullet lists read aloud.
- The last scene calls back to the opening (same moment, person or question, now resolved) and ends with the call to action in one short line.
- On-screen text adds what the voice does not say (the time and place, a quote, a key word); it never repeats the narration.
- Use "moment" and "quote" scenes for story beats. Slide-like templates (features, steps, compare, stats) at most twice in total, and only where the story needs them.
- Never use: ${p.spec.language === "zh" ? CLICHES.zh : CLICHES.en}.
Total narration must be about ${budget.chars} ${budget.unit} in ${lang(p)} (spoken at a natural pace), split across scenes.
${images.length ? `Use the uploaded images (${images.join(", ")}) in "solution" or "screenshot" scenes via the "image" field, at the moment the product appears.` : `There are no uploaded images: do not use the "screenshot" template and leave "image" out.`}
Story details inside a scene (a time, an unread count, the weather) are yours to invent; claims about the product (speed, savings, prices, distances, accuracy, results) must come from the plan. Do not invent statistics, customers or quotes from real people; "stats" only if the plan has real numbers. A "quote" is what the protagonist or a typical user would say, attributed to a role ("a product manager"), never a real name.
Templates:
${templates}
Reply with JSON only:
{"scenes":[{"template":"moment","narration":"...","fields":{...}}]}`,
    },
    { role: "user", content: [concept ? `STORY DIRECTION:\n${conceptBlock(concept)}` : "", planBlock(p), ideaBlock(p)].filter(Boolean).join("\n\n") },
  ];
}

export function judgeStoryboardsPrompt(p: IdeaProject, drafts: Scene[][]): ChatMessage[] {
  const show = (scenes: Scene[]) => scenes.map((s, i) => `${i + 1}. [${s.template}] VO: ${s.narration}\n   ON SCREEN: ${JSON.stringify(s.fields)}`).join("\n");
  return [
    {
      role: "system",
      content: `TASK: judge-storyboard
${IMMEDIATE}
You are the editor choosing which script to produce for a ${p.spec.duration}-second product film. Score each draft 1–10 on:
- story: does the voice-over read as one continuous story with cause and effect (not a list of slides)?
- hook: does the first line grab attention without naming the product?
- clarity: is it clear what the product does and for whom?
- show: concrete moments and on-screen text that adds to (not repeats) the voice?
- ending: does it pay off the opening and end on a clear call to action?
- voice: natural spoken ${lang(p)}, short sentences, no clichés, no product claims missing from the plan, no contradictions in time or place?
Be harsh and decisive. "reason" is one short sentence in ${lang(p)}.
Reply with JSON only:
{"scores":[{"draft":1,"story":7,"hook":6,"clarity":8,"show":6,"ending":7,"voice":8,"reason":"..."}]}`,
    },
    { role: "user", content: `${planBlock(p)}\n\n${drafts.map((d, i) => `DRAFT ${i + 1}:\n${show(d)}`).join("\n\n")}` },
  ];
}

function describeFields(id: keyof typeof TEMPLATES): string {
  const shape = TEMPLATES[id].fields.shape as Record<string, unknown>;
  const examples: Record<string, string> = {
    hook: `{"line":"..."}`,
    moment: `{"kicker":"23:11 · desk","emoji":"🎧","line":"a few words the voice doesn't say, e.g. 2 hours of audio, again","sub":"(optional)"}`,
    quote: `{"quote":"...","who":"a role, e.g. a product manager"}`,
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
