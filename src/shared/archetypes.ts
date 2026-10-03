// The narrative archetypes concepts are drafted from, and the rubric they are judged by.

export interface Archetype {
  id: string;
  label: string;
  /** How to tell the story, for the writer. */
  how: string;
}

export const ARCHETYPES: Archetype[] = [
  { id: "moment", label: "那个时刻", how: "Open on one specific moment in the protagonist's day when the pain peaks (time, place, what they are doing). The product changes that exact moment." },
  { id: "before-after", label: "前后对比", how: "The same task told twice: before (friction, wasted effort) and after (with the product). Mirror the two halves so the contrast is obvious." },
  { id: "counterintuitive", label: "反常识", how: "Open with a surprising but true observation about the problem (no invented statistics). Pay it off by showing why the product is the logical answer." },
  { id: "user-voice", label: "用户吐槽", how: "Open with something users genuinely say or think about this problem, in their words. The story answers that complaint." },
  { id: "deadline", label: "倒计时", how: "A deadline creates tension (a meeting in 10 minutes, a submission tonight). The product is how the protagonist beats the clock." },
  { id: "failed-attempts", label: "旧办法都失败", how: "A quick run of the workarounds people try today and why each one fails. Then the product, which fixes the root cause." },
  { id: "one-person", label: "一个人的故事", how: "Follow one specific persona (role, situation, what is at stake for them) through a short arc: want, obstacle, product, win." },
  { id: "what-if", label: "如果……", how: "Ask the viewer to imagine the pain simply gone. Then reveal it is real now, and show how." },
  { id: "zoom-out", label: "从一个人到所有人", how: "Start with one person's small frustration, then zoom out: everyone in this situation lives it (qualitatively, no invented numbers). The product helps them all." },
  { id: "dialogue", label: "一段对话", how: "Two people talk: one is stuck, the other casually shows the product. The narration carries both voices or summarises them." },
  { id: "behind-scenes", label: "揭秘幕后", how: "Reveal the hidden, tedious work behind something that looks simple. The product takes that hidden work away." },
  { id: "challenge", label: "挑战与突破", how: "A mini hero's journey: a goal, a wall the protagonist hits, the product as the tool that gets them over it, the win." },
  { id: "metaphor", label: "一个比喻", how: "One vivid metaphor for the problem and the product, carried through every scene (e.g. untangling a knot, a lighthouse)." },
  { id: "live-demo", label: "边看边懂", how: "Tell the story by using the product in real time: a real task, step by step, the viewer understands it by watching." },
  { id: "villain", label: "问题是反派", how: "Personify the problem as the antagonist (the endless spreadsheet, the 2 a.m. inbox). The product defeats it." },
  { id: "future", label: "从未来回望", how: "The narrator speaks from a near future where the product is normal, looking back at how painful it used to be." },
  { id: "overload", label: "混乱到平静", how: "Chaos piles up (tabs, messages, to-dos, versions) faster and faster, then the product brings calm and order." },
  { id: "second-person", label: "你就是主角", how: "Second person throughout: the viewer ('you') lives the problem and then the relief. Concrete, sensory, immediate." },
  { id: "origin", label: "我们为什么做它", how: "The founders' own moment of frustration that led them to build this; honest and specific, then what they built." },
  { id: "one-question", label: "一个问题到底", how: "Ask one sharp question at the very start and let the whole video answer it, with the answer landing in the last line." },
];

/** Rubric for concepts; weights sum to 1. */
export const RUBRIC = [
  { key: "hook", label: "开场", weight: 0.2, ask: "Do the first 3 seconds create curiosity or tension a judge cannot ignore?" },
  { key: "clarity", label: "清晰", weight: 0.2, ask: "By the midpoint, does a viewer understand what the product does and for whom?" },
  { key: "specificity", label: "具体", weight: 0.2, ask: "Is it specific to THIS idea (could not be pasted onto another product)?" },
  { key: "emotion", label: "情绪", weight: 0.15, ask: "Is there a felt arc: tension, turn, relief or delight?" },
  { key: "credibility", label: "可信", weight: 0.15, ask: "Does it rely only on the founder's facts, with no invented numbers, customers or claims?" },
  { key: "fit", label: "可拍", weight: 0.1, ask: "Can it be told in the target length with motion-graphics scenes (text, emoji, screenshots), no live footage?" },
] as const;
