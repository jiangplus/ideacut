import { useEffect, useState, type ReactNode } from "react";
import { narrationBudget, narrationLength, sceneIssues, type Answer, type IdeaProject, type Plan, type Scene } from "../shared/project";
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from "../shared/templates";
import { api, fileUrl, relInProject } from "./api";
import type { Ctx } from "./main";
import { SpecForm } from "./spec";

function Busy({ label }: { label: string }) {
  return (
    <div className="busy">
      <span className="spinner" /> {label}
    </div>
  );
}

function Footer({ ctx, children }: { ctx: Ctx; children: ReactNode }) {
  return <div className="footer">{ctx.busy ? <Busy label={ctx.busy} /> : children}</div>;
}

function StaleNote({ ctx, step, children }: { ctx: Ctx; step: "questions" | "plan" | "storyboard" | "video"; children: ReactNode }) {
  return ctx.project.stale.includes(step) ? <div className="stale-note">{children}</div> : null;
}

/** Text that saves on blur. */
function Field({ label, value, onSave, rows = 1, hint }: { label: string; value: string; onSave: (v: string) => void; rows?: number; hint?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      {rows > 1 ? <textarea rows={rows} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} /> : <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />}
      {hint && <em>{hint}</em>}
    </label>
  );
}

// ---------- 1. Idea ----------

export function IdeaStep({ ctx }: { ctx: Ctx }) {
  const { project: p, setProject } = ctx;
  const save = (patch: object) => ctx.run("保存中", () => api.update(p.id, patch).then(setProject));
  const next = async () => {
    if (p.questions && !p.stale.includes("questions")) return ctx.go("questions");
    const r = await ctx.run("AI 正在思考要问你的问题…", () => api.questions(p.id));
    if (r) {
      setProject(r.project);
      ctx.go("questions");
    }
  };
  return (
    <div className="step">
      <h2>说说你的想法</h2>
      <Field label="一句话想法" value={p.idea.text} rows={3} onSave={(text) => void save({ idea: { text } })} />
      <Field label="更多细节（可选）" value={p.idea.details} rows={5} hint="目标用户、已有进展、团队、链接……写得越具体，视频越准确" onSave={(details) => void save({ idea: { details } })} />
      <div className="field">
        <span>产品截图 / 配图（可选）</span>
        <div className="materials">
          {p.idea.materials.map((m) => (
            <div key={m.id} className="mat">
              <img src={fileUrl(p.id, m.path)} alt="" />
              <input
                placeholder="这张图是什么？"
                defaultValue={m.note}
                onBlur={(e) => e.target.value !== m.note && void save({ idea: { materials: p.idea.materials.map((x) => (x.id === m.id ? { ...x, note: e.target.value } : x)) } })}
              />
              <button className="x" title="移除" onClick={() => void save({ idea: { materials: p.idea.materials.filter((x) => x.id !== m.id) } })}>✕</button>
            </div>
          ))}
          <button className="add-mat" onClick={() => void ctx.run("添加图片", () => api.addMaterials(p.id).then(setProject))}>＋ 添加图片</button>
        </div>
      </div>
      <h3>视频设置</h3>
      <SpecForm spec={p.spec} onChange={(spec) => void save({ spec })} />
      <Footer ctx={ctx}>
        <button className="primary" disabled={p.idea.text.trim().length < 4} onClick={() => void next()}>
          下一步：AI 追问 →
        </button>
      </Footer>
    </div>
  );
}

// ---------- 2. Questions ----------

export function QuestionsStep({ ctx }: { ctx: Ctx }) {
  const { project: p, setProject } = ctx;
  const [answers, setAnswers] = useState<Answer[]>(p.answers);
  useEffect(() => setAnswers(p.answers), [p.answers]);
  const get = (id: string) => answers.find((a) => a.questionId === id) ?? { questionId: id, choices: [], note: "" };
  const set = (a: Answer) => setAnswers([...answers.filter((x) => x.questionId !== a.questionId), a]);
  const next = async () => {
    await api.update(p.id, { answers });
    const r = await ctx.run("AI 正在写项目方案…", () => api.plan(p.id));
    if (r) {
      setProject(r.project);
      ctx.go("plan");
    }
  };
  return (
    <div className="step">
      <h2>回答几个问题，让方案更扎实</h2>
      <p className="muted">点选最接近的答案，或者补充一句。都可以跳过。</p>
      <StaleNote ctx={ctx} step="questions">你修改了想法，可以换一批更贴切的问题。</StaleNote>
      {(p.questions ?? []).map((q, i) => {
        const a = get(q.id);
        return (
          <div key={q.id} className="qcard">
            <div className="q">
              <b>{i + 1}.</b> {q.question}
            </div>
            {q.why && <div className="why">{q.why}</div>}
            <div className="chips">
              {q.options.map((o) => {
                const on = a.choices.includes(o);
                return (
                  <button key={o} className={`chip ${on ? "on" : ""}`} onClick={() => set({ ...a, choices: q.multi ? (on ? a.choices.filter((c) => c !== o) : [...a.choices, o]) : on ? [] : [o] })}>
                    {o}
                  </button>
                );
              })}
            </div>
            <input className="note" placeholder="补充说明（可选）" value={a.note} onChange={(e) => set({ ...a, note: e.target.value })} />
          </div>
        );
      })}
      <Footer ctx={ctx}>
        <button onClick={() => void ctx.run("换一批问题…", () => api.questions(p.id).then((r) => setProject(r.project)))}>换一批问题</button>
        <button className="primary" onClick={() => void next()}>
          下一步：生成方案 →
        </button>
      </Footer>
    </div>
  );
}

// ---------- 3. Plan ----------

const PLAN_FIELDS: { key: keyof Plan; label: string; rows?: number; list?: boolean }[] = [
  { key: "name", label: "产品名" },
  { key: "oneLiner", label: "一句话介绍" },
  { key: "audience", label: "目标用户", rows: 2 },
  { key: "problem", label: "要解决的问题", rows: 3 },
  { key: "solution", label: "解决方案", rows: 3 },
  { key: "features", label: "核心功能（每行一个）", rows: 4, list: true },
  { key: "howItWorks", label: "使用流程（三步，每行一步）", rows: 3, list: true },
  { key: "differentiation", label: "差异化", rows: 2 },
  { key: "businessModel", label: "商业模式", rows: 2 },
  { key: "traction", label: "进展 / 数据（没有就留空，不要编）", rows: 2 },
  { key: "cta", label: "结尾号召" },
  { key: "contact", label: "链接 / 联系方式" },
];

export function PlanStep({ ctx }: { ctx: Ctx }) {
  const { project: p, setProject } = ctx;
  if (!p.plan) return null;
  const plan = p.plan;
  const save = (key: keyof Plan, v: string, list?: boolean) => {
    const value = list ? v.split("\n").map((s) => s.trim()).filter(Boolean) : v;
    void ctx.run("保存中", () => api.update(p.id, { plan: { ...plan, [key]: value } }).then(setProject));
  };
  const next = async () => {
    if (p.scenes && !p.stale.includes("storyboard")) return ctx.go("storyboard");
    const r = await ctx.run("AI 正在写分镜脚本…", () => api.storyboard(p.id));
    if (r) {
      setProject(r.project);
      ctx.go("storyboard");
    }
  };
  return (
    <div className="step">
      <h2>项目方案</h2>
      <p className="muted">视频会根据这份方案来写。直接修改任何一项。</p>
      <StaleNote ctx={ctx} step="plan">想法或回答有变化，可以重新生成方案。</StaleNote>
      <div className="plan-grid">
        {PLAN_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} rows={f.rows} value={f.list ? (plan[f.key] as string[]).join("\n") : String(plan[f.key] ?? "")} onSave={(v) => save(f.key, v, f.list)} />
        ))}
      </div>
      <Footer ctx={ctx}>
        <button onClick={() => void ctx.run("重新生成方案…", () => api.plan(p.id).then((r) => setProject(r.project)))}>重新生成</button>
        <button className="primary" onClick={() => void next()}>
          下一步：写分镜 →
        </button>
      </Footer>
    </div>
  );
}

// ---------- 4. Storyboard ----------

const FIELD_LABELS: Record<string, string> = {
  line: "画面文字",
  name: "产品名",
  tagline: "标语",
  heading: "标题",
  points: "要点",
  body: "说明",
  items: "功能",
  steps: "步骤",
  caption: "图注",
  stats: "数据",
  them: "其他方案",
  us: "我们",
  action: "号召",
  contact: "联系方式",
};
const fieldLabel = (k: string) => FIELD_LABELS[k] ?? k;

function SceneEditor({ p, scene, index, total, onChange, onMove, onDelete }: { p: IdeaProject; scene: Scene; index: number; total: number; onChange: (s: Scene) => void; onMove: (d: -1 | 1) => void; onDelete: () => void }) {
  const fields = scene.fields as Record<string, unknown>;
  const setField = (k: string, v: unknown) => onChange({ ...scene, fields: { ...fields, [k]: v } });
  const issues = sceneIssues(scene, p.idea.materials);
  const shape = TEMPLATES[scene.template].fields.shape as Record<string, unknown>;
  return (
    <div className={`scene ${issues.length ? "bad" : ""}`}>
      <div className="scene-head">
        <b>{index + 1}</b>
        <select value={scene.template} onChange={(e) => onChange({ ...scene, template: e.target.value as TemplateId })}>
          {TEMPLATE_IDS.filter((t) => t !== "screenshot" || p.idea.materials.length).map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}
        </select>
        <span className="grow" />
        <button className="ghost" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="ghost" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
        <button className="ghost" onClick={onDelete}>✕</button>
      </div>
      <div className="scene-body">
        <Field label="旁白" value={scene.narration} rows={3} hint={`${narrationLength(scene.narration, p.spec.language)} ${p.spec.language === "zh" ? "字" : "词"}`} onSave={(narration) => onChange({ ...scene, narration })} />
        <div className="scene-fields">
          {Object.keys(shape).map((k) => {
            const v = fields[k];
            if (k === "image") {
              return (
                <label key={k} className="field">
                  <span>图片</span>
                  <select value={String(v ?? "")} onChange={(e) => setField(k, e.target.value || undefined)}>
                    <option value="">（无）</option>
                    {p.idea.materials.map((m) => <option key={m.id} value={m.id}>{m.note || m.name}</option>)}
                  </select>
                </label>
              );
            }
            if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
              return <Field key={k} label={`${fieldLabel(k)}（每行一项）`} rows={Math.max(2, v.length)} value={(v as string[]).join("\n")} onSave={(t) => setField(k, t.split("\n").map((s) => s.trim()).filter(Boolean))} />;
            }
            if (Array.isArray(v)) {
              const first = (v[0] ?? {}) as Record<string, unknown>;
              const keys = Object.keys(first);
              return (
                <Field
                  key={k}
                  label={`${fieldLabel(k)}（每行：${keys.map((kk) => ({ icon: "图标", text: "文字", value: "数值", label: "说明" })[kk] ?? kk).join(" | ")}）`}
                  rows={Math.max(2, v.length)}
                  value={(v as Record<string, unknown>[]).map((o) => keys.map((kk) => String(o[kk] ?? "")).join(" | ")).join("\n")}
                  onSave={(t) => setField(k, t.split("\n").filter((l) => l.trim()).map((l) => Object.fromEntries(keys.map((kk, i) => [kk, (l.split("|")[i] ?? "").trim()]))))}
                />
              );
            }
            return <Field key={k} label={fieldLabel(k)} value={String(v ?? "")} onSave={(t) => setField(k, t)} />;
          })}
        </div>
      </div>
      {issues.length > 0 && <div className="err small">{issues.join("；")}</div>}
    </div>
  );
}

export function StoryboardStep({ ctx }: { ctx: Ctx }) {
  const { project: p, setProject } = ctx;
  const scenes = p.scenes ?? [];
  const save = (next: Scene[]) => void ctx.run("保存中", () => api.update(p.id, { scenes: next.map((s, i) => ({ ...s, id: s.id || `s${i + 1}` })) }).then(setProject));
  const budget = narrationBudget(p.spec);
  const total = scenes.reduce((n, s) => n + narrationLength(s.narration, p.spec.language), 0);
  const ratio = total / budget.chars;
  const bad = scenes.some((s) => sceneIssues(s, p.idea.materials).length);
  const produce = async () => {
    ctx.go("video");
    const r = await ctx.run("正在生成视频…", () => api.produce(p.id));
    if (r) setProject(r);
  };
  return (
    <div className="step wide">
      <h2>分镜脚本</h2>
      <p className="muted">
        每个镜头 = 一个动画模板 + 一段旁白。旁白共 {total} {p.spec.language === "zh" ? "字" : "词"}，目标约 {budget.chars}（{p.spec.duration} 秒）
        <span className={`meter ${ratio > 1.3 || ratio < 0.6 ? "warn" : ""}`}><i style={{ width: `${Math.min(100, ratio * 70)}%` }} /></span>
      </p>
      <StaleNote ctx={ctx} step="storyboard">方案有变化，可以重新生成分镜。</StaleNote>
      {scenes.map((s, i) => (
        <SceneEditor
          key={s.id}
          p={p}
          scene={s}
          index={i}
          total={scenes.length}
          onChange={(ns) => save(scenes.map((x) => (x.id === s.id ? ns : x)))}
          onMove={(d) => {
            const next = [...scenes];
            [next[i], next[i + d]] = [next[i + d]!, next[i]!];
            save(next);
          }}
          onDelete={() => save(scenes.filter((x) => x.id !== s.id))}
        />
      ))}
      <Footer ctx={ctx}>
        <button onClick={() => void ctx.run("重新写分镜…", () => api.storyboard(p.id).then((r) => setProject(r.project)))}>重新生成</button>
        <button className="primary" disabled={bad || scenes.length === 0} onClick={() => void produce()}>
          生成视频 →
        </button>
      </Footer>
    </div>
  );
}

// ---------- 5. Video ----------

const ICON: Record<string, string> = { pending: "○", running: "◐", done: "✓", skipped: "–", error: "✕" };

export function VideoStep({ ctx }: { ctx: Ctx }) {
  const { project: p, setProject } = ctx;
  const run = p.run;
  const [running, setRunning] = useState(false);
  useEffect(() => {
    void api.running(p.id).then(setRunning);
  }, [p.id, run?.status]);
  const produce = async () => {
    const r = await ctx.run("正在生成视频…", () => api.produce(p.id));
    if (r) setProject(r);
  };
  const busy = running || run?.status === "running" || !!ctx.busy;
  return (
    <div className="step wide">
      <h2>项目视频</h2>
      <StaleNote ctx={ctx} step="video">内容有修改，重新生成后视频才会更新。</StaleNote>
      {!run && !busy && (
        <div className="empty">
          <p>将依次完成：生成配音 → 生成配乐 → 搭建视频工程 → 检查画面 → 渲染视频。</p>
          <p className="muted">通常 1–3 分钟。生成后可以直接导出，也可以在 EverCut 里逐帧精修。</p>
        </div>
      )}
      {run && (
        <div className="progress-list">
          {run.steps.map((s) => (
            <div key={s.key} className={`pstep ${s.status}`}>
              <span className="icon">{s.status === "running" ? <span className="spinner" /> : ICON[s.status]}</span>
              <span className="label">{s.label}</span>
              <span className="detail">{s.detail}</span>
            </div>
          ))}
        </div>
      )}
      {run?.status === "error" && <div className="banner err">{run.error}</div>}
      {run?.output && run.status === "done" && (
        <div className="result">
          <div className="actions">
            <button className="primary" onClick={() => void ctx.run("导出", () => api.saveVideo(p.id))}>导出 MP4…</button>
            <button onClick={() => void api.revealVideo(p.id)}>在文件夹中显示</button>
            <button onClick={() => void ctx.run("打开 EverCut", () => api.openInEverCut(p.id))} title="在 EverCut 中逐帧精修（时间线、字幕、关键帧……）">在 EverCut 中精修</button>
          </div>
          <video key={run.finishedAt} src={fileUrl(p.id, "video.mp4", run.finishedAt)} controls className={p.spec.aspect === "9:16" ? "portrait" : ""} />
        </div>
      )}
      {run && run.previews.length > 0 && run.status !== "done" && (
        <div className="previews">
          {run.previews.map((f) => <img key={f} src={fileUrl(p.id, relInProject(p.id, f), run.startedAt)} alt="" />)}
        </div>
      )}
      <Footer ctx={ctx}>
        {!busy && (
          <button className={run?.output ? "" : "primary"} onClick={() => void produce()}>
            {run ? "重新生成视频" : "生成视频"}
          </button>
        )}
      </Footer>
    </div>
  );
}
