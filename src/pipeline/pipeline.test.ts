import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IdeaProject, Spec } from "../shared/project";
import { captionLines, compileTimeline } from "./compile";
import { askJson, extractJson } from "./llm-json";
import { stripThinking, type Provider } from "./minimax";

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
    const fixed = await askJson(scripted(['{"n": 3}', '{"n": 12}']), [{ role: "user", content: "x" }], schema, { fallback: () => ({ n: 99 }) });
    expect(fixed).toMatchObject({ value: { n: 12 }, attempts: 2, usedFallback: false });
    const gaveUp = await askJson(scripted(["nope"]), [{ role: "user", content: "x" }], schema, { fallback: () => ({ n: 99 }), attempts: 2 });
    expect(gaveUp).toMatchObject({ value: { n: 99 }, usedFallback: true });
    const checked = await askJson(scripted(['{"n": 11}', '{"n": 20}']), [{ role: "user", content: "x" }], schema, { fallback: () => ({ n: 99 }), check: (v) => (v.n % 2 ? ["must be even"] : []) });
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
