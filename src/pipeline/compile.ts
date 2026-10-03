// Storyboard + voice timings → one EverCut edit batch. Pure and deterministic: the same inputs
// always give the same timeline, which keeps the workflow predictable and testable.

import { THEMES, type IdeaProject, type Scene } from "../shared/project";
import type { TemplateId } from "../shared/templates";

export interface SceneVoice {
  sceneId: string;
  /** EverCut asset id of the voice-over audio. */
  assetId?: string;
  seconds: number;
  /** Sentence timings within the clip (ms), when the TTS returned them. */
  sentences?: { text: string; startMs: number; endMs: number }[];
}

export interface CompileInput {
  project: IdeaProject;
  width: number;
  height: number;
  fps: number;
  voices: SceneVoice[];
  templateAssets: Partial<Record<TemplateId, string>>;
  /** Material id → path inside the EverCut bundle (e.g. "media/shot.png"). */
  materialPaths: Record<string, string>;
  music?: { assetId: string; seconds: number };
  /** Existing tracks in the new EverCut project. */
  tracks: { video: string; audio: string };
}

export interface CaptionLine {
  text: string;
  start: number;
  end: number;
}

const LEAD = 0.35;
const TAIL = 0.55;
const MIN_SCENE = 2.5;

/** Splits narration into caption lines over `seconds` (sentence timings win when available). */
export function captionLines(narration: string, seconds: number, language: "zh" | "en", sentences?: SceneVoice["sentences"]): CaptionLine[] {
  const max = language === "zh" ? 16 : 42;
  const base: CaptionLine[] =
    sentences && sentences.length
      ? sentences.map((s) => ({ text: s.text.trim(), start: s.startMs / 1000, end: s.endMs / 1000 })).filter((s) => s.text)
      : [{ text: narration.trim(), start: 0, end: seconds }];
  const out: CaptionLine[] = [];
  for (const line of base) {
    const parts = splitText(line.text, max, language);
    const total = parts.reduce((n, p) => n + weight(p, language), 0) || 1;
    let t = line.start;
    for (const p of parts) {
      const d = ((line.end - line.start) * weight(p, language)) / total;
      out.push({ text: p, start: t, end: t + d });
      t += d;
    }
  }
  return out;
}

const weight = (s: string, language: "zh" | "en") => (language === "zh" ? s.replace(/\s/g, "").length : s.split(/\s+/).length);

function splitText(text: string, max: number, language: "zh" | "en"): string[] {
  // First at sentence/clause punctuation, then hard-wrap what is still too long.
  const pieces = text
    .split(language === "zh" ? /(?<=[。！？；，、])/ : /(?<=[.!?;,])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged: string[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && (last + p).length <= max) merged[merged.length - 1] = language === "zh" ? last + p : `${last} ${p}`;
    else merged.push(p);
  }
  const out: string[] = [];
  for (const m of merged) {
    if (m.length <= max) out.push(m.replace(/[，、,;；]$/, ""));
    else if (language === "zh") for (let i = 0; i < m.length; i += max) out.push(m.slice(i, i + max));
    else {
      let cur = "";
      for (const w of m.split(/\s+/)) {
        if ((cur + " " + w).trim().length > max && cur) {
          out.push(cur);
          cur = w;
        } else cur = `${cur} ${w}`.trim();
      }
      if (cur) out.push(cur);
    }
  }
  return out.filter(Boolean);
}

/** Template props for a scene: its fields, image path and the theme colors. */
export function sceneProps(scene: Scene, input: Pick<CompileInput, "project" | "materialPaths">): Record<string, unknown> {
  const t = THEMES[input.project.spec.theme];
  const props: Record<string, unknown> = { ...scene.fields, bg: t.bg, fg: t.fg, accent: t.accent, accent2: t.accent2, grad1: t.gradient[0], grad2: t.gradient[1], grad3: t.gradient[2] };
  const image = (scene.fields as { image?: string }).image;
  if (image) props.image = input.materialPaths[image] ?? "";
  if (scene.template === "compare" && input.project.spec.language === "en") Object.assign(props, { themLabel: "Others", usLabel: "Us" });
  return props;
}

export function compileTimeline(input: CompileInput) {
  const { project, fps, width: W, height: H } = input;
  const scenes = project.scenes ?? [];
  const portrait = H > W;
  type Op = Record<string, unknown> & { op: string };
  const ops: Op[] = [
    { op: "project.update", name: project.title },
    { op: "track.update", id: input.tracks.video, name: "Scenes" },
    { op: "track.update", id: input.tracks.audio, name: "Voice", role: "voice" },
  ];
  if (project.spec.captions) ops.push({ op: "track.create", ref: "$cc", kind: "video", name: "Captions", role: "captions", index: 0 });

  let cursor = 0;
  const sceneStarts: number[] = [];
  scenes.forEach((scene, i) => {
    const voice = input.voices.find((v) => v.sceneId === scene.id);
    const seconds = voice?.seconds ?? 0;
    const lead = i === 0 ? 0.5 : LEAD;
    const tail = i === scenes.length - 1 ? 1.8 : TAIL;
    const duration = Math.round(Math.max(MIN_SCENE, lead + seconds + tail) * fps);
    const tpl = input.templateAssets[scene.template];
    sceneStarts.push(cursor);
    if (tpl) {
      ops.push({
        op: "item.add",
        track: input.tracks.video,
        item: {
          type: "motion",
          assetId: tpl,
          start: cursor,
          duration,
          props: sceneProps(scene, input),
          ...(i > 0 ? { transitionIn: { type: "fade", durationInFrames: 8 } } : {}),
          meta: { "ideacut.sceneId": scene.id },
        },
      });
    }
    const voiceStart = cursor + Math.round(lead * fps);
    if (voice?.assetId && seconds > 0) {
      ops.push({ op: "item.add", track: input.tracks.audio, item: { type: "media", assetId: voice.assetId, start: voiceStart, duration: Math.max(1, Math.floor(seconds * fps)), meta: { "ideacut.sceneId": scene.id } } });
    }
    if (project.spec.captions && seconds > 0) {
      let last = voiceStart;
      for (const line of captionLines(scene.narration, seconds, project.spec.language, voice?.sentences)) {
        const s = Math.max(last, voiceStart + Math.round(line.start * fps));
        const e = Math.min(voiceStart + Math.round(line.end * fps), cursor + duration);
        if (e - s < 2) continue;
        ops.push({
          op: "item.add",
          track: "$cc",
          item: {
            type: "text",
            text: line.text,
            start: s,
            duration: e - s,
            transform: { width: Math.round(W * 0.86), height: Math.round(H * (portrait ? 0.1 : 0.12)), y: Math.round(H * (portrait ? 0.3 : 0.37)) },
            style: { fontSize: Math.round(Math.min(W, H) * (portrait ? 0.05 : 0.042)), fontWeight: 700, color: "#ffffff", background: "rgba(0,0,0,0.55)", lineHeight: 1.25 },
            meta: { "evercut.caption": true, "ideacut.sceneId": scene.id },
          },
        });
        last = e;
      }
    }
    cursor += duration;
  });

  if (input.music && input.music.seconds > 0.5) {
    ops.push({ op: "track.create", ref: "$music", kind: "audio", name: "Music", role: "music" });
    const len = Math.floor(input.music.seconds * fps);
    for (let at = 0; at < cursor; at += len) {
      const d = Math.min(len, cursor - at);
      ops.push({
        op: "item.add",
        track: "$music",
        item: {
          type: "media",
          assetId: input.music.assetId,
          start: at,
          duration: d,
          volume: 0.32,
          fadeIn: Math.min(Math.floor(d / 2), at === 0 ? Math.round(fps) : Math.round(fps / 3)),
          fadeOut: Math.min(Math.floor(d / 2), at + d >= cursor ? Math.round(fps * 2) : Math.round(fps / 3)),
        },
      });
    }
  }
  return { ops, totalFrames: cursor, sceneStarts };
}
