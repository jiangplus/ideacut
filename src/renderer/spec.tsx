import { useEffect, useState } from "react";
import { THEMES, type Spec, type ThemeId } from "../shared/project";
import { api, type Voice } from "./api";

function Seg<T extends string | number>({ value, options, onChange }: { value: T | undefined; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={String(v)} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

/** Video settings: length, shape, language, look, voice, music, captions. */
export function SpecForm({ spec, onChange, compact }: { spec: Partial<Spec>; onChange: (s: Partial<Spec>) => void; compact?: boolean }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  useEffect(() => void api.voices().then(setVoices).catch(() => setVoices([])), []);
  const lang = spec.language ?? "zh";
  const list = voices.filter((v) => (lang === "zh" ? /Chinese|Mandarin|male|female|presenter|audiobook/i.test(v.id) && !v.id.startsWith("English") : v.id.startsWith("English")) || v.id.startsWith("demo"));
  return (
    <div className={`spec ${compact ? "compact" : ""}`}>
      <label>时长<Seg value={spec.duration} options={[[30, "30 秒"], [60, "60 秒"], [90, "90 秒"]]} onChange={(duration) => onChange({ duration: duration as Spec["duration"] })} /></label>
      <label>画幅<Seg value={spec.aspect} options={[["16:9", "横屏 16:9"], ["9:16", "竖屏 9:16"]]} onChange={(aspect) => onChange({ aspect })} /></label>
      <label>语言<Seg value={spec.language} options={[["zh", "中文"], ["en", "English"]]} onChange={(language) => onChange({ language, voiceId: "" })} /></label>
      <label>
        风格
        <div className="themes">
          {(Object.keys(THEMES) as ThemeId[]).map((t) => (
            <button key={t} className={`theme ${spec.theme === t ? "on" : ""}`} onClick={() => onChange({ theme: t })} title={THEMES[t].label}>
              <span style={{ background: `linear-gradient(135deg, ${THEMES[t].gradient.join(", ")})` }}><i style={{ background: THEMES[t].accent }} /></span>
              {THEMES[t].label}
            </button>
          ))}
        </div>
      </label>
      {!compact && (
        <>
          <label>
            配音
            <select value={spec.voiceId ?? ""} onChange={(e) => onChange({ voiceId: e.target.value })}>
              <option value="">自动选择</option>
              {(list.length ? list : voices).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className="checks">
            <span><input type="checkbox" checked={spec.music ?? true} onChange={(e) => onChange({ music: e.target.checked })} /> 背景音乐</span>
            <span><input type="checkbox" checked={spec.captions ?? true} onChange={(e) => onChange({ captions: e.target.checked })} /> 字幕</span>
          </label>
        </>
      )}
    </div>
  );
}
