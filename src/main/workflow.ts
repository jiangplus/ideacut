// The workflow service behind the UI: project CRUD, the five steps, staleness tracking.
// One instance per app; all state lives in project folders.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chosenConcept, IdeaProject, Spec, type Answer, type Idea, type Plan, type ProduceStep, type Run, type Scene, type StepKey } from "../shared/project";
import { DemoProvider } from "../pipeline/demo";
import { checkEverCutBuilt, EverCutEngine, locateEverCut } from "../pipeline/evercut";
import { getMiniMaxBaseUrl, getMiniMaxKey, maskKey, setMiniMaxBaseUrl, setMiniMaxKey } from "../pipeline/keys";
import { callLog, detectRegion, MiniMax, type Provider, type Voice } from "../pipeline/minimax";
import { inputHash, produce, PRODUCE_STEPS } from "../pipeline/produce";
import { expandConcept, generateConcepts } from "../pipeline/story";
import { downstream, ProjectStore } from "../pipeline/store";
import { generatePlan, generateQuestions, generateStoryboard } from "../pipeline/writing";

export interface ProjectPatch {
  title?: string;
  spec?: Partial<Spec>;
  idea?: Partial<Idea>;
  answers?: Answer[];
  plan?: Plan;
  conceptId?: string;
  scenes?: Scene[];
}

/** Writing stages shown before production in a one-click run. */
const WRITE_STEPS = [
  { key: "plan", label: "梳理项目要点" },
  { key: "concepts", label: "构思 20 个故事，评委打分" },
  { key: "storyboard", label: "写分镜（3 稿择优）" },
];

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
    // Demo voices are placeholders; an empty id is resolved to a real voice at production time.
    const voice = spec.voiceId || (await this.defaultVoice(spec.language ?? "zh"));
    return this.store.create({ text, spec: { ...spec, voiceId: isDemoVoice(voice) ? "" : voice } });
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

  /**
   * A voice MiniMax will accept for this spec. The saved id can be empty (language changed),
   * a demo placeholder (project made before a key was set) or from another platform's list.
   */
  private async usableVoice(spec: Spec): Promise<string> {
    const want = spec.voiceId ?? "";
    let known: Voice[] | undefined;
    try {
      known = await this.voices();
    } catch {
      /* list unavailable: trust a real-looking saved id */
    }
    if (want && !isDemoVoice(want) && (!known || known.some((v) => v.id === want))) return want;
    const fallback = await this.defaultVoice(spec.language);
    if (!fallback) throw new Error("无法获取 MiniMax 音色列表，请检查网络后重试");
    return fallback;
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
    if (patch.conceptId !== undefined && patch.conceptId !== chosenConcept(p)?.id) {
      next.conceptId = patch.conceptId;
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
    return this.logged(id, () => this.questionsStep(id));
  }

  private async questionsStep(id: string) {
    const p = this.store.load(id);
    const provider = await this.provider(id);
    const r = await generateQuestions(provider, p);
    return { project: this.finishStep(p, "questions", (x) => ({ ...x, questions: r.value, answers: [], demo: provider.demo }), !!p.questions), usedFallback: r.usedFallback };
  }

  /** The plan, then story concepts drafted and ranked from it (the "story" step). */
  async plan(id: string, onPlanned?: () => void) {
    return this.logged(id, () => this.planStep(id, onPlanned));
  }

  private async planStep(id: string, onPlanned?: () => void) {
    const p = this.store.load(id);
    const provider = await this.provider(id);
    const r = await generatePlan(provider, p);
    const withPlan = this.store.save({ ...p, plan: r.value, title: p.title || r.value.name });
    onPlanned?.();
    const c = await generateConcepts(provider, withPlan);
    const project = this.finishStep(p, "plan", (x) => ({ ...x, plan: r.value, concepts: c.concepts, conceptId: c.concepts[0]?.id, title: x.title || r.value.name, demo: provider.demo }), !!p.plan);
    return { project, usedFallback: r.usedFallback || c.fallbackBatches > 0 };
  }

  /** A fresh set of story concepts for the current plan. */
  async concepts(id: string) {
    return this.logged(id, () => this.conceptsStep(id));
  }

  private async conceptsStep(id: string) {
    const p = this.store.load(id);
    if (!p.plan) throw new Error("请先生成方案");
    const provider = await this.provider(id);
    const c = await generateConcepts(provider, p);
    const project = this.finishStep(p, "plan", (x) => ({ ...x, concepts: c.concepts, conceptId: c.concepts[0]?.id }), !!p.scenes);
    return { project, usedFallback: c.fallbackBatches > 0 };
  }

  async storyboard(id: string) {
    return this.logged(id, () => this.storyboardStep(id));
  }

  private async storyboardStep(id: string) {
    let p = this.store.load(id);
    const provider = await this.provider(id);
    // A concept the user picked from the list hasn't been expanded into beats yet.
    const chosen = chosenConcept(p);
    if (chosen && !chosen.beats.length) {
      const expanded = await expandConcept(provider, p, chosen);
      p = this.store.save({ ...p, concepts: p.concepts!.map((c) => (c.id === expanded.id ? expanded : c)) });
    }
    const r = await generateStoryboard(provider, p);
    return { project: this.finishStep(p, "storyboard", (x) => ({ ...x, scenes: r.value, demo: provider.demo }), !!p.scenes), usedFallback: r.usedFallback, drafts: r.drafts, reason: r.reason };
  }

  async produce(id: string) {
    if (this.running.has(id)) throw new Error("视频已在生成中");
    this.running.add(id);
    try {
      return await this.runProduce(id);
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * One click from idea to video: plan → story concepts → storyboard → production, reusing
   * whatever is already done and up to date. Progress shows in the video step.
   */
  async autopilot(id: string) {
    return this.logged(id, () => this.autopilotRun(id));
  }

  /** Runs `fn` with model calls logged to the project's calls.jsonl (for debugging slow or failed runs). */
  private logged<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return callLog.run(join(this.store.dir(id), "calls.jsonl"), fn);
  }

  private async autopilotRun(id: string) {
    if (this.running.has(id)) throw new Error("视频已在生成中");
    this.running.add(id);
    const steps: ProduceStep[] = [...WRITE_STEPS, ...PRODUCE_STEPS].map((s) => ({ ...s, status: "pending", detail: "" }));
    const run: Run = { status: "running", steps, previews: [], startedAt: new Date().toISOString() };
    const emit = () => this.notify(this.store.save({ ...this.store.load(id), run: structuredClone(run) }));
    const set = (key: string, status: ProduceStep["status"], detail = "") => {
      Object.assign(steps.find((s) => s.key === key)!, { status, detail });
      emit();
    };
    try {
      emit();
      let p = this.store.load(id);
      if (!p.plan || !p.concepts?.length || p.stale.includes("plan")) {
        set("plan", "running");
        p = (await this.plan(id, () => {
          set("plan", "done", this.store.load(id).plan?.oneLiner ?? "");
          set("concepts", "running", "并行起草、评委打分中…");
        })).project;
      }
      set("plan", "done", p.plan!.oneLiner);
      const best = chosenConcept(p);
      set("concepts", "done", best ? `${p.concepts!.length} 个方案，选中「${best.title}」${best.score !== undefined ? `（${best.score} 分）` : ""}` : "");
      if (!p.scenes?.length || p.stale.includes("storyboard")) {
        set("storyboard", "running", "3 稿并行起草中…");
        const r = await this.storyboard(id);
        p = r.project;
        set("storyboard", "done", `${p.scenes!.length} 个镜头${r.drafts > 1 ? `，${r.drafts} 稿中选出：${r.reason}` : ""}`);
      } else set("storyboard", "done", `${p.scenes!.length} 个镜头`);
      return await this.runProduce(id, steps.slice(0, WRITE_STEPS.length));
    } catch (err) {
      const running = steps.find((s) => s.status === "running");
      if (running) Object.assign(running, { status: "error", detail: (err as Error).message.slice(0, 300) });
      Object.assign(run, { status: "error", error: (err as Error).message, finishedAt: new Date().toISOString() });
      emit();
      return this.store.load(id);
    } finally {
      this.running.delete(id);
    }
  }

  private async runProduce(id: string, before?: ProduceStep[]) {
    let p = this.store.load(id);
    const provider = await this.provider(id);
    if (!provider.demo) {
      const voiceId = await this.usableVoice(p.spec);
      if (voiceId !== p.spec.voiceId) p = this.store.save({ ...p, spec: { ...p.spec, voiceId } });
    }
    const run = await produce({
      project: p,
      dir: this.store.dir(id),
      provider,
      engine: this.getEngine(),
      before,
      onRun: (r) => {
        p = this.store.save({ ...this.store.load(id), run: r });
        this.notify(p);
      },
    });
    p = this.store.load(id);
    if (run.status === "done") p = this.store.save({ ...p, stale: p.stale.filter((k) => k !== "video"), demo: provider.demo });
    return p;
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

const isDemoVoice = (id: string) => id.startsWith("demo");
