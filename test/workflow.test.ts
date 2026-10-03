// End to end in demo mode: idea → questions → plan → storyboard → MP4, through a real EverCut engine.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DemoProvider } from "../src/pipeline/demo";
import { EverCutEngine, locateEverCut } from "../src/pipeline/evercut";
import { produce } from "../src/pipeline/produce";
import { ProjectStore } from "../src/pipeline/store";
import { generatePlan, generateQuestions, generateStoryboard, storyboardIssues } from "../src/pipeline/writing";
import type { IdeaProject } from "../src/shared/project";

// IDEACUT_TEST_KEEP=<dir> keeps the generated project for inspection.
const home = process.env.IDEACUT_TEST_KEEP ?? mkdtempSync(join(tmpdir(), "ideacut-e2e-"));
afterAll(() => {
  if (!process.env.IDEACUT_TEST_KEEP) rmSync(home, { recursive: true, force: true });
});

describe("demo workflow", () => {
  it("goes from an idea to a rendered video", async () => {
    const store = new ProjectStore(home);
    let p: IdeaProject = store.create({ text: "PPT 生成器：上传文档，一键生成可编辑的演示文稿", spec: { duration: 30 } });
    const shot = join(home, "shot.png");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x800", "-frames:v", "1", shot]);
    const m = store.addMaterial(p.id, shot);
    p.idea.materials.push({ id: "img1", path: m.path, name: m.name, note: "editor screenshot" });
    const provider = new DemoProvider(() => p);

    const q = await generateQuestions(provider, p);
    expect(q.value.length).toBeGreaterThanOrEqual(3);
    p = { ...p, questions: q.value, answers: [{ questionId: "q1", choices: [q.value[0]!.options[1]!], note: "" }] };
    const plan = await generatePlan(provider, p);
    expect(plan.usedFallback).toBe(false);
    p = { ...p, plan: plan.value };
    const sb = await generateStoryboard(provider, p);
    p = { ...p, scenes: sb.value };
    expect(storyboardIssues(p, p.scenes!)).toEqual([]);
    p = store.save(p);

    const engine = new EverCutEngine(locateEverCut(resolve(__dirname, "..")));
    const runs: string[] = [];
    try {
      const run = await produce({
        project: p,
        dir: store.dir(p.id),
        provider,
        engine,
        onRun: (r) => {
          runs.push(r.steps.map((s) => s.status[0]).join(""));
          store.save({ ...store.load(p.id), run: r });
        },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("done");
      expect(existsSync(run.output!)).toBe(true);
      expect(run.previews.length).toBe(p.scenes!.length);
      // Every step finished in order.
      expect(runs.at(-1)).toBe("ddddd");
      const probe = await engine.call("media.probe", { path: run.output });
      expect(probe.probe).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
      expect(probe.probe.durationSeconds).toBeGreaterThan(10);
      const read = await engine.call("project.read", { project: run.evercutProject });
      const names = read.activeTimeline.tracks.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(["Captions", "Scenes", "Voice", "Music"]));
    } finally {
      engine.stop();
    }
  }, 240_000);
});
