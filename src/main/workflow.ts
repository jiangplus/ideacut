// The workflow service behind the UI: project CRUD, the five steps, staleness tracking.
// One instance per app; all state lives in project folders.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { IdeaProject, Spec, type Answer, type Idea, type Plan, type Scene, type StepKey } from "../shared/project";
import { DemoProvider } from "../pipeline/demo";
import { checkEverCutBuilt, EverCutEngine, locateEverCut } from "../pipeline/evercut";
import { getMiniMaxBaseUrl, getMiniMaxKey, maskKey, setMiniMaxBaseUrl, setMiniMaxKey } from "../pipeline/keys";
import { detectRegion, MiniMax, type Provider, type Voice } from "../pipeline/minimax";
import { inputHash, produce } from "../pipeline/produce";
import { downstream, ProjectStore } from "../pipeline/store";
import { generatePlan, generateQuestions, generateStoryboard } from "../pipeline/writing";

export interface ProjectPatch {
  title?: string;
  spec?: Partial<Spec>;
  idea?: Partial<Idea>;
  answers?: Answer[];
  plan?: Plan;
  scenes?: Scene[];
}

export class Workflow {
  readonly store = new ProjectStore();
  private engine?: EverCutEngine;
  private evercutDir?: string;
  private voicesCache?: Voice[];
  private running = new Set<string>();

  constructor(
    private readonly appRoot: string,
    private readonly notify: (project: IdeaProject) => void,
  ) {}

  async status() {
    let evercut: { dir?: string; problems: string[] };
    try {
      const dir = locateEverCut(this.appRoot);
      evercut = { dir, problems: checkEverCutBuilt(dir) };
    } catch (err) {
      evercut = { problems: [(err as Error).message] };
    }
    const key = process.env.IDEACUT_FORCE_DEMO ? undefined : await getMiniMaxKey();
    let model: string | undefined;
    if (key) model = await (await this.client())?.model().catch(() => undefined);
    return {
      evercut,
      key: key ? { configured: true, masked: maskKey(key.key), source: key.source, region: (await this.baseUrl()) ?? "", model } : { configured: false },
      demo: !key,
    };
  }

  async setKey(key: string) {
    // A free call that proves the key works (and finds its platform) before storing it.
    const baseUrl = await detectRegion(key.trim());
    const where = await setMiniMaxKey(key.trim());
    setMiniMaxBaseUrl(baseUrl);
    this.voicesCache = undefined;
    this.cached = undefined;
    return { stored: where, masked: maskKey(key.trim()), region: baseUrl };
  }

  private cached?: MiniMax;

  /** Platform for the current key: the saved setting, or detected once and saved. */
  private async baseUrl(): Promise<string | undefined> {
    const key = await getMiniMaxKey();
    if (!key) return undefined;
    const saved = getMiniMaxBaseUrl();
    if (saved) return saved;
    const found = await detectRegion(key.key).catch(() => undefined);
    if (found) setMiniMaxBaseUrl(found);
    return found;
  }

  private async client(): Promise<MiniMax | undefined> {
    if (process.env.IDEACUT_FORCE_DEMO) return undefined;
    if (this.cached) return this.cached;
    const key = await getMiniMaxKey();
    if (!key) return undefined;
    this.cached = new MiniMax(key.key, await this.baseUrl());
    return this.cached;
  }

  private async provider(projectId: string): Promise<Provider> {
    return (await this.client()) ?? new DemoProvider(() => this.store.load(projectId));
  }

  async voices(): Promise<Voice[]> {
    if (this.voicesCache) return this.voicesCache;
    const client = await this.client();
    if (!client) return new DemoProvider(() => undefined as never).voices();
    this.voicesCache = await client.voices();
    return this.voicesCache;
  }

  private getEngine(): EverCutEngine {
    if (!this.engine) {
      this.evercutDir ??= locateEverCut(this.appRoot);
      this.engine = new EverCutEngine(this.evercutDir);
    }
    return this.engine;
  }

  shutdown() {
    this.engine?.stop();
  }

  // ---------- projects ----------

  list() {
    return this.store.list();
  }

  async create(text: string, spec: Partial<Spec>) {
    const voice = spec.voiceId || (await this.defaultVoice(spec.language ?? "zh"));
    return this.store.create({ text, spec: { ...spec, voiceId: voice } });
  }

  private async defaultVoice(language: "zh" | "en"): Promise<string> {
    try {
      const voices = await this.voices();
      const pick = voices.find((v) => (language === "zh" ? /Chinese \(Mandarin\)_(Reliable_Executive|News_Anchor|Gentleman)/ : /English_(Persuasive_Man|Insightful_Speaker)/).test(v.id)) ?? voices.find((v) => v.id.startsWith(language === "zh" ? "Chinese" : "English")) ?? voices[0];
      return pick?.id ?? "";
    } catch {
      return "";
    }
  }

  load(id: string) {
    return this.store.load(id);
  }

  remove(id: string) {
    if (this.running.has(id)) throw new Error("正在生成视频，请稍后再删除");
    this.store.remove(id);
  }

  /** Applies user edits and marks the steps that depend on them as stale. */
  update(id: string, patch: ProjectPatch): IdeaProject {
    if (this.running.has(id)) throw new Error("正在生成视频，完成后再修改");
    const p = this.store.load(id);
    const stale = new Set<StepKey>(p.stale);
    const touch = (k: StepKey) => downstream(k).forEach((d) => stale.add(d));
    const next: IdeaProject = { ...p };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.idea) {
      next.idea = { ...p.idea, ...patch.idea };
      if (patch.idea.text !== undefined || patch.idea.details !== undefined || patch.idea.materials !== undefined) touch("questions");
    }
    if (patch.spec) {
      next.spec = Spec.parse({ ...p.spec, ...patch.spec });
      if (patch.spec.duration !== undefined && patch.spec.duration !== p.spec.duration) touch("plan");
      else if (patch.spec.language !== undefined && patch.spec.language !== p.spec.language) touch("questions");
      else touch("storyboard");
    }
    if (patch.answers) {
      next.answers = patch.answers;
      touch("questions");
    }
    if (patch.plan) {
      next.plan = patch.plan;
      touch("plan");
    }
    if (patch.scenes) {
      next.scenes = patch.scenes;
      touch("storyboard");
    }
    // Only mark steps that have output.
    next.stale = [...stale].filter((k) => (k === "questions" ? !!next.questions : k === "plan" ? !!next.plan : k === "storyboard" ? !!next.scenes : k === "video" ? !!next.run?.output : false));
    return this.store.save(IdeaProject.parse(next));
  }

  addMaterial(id: string, src: string, note = "") {
    const p = this.store.load(id);
    const m = this.store.addMaterial(id, src);
    const n = Math.max(0, ...p.idea.materials.map((x) => Number(x.id.replace(/\D/g, "")) || 0)) + 1;
    return this.update(id, { idea: { materials: [...p.idea.materials, { id: `img${n}`, path: m.path, name: m.name, note }] } });
  }

  // ---------- steps ----------

  private finishStep(p: IdeaProject, key: StepKey, apply: (p: IdeaProject) => IdeaProject, hadOutput: boolean): IdeaProject {
    const next = apply(p);
    const stale = new Set(next.stale.filter((k) => k !== key));
    if (hadOutput) downstream(key).forEach((d) => stale.add(d));
    next.stale = [...stale].filter((k) => (k === "plan" ? !!next.plan : k === "storyboard" ? !!next.scenes : k === "video" ? !!next.run?.output : k === "questions" ? !!next.questions : false));
    return this.store.save(next);
  }

  async questions(id: string) {
    const p = this.store.load(id);
    const provider = await this.provider(id);
    const r = await generateQuestions(provider, p);
    return { project: this.finishStep(p, "questions", (x) => ({ ...x, questions: r.value, answers: [], demo: provider.demo }), !!p.questions), usedFallback: r.usedFallback };
  }

  async plan(id: string) {
    const p = this.store.load(id);
    const provider = await this.provider(id);
    const r = await generatePlan(provider, p);
    return { project: this.finishStep(p, "plan", (x) => ({ ...x, plan: r.value, title: x.title || r.value.name, demo: provider.demo }), !!p.plan), usedFallback: r.usedFallback };
  }

  async storyboard(id: string) {
    const p = this.store.load(id);
    const provider = await this.provider(id);
    const r = await generateStoryboard(provider, p);
    return { project: this.finishStep(p, "storyboard", (x) => ({ ...x, scenes: r.value, demo: provider.demo }), !!p.scenes), usedFallback: r.usedFallback };
  }

  async produce(id: string) {
    if (this.running.has(id)) throw new Error("视频已在生成中");
    this.running.add(id);
    try {
      let p = this.store.load(id);
      const provider = await this.provider(id);
      const run = await produce({
        project: p,
        dir: this.store.dir(id),
        provider,
        engine: this.getEngine(),
        onRun: (r) => {
          p = this.store.save({ ...this.store.load(id), run: r });
          this.notify(p);
        },
      });
      p = this.store.load(id);
      if (run.status === "done") p = this.store.save({ ...p, stale: p.stale.filter((k) => k !== "video"), demo: provider.demo });
      return p;
    } finally {
      this.running.delete(id);
    }
  }

  isRunning(id: string) {
    return this.running.has(id);
  }

  /** True when the video was made from different inputs than the current ones. */
  videoOutdated(p: IdeaProject) {
    return !!p.run?.output && p.run.inputHash !== inputHash(p);
  }

  evercutBundle(id: string) {
    const bundle = join(this.store.dir(id), "video.evercut");
    if (!existsSync(join(bundle, "project.json"))) throw new Error("还没有生成视频工程");
    return { bundle, command: this.getEngine().studioCommand() };
  }
}
