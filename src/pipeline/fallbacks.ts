// Deterministic content used when the model fails repeatedly (or in demo mode), so the
// workflow always reaches a video. Quality is basic; the user can edit everything.

import type { Concept, IdeaProject, Plan, Question, Scene } from "../shared/project";
import { chosenConcept, narrationBudget, narrationLength } from "../shared/project";
import type { Archetype } from "../shared/archetypes";

const zh = (p: IdeaProject) => p.spec.language === "zh";

function firstSentence(text: string, max: number): string {
  const s = text.trim().split(/(?<=[。！？.!?])\s*/)[0] ?? text;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A product name guess: text before "：/:" or the first few words. */
export function guessName(idea: string): string {
  const head = idea.split(/[:：,，。.\n]/)[0]!.trim();
  return (head.length <= 16 ? head : head.slice(0, 12)) || "Our product";
}

export function fallbackQuestions(p: IdeaProject): Question[] {
  if (zh(p)) {
    return [
      { id: "q1", question: "这个产品最主要是给谁用的？", why: "视频要让目标用户一眼认出自己", options: ["个人用户", "中小团队", "企业", "学生与创作者"], multi: false },
      { id: "q2", question: "他们现在最痛的问题是什么？", why: "问题越具体，开场越有力", options: ["太耗时间", "成本太高", "效果不好", "门槛太高"], multi: true },
      { id: "q3", question: "和现有方案比，你最大的不同是？", why: "评委最关心为什么是你", options: ["更快", "更便宜", "更好用", "做到了别人做不到的事"], multi: true },
      { id: "q4", question: "希望观众看完做什么？", why: "决定结尾的号召", options: ["试用产品", "联系团队", "投票支持", "加入内测"], multi: false },
    ];
  }
  return [
    { id: "q1", question: "Who is this mainly for?", why: "Viewers should recognise themselves", options: ["Individuals", "Small teams", "Enterprises", "Students & creators"], multi: false },
    { id: "q2", question: "What hurts most for them today?", why: "A specific pain makes a strong hook", options: ["It takes too long", "It costs too much", "Results are poor", "It's too hard to start"], multi: true },
    { id: "q3", question: "What's your biggest difference?", why: "Judges want to know why you", options: ["Faster", "Cheaper", "Easier", "Does what others can't"], multi: true },
    { id: "q4", question: "What should viewers do after watching?", why: "Sets the closing call to action", options: ["Try it", "Contact us", "Vote for us", "Join the beta"], multi: false },
  ];
}

export function fallbackPlan(p: IdeaProject): Plan {
  const answer = (id: string) => {
    const a = p.answers.find((x) => x.questionId === id);
    return [...(a?.choices ?? []), a?.note].filter(Boolean).join("、");
  };
  const name = guessName(p.idea.text);
  const one = firstSentence(p.idea.text.replace(/^[^:：]*[:：]/, "").trim() || p.idea.text, 40);
  if (zh(p)) {
    return {
      name,
      oneLiner: one,
      problem: answer("q2") ? `目标用户面临：${answer("q2")}` : "现有做法费时费力，效果也难以保证。",
      audience: answer("q1") || "有这个需求的用户",
      solution: one,
      features: ["一步上手", "自动完成繁琐工作", "结果清晰可用"],
      howItWorks: ["输入你的需求", "自动生成结果", "确认并分享"],
      differentiation: answer("q3") ? `我们的优势：${answer("q3")}` : "更快、更简单。",
      businessModel: "免费试用，按需付费",
      traction: "",
      cta: answer("q4") || "立即试用",
      contact: "",
    };
  }
  return {
    name,
    oneLiner: one,
    problem: answer("q2") ? `Today: ${answer("q2")}` : "Today it's slow, costly and hard to get right.",
    audience: answer("q1") || "People with this need",
    solution: one,
    features: ["Start in one step", "Automates the busywork", "Clear, usable results"],
    howItWorks: ["Describe what you need", "Get it generated", "Review and share"],
    differentiation: answer("q3") ? `What sets us apart: ${answer("q3")}` : "Faster and simpler.",
    businessModel: "Free to try, pay as you grow",
    traction: "",
    cta: answer("q4") || "Try it today",
    contact: "",
  };
}

/** One plain concept per archetype, built from the plan. */
export function fallbackConcepts(p: IdeaProject, archetypes: Archetype[]): Omit<Concept, "id" | "verdict" | "protagonist" | "beats" | "ending">[] {
  const plan = p.plan ?? fallbackPlan(p);
  const c = zh(p);
  return archetypes.map((a) => ({
    archetype: a.id,
    title: c ? `${a.label}：${short(plan.name, 16)}` : `${a.label}: ${short(plan.name, 16)}`,
    hook: short(c ? `${plan.audience}，又一次卡在这里。` : `Stuck here again.`, 40),
    logline: short(c ? `${plan.audience}被「${short(plan.problem, 30)}」困住，直到用上${plan.name}。` : `${plan.audience} are stuck with "${short(plan.problem, 40)}" until ${plan.name}.`, 150),
  }));
}

/** Plain beats for a concept, built from the plan. */
export function fallbackExpansion(p: IdeaProject, concept: Concept): Pick<Concept, "protagonist" | "beats" | "ending"> {
  const plan = p.plan ?? fallbackPlan(p);
  const c = zh(p);
  return {
    protagonist: plan.audience,
    beats: c
      ? [`${concept.hook}${short(plan.problem, 40)}`, "试过的办法都不管用", `${plan.name}出现：${short(plan.oneLiner, 30)}`, `结果：${short(plan.differentiation, 30)}`]
      : [`${concept.hook} ${short(plan.problem, 60)}`, "Nothing they try works", `${plan.name} arrives: ${short(plan.oneLiner, 50)}`, `The result: ${short(plan.differentiation, 50)}`],
    ending: c ? `回到开头那一刻，这次很轻松。${plan.cta}` : `Back to that moment, easy this time. ${plan.cta}`,
  };
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function fallbackStoryboard(p: IdeaProject): Scene[] {
  const plan = p.plan ?? fallbackPlan(p);
  const c = zh(p);
  const image = p.idea.materials[0]?.id;
  const concept = chosenConcept(p);
  const scenes: Omit<Scene, "id">[] = [
    concept
      ? { template: "moment", narration: `${concept.hook}${c ? "" : " "}${plan.problem}`, fields: { kicker: short(concept.protagonist || plan.audience, 20), emoji: "😩", line: short(concept.hook, 36) } }
      : { template: "hook", narration: c ? `${plan.problem}` : plan.problem, fields: { line: short(c ? `${plan.audience}，还在忍受这些吗？` : `Still putting up with this?`, 40) } },
    { template: "title", narration: c ? `${plan.name}：${plan.oneLiner}。` : `${plan.name}: ${plan.oneLiner}.`, fields: { name: short(plan.name, 24), tagline: short(plan.oneLiner, 40) } },
    { template: "solution", narration: plan.solution, fields: { heading: c ? "我们的方案" : "Our solution", body: short(plan.features.slice(0, 3).join(" · "), 80), ...(image ? { image } : {}) } },
    {
      template: "features",
      narration: c ? `核心功能：${plan.features.slice(0, 3).join("，")}。` : `Key features: ${plan.features.slice(0, 3).join(", ")}.`,
      fields: { heading: c ? "核心功能" : "Key features", items: plan.features.slice(0, 4).map((t, i) => ({ icon: ["⚡", "🎯", "🧩", "🚀"][i]!, text: short(t, 26) })) },
    },
    {
      template: "steps",
      narration: c ? `只需三步：${plan.howItWorks.join("，")}。` : `Three steps: ${plan.howItWorks.join(", ")}.`,
      fields: { heading: c ? "三步完成" : "How it works", steps: plan.howItWorks.map((s) => short(s, 18)) },
    },
    { template: "cta", narration: c ? `${plan.name}，${plan.cta}。` : `${plan.name}. ${plan.cta}.`, fields: { name: short(plan.name, 24), action: short(plan.cta, 40), ...(plan.contact ? { contact: plan.contact.slice(0, 60) } : {}) } },
  ];
  // Trim narration to the budget so the video length stays close to the target.
  const budget = narrationBudget(p.spec).chars;
  const per = Math.max(8, Math.floor(budget / scenes.length));
  return scenes.map((s, i) => ({ ...s, id: `s${i + 1}`, narration: clip(s.narration, per, p.spec.language) }));
}

/** Shortens narration at a sentence/clause boundary (never mid-word); keeps it whole if no good cut. */
function clip(text: string, max: number, language: "zh" | "en"): string {
  if (narrationLength(text, language) <= max) return text;
  if (language === "zh") {
    const head = text.slice(0, max + 1);
    const cut = Math.max(...["。", "！", "？", "；", "，"].map((p) => head.lastIndexOf(p)));
    if (cut >= max * 0.4) return `${text.slice(0, cut)}。`;
    return text.length <= max * 2 ? text : `${text.slice(0, max)}。`;
  }
  const words = text.split(/\s+/);
  const head = words.slice(0, max).join(" ");
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf(", "), head.lastIndexOf("; "));
  if (cut >= head.length * 0.4) return `${head.slice(0, cut)}.`;
  return words.length <= max * 2 ? text : `${head}.`;
}
