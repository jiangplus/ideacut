// The scene templates a storyboard may use. Each one is a motion graphic (src/templates/*.mg.tsx)
// rendered by EverCut; `fields` is what the storyboard fills in. Shared by the LLM prompt,
// validation and the UI editor.

import { z } from "zod";

const short = (max: number) => z.string().trim().min(1).max(max);

export const TEMPLATES = {
  hook: {
    label: "开场钩子",
    purpose: "Open with a provocative question or bold statement that names the pain.",
    fields: z.object({ line: short(40) }),
  },
  title: {
    label: "产品亮相",
    purpose: "Reveal the product name and its one-line promise.",
    fields: z.object({ name: short(24), tagline: short(40) }),
  },
  problem: {
    label: "问题",
    purpose: "Show 2–3 concrete pains of the target users.",
    fields: z.object({ heading: short(30), points: z.array(short(28)).min(2).max(3) }),
  },
  solution: {
    label: "解决方案",
    purpose: "Explain what the product does; can show a product screenshot.",
    fields: z.object({ heading: short(30), body: short(80), image: z.string().optional() }),
  },
  features: {
    label: "核心功能",
    purpose: "List 3–4 key features, each with an emoji icon.",
    fields: z.object({ heading: short(30), items: z.array(z.object({ icon: z.string().max(4), text: short(26) })).min(3).max(4) }),
  },
  steps: {
    label: "使用流程",
    purpose: "Show how it works in exactly 3 steps.",
    fields: z.object({ heading: short(30), steps: z.array(short(18)).length(3) }),
  },
  screenshot: {
    label: "产品截图",
    purpose: "Showcase a product screenshot with a caption. Only when the user uploaded an image.",
    fields: z.object({ caption: short(40), image: z.string() }),
  },
  stats: {
    label: "数据",
    purpose: "2–3 big numbers (market size, results, traction). Only numbers the user gave or clearly labeled estimates.",
    fields: z.object({ heading: short(30), stats: z.array(z.object({ value: short(10), label: short(20) })).min(2).max(3) }),
  },
  compare: {
    label: "差异化",
    purpose: "Contrast 'others' vs 'us' on 2–3 points.",
    fields: z.object({ heading: short(30), them: z.array(short(22)).min(2).max(3), us: z.array(short(22)).min(2).max(3) }),
  },
  cta: {
    label: "结尾号召",
    purpose: "Close with the product name, a call to action and contact/link.",
    fields: z.object({ name: short(24), action: short(40), contact: z.string().max(60).optional() }),
  },
} as const;

export type TemplateId = keyof typeof TEMPLATES;
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];
