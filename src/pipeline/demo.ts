// Demo provider: runs the whole workflow without an API key (rule-based writing, silent
// voice-over, synthesized music). Also used by tests.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Concept, IdeaProject } from "../shared/project";
import { narrationLength } from "../shared/project";
import { ambientPad, silence } from "./audio";
import { ARCHETYPES } from "../shared/archetypes";
import { fallbackConcepts, fallbackExpansion, fallbackPlan, fallbackQuestions, fallbackStoryboard } from "./fallbacks";
import type { ChatMessage, Provider, SpeechResult, Voice } from "./minimax";

export class DemoProvider implements Provider {
  readonly demo = true;
  /** The project being worked on, so demo answers can use the idea text. */
  constructor(private readonly project: () => IdeaProject) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const system = messages[0]?.content ?? "";
    const task = system.match(/^TASK: ([\w-]+)/)?.[1];
    const p = this.project();
    const body =
      task === "questions" ? { questions: fallbackQuestions(p) }
      : task === "plan" ? fallbackPlan(p)
      : task === "concepts" ? { concepts: fallbackConcepts(p, ARCHETYPES.filter((a) => system.match(/^ARCHETYPES: (.*)$/m)?.[1]?.split(",").includes(a.id))) }
      : task === "expand" ? fallbackExpansion(p, { hook: messages[1]?.content.match(/^HOOK: (.*)$/m)?.[1] ?? "" } as Concept)
      : task === "storyboard" ? { scenes: fallbackStoryboard(p) }
      // Judges: no opinion, so the original order stands.
      : { scores: [] };
    return "```json\n" + JSON.stringify(body) + "\n```";
  }

  async speech(text: string, opts: { language: "zh" | "en"; speed?: number }): Promise<SpeechResult> {
    const seconds = Math.max(1.2, narrationLength(text, opts.language) / (opts.language === "zh" ? 4.2 : 2.4) / (opts.speed ?? 1));
    const dir = mkdtempSync(join(tmpdir(), "ideacut-demo-"));
    try {
      const out = join(dir, "voice.mp3");
      await silence(seconds, out);
      return { audio: readFileSync(out), format: "mp3", durationMs: Math.round(seconds * 1000) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async voices(): Promise<Voice[]> {
    return [
      { id: "demo-male", name: "演示（无声）", description: "Demo mode: silent voice-over" },
    ];
  }

  async music(_prompt: string, seconds: number): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), "ideacut-demo-"));
    try {
      const out = join(dir, "music.mp3");
      await ambientPad(seconds, out);
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
