import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IdeaProject, Spec, StepKey } from "../shared/project";
import { api, type AppStatus, type ProjectSummary } from "./api";
import { autopilot, IdeaStep, PlanStep, QuestionsStep, StoryboardStep, VideoStep } from "./steps";
import { SpecForm } from "./spec";
import "./styles.css";

const STEPS: { key: StepKey; label: string }[] = [
  { key: "idea", label: "想法" },
  { key: "questions", label: "追问" },
  { key: "plan", label: "故事" },
  { key: "storyboard", label: "分镜" },
  { key: "video", label: "视频" },
];

/** The furthest step a project has reached. */
function reached(p: IdeaProject): StepKey {
  if (p.run?.output || p.run?.status === "running") return "video";
  if (p.scenes) return "storyboard";
  if (p.plan) return "plan";
  if (p.questions) return "questions";
  return "idea";
}

export interface Ctx {
  project: IdeaProject;
  setProject: (p: IdeaProject) => void;
  go: (s: StepKey) => void;
  busy: string | null;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  status: AppStatus;
}

function Settings({ status, onClose, onSaved }: { status: AppStatus; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>设置</h2>
        <h3>MiniMax API Key</h3>
        <p className="muted">
          IdeaCut 用 MiniMax 完成写作、配音和配乐，费用由 MiniMax 直接计入你的账户。Key 存在系统钥匙串里，与 EverCut 共用。
          {status.key.configured ? (
            <>
              {" "}当前：<code>{status.key.masked}</code>（{status.key.source === "keychain" ? "钥匙串" : status.key.source === "env" ? "环境变量" : "本地文件"}
              {status.key.region ? ` · ${status.key.region.includes("minimaxi") ? "国内站" : "国际站"}` : ""}
              {status.key.model ? ` · ${status.key.model}` : ""}）。
            </>
          ) : (
            " 当前未设置，使用演示模式。"
          )}
        </p>
        <input type="password" value={key} placeholder="粘贴 MiniMax API Key" onChange={(e) => setKey(e.target.value)} />
        {msg && <p className={msg.startsWith("已保存") ? "ok" : "err"}>{msg}</p>}
        <h3>EverCut</h3>
        <p className="muted">{status.evercut.problems.length ? status.evercut.problems.join("；") : `已连接：${status.evercut.dir}`}</p>
        <div className="actions">
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={busy || key.trim().length < 8}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              try {
                const r = await api.setKey(key);
                setMsg(`已保存（${r.stored === "keychain" ? "系统钥匙串" : "本地文件"}，${r.region.includes("minimaxi") ? "国内站" : "国际站"}）：${r.masked}`);
                setKey("");
                onSaved();
              } catch (err) {
                setMsg((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "验证中…" : "验证并保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewProject({ onCreated, status }: { onCreated: (p: IdeaProject, quick: boolean) => void; status: AppStatus }) {
  const [text, setText] = useState("");
  const [spec, setSpec] = useState<Partial<Spec>>({ duration: 60, aspect: "16:9", language: "zh", theme: "midnight", music: true, captions: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async (quick: boolean) => {
    setBusy(true);
    try {
      onCreated(await api.create(text, spec), quick);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="welcome">
      <h1>
        Idea<span>Cut</span>
      </h1>
      <p className="muted">从一个想法，到一支项目介绍视频。</p>
      <textarea className="idea-input" autoFocus rows={4} value={text} placeholder="用一两句话描述你的项目，例如：PPT 生成器——上传文档，一键生成可编辑的演示文稿" onChange={(e) => setText(e.target.value)} />
      <SpecForm spec={spec} onChange={(s) => setSpec({ ...spec, ...s })} compact />
      {err && <p className="err">{err}</p>}
      <div className="start">
        <button disabled={busy || text.trim().length < 4} onClick={() => void start(false)} title="逐步确认问题、故事和分镜">
          逐步打磨
        </button>
        <button className="primary big" disabled={busy || text.trim().length < 4} onClick={() => void start(true)} title="AI 构思 20 个故事选出最好的，写分镜，直接成片；之后每一步都还能改">
          ⚡ 一键成片
        </button>
      </div>
      {status.demo && <p className="muted small">未设置 MiniMax Key：将以演示模式运行（规则生成文案、无声配音），可在左下角“设置”中添加。</p>}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<IdeaProject | null>(null);
  const [step, setStep] = useState<StepKey>("idea");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const refreshList = useCallback(() => void api.list().then(setProjects), []);
  const refreshStatus = useCallback(() => void api.status().then(setStatus), []);
  useEffect(() => {
    refreshStatus();
    refreshList();
    // `#open=<id>&step=<key>` deep link (used by dev screenshots).
    const h = new URLSearchParams(location.hash.slice(1));
    const id = h.get("open");
    if (id)
      void api.load(id).then((p) => {
        setProject(p);
        setStep((h.get("step") as StepKey) ?? reached(p));
      });
  }, [refreshList, refreshStatus]);
  useEffect(() => window.ideacut.onProjectChanged((p) => setProject((cur) => (cur && cur.id === p.id ? p : cur))), []);

  const open = async (id: string) => {
    const p = await api.load(id);
    setProject(p);
    setStep(reached(p));
    setError(null);
  };

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(null);
      refreshList();
    }
  }, [refreshList]);

  if (!status) return <div className="loading">IdeaCut</div>;
  const ctx: Ctx | null = project ? { project, setProject, go: setStep, busy, run, status } : null;
  const reach = project ? STEPS.findIndex((s) => s.key === reached(project)) : 0;

  return (
    <div className="app">
      <aside className="side">
        <div className="logo">
          Idea<span>Cut</span>
        </div>
        <button className="new" onClick={() => { setProject(null); setError(null); }}>＋ 新项目</button>
        <div className="plist">
          {projects.map((p) => (
            <button key={p.id} className={`pitem ${project?.id === p.id ? "on" : ""}`} onClick={() => void open(p.id)}>
              <span>{p.title}</span>
              <small>{p.hasVideo ? "🎬 " : ""}{p.updatedAt.slice(5, 16).replace("T", " ")}</small>
            </button>
          ))}
        </div>
        <button className="settings" onClick={() => setSettings(true)}>
          设置 {status.demo ? <em className="demo">演示模式</em> : <em className="okdot">●</em>}
        </button>
      </aside>
      <main className="main">
        {status.evercut.problems.length > 0 && <div className="banner err">{status.evercut.problems[0]}</div>}
        {!ctx ? (
          <NewProject
            status={status}
            onCreated={(p, quick) => {
              setProject(p);
              setStep("idea");
              refreshList();
              if (quick) void autopilot({ project: p, setProject, go: setStep, busy, run, status });
            }}
          />
        ) : (
          <>
            <header className="phead">
              <input className="ptitle" value={ctx.project.title} onChange={(e) => setProject({ ...ctx.project, title: e.target.value })} onBlur={(e) => void api.update(ctx.project.id, { title: e.target.value }).then(setProject)} />
              <nav className="stepper">
                {STEPS.map((s, i) => (
                  <button key={s.key} className={`st ${step === s.key ? "on" : ""} ${i <= reach ? "done" : ""} ${ctx.project.stale.includes(s.key) ? "stale" : ""}`} disabled={i > reach || !!busy} onClick={() => setStep(s.key)}>
                    <b>{i + 1}</b> {s.label}
                  </button>
                ))}
              </nav>
              <button className="ghost" title="删除项目" onClick={async () => { if (confirm(`删除「${ctx.project.title}」？`)) { await api.remove(ctx.project.id); setProject(null); refreshList(); } }}>🗑</button>
            </header>
            {ctx.project.demo && !status.demo && <div className="banner">部分内容是在演示模式下生成的，设置好 Key 后可重新生成。</div>}
            {error && <div className="banner err" onClick={() => setError(null)}>{error}</div>}
            <section className="body">
              {step === "idea" && <IdeaStep ctx={ctx} />}
              {step === "questions" && <QuestionsStep ctx={ctx} />}
              {step === "plan" && <PlanStep ctx={ctx} />}
              {step === "storyboard" && <StoryboardStep ctx={ctx} />}
              {step === "video" && <VideoStep ctx={ctx} />}
            </section>
          </>
        )}
      </main>
      {settings && <Settings status={status} onClose={() => setSettings(false)} onSaved={refreshStatus} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
