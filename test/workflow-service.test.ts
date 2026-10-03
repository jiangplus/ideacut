// The service behind the UI: staleness rules and a full demo run that persists its result.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workflow } from "../src/main/workflow";

const home = mkdtempSync(join(tmpdir(), "ideacut-svc-"));
beforeAll(() => {
  process.env.IDEACUT_HOME = home;
  process.env.EVERCUT_HOME = join(home, "evercut");
  process.env.EVERCUT_NO_KEYCHAIN = "1";
  delete process.env.MINIMAX_API_KEY;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("workflow service (demo mode)", () => {
  it("tracks stale steps and produces a saved video", async () => {
    const seen: string[] = [];
    const wf = new Workflow(resolve(__dirname, ".."), (p) => seen.push(p.run?.status ?? ""));
    expect((await wf.status()).demo).toBe(true);
    let p = await wf.create("会议纪要助手：自动把会议录音整理成待办和决议", { duration: 30, aspect: "9:16" });
    expect(p.spec.voiceId).toBe("demo-male");

    p = (await wf.questions(p.id)).project;
    p = wf.update(p.id, { answers: [{ questionId: "q1", choices: ["中小团队"], note: "" }] });
    p = (await wf.plan(p.id)).project;
    p = (await wf.storyboard(p.id)).project;
    expect(p.stale).toEqual([]);

    // Editing the plan makes the storyboard stale (not the questions).
    p = wf.update(p.id, { plan: { ...p.plan!, oneLiner: "开完会，待办自动出来" } });
    expect(p.stale).toEqual(["storyboard"]);
    p = (await wf.storyboard(p.id)).project;
    expect(p.stale).toEqual([]);

    const shot = join(home, "app.png");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#334455:s=1080x1920", "-frames:v", "1", shot]);
    p = wf.addMaterial(p.id, shot, "app home screen");
    expect(p.idea.materials[0]).toMatchObject({ id: "img1", note: "app home screen" });
    expect(p.stale).toEqual(expect.arrayContaining(["plan", "storyboard"]));
    p = (await wf.plan(p.id)).project;
    p = (await wf.storyboard(p.id)).project;

    p = await wf.produce(p.id);
    expect(p.run?.status).toBe("done");
    expect(existsSync(p.run!.output!)).toBe(true);
    expect(seen).toContain("running");
    expect(wf.videoOutdated(p)).toBe(false);
    // A later storyboard edit marks the video as outdated.
    p = wf.update(p.id, { scenes: p.scenes!.map((s, i) => (i === 0 ? { ...s, narration: `${s.narration}！` } : s)) });
    expect(p.stale).toContain("video");
    expect(wf.videoOutdated(p)).toBe(true);
    expect(wf.list()[0]).toMatchObject({ id: p.id, hasVideo: true });
    wf.shutdown();
  }, 240_000);
});
