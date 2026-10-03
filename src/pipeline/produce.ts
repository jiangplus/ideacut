// One click from storyboard to video: voice-over → music → EverCut project → preview check → render.
// Every sub-step reports progress; voice and music are cached by content hash, so re-running
// after a small edit only redoes what changed.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sceneIssues, type IdeaProject, type ProduceStep, type Run } from "../shared/project";
import type { TemplateId } from "../shared/templates";
import { templateSource } from "../templates";
import { ambientPad, audioDuration } from "./audio";
import { compileTimeline, type SceneVoice } from "./compile";
import type { EverCutEngine } from "./evercut";
import { withRetry, type Provider } from "./minimax";

export const PRODUCE_STEPS: { key: string; label: string }[] = [
  { key: "voice", label: "生成配音" },
  { key: "music", label: "生成配乐" },
  { key: "assemble", label: "搭建视频工程" },
  { key: "preview", label: "检查画面" },
  { key: "render", label: "渲染视频" },
];

export interface ProduceContext {
  project: IdeaProject;
  dir: string;
  provider: Provider;
  engine: EverCutEngine;
  /** Called whenever progress changes; persist and forward to the UI. */
  onRun: (run: Run) => void;
  /** Steps already finished before production (the writing stages of a one-click run). */
  before?: ProduceStep[];
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export function inputHash(p: IdeaProject): string {
  return sha(JSON.stringify({ spec: p.spec, scenes: p.scenes, materials: p.idea.materials, title: p.title }));
}

export async function produce(ctx: ProduceContext): Promise<Run> {
  const { project: p, dir, provider, engine } = ctx;
  const steps: ProduceStep[] = [...(ctx.before ?? []), ...PRODUCE_STEPS.map((s) => ({ ...s, status: "pending" as const, detail: "" }))];
  const run: Run = { status: "running", steps, previews: [], startedAt: p.run?.status === "running" && ctx.before ? p.run.startedAt : new Date().toISOString() };
  const emit = () => ctx.onRun(structuredClone(run));
  const step = (key: string) => steps.find((s) => s.key === key)!;
  const begin = (key: string, detail = "") => {
    Object.assign(step(key), { status: "running", detail });
    emit();
  };
  const finish = (key: string, detail = "", status: ProduceStep["status"] = "done") => {
    Object.assign(step(key), { status, detail });
    emit();
  };

  try {
    const scenes = p.scenes ?? [];
    if (!scenes.length) throw new Error("没有分镜，请先生成分镜");
    const problems = scenes.flatMap((s) => sceneIssues(s, p.idea.materials));
    if (problems.length) throw new Error(`分镜有问题：\n${problems.join("\n")}`);

    // 1. Voice-over, one clip per scene.
    begin("voice", `0/${scenes.length}`);
    mkdirSync(join(dir, "audio"), { recursive: true });
    const voiceId = p.spec.voiceId || "demo-male";
    const voices: (SceneVoice & { file: string })[] = [];
    for (const [i, scene] of scenes.entries()) {
      const key = sha(JSON.stringify([provider.demo, voiceId, p.spec.language, scene.narration]));
      const file = join(dir, "audio", `voice-${key}.mp3`);
      const meta = `${file}.json`;
      let sentences: SceneVoice["sentences"];
      if (!existsSync(file)) {
        const r = await withRetry(() => provider.speech(scene.narration, { voiceId, language: p.spec.language }));
        writeFileSync(file, r.audio);
        writeFileSync(meta, JSON.stringify({ sentences: r.sentences ?? null }));
        sentences = r.sentences;
      } else if (existsSync(meta)) {
        sentences = (JSON.parse(readFileSync(meta, "utf8")) as { sentences?: SceneVoice["sentences"] }).sentences ?? undefined;
      }
      voices.push({ sceneId: scene.id, file, seconds: await audioDuration(file), sentences });
      begin("voice", `${i + 1}/${scenes.length}`);
    }
    const speech = voices.reduce((n, v) => n + v.seconds, 0);
    finish("voice", `${scenes.length} 段，共 ${speech.toFixed(1)} 秒${provider.demo ? "（演示模式：无声）" : ""}`);

    // 2. Background music (optional). AI music first, then the built-in pad.
    let music: { file: string; seconds: number } | undefined;
    if (p.spec.music) {
      begin("music");
      const seconds = Math.ceil(speech + scenes.length * 1.2 + 4);
      const prompt = `Instrumental background music for a startup product intro video, ${p.spec.theme === "ember" ? "warm, hopeful" : "modern, confident, techy"}, light electronic, steady 110 BPM, no vocals, unobtrusive under voice-over.`;
      const key = sha(JSON.stringify([provider.demo, prompt]));
      const file = join(dir, "audio", `music-${key}.mp3`);
      let note = "AI 配乐";
      if (!existsSync(file)) {
        try {
          writeFileSync(file, await withRetry(() => provider.music(prompt, seconds), 2));
          if (provider.demo) note = "内置配乐";
        } catch (err) {
          await ambientPad(Math.max(30, seconds), file);
          note = `内置配乐（AI 配乐不可用：${(err as Error).message.slice(0, 80)}）`;
        }
      }
      music = { file, seconds: await audioDuration(file) };
      finish("music", note);
    } else {
      finish("music", "已关闭", "skipped");
    }

    // 3. EverCut project: templates, media, timeline.
    begin("assemble", "启动 EverCut 引擎");
    await engine.start();
    const bundle = join(dir, "video.evercut");
    rmSync(bundle, { recursive: true, force: true });
    const [width, height] = p.spec.aspect === "9:16" ? [1080, 1920] : [1920, 1080];
    const created = await engine.call("project.create", { dir: bundle, name: p.title, width, height, fps: 30 });
    const tracks = { video: created.activeTimeline.tracks.find((t: any) => t.kind === "video").id, audio: created.activeTimeline.tracks.find((t: any) => t.kind === "audio").id };
    begin("assemble", "导入素材");
    const usedImages = new Set(scenes.map((s) => (s.fields as { image?: string }).image).filter(Boolean) as string[]);
    const materials = p.idea.materials.filter((m) => usedImages.has(m.id));
    const paths = [...voices.map((v) => v.file), ...materials.map((m) => join(dir, m.path)), ...(music ? [music.file] : [])];
    const { assets } = await engine.call("asset.import", { project: bundle, paths });
    voices.forEach((v, i) => (v.assetId = assets[i].id));
    const materialPaths: Record<string, string> = {};
    materials.forEach((m, i) => (materialPaths[m.id] = assets[voices.length + i].path));
    const musicAsset = music ? { assetId: assets[assets.length - 1].id as string, seconds: music.seconds } : undefined;
    begin("assemble", "加载动画模板");
    const templateAssets: Partial<Record<TemplateId, string>> = {};
    for (const t of [...new Set(scenes.map((s) => s.template))]) {
      const { asset } = await engine.call("mg.create", { project: bundle, name: `ideacut-${t}`, code: templateSource(t), id: `ast_tpl_${t}` });
      templateAssets[t] = asset.id;
    }
    begin("assemble", "排时间线");
    const compiled = compileTimeline({ project: p, width, height, fps: 30, voices, templateAssets, materialPaths, music: musicAsset, tracks });
    await engine.call("timeline.apply", { project: bundle, label: "IdeaCut storyboard", ops: compiled.ops });
    run.evercutProject = bundle;
    finish("assemble", `${scenes.length} 个镜头，${(compiled.totalFrames / 30).toFixed(1)} 秒`);

    // 4. Preview stills of every scene (shown in the app, and proof that rendering works).
    begin("preview");
    const at = compiled.sceneStarts.map((s, i) => Math.min(compiled.totalFrames - 1, s + Math.round(((compiled.sceneStarts[i + 1] ?? compiled.totalFrames) - s) * 0.6)));
    const previewsDir = join(dir, "previews");
    rmSync(previewsDir, { recursive: true, force: true });
    const { files } = await engine.call("preview.frames", { project: bundle, frames: at, outDir: previewsDir, width: 640 });
    run.previews = files;
    finish("preview", `${files.length} 张`);

    // 5. Render.
    begin("render", "0%");
    const off = engine.on((method, params) => {
      if (method === "job.progress" && params.phase === "frames" && params.total) begin("render", `${Math.round((params.done / params.total) * 100)}%`);
    });
    const output = join(dir, "video.mp4");
    const tmp = join(dir, "video.rendering.mp4");
    try {
      const job = await engine.call("render.start", { project: bundle, output: tmp, preset: "mp4", quality: 0.85, wait: true });
      if (job.status !== "done") throw new Error(job.error ?? "render failed");
    } finally {
      off();
    }
    copyFileSync(tmp, output);
    rmSync(tmp, { force: true });
    finish("render", `${(compiled.totalFrames / 30).toFixed(1)} 秒 · ${width}×${height}`);

    Object.assign(run, { status: "done", output, finishedAt: new Date().toISOString(), inputHash: inputHash(p) });
    emit();
    return run;
  } catch (err) {
    const running = steps.find((s) => s.status === "running");
    if (running) Object.assign(running, { status: "error", detail: (err as Error).message.slice(0, 300) });
    Object.assign(run, { status: "error", error: (err as Error).message, finishedAt: new Date().toISOString() });
    emit();
    return run;
  }
}
