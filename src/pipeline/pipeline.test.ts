import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IdeaProject, Spec, type Scene } from "../shared/project";
import { captionLines, compileTimeline } from "./compile";
import { askJson, extractJson } from "./llm-json";
import { stripThinking, type Provider } from "./minimax";
import { ARCHETYPES } from "../shared/archetypes";
import { DemoProvider } from "./demo";
import { fallbackPlan } from "./fallbacks";
import { generateConcepts, judgeConcepts } from "./story";
import { gather } from "./gather";
import { MiniMax, MiniMaxError, type ChatMessage, type ChatOptions } from "./minimax";
import { cutText, echoIssues, fixStoryboard } from "./writing";

const project = (over: Partial<IdeaProject> = {}): IdeaProject =>
  IdeaProject.parse({ version: 1, id: "p", createdAt: "", updatedAt: "", title: "T", spec: Spec.parse({}), idea: { text: "x" }, ...over });

function scripted(replies: string[]): Provider {
  let i = 0;
  return { demo: true, chat: async () => replies[Math.min(i++, replies.length - 1)]!, speech: async () => { throw new Error(); }, voices: async () => [], music: async () => { throw new Error(); } };
}

describe("structured output", () => {
  it("extracts JSON from fenced, chatty and thinking replies", () => {
    expect(extractJson('Sure!\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Here: {"a":"}{"} trailing')).toEqual({ a: "}{" });
    expect(extractJson(stripThinking('<think>{"no":1}</think>{"yes":2}'))).toEqual({ yes: 2 });
    expect(() => extractJson("no json here")).toThrow();
  });

  it("repairs invalid output, then falls back", async () => {
    const schema = z.object({ n: z.number().min(10) });
    const fixed = await askJson(scripted(['{"n": 3}', '{"n": 12}']), [{ role: "user", content: "x" }], schema, { task: "plan", fallback: () => ({ n: 99 }) });
    expect(fixed).toMatchObject({ value: { n: 12 }, attempts: 2, usedFallback: false });
    const gaveUp = await askJson(scripted(["nope"]), [{ role: "user", content: "x" }], schema, { task: "plan", fallback: () => ({ n: 99 }), attempts: 2 });
    expect(gaveUp).toMatchObject({ value: { n: 99 }, usedFallback: true });
    const checked = await askJson(scripted(['{"n": 11}', '{"n": 20}']), [{ role: "user", content: "x" }], schema, { task: "plan", fallback: () => ({ n: 99 }), check: (v) => (v.n % 2 ? ["must be even"] : []) });
    expect(checked.value.n).toBe(20);
  });
});

describe("captions & timeline", () => {
  it("splits narration into timed caption lines", () => {
    const lines = captionLines("上传你的文档，我们自动生成可编辑的演示文稿。三分钟搞定！", 6, "zh");
    expect(lines.map((l) => l.text)).toEqual(["上传你的文档", "我们自动生成可编辑的演示文稿。", "三分钟搞定！"]);
    expect(lines[0]!.start).toBe(0);
    expect(lines.at(-1)!.end).toBeCloseTo(6);
    const timed = captionLines("ignored", 4, "en", [{ text: "Hello world.", startMs: 200, endMs: 1500 }, { text: "Bye.", startMs: 1600, endMs: 2400 }]);
    expect(timed).toEqual([{ text: "Hello world.", start: 0.2, end: 1.5 }, { text: "Bye.", start: 1.6, end: 2.4 }]);
  });

  it("compiles scenes, voice, captions and looped music deterministically", () => {
    const p = project({
      scenes: [
        { id: "s1", template: "title", narration: "我们是谁。", fields: { name: "X", tagline: "Y" } },
        { id: "s2", template: "cta", narration: "快来试试。", fields: { name: "X", action: "试试" } },
      ],
    });
    const input = { project: p, width: 1920, height: 1080, fps: 30, voices: [{ sceneId: "s1", assetId: "v1", seconds: 2 }, { sceneId: "s2", assetId: "v2", seconds: 1 }], templateAssets: { title: "t1", cta: "t2" }, materialPaths: {}, music: { assetId: "m", seconds: 3 }, tracks: { video: "V", audio: "A" } };
    const a = compileTimeline(input);
    expect(a).toEqual(compileTimeline(input));
    // scene 1: 0.5 + 2 + 0.55 s → 92 frames; scene 2 (last): 0.35 + 1 + 1.8 → 95 frames (min 2.5 s = 75)
    expect(a.sceneStarts).toEqual([0, 92]);
    expect(a.totalFrames).toBe(187);
    const adds = a.ops.filter((o) => o.op === "item.add") as any[];
    expect(adds.filter((o) => o.track === "$music").map((o) => [o.item.start, o.item.duration])).toEqual([[0, 90], [90, 90], [180, 7]]);
    expect(adds.find((o) => o.item.assetId === "v2").item.start).toBe(92 + 11);
    expect(adds.filter((o) => o.track === "$cc").every((o) => o.item.meta["evercut.caption"])).toBe(true);
  });
});

describe("story concepts", () => {
  const concept = (id: string) => ({ id, archetype: "moment", title: id, logline: "l", protagonist: "", hook: "h", beats: ["a", "b", "c", "d"], ending: "", verdict: "" });
  const row = (id: string, n: number) => ({ id, hook: n, clarity: n, specificity: n, emotion: n, credibility: n, fit: n, reason: `r${id}` });

  it("averages two judge passes and ranks best first", async () => {
    const judge: Provider = {
      demo: false,
      // Pass one loves c2, pass two is lukewarm on it; c1 is steady.
      chat: (() => {
        let call = 0;
        return async () => JSON.stringify({ scores: call++ === 0 ? [row("c1", 6), row("c2", 10), row("c3", 2)] : [row("c1", 6), row("c2", 4), row("c3", 2)] });
      })(),
      speech: async () => { throw new Error(); },
      voices: async () => [],
      music: async () => { throw new Error(); },
    };
    const r = await judgeConcepts(judge, project(), [concept("c1"), concept("c2"), concept("c3")]);
    expect(r.judged).toBe(true);
    expect(r.concepts.map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
    expect(r.concepts[0]).toMatchObject({ score: 70, scores: { hook: 7 } });
  });

  it("keeps the drafted order when the judge fails", async () => {
    const r = await judgeConcepts({ ...scripted(["nope"]), demo: false }, project(), [concept("c1"), concept("c2")]);
    expect(r).toMatchObject({ judged: false, concepts: [{ id: "c1" }, { id: "c2" }] });
  });

  it("drafts one concept per archetype in demo mode", async () => {
    const p = project({ plan: fallbackPlan(project()) });
    const r = await generateConcepts(new DemoProvider(() => p), p);
    expect(r.concepts).toHaveLength(ARCHETYPES.length);
    expect(new Set(r.concepts.map((c) => c.archetype)).size).toBe(ARCHETYPES.length);
    expect(r.fallbackBatches).toBe(0);
  });
});

describe("slow and runaway model calls", () => {
  const after = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  it("drops stragglers once the quorum is met and the grace period ends", async () => {
    const t = Date.now();
    const r = await gather([after(10, "a"), after(20, "b"), after(5_000, "slow")], { ok: () => true, quorum: 2, graceMs: 50 });
    expect(r).toEqual(["a", "b", undefined]);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("waits for everything when too few results are good", async () => {
    const r = await gather([after(10, "bad"), after(40, "ok")], { ok: (v) => v === "ok", quorum: 2, graceMs: 1 });
    expect(r).toEqual(["bad", "ok"]);
  });

  it("treats a reply that ran out of budget while thinking as a failed attempt", async () => {
    const reply = { choices: [{ finish_reason: "length", message: { content: "<think>still thinking about the hook and the" } }], base_resp: { status_code: 0 } };
    const fake = (async () => new Response(JSON.stringify(reply), { status: 200 })) as typeof fetch;
    const mm = new MiniMax("k", "https://example.invalid", fake);
    (mm as unknown as { textModel: string }).textModel = "MiniMax-M3";
    await expect(mm.chat([{ role: "user", content: "x" }])).rejects.toThrow(/token 预算/);
    const cut = { choices: [{ finish_reason: "length", message: { content: '{"scenes":[{"template":"moment","narration":"十点' } }], base_resp: { status_code: 0 } };
    const mm2 = new MiniMax("k", "https://example.invalid", (async () => new Response(JSON.stringify(cut))) as typeof fetch);
    (mm2 as unknown as { textModel: string }).textModel = "MiniMax-M3";
    await expect(mm2.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ kind: "runaway" });
  });
});

describe("follow-ups and code-side fixes", () => {
  it("retries a runaway call fresh with thinking off, and repairs with only the JSON", async () => {
    const calls: { think?: string; messages: ChatMessage[] }[] = [];
    const replies: (() => string)[] = [
      () => { throw new MiniMaxError("budget", 200, false, "runaway"); },
      () => '<think>hmm</think>{"n": 3}',
      () => '{"n": 12}',
    ];
    const provider: Provider = { ...scripted([]), demo: false, chat: async (messages: ChatMessage[], o?: ChatOptions) => { calls.push({ think: o?.think, messages }); return replies[calls.length - 1]!(); } };
    const schema = z.object({ n: z.number().min(10) });
    const r = await askJson(provider, [{ role: "user", content: "x" }], schema, { task: "judge", fallback: () => ({ n: 99 }), attempts: 3 });
    expect(r.value.n).toBe(12);
    expect(calls.map((c) => c.think)).toEqual(["low", "off", "off"]);
    expect(calls[1]!.messages).toHaveLength(1);
    // The repair turn carries the extracted JSON, not the reasoning.
    expect(calls[2]!.messages[1]).toEqual({ role: "assistant", content: '{"n":3}' });
  });

  it("gives up after one repair by default", async () => {
    const r = await askJson(scripted(["nope", "still nope", '{"n": 50}']), [{ role: "user", content: "x" }], z.object({ n: z.number() }), { task: "plan", fallback: () => ({ n: 99 }) });
    expect(r).toMatchObject({ usedFallback: true, attempts: 2, value: { n: 99 } });
  });

  it("fixes lengths, CTA order and a missing title in code", () => {
    const p = project({ plan: { ...fallbackPlan(project()), name: "会议助手", oneLiner: "开完会，待办自动出来", cta: "申请内测" } });
    const raw = {
      scenes: [
        { template: "cta", narration: "会议助手，申请内测。", fields: { name: "会议助手", action: "申请内测" } },
        { template: "moment", narration: "十点四十七分。", fields: { kicker: "周一晚上十点四十七分 · 公司三楼大会议室里面", emoji: "😩", line: "她还在拖动录音进度条，想找到谁答应改登录页，找了半个小时也没找到，明早九点就要评审了" } },
        { template: "solution", narration: "然后……", fields: { heading: "自动整理", body: "录音进去，待办出来", image: "nope" } },
      ],
    };
    const fixed = fixStoryboard(p, raw) as { scenes: Scene[] };
    expect(fixed.scenes.map((s) => s.template)).toEqual(["moment", "title", "solution", "cta"]);
    const m = fixed.scenes[0]!.fields as { kicker: string; line: string };
    expect(m.kicker.length).toBeLessThanOrEqual(20);
    expect(m.line.length).toBeLessThanOrEqual(36);
    expect(m.line).toBe("她还在拖动录音进度条，想找到谁答应改登录页，找了半个小时也没找到");
    expect(m.kicker).toBe("周一晚上十点四十七分");
    expect((fixed.scenes[2]!.fields as { image?: string }).image).toBeUndefined();
    expect(cutText("short", 10)).toBe("short");
    const echo = { id: "s2", template: "moment" as const, narration: "晚上十一点，耳机一戴，把两小时的站会录音拖回最开头。", fields: { kicker: "23:11", emoji: "🎧", line: "晚上十一点，耳机一戴，把两小时的站会录音拖回最开头。" } };
    expect(echoIssues(echo, "zh")).toHaveLength(1);
    expect(echoIssues({ ...echo, fields: { ...echo.fields, line: "两小时录音，从头再听" } }, "zh")).toEqual([]);
  });
});
